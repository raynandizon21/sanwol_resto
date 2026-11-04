// ============================================
// ZKTECO HTTP HELPERS
// ============================================
// File: utils/zktecoHttp.js
// Description: Request helpers shared by the ZKTeco (MB160) and attendance controllers:
// branch scope, CRUD permissions, and name lookups across the two databases.
// ============================================

const pool = require('../config/db');
const RoleCrudPermissionModel = require('../models/roleCrudPermissionModel');
const ApiResponse = require('./apiResponse');
const { YMD, isValidWallClock, isValidYmd } = require('./wallClock');

const REASON_MAX = 255;

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/**
 * Branch scope from ?branch_id=. Returns null for "every device" (admin with
 * All Branches, which also includes devices not yet assigned to a branch), or
 * an array of branch IDs. Requires getUserBranches to have run.
 */
function resolveBranchScope(req) {
	const raw = String(req.query.branch_id || '').trim();
	const isAdmin = Number(req.user?.permissions) === 1;
	const allowed = (req.userBranches || []).map(Number);

	if (!raw || raw === 'all') return isAdmin ? null : allowed;

	const id = parseInt(raw, 10);
	if (!id) throw new HttpError(400, 'Invalid branch_id');
	if (!isAdmin && !allowed.includes(id)) throw new HttpError(403, 'Access denied to this branch');
	return [id];
}

/** True when `branchId` is inside the scope from resolveBranchScope (null = everything). */
const inScope = (scope, branchId) => scope == null || scope.includes(Number(branchId));

/** Device rows live in another DB, so branch names are looked up here instead of joined. */
async function attachBranchNames(rows) {
	const ids = [...new Set(rows.map((r) => r.BRANCH_ID).filter((id) => id != null))];
	if (ids.length === 0) return rows.map((r) => ({ ...r, BRANCH_NAME: null }));
	const [branches] = await pool.query(
		`SELECT IDNo, BRANCH_NAME FROM branches WHERE IDNo IN (${ids.map(() => '?').join(',')})`,
		ids
	);
	const names = new Map(branches.map((b) => [Number(b.IDNo), b.BRANCH_NAME]));
	return rows.map((r) => ({ ...r, BRANCH_NAME: r.BRANCH_ID != null ? names.get(Number(r.BRANCH_ID)) ?? null : null }));
}

/** sanwol_resto users live in the other DB, so names are looked up here instead of joined. */
async function attachUserNames(rows, idKey, nameKey) {
	const ids = [...new Set(rows.map((r) => r[idKey]).filter((id) => id != null))];
	if (ids.length === 0) return rows.map((r) => ({ ...r, [nameKey]: null }));
	const [users] = await pool.query(
		`SELECT IDNo, FIRSTNAME, LASTNAME, USERNAME FROM user_info WHERE IDNo IN (${ids.map(() => '?').join(',')})`,
		ids
	);
	const names = new Map(
		users.map((u) => [Number(u.IDNo), [u.FIRSTNAME, u.LASTNAME].filter(Boolean).join(' ') || u.USERNAME || null])
	);
	return rows.map((r) => ({ ...r, [nameKey]: r[idKey] != null ? names.get(Number(r[idKey])) ?? null : null }));
}

/**
 * Admins always; other roles need one of `actions` for the module in
 * User Access → CRUD permissions (create = Add, update = Edit, delete = Delete).
 */
async function hasCrudPermission(req, moduleKey, actions) {
	const roleId = Number(req.user?.permissions);
	if (roleId === 1) return true;
	if (!roleId) return false;
	const perms = (await RoleCrudPermissionModel.getByRoleId(roleId))[moduleKey] || {};
	return actions.some((action) => Boolean(perms[action]));
}

const handleError = (res, error, label) => {
	if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
	console.error(`Error fetching ${label}:`, error);
	return ApiResponse.error(res, `Failed to fetch ${label}`, 500, error.message);
};

const cleanReason = (value) => {
	const reason = String(value ?? '').replace(/\s+/g, ' ').trim();
	return reason ? reason.slice(0, REASON_MAX) : null;
};

module.exports = {
	YMD,
	HttpError,
	resolveBranchScope,
	inScope,
	attachBranchNames,
	attachUserNames,
	hasCrudPermission,
	handleError,
	cleanReason,
	isValidWallClock,
	isValidYmd,
};
