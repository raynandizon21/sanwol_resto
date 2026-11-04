// ============================================
// EMPLOYEE LINK SERVICE
// ============================================
// File: services/employeeLinkService.js
// Description: Every MB160 device user gets an app-only profile (sanwol_resto.employee),
// linked by zkteco.device_users.EMPLOYEE_ID. All rows of one person (a removed row and the
// row they were added again as, READDED_AS_ID) share one profile. The DBs are never joined:
// rows are read from one and written to the other here. See docs/attendance.md.
// ============================================

const ZktecoModel = require('../models/zktecoModel');
const EmployeeModel = require('../models/employeeModel');

// Linking runs one pass at a time in this process, so two page loads can't create two
// profiles for the same new user. (A second API process would need a DB lock instead.)
let queue = Promise.resolve();

/**
 * Links every device user in scope that has no profile yet: to the profile of their earlier
 * rows when they were added again, otherwise to a new profile, filled from the Add employee
 * form when they were added in the app (PENDING_PROFILE_JSON), else named as on the device.
 * Details from Add employee for someone who already has a profile ("Add again") update it.
 * Cheap when everyone is linked and nothing is pending (one read).
 */
function ensureEmployeeLinks(branchIds) {
	const run = queue.then(() => linkPass(branchIds));
	queue = run.catch(() => {});
	return run;
}

/** { fields, userId } from PENDING_PROFILE_JSON, or null when missing or unreadable. */
function readPending(json) {
	if (!json) return null;
	try {
		const data = JSON.parse(json);
		if (!data || typeof data.fields !== 'object' || data.fields === null) return null;
		return { fields: data.fields, userId: data.userId ?? null };
	} catch {
		return null;
	}
}

async function linkPass(branchIds) {
	const rows = await ZktecoModel.getUserRowsForLinking(branchIds);
	if (!rows.some((r) => r.EMPLOYEE_ID == null || r.PENDING_PROFILE_JSON)) return;

	const byId = new Map(rows.map((r) => [Number(r.IDNo), r]));
	// A person = their latest row (READDED_AS_ID always names it) plus the rows pointing at it.
	const persons = new Map();
	for (const row of rows) {
		const personId = Number(row.READDED_AS_ID || row.IDNo);
		if (!persons.has(personId)) persons.set(personId, []);
		persons.get(personId).push(row);
	}

	for (const [personId, members] of persons) {
		const unlinked = members.filter((r) => r.EMPLOYEE_ID == null).map((r) => Number(r.IDNo));
		// Details from Add employee: only the newest row's count (an add is always the newest row);
		// any older ones are stale and are cleared with it.
		const pendingRows = members.filter((r) => r.PENDING_PROFILE_JSON).sort((a, b) => Number(b.IDNo) - Number(a.IDNo));
		const pending = readPending(pendingRows[0]?.PENDING_PROFILE_JSON);
		if (unlinked.length === 0 && !pendingRows.length) continue;

		// Prefer the profile of the latest row, then of the most recent earlier row.
		const linked = members
			.filter((r) => r.EMPLOYEE_ID != null)
			.sort((a, b) => (Number(a.IDNo) === personId ? -1 : Number(b.IDNo) === personId ? 1 : Number(b.IDNo) - Number(a.IDNo)));
		if (linked.length) {
			const employeeId = Number(linked[0].EMPLOYEE_ID);
			if (unlinked.length) await ZktecoModel.linkUnlinkedRows(unlinked, employeeId);
			if (pending) await EmployeeModel.updateProfile(employeeId, pending.fields, pending.userId);
		} else {
			const latest = byId.get(personId) || members[0];
			const employeeId = await EmployeeModel.createForDeviceUser({
				name: latest.NAME,
				branchId: latest.BRANCH_ID,
				fields: pending?.fields ?? null,
				userId: pending?.userId ?? null,
			});
			const count = await ZktecoModel.linkUnlinkedRows(unlinked, employeeId);
			// Someone else linked them first (another process): drop the unused profile, and leave
			// the details for the next pass to apply to theirs.
			if (count === 0) {
				await EmployeeModel.deactivateProfile(employeeId, null);
				continue;
			}
		}
		for (const row of pendingRows) await ZktecoModel.clearPendingProfile(Number(row.IDNo), row.PENDING_PROFILE_JSON);
	}
}

/**
 * Profiles that no active device user points at (people removed from the device), in scope.
 * Used to link someone added back directly on the device to their old profile.
 */
async function getFormerEmployees(branchIds) {
	const rows = await ZktecoModel.getUserRowsForLinking(branchIds);
	const current = new Set(rows.filter((r) => Number(r.ACTIVE) && r.EMPLOYEE_ID != null).map((r) => Number(r.EMPLOYEE_ID)));
	const former = new Set(rows.filter((r) => !Number(r.ACTIVE) && r.EMPLOYEE_ID != null).map((r) => Number(r.EMPLOYEE_ID)));
	current.forEach((id) => former.delete(id));
	const profiles = await EmployeeModel.getProfilesByIds([...former]);
	return profiles.filter((p) => Number(p.ACTIVE));
}

/**
 * Moves a device user (and their earlier rows) onto `employeeId`. Their previous profile is
 * soft-deleted when nothing points at it any more.
 */
async function relinkDeviceUser(user, employeeId, userId) {
	const personId = Number(user.READDED_AS_ID || user.IDNo);
	const previous = user.EMPLOYEE_ID != null ? Number(user.EMPLOYEE_ID) : null;
	await ZktecoModel.relinkPerson(personId, employeeId);
	if (previous && previous !== employeeId && (await ZktecoModel.countRowsForEmployee(previous)) === 0) {
		await EmployeeModel.deactivateProfile(previous, userId);
	}
}

module.exports = { ensureEmployeeLinks, getFormerEmployees, relinkDeviceUser };
