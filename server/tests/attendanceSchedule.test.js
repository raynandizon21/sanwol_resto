// Late, undertime, absences, days off, leave and recorded absences against a per-day
// schedule (attendanceEngine with a roster, as set on the Schedules page).
// Run: cd server && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAttendance, shiftLength } = require('../services/attendanceEngine');

const IN = 0;
const OUT = 1;
// 2026-10-05 is a Monday.
const MON = '2026-10-05';
const NOW = '2026-10-27 12:00:00';

const punch = (time, status, date = MON) => ({ dt: `${date} ${time}:00`, status });
const OPENING = { type: 'shift', shiftTypeId: 1, name: 'Opening', color: '#FCD34D', start: '10:00', end: '19:00' };
const rosterOf = (entry, date = MON) => new Map(entry ? [[date, entry]] : []);

/** One day's result. */
function day(punches, { date = MON, now = NOW, entry = OPENING, ...extra } = {}) {
	return computeAttendance({ punches, startYmd: date, endYmd: date, now, roster: rosterOf(entry, date), ...extra }).days[0];
}

test('on time (or within the first minute): not late', () => {
	assert.equal(day([punch('09:40', IN), punch('19:00', OUT)]).lateMinutes, 0);
	assert.equal(day([punch('10:00', IN), punch('19:00', OUT)]).lateMinutes, 0);
	assert.equal(computeAttendance({
		punches: [{ dt: `${MON} 10:00:59`, status: IN }, punch('19:00', OUT)],
		startYmd: MON,
		endYmd: MON,
		now: NOW,
		roster: rosterOf(OPENING),
	}).days[0].lateMinutes, 0);
});

test('no grace period: late counts from the start, from the first minute', () => {
	assert.equal(day([punch('10:01', IN), punch('19:00', OUT)]).lateMinutes, 1);
	const d = day([punch('10:20', IN), punch('19:00', OUT)]);
	assert.equal(d.lateMinutes, 20);
	assert.equal(d.status, 'worked');
	assert.equal(d.shift.name, 'Opening');
	assert.equal(d.scheduled, true);
});

test('each day uses its own shift', () => {
	const roster = new Map([
		[MON, OPENING],
		['2026-10-06', { type: 'shift', shiftTypeId: 3, name: 'Closing', start: '14:00', end: '23:00' }],
	]);
	const { days } = computeAttendance({
		punches: [punch('10:20', IN), punch('19:00', OUT), punch('14:20', IN, '2026-10-06'), punch('22:30', OUT, '2026-10-06')],
		startYmd: MON,
		endYmd: '2026-10-06',
		now: NOW,
		roster,
	});
	assert.equal(days[0].lateMinutes, 20);
	assert.equal(days[1].lateMinutes, 20);
	assert.equal(days[1].undertimeMinutes, 30);
});

test('late is from the first time-in of the day', () => {
	const d = day([punch('10:30', IN), punch('14:00', OUT), punch('15:00', IN), punch('19:00', OUT)]);
	assert.equal(d.lateMinutes, 30);
});

test('undertime: leaving before the shift ends', () => {
	assert.equal(day([punch('10:00', IN), punch('18:15', OUT)]).undertimeMinutes, 45);
	assert.equal(day([punch('10:00', IN), punch('19:30', OUT)]).undertimeMinutes, 0);
});

test('custom times count like a shift type', () => {
	const d = day([punch('11:30', IN), punch('23:00', OUT)], { entry: { type: 'shift', shiftTypeId: null, name: null, start: '11:00', end: '23:00' } });
	assert.equal(d.lateMinutes, 30);
	assert.equal(d.shift.name, null);
});

test('a night shift ends the next day', () => {
	const entry = { type: 'shift', start: '18:00', end: '02:00' };
	const d = day([punch('18:05', IN), punch('01:30', OUT, '2026-10-06')], { entry });
	assert.equal(d.lateMinutes, 5);
	assert.equal(d.undertimeMinutes, 30);
	assert.equal(shiftLength('18:00', '02:00'), 480);
});

