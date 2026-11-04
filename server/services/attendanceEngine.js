// ============================================
// ATTENDANCE ENGINE
// ============================================
// File: services/attendanceEngine.js
// Description: Basic time tracking. Pairs one person's punches into time-in → time-out shifts and
// adds up the hours per day, split into regular (up to the standard day) and "over". Pure (no DB),
// so every page computes the same thing. No schedules, overtime rules, late or absences (yet).
// Rules: docs/attendance.md.
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

/** Totals for one date from the shifts that started on it. */
function computeDay(ymd, shifts, rules, ctx) {
	const evaluated = shifts.map((s) => evaluateShift(s, rules, ctx.nowMin));
	const flags = new Set();
	evaluated.forEach((e) => e.flags.forEach((f) => flags.add(f)));

	const workedMinutes = evaluated.reduce((sum, e) => sum + (e.minutes ?? 0), 0);
	const regularMinutes = Math.min(workedMinutes, Math.round(rules.standardHours * 60));
	const isOpen = evaluated.some((e) => e.isOpen);

	let status;
	if (!shifts.length) status = ymd > ctx.today ? 'upcoming' : 'off';
	else if (isOpen) status = 'on_shift';
	else if ([...flags].some((f) => ISSUE_FLAGS.has(f))) status = 'incomplete';
	else status = 'worked';

	return {
		date: ymd,
		status,
		workedMinutes,
		regularMinutes,
		overMinutes: workedMinutes - regularMinutes,
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
 */
function computeAttendance({ punches, rules = DEFAULT_RULES, startYmd, endYmd, now }) {
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

	const ctx = { nowMin: now ? toMin(now) : null, today: now ? String(now).slice(0, 10) : '9999-12-31' };
	const days = [];
	for (let ymd = startYmd; ymd <= endYmd; ymd = addDays(ymd, 1)) {
		days.push(computeDay(ymd, byDate.get(ymd) || [], rules, ctx));
	}
	return { days, totals: summarize(days) };
}

/**
 * Range totals for one person. daysWorked: days with a time-in. daysWithHours: days with counted
 * hours (the average is over these, so an unfixed or still-running day doesn't drag it down).
 */
function summarize(days) {
	const t = { daysWorked: 0, daysWithHours: 0, workedMinutes: 0, regularMinutes: 0, overMinutes: 0, incompleteDays: 0, averageMinutes: 0 };
	for (const d of days) {
		if (d.shifts.some((s) => s.in)) t.daysWorked += 1;
		if (d.workedMinutes > 0) t.daysWithHours += 1;
		if (d.status === 'incomplete') t.incompleteDays += 1;
		t.workedMinutes += d.workedMinutes;
		t.regularMinutes += d.regularMinutes;
		t.overMinutes += d.overMinutes;
	}
	t.averageMinutes = t.daysWithHours ? Math.round(t.workedMinutes / t.daysWithHours) : 0;
	return t;
}

module.exports = {
	DEFAULT_RULES,
	ISSUE_FLAGS,
	computeAttendance,
	summarize,
	// exported for the summary service and tests
	toMin,
	addDays,
	ymdOf,
};
