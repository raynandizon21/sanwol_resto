// Late, undertime, absences, rest days, holidays and excused days (attendanceEngine with a schedule).
// Run: cd server && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAttendance, DEFAULT_RULES } = require('../services/attendanceEngine');

const IN = 0;
const OUT = 1;
// 2026-10-05 is a Monday.
const MON = '2026-10-05';
const NOW = '2026-10-27 12:00:00';

const punch = (time, status, date = MON) => ({ dt: `${date} ${time}:00`, status });
const SCHEDULE = { start: '10:00', end: '19:00', restDays: [0], graceMinutes: 15 };

/** One day's result. */
function day(punches, { date = MON, now = NOW, schedule = SCHEDULE, ...extra } = {}) {
	return computeAttendance({ punches, rules: DEFAULT_RULES, startYmd: date, endYmd: date, now, schedule, ...extra }).days[0];
}

test('on time and within the grace period: not late', () => {
	assert.equal(day([punch('09:40', IN), punch('19:00', OUT)]).lateMinutes, 0);
	assert.equal(day([punch('10:15', IN), punch('19:00', OUT)]).lateMinutes, 0);
});

test('past the grace period, late counts from the start', () => {
	const d = day([punch('10:20', IN), punch('19:00', OUT)]);
	assert.equal(d.lateMinutes, 20);
	assert.equal(d.status, 'worked');
});

test('late is from the first time-in of the day', () => {
	const d = day([punch('10:30', IN), punch('14:00', OUT), punch('15:00', IN), punch('19:00', OUT)]);
	assert.equal(d.lateMinutes, 30);
});

test('undertime: leaving before the scheduled end', () => {
	assert.equal(day([punch('10:00', IN), punch('18:15', OUT)]).undertimeMinutes, 45);
	assert.equal(day([punch('10:00', IN), punch('19:30', OUT)]).undertimeMinutes, 0);
});

test('undertime is from the last time-out of the day', () => {
	const d = day([punch('10:00', IN), punch('14:00', OUT), punch('15:00', IN), punch('18:50', OUT)]);
	assert.equal(d.undertimeMinutes, 10);
});

test('no end time: no undertime, late still counts', () => {
	const d = day([punch('10:30', IN), punch('15:00', OUT)], { schedule: { ...SCHEDULE, end: null } });
	assert.equal(d.undertimeMinutes, 0);
	assert.equal(d.lateMinutes, 30);
});

test('a night schedule ends the next day', () => {
	const schedule = { start: '18:00', end: '02:00', restDays: [], graceMinutes: 15 };
	const d = day([punch('18:05', IN), punch('01:30', OUT, '2026-10-06')], { schedule });
	assert.equal(d.lateMinutes, 0);
	assert.equal(d.undertimeMinutes, 30);
});

test('a day to fix has no undertime yet', () => {
	const d = day([punch('10:00', IN)]);
	assert.equal(d.status, 'incomplete');
	assert.equal(d.undertimeMinutes, 0);
});

test('absent: a past work day with no punches', () => {
	const d = day([]);
	assert.equal(d.status, 'absent');
	assert.equal(d.scheduled, true);
});

test('today and future days are never absent', () => {
	assert.equal(day([], { now: `${MON} 20:00:00` }).status, 'off');
	assert.equal(day([], { now: '2026-10-01 12:00:00' }).status, 'upcoming');
});

test('rest days are not absences, and working on one is never late', () => {
	const sunday = '2026-10-04';
	assert.equal(day([], { date: sunday }).status, 'rest_day');
	const worked = day([punch('12:00', IN, sunday), punch('20:00', OUT, sunday)], { date: sunday });
	assert.equal(worked.status, 'worked');
	assert.equal(worked.lateMinutes, 0);
	assert.equal(worked.scheduled, false);
});

test('branch holidays and excused days are not absences', () => {
	const holiday = day([], { holidays: new Map([[MON, 'Founding day']]) });
	assert.equal(holiday.status, 'holiday');
	assert.equal(holiday.holiday, 'Founding day');
	const leave = day([], { excused: new Map([[MON, { type: 'leave', note: 'Sick' }]]) });
	assert.equal(leave.status, 'excused');
	assert.deepEqual(leave.excuse, { type: 'leave', note: 'Sick' });
});

test('an excused day ahead of time shows as excused, not upcoming', () => {
	const d = day([], { now: '2026-10-01 12:00:00', excused: new Map([[MON, { type: 'leave', note: null }]]) });
	assert.equal(d.status, 'excused');
});

test('working on an excused day counts the hours and is never late', () => {
	const d = day([punch('11:00', IN), punch('19:00', OUT)], { excused: new Map([[MON, { type: 'day_off', note: null }]]) });
	assert.equal(d.status, 'worked');
	assert.equal(d.workedMinutes, 480);
	assert.equal(d.lateMinutes, 0);
});

test('no absences before the hire date or after the last day of work', () => {
	assert.equal(day([], { hired: '2026-10-06' }).status, 'off');
	assert.equal(day([], { separated: '2026-10-04' }).status, 'off');
	assert.equal(day([], { hired: MON, separated: MON }).status, 'absent');
});

test('no schedule (or no start time): never late, absent or undertime', () => {
	for (const schedule of [null, { ...SCHEDULE, start: null }]) {
		assert.equal(day([], { schedule }).status, 'off');
		const d = day([punch('13:00', IN), punch('15:00', OUT)], { schedule });
		assert.equal(d.lateMinutes, 0);
		assert.equal(d.undertimeMinutes, 0);
		assert.equal(d.scheduled, false);
	}
});

test('totals count absences, late and undertime', () => {
	// Mon late 20m and 30m undertime, Tue absent, Wed fine, Sun rest.
	const { totals } = computeAttendance({
		punches: [
			punch('10:20', IN),
			punch('18:30', OUT),
			punch('10:00', IN, '2026-10-07'),
			punch('19:00', OUT, '2026-10-07'),
		],
		rules: DEFAULT_RULES,
		startYmd: '2026-10-04',
		endYmd: '2026-10-07',
		now: NOW,
		schedule: SCHEDULE,
	});
	assert.equal(totals.absentDays, 1);
	assert.equal(totals.lateDays, 1);
	assert.equal(totals.lateMinutes, 20);
	assert.equal(totals.undertimeDays, 1);
	assert.equal(totals.undertimeMinutes, 30);
	assert.equal(totals.daysWorked, 2);
});
