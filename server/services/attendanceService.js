// ============================================
// ATTENDANCE SERVICE
// ============================================
// File: services/attendanceService.js
// Description: Loads punches (zkteco DB) and profiles/rules (sanwol_resto DB), runs
// attendanceEngine per person, and shapes the results for the Attendance Logs summary and the
// timesheet. The two DBs are read separately and combined here. See docs/attendance.md.
// ============================================

const ZktecoModel = require('../models/zktecoModel');
const EmployeeModel = require('../models/employeeModel');
const AttendanceSettingsModel = require('../models/attendanceSettingsModel');
const { ensureEmployeeLinks } = require('./employeeLinkService');
const { computeAttendance, addDays, ymdOf, ISSUE_FLAGS, toMin } = require('./attendanceEngine');

const MAX_RANGE_DAYS = 366;

const fullName = (profile, fallback) =>
	[profile?.FIRSTNAME, profile?.LASTNAME].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ') || fallback || null;

const dayCount = (startYmd, endYmd) => Math.round((toMin(`${endYmd} 00:00`) - toMin(`${startYmd} 00:00`)) / 1440) + 1;

/**
 * Everyone in scope: one entry per profile, with their device rows. Links new device users to
 * profiles first, so a user added minutes ago is included.
 */
async function loadPeople(branchIds) {
	await ensureEmployeeLinks(branchIds);
	const rows = await ZktecoModel.getUserRowsForLinking(branchIds);
	const profiles = new Map(
		(await EmployeeModel.getProfilesByIds(rows.map((r) => r.EMPLOYEE_ID))).map((p) => [Number(p.IDNo), p])
	);
	const people = new Map();
	for (const row of rows) {
		if (row.EMPLOYEE_ID == null) continue;
		const id = Number(row.EMPLOYEE_ID);
		if (!people.has(id)) people.set(id, { employeeId: id, profile: profiles.get(id) || null, rows: [] });
		people.get(id).rows.push(row);
	}
	for (const person of people.values()) {
		const active = person.rows.filter((r) => Number(r.ACTIVE));
		// The row that represents them now: their active row, else their latest one.
		const current = active[active.length - 1] || person.rows[person.rows.length - 1];
		const p = person.profile;
		person.deviceUserId = Number(current.IDNo);
		person.deviceId = Number(current.DEVICE_ID);
		person.pin = String(current.PIN);
		person.active = active.length > 0;
		person.branchId = p?.BRANCH_ID ?? current.BRANCH_ID ?? null;
		person.name = fullName(p, current.NAME);
		person.deviceName = current.NAME;
		person.position = p?.DEPARTMENT || null;
	}
	return people;
}

/** Punches grouped by profile; punches of User IDs not on the device by "deviceId:pin". */
function groupPunches(punches) {
	const byEmployee = new Map();
	const unknown = new Map();
	for (const p of punches) {
		const entry = { dt: p.PUNCH_DT, status: p.PUNCH_STATUS, ref: `${p.SOURCE}:${p.IDNo}` };
		if (p.EMPLOYEE_ID != null) {
			const id = Number(p.EMPLOYEE_ID);
			if (!byEmployee.has(id)) byEmployee.set(id, []);
			byEmployee.get(id).push(entry);
		} else {
			const key = `${p.DEVICE_ID}:${p.PIN}`;
			if (!unknown.has(key)) unknown.set(key, { deviceId: Number(p.DEVICE_ID), pin: String(p.PIN), branchId: p.BRANCH_ID, punches: [] });
			unknown.get(key).punches.push(entry);
		}
	}
	return { byEmployee, unknown };
}

function checkRange(startYmd, endYmd) {
	if (startYmd > endYmd) return 'The start date must be on or before the end date';
	if (dayCount(startYmd, endYmd) > MAX_RANGE_DAYS) return `Choose a range of at most ${MAX_RANGE_DAYS} days`;
	return null;
}

// A day before and after the range, so shifts crossing its edges are complete.
const loadRange = (branchIds, startYmd, endYmd) =>
	ZktecoModel.getPunchesForAttendance(branchIds, `${addDays(startYmd, -1)} 00:00:00`, `${addDays(endYmd, 2)} 00:00:00`);

/** Drops the internal fields the API doesn't send. */
const publicDay = ({ presence, punches, ...day }) => day;

/**
 * Summary for the Attendance Logs page: per-person totals for the range, a daily series, average
 * staffing by hour, problems to fix, and a live block for today (who is on shift now).
 */
