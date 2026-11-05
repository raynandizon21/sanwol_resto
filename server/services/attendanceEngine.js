// ============================================
// ATTENDANCE ENGINE
// ============================================
// File: services/attendanceEngine.js
// Description: Pairs one person's punches into time-in → time-out shifts and adds up the hours per
// day, split into regular (up to the standard day) and "over". With a work schedule it also finds
// late arrivals, undertime and absences (rest days, holidays and excused days aren't absences).
// Pure (no DB), so every page computes the same thing. No overtime rules. Rules: docs/attendance.md.
//
// Times are device-local wall-clock text ("YYYY-MM-DD HH:mm[:ss]"). They are turned into
// minute counts with Date.UTC so no timezone ever applies. Seconds are kept (as a fraction of
// a minute) so a shift's length is exact; each shift is then rounded down to whole minutes.
// ============================================

const DEFAULT_RULES = Object.freeze({
	// Hours a day counted as regular; time past it is shown as "over".
	standardHours: 8,
	// A time-in with no time-out within this many hours is a forgotten time-out.
	maxShiftHours: 20,
});

// MB160 punch states. Whatever key is pressed, it's either arriving or leaving:
// Time-in (0), Break-in (3) and OT-in (4) start time at work; Time-out (1), Break-out (2) and
// OT-out (5) end it. Older punches with no state (255) are inferred.
const IN_STATUSES = new Set([0, 3, 4]);
const OUT_STATUSES = new Set([1, 2, 5]);

// The same kind of punch again within this many minutes is a double tap: the first time-in
// counts, and the last time-out.
const REPEAT_MINUTES = 5;
// A shift longer than this is almost certainly a forgotten time-out joined to a later one.
const LONG_SHIFT_MINUTES = 16 * 60;

/** Flags that mean a shift can't be counted until someone fixes a punch. */
const ISSUE_FLAGS = new Set(['missing_in', 'missing_out', 'long_shift']);

// ---- Time helpers (minutes since epoch, wall-clock) ----

const toMin = (dt) => {
	const [y, mo, d, h = 0, mi = 0, s = 0] = String(dt).slice(0, 19).split(/[- :T]/).map(Number);
	return Date.UTC(y, mo - 1, d, h, mi, s || 0) / 60000;
};
const ymdOf = (min) => new Date(min * 60000).toISOString().slice(0, 10);
/** "YYYY-MM-DD HH:mm" */
const dtOf = (min) => new Date(min * 60000).toISOString().slice(0, 16).replace('T', ' ');
const addDays = (ymd, n) => ymdOf(toMin(`${ymd} 00:00`) + n * 1440);

// ---- Shifts ----

/**
 * Pairs punches (oldest first) into shifts { in, out, punches }. A time-in opens a shift and the
 * next time-out closes it, if it comes within maxShiftHours. A time-out with no open shift is a
 * shift with no time-in; a time-in while one is still open leaves the open one without a time-out.
 */
function buildShifts(punches, rules) {
	const span = rules.maxShiftHours * 60;
	const shifts = [];
	let open = null; // has a time-in, no time-out yet
	let lastClosed = null; // for a double-tapped time-out

	for (const p of punches) {
		if (open && p.min - open.in.min > span) open = null; // stays without a time-out
		let kind = IN_STATUSES.has(p.status) ? 'in' : OUT_STATUSES.has(p.status) ? 'out' : null;
		if (kind === null) {
			// No state (older punches): alternate in / out.
			kind = open ? 'out' : 'in';
			p.inferred = true;
		}

		if (kind === 'in') {
			if (open && p.min - open.in.min <= REPEAT_MINUTES) {
				open.punches.push(p);
				continue;
			}
			// A new time-in while one is open: that one's time-out was forgotten (it isn't running).
			if (open) open.superseded = true;
			open = { in: p, out: null, punches: [p] };
			shifts.push(open);
			lastClosed = null;
		} else if (open) {
			open.out = p;
			open.punches.push(p);
			lastClosed = open;
			open = null;
		} else if (lastClosed && p.min - lastClosed.out.min <= REPEAT_MINUTES) {
			lastClosed.out = p;
			lastClosed.punches.push(p);
		} else {
			lastClosed = { in: null, out: p, punches: [p] };
			shifts.push(lastClosed);
		}
	}
	return shifts;
}

