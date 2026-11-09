const test = require('node:test');
const assert = require('node:assert');
const { computeAttendance, todayOf } = require('../services/attendanceEngine');

const OPENING = { type: 'shift', start: '10:00', end: '19:00', name: 'Opening', color: '#FCD34D', shiftTypeId: 1 };

/** Where someone stands at `now` on 2026-11-09, with that day's roster entry and punches. */
const today = ({ entry = null, punches = [], yesterday = null, now }) => {
	const roster = new Map();
	if (entry) roster.set('2026-11-09', entry);
	if (yesterday) roster.set('2026-11-08', yesterday);
	const { days } = computeAttendance({
		punches: punches.map(([dt, status]) => ({ dt, status })),
		startYmd: '2026-11-08',
		endYmd: '2026-11-09',
		now,
		roster,
	});
	return todayOf(days, now);
};

test('a shift that has not started yet is not "not in yet"', () => {
	const s = today({ entry: OPENING, now: '2026-11-09 09:59:00' });
	assert.equal(s.shift.name, 'Opening');
	assert.equal(s.notInYet, false);
	assert.equal(s.timeIn, null);
	assert.equal(s.atWork, false);
});

test('a started shift with no punch is "not in yet"', () => {
	const s = today({ entry: OPENING, now: '2026-11-09 10:01:00' });
	assert.equal(s.notInYet, true);
});

test('on time: in now, not late', () => {
	const s = today({ entry: OPENING, punches: [['2026-11-09 09:55:00', 0]], now: '2026-11-09 12:00:00' });
	assert.equal(s.atWork, true);
	assert.equal(s.timeIn, '2026-11-09 09:55');
	assert.equal(s.lateMinutes, 0);
	assert.equal(s.notInYet, false);
});

test('late by the first minute', () => {
	const s = today({ entry: OPENING, punches: [['2026-11-09 10:04:00', 0]], now: '2026-11-09 12:00:00' });
	assert.equal(s.lateMinutes, 4);
	assert.equal(s.atWork, true);
});

test('left for the day: has a time-in, no longer in now', () => {
	const s = today({
		entry: OPENING,
		punches: [['2026-11-09 10:00:00', 0], ['2026-11-09 19:00:00', 1]],
		now: '2026-11-09 20:00:00',
	});
	assert.equal(s.timeIn, '2026-11-09 10:00');
	assert.equal(s.atWork, false);
	assert.equal(s.needsFixing, false);
});

test('a time-out with no time-in needs fixing and is not "not in yet"', () => {
	const s = today({ entry: OPENING, punches: [['2026-11-09 19:00:00', 1]], now: '2026-11-09 20:00:00' });
	assert.equal(s.needsFixing, true);
	assert.equal(s.notInYet, false);
});

test('a day off carries through and is never "not in yet"', () => {
	const s = today({ entry: { type: 'day_off', note: null }, now: '2026-11-09 12:00:00' });
	assert.equal(s.shift, null);
	assert.equal(s.offDuty.type, 'day_off');
	assert.equal(s.notInYet, false);
});

test('a night shift from yesterday is still in now today', () => {
	const s = today({ punches: [['2026-11-08 18:00:00', 0]], now: '2026-11-09 01:00:00' });
	assert.equal(s.atWork, true);
	assert.equal(s.timeIn, '2026-11-08 18:00');
});

test('totals count days off separately from leave', () => {
	const roster = new Map([
		['2026-11-02', OPENING],
		['2026-11-03', { type: 'day_off', note: null }],
		['2026-11-04', { type: 'day_off', note: null }],
		['2026-11-05', { type: 'leave', note: null }],
	]);
	const { totals } = computeAttendance({ punches: [], startYmd: '2026-11-02', endYmd: '2026-11-05', now: '2026-11-09 12:00:00', roster });
	assert.equal(totals.dayOffDays, 2);
	assert.equal(totals.excusedDays, 1);
	assert.equal(totals.scheduledDays, 1);
	assert.equal(totals.absentDays, 1);
});

test('someone still clocked in from last night is in now, not "not in yet"', () => {
	const s = today({ entry: OPENING, punches: [['2026-11-08 20:00:00', 0]], now: '2026-11-09 10:30:00' });
	assert.equal(s.atWork, true);
	assert.equal(s.notInYet, false);
});

test('coming in on a day off or on leave counts as worked, not as the day off or leave too', () => {
	const roster = new Map([
		['2026-11-02', { type: 'day_off', note: null }],
		['2026-11-03', { type: 'leave', note: null }],
		['2026-11-04', { type: 'day_off', note: null }],
		['2026-11-05', { type: 'leave', note: null }],
	]);
	const punches = [
		{ dt: '2026-11-02 12:00:00', status: 0 },
		{ dt: '2026-11-02 16:00:00', status: 1 },
		{ dt: '2026-11-03 12:00:00', status: 0 },
		{ dt: '2026-11-03 16:00:00', status: 1 },
	];
	const { totals } = computeAttendance({ punches, startYmd: '2026-11-02', endYmd: '2026-11-05', now: '2026-11-09 12:00:00', roster });
	assert.equal(totals.daysWorked, 2);
	assert.equal(totals.dayOffDays, 1);
	assert.equal(totals.excusedDays, 1);
	assert.equal(totals.absentDays, 0);
});