async function getSummary(branchIds, startYmd, endYmd) {
	const now = String(await ZktecoModel.deviceNow());
	const today = now.slice(0, 10);
	const people = await loadPeople(branchIds);
	const [rangePunches, todayPunches] = await Promise.all([
		loadRange(branchIds, startYmd, endYmd),
		loadRange(branchIds, addDays(today, -1), today),
	]);
	const ruleBranchIds = [...people.values()].map((p) => p.branchId);
	const rangeGroups = groupPunches(rangePunches);
	rangeGroups.unknown.forEach((u) => ruleBranchIds.push(u.branchId));
	const rulesByBranch = await AttendanceSettingsModel.getRulesForBranches(ruleBranchIds);
	const rulesFor = (branchId) => rulesByBranch.get(Number(branchId)) || rulesByBranch.values().next().value;

	const inRange = (entries) => entries.some((e) => e.dt >= `${startYmd} 00:00:00` && e.dt < `${addDays(endYmd, 1)} 00:00:00`);
	const compute = (punches, branchId) =>
		computeAttendance({ punches, rules: rulesFor(branchId), startYmd, endYmd, now });

	const results = [];
	for (const person of people.values()) {
		const punches = rangeGroups.byEmployee.get(person.employeeId) || [];
		// Everyone on the device is listed; people removed from it only when they worked in the range.
		if (!person.active && !inRange(punches)) continue;
		results.push({ person, ...compute(punches, person.branchId) });
	}
	// Punches of User IDs that aren't on the device: shown so they aren't silently lost.
	for (const u of rangeGroups.unknown.values()) {
		if (!inRange(u.punches)) continue;
		results.push({
			person: { employeeId: null, deviceId: u.deviceId, pin: u.pin, name: null, active: false, branchId: u.branchId },
			...compute(u.punches, u.branchId),
		});
	}

	// Daily series: hours (regular / over) and people at work (complete / needs fixing).
	const daily = [];
	for (let ymd = startYmd; ymd <= endYmd; ymd = addDays(ymd, 1)) {
		daily.push({ date: ymd, regularMinutes: 0, overMinutes: 0, people: 0, incomplete: 0 });
	}
	const dailyIndex = new Map(daily.map((d, i) => [d.date, i]));
	const issues = [];

	// Staffing: how many people are at work at half past each hour on a typical working day.
	// Averaged only over dates someone was at work (closed days would drag it toward 0) and only
	// over hours that have passed (today's later hours haven't happened yet). Presence is checked
	// as intervals, so a night shift's hours after midnight count on the calendar date they fall on.
	const nowMin = toMin(now);
	const presenceByPerson = results.map(({ days }) => days.flatMap((d) => d.presence));
	const rangeStart = toMin(`${startYmd} 00:00`);
	const rangeEnd = toMin(`${addDays(endYmd, 1)} 00:00`);
	const workDates = new Set();
	for (const presence of presenceByPerson) {
		for (const [a, b] of presence) {
			for (let m = Math.max(a, rangeStart); m < Math.min(b, rangeEnd, nowMin); m = toMin(`${addDays(ymdOf(m), 1)} 00:00`)) {
				workDates.add(ymdOf(m));
			}
		}
	}
	const hourTotals = new Array(24).fill(0);
	const hourDays = new Array(24).fill(0);
	for (const date of workDates) {
		const dayStart = toMin(`${date} 00:00`);
		for (let h = 0; h < 24; h += 1) {
			const mark = dayStart + h * 60 + 30;
			if (mark > nowMin) continue;
			hourDays[h] += 1;
			for (const presence of presenceByPerson) {
				if (presence.some(([a, b]) => a <= mark && mark < b)) hourTotals[h] += 1;
			}
		}
	}

	for (const { person, days } of results) {
		for (const d of days) {
			const bucket = daily[dailyIndex.get(d.date)];
			bucket.regularMinutes += d.regularMinutes;
			bucket.overMinutes += d.overMinutes;
			if (d.status === 'incomplete') bucket.incomplete += 1;
			else if (d.status === 'worked' || d.status === 'on_shift') bucket.people += 1;

			const problems = d.flags.filter((f) => ISSUE_FLAGS.has(f));
			if (problems.length) {
				issues.push({ employeeId: person.employeeId, name: person.name, pin: person.pin, date: d.date, flags: problems });
			}
		}
	}
	const hourly = hourTotals.map((total, hour) => ({
		hour,
		average: hourDays[hour] ? Math.round((total / hourDays[hour]) * 10) / 10 : 0,
		// Days that hour was counted over (shown in the tooltip).
		days: hourDays[hour],
	}));

	const employees = results.map(({ person, totals }) => ({
		employeeId: person.employeeId,
		deviceUserId: person.deviceUserId ?? null,
		deviceId: person.deviceId,
		pin: person.pin,
		name: person.name,
		position: person.position ?? null,
		branchId: person.branchId,
		active: person.active,
		totals,
	}));

	const totals = employees.reduce(
		(acc, e) => {
			acc.workedMinutes += e.totals.workedMinutes;
			acc.regularMinutes += e.totals.regularMinutes;
			acc.overMinutes += e.totals.overMinutes;
			acc.daysWorked += e.totals.daysWorked;
			acc.daysWithHours += e.totals.daysWithHours;
			acc.incompleteDays += e.totals.incompleteDays;
			return acc;
		},
		{ workedMinutes: 0, regularMinutes: 0, overMinutes: 0, daysWorked: 0, daysWithHours: 0, incompleteDays: 0 }
	);
	totals.averageMinutes = totals.daysWithHours ? Math.round(totals.workedMinutes / totals.daysWithHours) : 0;

	return {
		range: { start: startYmd, end: endYmd },
		now,
		today: summarizeToday(people, todayPunches, rulesFor, now),
		employees,
		daily,
		hourly,
		issues: issues.sort((a, b) => (a.date === b.date ? String(a.name).localeCompare(String(b.name)) : a.date < b.date ? 1 : -1)),
		totals,
	};
}