/** One shift's minutes and flags. `minutes` is null when it can't be counted. */
function evaluateShift(s, rules, nowMin) {
	const flags = new Set();
	const isOpen =
		Boolean(s.in && !s.out && !s.superseded) &&
		nowMin != null &&
		nowMin >= s.in.min &&
		nowMin - s.in.min < rules.maxShiftHours * 60;
	if (!s.in) flags.add('missing_in');
	else if (!s.out && !isOpen) flags.add('missing_out');
	let minutes = null;
	if (s.in && s.out) {
		// Whole minutes, rounded down (08:00:59 → 17:00:00 is 8h 59m). The epsilon absorbs float noise.
		minutes = Math.floor(s.out.min - s.in.min + 1e-9);
		if (minutes > LONG_SHIFT_MINUTES) {
			flags.add('long_shift');
			minutes = null;
		}
	}
	if (s.punches.some((p) => p.inferred)) flags.add('inferred');
	return { shift: s, isOpen, minutes, flags };
}

/** Weekday of a "YYYY-MM-DD" (0 = Sunday). */
const weekdayOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

/**
 * What the schedule expects of one date: whether it's a work day, and why not (rest day, holiday,
 * excused, not employed yet or anymore). No schedule: nothing is expected.
 */
function expectationFor(ymd, ctx) {
	const holiday = ctx.holidays.get(ymd) ?? null;
	const excuse = ctx.excused.get(ymd) ?? null;
	const { schedule } = ctx;
	const employed = (!ctx.hired || ymd >= ctx.hired) && (!ctx.separated || ymd <= ctx.separated);
	const restDay = Boolean(schedule && employed && schedule.restDays.includes(weekdayOf(ymd)));
	return { holiday, excuse, employed, restDay, scheduled: Boolean(schedule && employed && !restDay && !holiday && !excuse) };
}

/** Totals for one date from the shifts that started on it. */
function computeDay(ymd, shifts, rules, ctx) {
	const evaluated = shifts.map((s) => evaluateShift(s, rules, ctx.nowMin));
	const flags = new Set();
	evaluated.forEach((e) => e.flags.forEach((f) => flags.add(f)));

	const workedMinutes = evaluated.reduce((sum, e) => sum + (e.minutes ?? 0), 0);
	const regularMinutes = Math.min(workedMinutes, Math.round(rules.standardHours * 60));
	const isOpen = evaluated.some((e) => e.isOpen);

	const expect = expectationFor(ymd, ctx);
	const { schedule } = ctx;

	let status;
	if (!shifts.length) {
		// Marked days show even ahead of time (a leave filed in advance, a holiday).
		if (expect.excuse) status = 'excused';
		else if (expect.holiday) status = 'holiday';
		else if (ymd > ctx.today) status = 'upcoming';
		// Absent: a past work day with no punches at all. Today isn't over yet.
		else if (expect.scheduled && ymd < ctx.today) status = 'absent';
		else if (expect.restDay) status = 'rest_day';
		else status = 'off';
	} else if (isOpen) status = 'on_shift';
	else if ([...flags].some((f) => ISSUE_FLAGS.has(f))) status = 'incomplete';
	else status = 'worked';

	// Late: the day's first time-in after the start plus the grace period. Past the grace period
	// it counts from the start (8:00 start, 15 min grace, in at 8:20 = 20 min late).
	let lateMinutes = 0;
	const firstIn = evaluated.find((e) => e.shift.in)?.shift.in;
	if (expect.scheduled && firstIn) {
		const late = Math.floor(firstIn.min - toMin(`${ymd} ${schedule.start}`) + 1e-9);
		if (late > schedule.graceMinutes) lateMinutes = late;
	}
	// Undertime: the day's last time-out before the scheduled end, on a complete day only (a day
	// to fix or still running can't tell yet). An end at or before the start is the next day's.
	let undertimeMinutes = 0;
	if (expect.scheduled && schedule.end && status === 'worked') {
		const counted = evaluated.filter((e) => e.minutes != null);
		if (counted.length) {
			const lastOut = Math.max(...counted.map((e) => e.shift.out.min));
			const endMin = toMin(`${ymd} ${schedule.end}`) + (schedule.end <= schedule.start ? 1440 : 0);
			undertimeMinutes = Math.max(0, Math.floor(endMin - lastOut + 1e-9));
		}
	}

	return {
		date: ymd,
		status,
		workedMinutes,
		regularMinutes,
		overMinutes: workedMinutes - regularMinutes,
		// A work day by the schedule (not a rest day, holiday or excused day).
		scheduled: expect.scheduled,
		lateMinutes,
		undertimeMinutes,
		restDay: expect.restDay,
		holiday: expect.holiday,
		excuse: expect.excuse,
		flags: [...flags],
		shifts: evaluated.map((e) => ({
			in: e.shift.in ? dtOf(e.shift.in.min) : null,
			inInferred: Boolean(e.shift.in?.inferred),
			out: e.shift.out ? dtOf(e.shift.out.min) : null,
			outInferred: Boolean(e.shift.out?.inferred),
			minutes: e.minutes,
			open: e.isOpen,
		})),
		punches: shifts.flatMap((s) => s.punches.map((p) => p.ref)),
		// Minute intervals at work, for the staffing-by-hour chart (an open shift runs until now).
		presence: evaluated.flatMap((e) => {
			if (e.minutes != null) return [[e.shift.in.min, e.shift.out.min]];
			if (e.isOpen) return [[e.shift.in.min, ctx.nowMin]];
			return [];
		}),
	};
}

