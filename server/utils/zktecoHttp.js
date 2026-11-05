// ============================================
// ZKTECO HTTP HELPERS
// ============================================
// File: utils/zktecoHttp.js
// Description: Request helpers shared by the ZKTeco (MB160) and attendance controllers:
// branch scope, CRUD permissions, reasons.
// ============================================

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
	hasCrudPermission,
	handleError,
	cleanReason,
	isValidWallClock,
	isValidYmd,
};