/** Live block: who is on shift right now, who came in today, and today's days to fix. */
function summarizeToday(people, punches, rulesFor, now) {
	const today = now.slice(0, 10);
	const yesterday = addDays(today, -1);
	const { byEmployee } = groupPunches(punches);
	const onShift = [];
	const counts = { cameIn: 0, needsFixing: 0 };
	for (const person of people.values()) {
		if (!person.active) continue;
		const { days } = computeAttendance({
			punches: byEmployee.get(person.employeeId) || [],
			rules: rulesFor(person.branchId),
			startYmd: yesterday,
			endYmd: today,
			now,
		});
		// A night shift that started yesterday can still be running.
		for (const d of days) {
			for (const shift of d.shifts) {
				if (shift.open) onShift.push({ employeeId: person.employeeId, name: person.name, pin: person.pin, since: shift.in });
			}
		}
		const t = days[1];
		if (t.shifts.some((s) => s.in)) counts.cameIn += 1;
		if (t.status === 'incomplete') counts.needsFixing += 1;
	}
	return { date: today, onShift: onShift.sort((a, b) => String(a.since).localeCompare(String(b.since))), ...counts };
}

/** One person's days (with their punches) for the timesheet. Null when not in scope. */
async function getTimesheet(branchIds, employeeId, startYmd, endYmd) {
	const people = await loadPeople(branchIds);
	const person = people.get(Number(employeeId));
	if (!person) return null;
	const now = String(await ZktecoModel.deviceNow());
	const punches = (await loadRange(branchIds, startYmd, endYmd)).filter((p) => Number(p.EMPLOYEE_ID) === person.employeeId);
	const rules = await AttendanceSettingsModel.getRules(person.branchId);
	const { days, totals } = computeAttendance({
		punches: punches.map((p) => ({ dt: p.PUNCH_DT, status: p.PUNCH_STATUS, ref: `${p.SOURCE}:${p.IDNo}` })),
		rules,
		startYmd,
		endYmd,
		now,
	});
	const details = new Map(
		punches.map((p) => [
			`${p.SOURCE}:${p.IDNo}`,
			{
				source: p.SOURCE,
				id: Number(p.IDNo),
				deviceId: Number(p.DEVICE_ID),
				pin: String(p.PIN),
				punchDt: p.PUNCH_DT,
				status: p.PUNCH_STATUS,
				originalPunchDt: p.ORIGINAL_PUNCH_DT,
				originalStatus: p.ORIGINAL_PUNCH_STATUS,
				isEdited: Boolean(Number(p.IS_EDITED)),
				reason: p.REASON,
				verifyType: p.VERIFY_TYPE,
			},
		])
	);
	return {
		employee: {
			employeeId: person.employeeId,
			deviceUserId: person.deviceUserId,
			deviceId: person.deviceId,
			pin: person.pin,
			name: person.name,
			position: person.position,
			branchId: person.branchId,
			active: person.active,
		},
		rules,
		now,
		days: days.map((d) => ({ ...publicDay(d), punches: d.punches.map((ref) => details.get(ref)).filter(Boolean) })),
		totals,
	};
}

module.exports = { getSummary, getTimesheet, loadPeople, checkRange, fullName };