/**
 * Work days for one person from startYmd to endYmd (inclusive). A shift counts on the day of its
 * time-in, so a night shift (6 PM – 3 AM) is one day.
 *
 * punches: [{ dt: "YYYY-MM-DD HH:mm:ss", status, ref }] for that person, any order; include a
 *   day before startYmd and after endYmd so shifts crossing the range edges are complete. `ref`
 *   is passed through to day.punches (e.g. the punch's id) for the timesheet.
 * rules: DEFAULT_RULES shape. now: device-local "YYYY-MM-DD HH:mm:ss" (decides "on shift").
 * schedule: { start: "HH:MM", end: "HH:MM" | null, restDays: [weekday 0-6], graceMinutes } or
 *   null (no schedule: never late, absent or undertime).
 * holidays: Map "YYYY-MM-DD" -> name (the branch's). excused: Map "YYYY-MM-DD" -> { type, note }
 *   (leave, day off, holiday marked for this person). hired / separated: "YYYY-MM-DD" or null
 *   (no absences before the hire date or after the last day of work).
 */
function computeAttendance({
	punches,
	rules = DEFAULT_RULES,
	startYmd,
	endYmd,
	now,
	schedule = null,
	holidays = new Map(),
	excused = new Map(),
	hired = null,
	separated = null,
}) {
	const sorted = punches
		.map((p, i) => ({ min: toMin(p.dt), status: p.status == null ? 255 : Number(p.status), ref: p.ref ?? null, i }))
		.sort((a, b) => a.min - b.min || a.i - b.i);
	const shifts = buildShifts(sorted, rules);

	const byDate = new Map();
	for (const s of shifts) {
		const ymd = ymdOf((s.in || s.out).min);
		if (!byDate.has(ymd)) byDate.set(ymd, []);
		byDate.get(ymd).push(s);
	}

	const ctx = {
		nowMin: now ? toMin(now) : null,
		today: now ? String(now).slice(0, 10) : '9999-12-31',
		schedule: schedule && schedule.start ? schedule : null,
		holidays,
		excused,
		hired,
		separated,
	};
	const days = [];
	for (let ymd = startYmd; ymd <= endYmd; ymd = addDays(ymd, 1)) {
		days.push(computeDay(ymd, byDate.get(ymd) || [], rules, ctx));
	}
	return { days, totals: summarize(days) };
}

/** Every total, zero. The service adds people's totals key by key. */
const emptyTotals = () => ({
	daysWorked: 0,
	daysWithHours: 0,
	workedMinutes: 0,
	regularMinutes: 0,
	overMinutes: 0,
	incompleteDays: 0,
	absentDays: 0,
	lateDays: 0,
	lateMinutes: 0,
	undertimeDays: 0,
	undertimeMinutes: 0,
	excusedDays: 0,
	averageMinutes: 0,
});

/**
 * Range totals for one person. daysWorked: days with a time-in. daysWithHours: days with counted
 * hours (the average is over these, so an unfixed or still-running day doesn't drag it down).
 * excusedDays: days marked leave / day off / holiday for them (branch holidays aren't counted).
 */
function summarize(days) {
	const t = emptyTotals();
	for (const d of days) {
		if (d.shifts.some((s) => s.in)) t.daysWorked += 1;
		if (d.workedMinutes > 0) t.daysWithHours += 1;
		if (d.status === 'incomplete') t.incompleteDays += 1;
		if (d.status === 'absent') t.absentDays += 1;
		if (d.lateMinutes > 0) t.lateDays += 1;
		if (d.undertimeMinutes > 0) t.undertimeDays += 1;
		if (d.excuse) t.excusedDays += 1;
		t.workedMinutes += d.workedMinutes;
		t.regularMinutes += d.regularMinutes;
		t.overMinutes += d.overMinutes;
		t.lateMinutes += d.lateMinutes;
		t.undertimeMinutes += d.undertimeMinutes;
	}
	t.averageMinutes = t.daysWithHours ? Math.round(t.workedMinutes / t.daysWithHours) : 0;
	return t;
}

module.exports = {
	DEFAULT_RULES,
	ISSUE_FLAGS,
	computeAttendance,
	summarize,
	emptyTotals,
	weekdayOf,
	// exported for the summary service and tests
	toMin,
	addDays,
	ymdOf,
};