test('regular hours go up to the shift length', () => {
	// Opening is 9 h: a full shift is all regular.
	const full = day([punch('10:00', IN), punch('19:00', OUT)]);
	assert.equal(full.regularMinutes, 540);
	assert.equal(full.overMinutes, 0);
	// Staying an hour later: 1 h over.
	const longer = day([punch('10:00', IN), punch('20:00', OUT)]);
	assert.equal(longer.regularMinutes, 540);
	assert.equal(longer.overMinutes, 60);
	// The 12 h Whole day shift.
	const whole = day([punch('11:00', IN), punch('23:00', OUT)], { entry: { type: 'shift', start: '11:00', end: '23:00' } });
	assert.equal(whole.regularMinutes, 720);
	// Not scheduled: all regular.
	const free = day([punch('10:00', IN), punch('22:00', OUT)], { entry: null });
	assert.equal(free.regularMinutes, 720);
	assert.equal(free.overMinutes, 0);
});

test('a day to fix has no undertime yet', () => {
	const d = day([punch('10:00', IN)]);
	assert.equal(d.status, 'incomplete');
	assert.equal(d.undertimeMinutes, 0);
});

test('a past shift with no punches is absent; today and later are not', () => {
	assert.equal(day([]).status, 'absent');
	assert.equal(day([], { date: '2026-10-27' }).status, 'upcoming');
	assert.equal(day([], { date: '2026-10-28' }).status, 'upcoming');
});

test('an unscheduled day is never late or absent, and hours still count', () => {
	assert.equal(day([], { entry: null }).status, 'off');
	const d = day([punch('13:00', IN), punch('17:00', OUT)], { entry: null });
	assert.equal(d.lateMinutes, 0);
	assert.equal(d.workedMinutes, 240);
	assert.equal(d.scheduled, false);
});

test('a day off is a rest day, shown ahead of time too', () => {
	const entry = { type: 'day_off', note: null };
	assert.equal(day([], { entry }).status, 'rest_day');
	assert.equal(day([], { entry, date: '2026-10-30' }).status, 'rest_day');
	// Coming in anyway: hours count, never late.
	const d = day([punch('12:00', IN), punch('16:00', OUT)], { entry });
	assert.equal(d.status, 'worked');
	assert.equal(d.lateMinutes, 0);
	assert.deepEqual(d.offDuty, { type: 'day_off', note: null });
});

test('leave is excused, with its note', () => {
	const d = day([], { entry: { type: 'leave', note: 'Sick' } });
	assert.equal(d.status, 'excused');
	assert.deepEqual(d.offDuty, { type: 'leave', note: 'Sick' });
});

test('a recorded absence counts as absent; punches win when they came in', () => {
	const entry = { type: 'absent', note: 'No call' };
	assert.equal(day([], { entry }).status, 'absent');
	assert.equal(day([], { entry, date: '2026-10-30' }).status, 'absent');
	const worked = day([punch('10:00', IN), punch('19:00', OUT)], { entry });
	assert.equal(worked.status, 'worked');
	assert.ok(worked.flags.includes('marked_absent'));
	assert.equal(worked.workedMinutes, 540);
});

test('shifts before the hire date or after the last day are not expected', () => {
	assert.equal(day([], { hired: '2026-10-06' }).status, 'off');
	assert.equal(day([], { separated: '2026-10-04' }).status, 'off');
	assert.equal(day([], { hired: MON }).status, 'absent');
});

test('totals: absences, leave, late, undertime and scheduled days', () => {
	const roster = new Map([
		['2026-10-05', OPENING],
		['2026-10-06', OPENING],
		['2026-10-07', { type: 'leave', note: null }],
		['2026-10-08', { type: 'day_off', note: null }],
		['2026-10-09', OPENING],
	]);
	const { totals } = computeAttendance({
		punches: [punch('10:30', IN), punch('19:00', OUT), punch('10:00', IN, '2026-10-09'), punch('18:00', OUT, '2026-10-09')],
		startYmd: '2026-10-05',
		endYmd: '2026-10-09',
		now: NOW,
		roster,
	});
	assert.equal(totals.absentDays, 1);
	assert.equal(totals.excusedDays, 1);
	assert.equal(totals.lateDays, 1);
	assert.equal(totals.lateMinutes, 30);
	assert.equal(totals.undertimeDays, 1);
	assert.equal(totals.undertimeMinutes, 60);
	assert.equal(totals.scheduledDays, 3);
});
