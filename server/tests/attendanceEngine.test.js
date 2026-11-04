// Run: cd server && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAttendance, DEFAULT_RULES } = require('../services/attendanceEngine');

const IN = 0;
const OUT = 1;
const BREAK_OUT = 2;
const BREAK_IN = 3;
const OT_IN = 4;
const OT_OUT = 5;
const NONE = 255;

const DAY = '2026-10-05';
const NEXT = '2026-10-06';
const NOW = '2026-10-27 12:00:00';
const TODAY = '2026-10-27';

const punch = (time, status, date = DAY) => ({ dt: `${date} ${time}:00`, status });

/** One day's result. */
function day(punches, { rules = {}, date = DAY, now = NOW } = {}) {
	return computeAttendance({ punches, rules: { ...DEFAULT_RULES, ...rules }, startYmd: date, endYmd: date, now }).days[0];
}

test('a normal day: time between time-in and time-out', () => {
	const d = day([punch('10:00', IN), punch('18:00', OUT)]);
	assert.equal(d.status, 'worked');
	assert.equal(d.workedMinutes, 480);
	assert.equal(d.regularMinutes, 480);
	assert.equal(d.overMinutes, 0);
	assert.deepEqual(d.flags, []);
	assert.equal(d.shifts[0].minutes, 480);
});

test('time past the standard day is shown as over, nothing is lost', () => {
	const d = day([punch('09:00', IN), punch('19:30', OUT)]);
	assert.equal(d.workedMinutes, 630);
	assert.equal(d.regularMinutes, 480);
	assert.equal(d.overMinutes, 150);
});

test('the standard day follows the branch rule', () => {
	const d = day([punch('09:00', IN), punch('19:00', OUT)], { rules: { standardHours: 9.5 } });
	assert.equal(d.regularMinutes, 570);
	assert.equal(d.overMinutes, 30);
});

test('no automatic break: clocking out for lunch is simply not counted', () => {
	const d = day([punch('08:00', IN), punch('12:00', OUT), punch('13:00', IN), punch('17:00', OUT)]);
	assert.equal(d.shifts.length, 2);
	assert.equal(d.workedMinutes, 480);
	assert.equal(d.status, 'worked');
});

test('break and OT keys count as leaving and arriving', () => {
	const d = day([
		punch('08:00', IN),
		punch('12:00', BREAK_OUT),
		punch('12:30', BREAK_IN),
		punch('17:00', OUT),
		punch('17:30', OT_IN),
		punch('19:00', OT_OUT),
	]);
	assert.equal(d.shifts.length, 3);
	assert.equal(d.workedMinutes, 240 + 270 + 90);
	assert.equal(d.status, 'worked');
});

test('a double tap within 5 minutes counts once (first time-in, last time-out)', () => {
	const d = day([punch('08:00', IN), punch('08:02', IN), punch('17:00', OUT), punch('17:03', OUT)]);
	assert.equal(d.shifts.length, 1);
	assert.equal(d.shifts[0].in, `${DAY} 08:00`);
	assert.equal(d.shifts[0].out, `${DAY} 17:03`);
	assert.equal(d.workedMinutes, 543);
});

test('missing time-out on a past day: needs fixing, not counted', () => {
	const d = day([punch('08:00', IN)]);
	assert.equal(d.status, 'incomplete');
	assert.ok(d.flags.includes('missing_out'));
	assert.equal(d.workedMinutes, 0);
});

test('time-out with no time-in: needs fixing', () => {
	const d = day([punch('17:00', OUT)]);
	assert.equal(d.status, 'incomplete');
	assert.ok(d.flags.includes('missing_in'));
});

test('two time-ins in a row: the first is missing its time-out, even today', () => {
	const d = day([punch('08:00', IN, TODAY), punch('09:00', IN, TODAY)], { date: TODAY, now: `${TODAY} 10:00:00` });
	assert.equal(d.shifts.length, 2);
	assert.equal(d.shifts[0].open, false);
	assert.equal(d.shifts[1].open, true);
	assert.ok(d.flags.includes('missing_out'));
	assert.equal(d.status, 'on_shift');
});

test('a shift still running today is "on shift", not missing a time-out', () => {
	const d = day([punch('08:00', IN, TODAY)], { date: TODAY, now: `${TODAY} 12:00:00` });
	assert.equal(d.status, 'on_shift');
	assert.equal(d.shifts[0].open, true);
	assert.deepEqual(d.flags, []);
	assert.equal(d.workedMinutes, 0);
});

test('a night shift past midnight counts on the day it started', () => {
	const result = computeAttendance({
		punches: [punch('18:00', IN), punch('03:00', OUT, NEXT)],
		rules: DEFAULT_RULES,
		startYmd: DAY,
		endYmd: NEXT,
		now: NOW,
	});
	const [first, second] = result.days;
	assert.equal(first.status, 'worked');
	assert.equal(first.workedMinutes, 540);
	assert.equal(first.overMinutes, 60);
	assert.equal(second.status, 'off');
});

test('a forgotten time-out joined to the next day: flagged, not counted', () => {
	const d = day([punch('08:00', IN), punch('02:00', OUT, NEXT)]);
	assert.ok(d.flags.includes('long_shift'));
	assert.equal(d.status, 'incomplete');
	assert.equal(d.workedMinutes, 0);
});

test('no time-out within the longest shift: the time-in is left without one', () => {
	const result = computeAttendance({
		punches: [punch('08:00', IN), punch('17:00', OUT, NEXT)],
		rules: DEFAULT_RULES,
		startYmd: DAY,
		endYmd: NEXT,
		now: NOW,
	});
	assert.ok(result.days[0].flags.includes('missing_out'));
	assert.ok(result.days[1].flags.includes('missing_in'));
});

test('punches with no state (older device setting) alternate in / out, flagged', () => {
	const d = day([punch('08:00', NONE), punch('17:00', NONE)]);
	assert.equal(d.workedMinutes, 540);
	assert.ok(d.flags.includes('inferred'));
	assert.equal(d.status, 'worked');
	assert.equal(d.shifts[0].inInferred, true);
});

test('a day with no punches is off; a future day is upcoming', () => {
	assert.equal(day([]).status, 'off');
	assert.equal(day([], { date: '2026-12-01' }).status, 'upcoming');
});

test('totals: days worked, hours, average over days with hours', () => {
	const { totals } = computeAttendance({
		punches: [
			punch('09:00', IN),
			punch('19:00', OUT),
			punch('09:00', IN, NEXT),
			punch('15:00', OUT, NEXT),
			punch('09:00', IN, '2026-10-07'),
		],
		rules: DEFAULT_RULES,
		startYmd: DAY,
		endYmd: '2026-10-08',
		now: NOW,
	});
	assert.equal(totals.daysWorked, 3);
	assert.equal(totals.daysWithHours, 2);
	assert.equal(totals.workedMinutes, 600 + 360);
	assert.equal(totals.regularMinutes, 480 + 360);
	assert.equal(totals.overMinutes, 120);
	assert.equal(totals.incompleteDays, 1);
	assert.equal(totals.averageMinutes, 480);
});

test('punches at the same minute keep their order', () => {
	const d = day([punch('08:00', IN), punch('17:00', OUT), punch('17:00', IN), punch('20:00', OUT)]);
	assert.equal(d.shifts.length, 2);
	assert.equal(d.workedMinutes, 540 + 180);
});
