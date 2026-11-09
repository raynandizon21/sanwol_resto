// ============================================
// ATTENDANCE SERVICE
// ============================================
// File: services/attendanceService.js
// Description: Loads punches (zk_attendance_logs), people (employee rows on a device) and
// schedules (one entry per person per day, from the Schedules page), runs attendanceEngine per
// person, and shapes the results for the Attendance Logs summary, the Timesheet tab (everyone's
// days), one person's timesheet and the Schedules page. See docs/attendance.md.
// ============================================

const ZktecoModel = require('../models/zktecoModel');
const EmployeeModel = require('../models/employeeModel');
const ScheduleModel = require('../models/scheduleModel');
const { computeAttendance, addDays, ISSUE_FLAGS, toMin, emptyTotals, todayOf } = require('./attendanceEngine');

const MAX_RANGE_DAYS = 366;
// The Timesheet tab shows one column per day.
const MAX_TIMESHEETS_DAYS = 62;

const fullName = (profile, fallback) =>
	[profile?.FIRSTNAME, profile?.LASTNAME].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ') || fallback || null;

const dayCount = (startYmd, endYmd) => Math.round((toMin(`${endYmd} 00:00`) - toMin(`${startYmd} 00:00`)) / 1440) + 1;

/** Everyone who is or was on a device in scope, by employee IDNo. `active` = on the device now. */
async function loadPeople(branchIds) {
	const rows = await ZktecoModel.getPeople(branchIds);
	const profiles = new Map((await EmployeeModel.getProfilesByIds(rows.map((r) => r.IDNo))).map((p) => [Number(p.IDNo), p]));
	const people = new Map();
	for (const row of rows) {
		const id = Number(row.IDNo);
		const profile = profiles.get(id) || null;
		people.set(id, {
			employeeId: id,
			profile,
			deviceId: Number(row.ZK_DEVICE_ID),
			pin: String(row.ZK_PIN),
			active: Boolean(Number(row.ZK_ON_DEVICE)),
			branchId: profile?.BRANCH_ID ?? row.DEVICE_BRANCH_ID ?? null,
			name: fullName(profile, row.ZK_NAME),
			deviceName: row.ZK_NAME,
			position: profile?.DEPARTMENT || null,
			// Profile → "Exclude from schedules and attendance" (a system or IT account).
			excludeFromAttendance: Boolean(Number(profile?.EXCLUDE_FROM_ATTENDANCE)),
		});
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

function checkRange(startYmd, endYmd, maxDays = MAX_RANGE_DAYS) {
	if (startYmd > endYmd) return 'The start date must be on or before the end date';
	if (dayCount(startYmd, endYmd) > maxDays) return `Choose a range of at most ${maxDays} days`;
	return null;
}

// A day before and after the range, so shifts crossing its edges are complete.
const loadRange = (branchIds, startYmd, endYmd) =>
	ZktecoModel.getPunchesForAttendance(branchIds, `${addDays(startYmd, -1)} 00:00:00`, `${addDays(endYmd, 2)} 00:00:00`);

/** Drops the internal fields the API doesn't send. */
const publicDay = ({ punches, ...day }) => day;

/**
 * Attendance for everyone in scope over the range: everyone on the device, people removed from it
 * who punched in the range, and punches of User IDs that aren't on the device (so they aren't
 * silently lost). `rangePunches` comes from loadRange.
 */
async function computeEveryone(people, rangePunches, startYmd, endYmd, now) {
	const rangeGroups = groupPunches(rangePunches);
	const rosterMaps = await ScheduleModel.getDayMaps([...people.keys()], startYmd, endYmd);

	const inRange = (entries) => entries.some((e) => e.dt >= `${startYmd} 00:00:00` && e.dt < `${addDays(endYmd, 1)} 00:00:00`);
	const compute = (punches, person = null) =>
		computeAttendance({
			punches,
			startYmd,
			endYmd,
			now,
			roster: (person && rosterMaps.get(person.employeeId)) || new Map(),
			hired: person?.profile?.DATE_STARTED || null,
			separated: person?.profile?.DATE_SEPARATED || null,
		});

	const results = [];
	for (const person of people.values()) {
		// Excluded people (Profile) are never in attendance, whether on the device or removed.
		if (person.excludeFromAttendance) continue;
		const punches = rangeGroups.byEmployee.get(person.employeeId) || [];
		// Everyone on the device is listed; people removed from it only when they worked in the range.
		if (!person.active && !inRange(punches)) continue;
		results.push({ person, ...compute(punches, person) });
	}
	for (const u of rangeGroups.unknown.values()) {
		if (!inRange(u.punches)) continue;
		results.push({
			person: { employeeId: null, deviceId: u.deviceId, pin: u.pin, name: null, active: false, branchId: u.branchId },
			...compute(u.punches),
		});
	}
	return results;
}

/** The person fields the summary and the timesheets send (each day carries its own shift). */
const publicPerson = (person) => ({
	employeeId: person.employeeId,
	deviceId: person.deviceId,
	pin: person.pin,
	name: person.name,
	position: person.position ?? null,
	branchId: person.branchId,
	active: person.active,
});

/** Adds up per-person totals, key by key. */
function sumTotals(list) {
	const totals = emptyTotals();
	for (const t of list) for (const key of Object.keys(totals)) totals[key] += t[key] || 0;
	totals.averageMinutes = totals.daysWithHours ? Math.round(totals.workedMinutes / totals.daysWithHours) : 0;
	return totals;
}

/**
 * Summary for the Attendance Logs page: per-person totals for the range, problems to fix, and today
 * (the schedule against who actually punched), overall and per person.
 */
async function getSummary(branchIds, startYmd, endYmd) {
	const now = String(await ZktecoModel.deviceNow());
	const today = now.slice(0, 10);
	const people = await loadPeople(branchIds);
	const [rangePunches, todayPunches] = await Promise.all([
		loadRange(branchIds, startYmd, endYmd),
		loadRange(branchIds, addDays(today, -1), today),
	]);
	const results = await computeEveryone(people, rangePunches, startYmd, endYmd, now);
	const { counts, byPerson } = await summarizeToday(people, todayPunches, now);

	const issues = [];
	for (const { person, days } of results) {
		for (const d of days) {
			const problems = d.flags.filter((f) => ISSUE_FLAGS.has(f));
			if (problems.length) {
				issues.push({ employeeId: person.employeeId, name: person.name, pin: person.pin, date: d.date, flags: problems });
			}
		}
	}

	return {
		range: { start: startYmd, end: endYmd },
		now,
		today: { date: today, ...counts },
		employees: results.map(({ person, totals }) => ({
			...publicPerson(person),
			totals,
			today: byPerson.get(person.employeeId) ?? null,
		})),
		issues: issues.sort((a, b) => (a.date === b.date ? String(a.name).localeCompare(String(b.name)) : a.date < b.date ? 1 : -1)),
	};
}

/** Today for everyone on the device: each person's schedule against their punches, and the counts. */
async function summarizeToday(people, punches, now) {
	const today = now.slice(0, 10);
	const yesterday = addDays(today, -1);
	const { byEmployee } = groupPunches(punches);
	const rosterMaps = await ScheduleModel.getDayMaps([...people.keys()], yesterday, today);
	const byPerson = new Map();
	const counts = { scheduled: 0, inNow: 0, notInYet: 0, late: 0, needsFixing: 0 };
	for (const person of people.values()) {
		if (!person.active || person.excludeFromAttendance) continue;
		const { days } = computeAttendance({
			punches: byEmployee.get(person.employeeId) || [],
			startYmd: yesterday,
			endYmd: today,
			now,
			roster: rosterMaps.get(person.employeeId) || new Map(),
			hired: person.profile?.DATE_STARTED || null,
			separated: person.profile?.DATE_SEPARATED || null,
		});
		const status = todayOf(days, now);
		byPerson.set(person.employeeId, status);
		if (status.shift) counts.scheduled += 1;
		if (status.atWork) counts.inNow += 1;
		if (status.notInYet) counts.notInYet += 1;
		if (status.lateMinutes > 0) counts.late += 1;
		if (status.needsFixing) counts.needsFixing += 1;
	}
	return { counts, byPerson };
}

/**
 * Everyone's days for the Timesheet tab (a grid of people × days): each day's status, hours and
 * shifts, without the punches (one person's punches come from getTimesheet). At most
 * MAX_TIMESHEETS_DAYS days, one column each.
 */
async function getTimesheets(branchIds, startYmd, endYmd) {
	const now = String(await ZktecoModel.deviceNow());
	const people = await loadPeople(branchIds);
	const rangePunches = await loadRange(branchIds, startYmd, endYmd);
	const results = await computeEveryone(people, rangePunches, startYmd, endYmd, now);
	const employees = results.map(({ person, days, totals }) => ({
		...publicPerson(person),
		days: days.map(publicDay),
		totals,
	}));
	return {
		range: { start: startYmd, end: endYmd },
		now,
		employees,
		totals: sumTotals(employees.map((e) => e.totals)),
	};
}

/** One person's days (with their punches) for the timesheet. Null when not in scope. */
async function getTimesheet(branchIds, employeeId, startYmd, endYmd) {
	const people = await loadPeople(branchIds);
	const person = people.get(Number(employeeId));
	if (!person) return null;
	const now = String(await ZktecoModel.deviceNow());
	const punches = (await loadRange(branchIds, startYmd, endYmd)).filter((p) => Number(p.EMPLOYEE_ID) === person.employeeId);
	const rosterMaps = await ScheduleModel.getDayMaps([person.employeeId], startYmd, endYmd);
	const { days, totals } = computeAttendance({
		punches: punches.map((p) => ({ dt: p.PUNCH_DT, status: p.PUNCH_STATUS, ref: `${p.SOURCE}:${p.IDNo}` })),
		startYmd,
		endYmd,
		now,
		roster: rosterMaps.get(person.employeeId) || new Map(),
		hired: person.profile?.DATE_STARTED || null,
		separated: person.profile?.DATE_SEPARATED || null,
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
		employee: publicPerson(person),
		now,
		days: days.map((d) => ({ ...publicDay(d), punches: d.punches.map((ref) => details.get(ref)).filter(Boolean) })),
		totals,
	};
}

module.exports = { getSummary, getTimesheet, getTimesheets, loadPeople, checkRange, fullName, MAX_TIMESHEETS_DAYS };
