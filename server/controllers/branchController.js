const BranchModel = require('../models/branchModel');
const UserBranchModel = require('../models/userBranchModel');
const AuditLogModel = require('../models/auditLogModel');
const UserModel = require('../models/userModel');
const BranchSidebarPermissionModel = require('../models/branchSidebarPermissionModel');
const ApiResponse = require('../utils/apiResponse');
const { SUBDIRS, publicUrl, safeDeletePublicFile } = require('../utils/uploadPaths');

function resolveBranchLogoPath(req) {
	if (!req.file) return null;
	return publicUrl(SUBDIRS.BRANCHES, req.file.filename);
}

async function deleteBranchLogoFile(logoPath) {
	await safeDeletePublicFile(logoPath, SUBDIRS.BRANCHES);
}

class BranchController {

	// Get all branches
	static async getAll(req, res) {
		try {
			const user_id = req.session?.user_id || req.user?.user_id;
			const userPermissions = req.session?.permissions || req.user?.permissions;
			
			let branches = [];
			
			// If admin, return all branches
			if (parseInt(userPermissions) === 1) {
				branches = await BranchModel.getAllActive();
			} else if (user_id) {
				// Regular users get only their assigned branches
				branches = await UserBranchModel.getBranchesByUserId(user_id);
			} else {
				// No user context, return all active branches
				branches = await BranchModel.getAllActive();
			}
			
			
			return ApiResponse.success(res, branches, 'Branches retrieved successfully');
		} catch (error) {
			console.error('Error fetching branches:', error);
			return ApiResponse.error(res, 'Failed to fetch branches', 500, error.message);
		}
	}

	// Options for dashboard branch switcher
	// - Admin (PERMISSIONS=1): can choose ALL or any branch
	// - Non-admin: only their single assigned branch
	static async getBranchOptions(req, res) {
		try {
			const user_id = req.session?.user_id;
			const perm = parseInt(req.session?.permissions);

			let branches = [];
			if (perm === 1) {
				branches = await BranchModel.getAllActive();
			} else {
				branches = await UserBranchModel.getBranchesByUserId(user_id);
			}

			const current = req.session?.branch_id ?? null;

			const options = [];
			if (perm === 1) {
				options.push({ value: 'ALL', label: 'ALL BRANCHES' });
			}

			(branches || []).forEach(b => {
				options.push({
					value: String(b.IDNo),
					label: `${b.BRANCH_NAME} (${b.BRANCH_CODE})`
				});
			});

			return ApiResponse.success(res, {
				permissions: perm,
				current: current === null ? 'ALL' : String(current),
				options
			}, 'Branch options retrieved successfully');
		} catch (error) {
			console.error('Error getting branch options:', error);
			return ApiResponse.error(res, 'Failed to get branch options', 500, error.message);
		}
	}

	// Set current branch filter for session
	static async setCurrentBranch(req, res) {
		try {
			const user_id = req.session?.user_id;
			const perm = parseInt(req.session?.permissions);
			const branch_id = req.body?.branch_id ?? req.body?.branchId ?? req.body?.BRANCH_ID;

			if (!branch_id) {
				return ApiResponse.badRequest(res, 'branch_id is required');
			}

			// Admin: allow ALL or specific branch
			if (perm === 1) {
				if (String(branch_id).toUpperCase() === 'ALL') {
					req.session.branch_id = null;
					req.session.branch_name = null;
					req.session.branch_code = null;
					return ApiResponse.success(res, { current: 'ALL' }, 'Branch set to ALL');
				}

				const bid = parseInt(branch_id);
				if (isNaN(bid)) {
					return ApiResponse.badRequest(res, 'Invalid branch_id');
				}

				const branch = await BranchModel.getById(bid);
				if (!branch) {
					return ApiResponse.notFound(res, 'Branch');
				}

				req.session.branch_id = bid;
				req.session.branch_name = branch.BRANCH_NAME;
				req.session.branch_code = branch.BRANCH_CODE;
				return ApiResponse.success(res, { current: String(bid) }, 'Branch set successfully');
			}

			// Non-admin: must stay on their single assigned branch
			const assigned = await UserBranchModel.getBranchesByUserId(user_id);
			const only = assigned?.[0];
			if (!only) {
				return ApiResponse.badRequest(res, 'No branch assigned to this account');
			}

			const onlyId = parseInt(only.IDNo);
			const bid = parseInt(branch_id);
			if (isNaN(bid) || bid !== onlyId) {
				return ApiResponse.forbidden(res, 'Non-admin users cannot switch branches');
			}

			req.session.branch_id = onlyId;
			req.session.branch_name = only.BRANCH_NAME;
			req.session.branch_code = only.BRANCH_CODE;
			return ApiResponse.success(res, { current: String(onlyId) }, 'Branch set successfully');
		} catch (error) {
			console.error('Error setting current branch:', error);
			return ApiResponse.error(res, 'Failed to set current branch', 500, error.message);
		}
	}

	// Get branch by ID
	static async getById(req, res) {
		try {
			const { id } = req.params;
			let branch = null;
			const branchIdInt = parseInt(id);
			if (!isNaN(branchIdInt)) {
				branch = await BranchModel.getById(branchIdInt);
			} else {
				branch = await BranchModel.getByCode(String(id || '').trim());
			}
			
			if (!branch) {
				return ApiResponse.notFound(res, 'Branch');
			}
			return ApiResponse.success(res, branch, 'Branch retrieved successfully');
		} catch (error) {
			console.error('Error fetching branch:', error);
			return ApiResponse.error(res, 'Failed to fetch branch', 500, error.message);
		}
	}


	// Create new branch
	static async create(req, res) {
		try {
			const body = req.body || {};
			const BRANCH_CODE = body.BRANCH_CODE != null ? String(body.BRANCH_CODE).trim() : '';
			const BRANCH_NAME = body.BRANCH_NAME != null ? String(body.BRANCH_NAME).trim() : '';
			const ADDRESS = body.ADDRESS != null ? String(body.ADDRESS).trim() : null;
			const PHONE = body.PHONE != null ? String(body.PHONE).trim() : null;

			if (!BRANCH_CODE) {
				return ApiResponse.badRequest(res, 'Branch code is required');
			}

			if (!BRANCH_NAME) {
				return ApiResponse.badRequest(res, 'Branch name is required');
			}

			const existing = await BranchModel.getByCode(BRANCH_CODE);
			if (existing) {
				return ApiResponse.error(res, 'Branch code already exists', 409);
			}

			const user_id = req.session?.user_id || req.user?.user_id;
			const MENU_CATEGORY_LEVEL = body.MENU_CATEGORY_LEVEL ?? body.menu_category_level;
			const BRANCH_LOGO = resolveBranchLogoPath(req);

			const branchId = await BranchModel.create({
				BRANCH_CODE,
				BRANCH_NAME,
				ADDRESS: ADDRESS || undefined,
				PHONE: PHONE || undefined,
				BRANCH_LOGO,
				MENU_CATEGORY_LEVEL,
			});

			try {
				await AuditLogModel.create({
					user_id: user_id || null,
					branch_id: branchId,
					action: 'CREATE',
					table_name: 'branches',
					record_id: branchId
				});
			} catch (auditErr) {
				console.error('Audit log create failed (branch create):', auditErr);
			}

			return ApiResponse.created(res, { id: branchId }, 'Branch created successfully');
		} catch (error) {
			console.error('Error creating branch:', error);
			return ApiResponse.error(res, 'Failed to create branch', 500, error.message);
		}
	}

	// Update branch
	static async update(req, res) {
		try {
			const { id } = req.params;
			const idNum = parseInt(id, 10);
			if (isNaN(idNum)) {
				return ApiResponse.badRequest(res, 'Invalid branch ID');
			}

			const body = req.body || {};
			const { BRANCH_CODE, BRANCH_NAME, ADDRESS, PHONE, MENU_CATEGORY_LEVEL, menu_category_level, BRANCH_LOGO } = body;
			const categoryLevel = MENU_CATEGORY_LEVEL ?? menu_category_level;

			if (!BRANCH_CODE || BRANCH_CODE.trim() === '') {
				return ApiResponse.badRequest(res, 'Branch code is required');
			}

			if (!BRANCH_NAME || BRANCH_NAME.trim() === '') {
				return ApiResponse.badRequest(res, 'Branch name is required');
			}

			const existing = await BranchModel.getByCode(BRANCH_CODE);
			if (existing && existing.IDNo !== idNum) {
				return ApiResponse.error(res, 'Branch code already exists', 409);
			}

			const existingBranch = await BranchModel.getById(idNum);
			if (!existingBranch) {
				return ApiResponse.notFound(res, 'Branch');
			}

			const user_id = req.session?.user_id || req.user?.user_id;
			const updateData = {
				BRANCH_CODE,
				BRANCH_NAME,
				ADDRESS,
				PHONE,
				MENU_CATEGORY_LEVEL: categoryLevel,
			};

			const uploadedLogo = resolveBranchLogoPath(req);
			if (uploadedLogo) {
				updateData.BRANCH_LOGO = uploadedLogo;
			} else if (BRANCH_LOGO !== undefined) {
				const keepExisting = BRANCH_LOGO != null && String(BRANCH_LOGO).trim() !== '';
				updateData.BRANCH_LOGO = keepExisting ? String(BRANCH_LOGO).trim() : null;
			}

			const updated = await BranchModel.update(idNum, updateData);

			if (!updated) {
				return ApiResponse.notFound(res, 'Branch');
			}

			if (uploadedLogo && existingBranch.BRANCH_LOGO && existingBranch.BRANCH_LOGO !== uploadedLogo) {
				await deleteBranchLogoFile(existingBranch.BRANCH_LOGO);
			}

			try {
				await AuditLogModel.create({
					user_id: user_id || null,
					branch_id: idNum,
					action: 'UPDATE',
					table_name: 'branches',
					record_id: idNum
				});
			} catch (auditErr) {
				console.error('Audit log create failed (branch update):', auditErr);
			}

			return ApiResponse.success(res, null, 'Branch updated successfully');
		} catch (error) {
			console.error('Error updating branch:', error);
			return ApiResponse.error(res, 'Failed to update branch', 500, error.message);
		}
	}

	// Delete branch
	static async delete(req, res) {
		try {
			const { id } = req.params;
			const idNum = parseInt(id, 10);
			if (isNaN(idNum)) {
				return ApiResponse.badRequest(res, 'Invalid branch ID');
			}

			const user_id = req.session?.user_id || req.user?.user_id;
			const deleted = await BranchModel.delete(idNum);

			if (!deleted) {
				return ApiResponse.notFound(res, 'Branch');
			}

			try {
				await AuditLogModel.create({
					user_id: user_id || null,
					branch_id: idNum,
					action: 'DELETE',
					table_name: 'branches',
					record_id: idNum
				});
			} catch (auditErr) {
				console.error('Audit log create failed (branch delete):', auditErr);
			}

			return ApiResponse.success(res, null, 'Branch deleted successfully');
		} catch (error) {
			console.error('Error deleting branch:', error);
			return ApiResponse.error(res, 'Failed to delete branch', 500, error.message);
		}
	}

	// Get branches for a user
	static async getBranchesByUser(req, res) {
		try {
			const { userId } = req.params;
			const branches = await UserBranchModel.getBranchesByUserId(userId);
			return ApiResponse.success(res, branches, 'User branches retrieved successfully');
		} catch (error) {
			console.error('Error fetching user branches:', error);
			return ApiResponse.error(res, 'Failed to fetch user branches', 500, error.message);
		}
	}

	// Get users for a branch
	static async getUsersByBranch(req, res) {
		try {
			const { branchId } = req.params;
			const users = await UserBranchModel.getUsersByBranchId(branchId);
			return ApiResponse.success(res, users, 'Branch users retrieved successfully');
		} catch (error) {
			console.error('Error fetching branch users:', error);
			return ApiResponse.error(res, 'Failed to fetch branch users', 500, error.message);
		}
	}

	// Assign user to branch
	static async assignUserToBranch(req, res) {
		try {
			const { userId, branchId } = req.body;
			const currentUserId = req.session.user_id || req.user?.user_id;

			if (!userId || !branchId) {
				return ApiResponse.badRequest(res, 'User ID and Branch ID are required');
			}

			// Enforce: non-admin users must have exactly ONE branch
			const targetPerm = await UserModel.getUserPermissions(userId);
			if (targetPerm == null) {
				return ApiResponse.notFound(res, 'User');
			}

			// For non-admin, replace existing assignment with this single branch
			if (parseInt(targetPerm) !== 1) {
				await UserBranchModel.setUserBranches(userId, [parseInt(branchId)]);
			} else {
				// Admin has ALL branches automatically; keep assignment optional
				await UserBranchModel.setUserBranches(userId, []);
			}

			// Log audit
			await AuditLogModel.create({
				user_id: currentUserId,
				branch_id: branchId,
				action: 'ASSIGN_USER',
				table_name: 'user_info',
				record_id: userId
			});

			return ApiResponse.success(res, null, 'User assigned to branch successfully');
		} catch (error) {
			console.error('Error assigning user to branch:', error);
			return ApiResponse.error(res, 'Failed to assign user to branch', 500, error.message);
		}
	}

	// Remove user from branch
	static async removeUserFromBranch(req, res) {
		try {
			const { userId, branchId } = req.body;
			const currentUserId = req.session.user_id || req.user?.user_id;

			if (!userId || !branchId) {
				return ApiResponse.badRequest(res, 'User ID and Branch ID are required');
			}

			await UserBranchModel.removeUserFromBranch(userId, branchId);

			// Log audit
			await AuditLogModel.create({
				user_id: currentUserId,
				branch_id: branchId,
				action: 'REMOVE_USER',
				table_name: 'user_info',
				record_id: userId
			});

			return ApiResponse.success(res, null, 'User removed from branch successfully');
		} catch (error) {
			console.error('Error removing user from branch:', error);
			return ApiResponse.error(res, 'Failed to remove user from branch', 500, error.message);
		}
	}

	// Set all branches for a user (replace existing)
	static async setUserBranches(req, res) {
		try {
			const { userId, branchIds } = req.body;
			const currentUserId = req.session.user_id || req.user?.user_id;

			if (!userId) {
				return ApiResponse.badRequest(res, 'User ID is required');
			}

			// Enforce: non-admin users must have exactly ONE branch
			const targetPerm = await UserModel.getUserPermissions(userId);
			if (targetPerm == null) {
				return ApiResponse.notFound(res, 'User');
			}

			const ids = Array.isArray(branchIds) ? branchIds.map(x => parseInt(x)).filter(x => !isNaN(x)) : [];

			if (parseInt(targetPerm) === 1) {
				// Admin has ALL branches automatically. We don't need to store assignments.
				await UserBranchModel.setUserBranches(userId, []);
				await AuditLogModel.create({
					user_id: currentUserId,
					action: 'SET_ADMIN_BRANCH_MODE_ALL',
					table_name: 'user_info',
					record_id: userId
				});
				return ApiResponse.success(res, { branches_assigned: 0 }, 'Admin has ALL branches automatically (no branch assignment needed).');
			}

			// Non-admin: must be exactly one
			if (ids.length !== 1) {
				return ApiResponse.badRequest(res, 'Non-admin user must be assigned exactly ONE branch.');
			}

			await UserBranchModel.setUserBranches(userId, ids);

			// Log audit
			await AuditLogModel.create({
				user_id: currentUserId,
				action: 'SET_USER_BRANCHES',
				table_name: 'user_info',
				record_id: userId
			});

			return ApiResponse.success(res, { branches_assigned: branchIds.length }, 'User branches updated successfully');
		} catch (error) {
			console.error('Error setting user branches:', error);
			return ApiResponse.error(res, 'Failed to set user branches', 500, error.message);
		}
	}

	// Get sidebar permissions for one branch (for sidebar filtering)
	static async getSidebarPermissions(req, res) {
		try {
			const { id } = req.params;
			const branchId = parseInt(id, 10);
			if (isNaN(branchId)) {
				return ApiResponse.badRequest(res, 'Invalid branch id');
			}
			const features = await BranchSidebarPermissionModel.getByBranchId(branchId);
			return ApiResponse.success(res, { features }, 'Sidebar permissions retrieved');
		} catch (error) {
			console.error('Error fetching sidebar permissions:', error);
			return ApiResponse.error(res, 'Failed to fetch sidebar permissions', 500, error.message);
		}
	}

	// Get all branches' sidebar permissions (admin only, for User Access page)
	static async getAllSidebarPermissions(req, res) {
		try {
			const branches = await BranchModel.getAllActive();
			const branchIds = (branches || []).map((b) => b.IDNo);
			const permissions = await BranchSidebarPermissionModel.getAllByBranches(branchIds);
			return ApiResponse.success(res, { permissions, branches }, 'All sidebar permissions retrieved');
		} catch (error) {
			console.error('Error fetching all sidebar permissions:', error);
			return ApiResponse.error(res, 'Failed to fetch sidebar permissions', 500, error.message);
		}
	}

	// Update sidebar permissions for all branches (admin only)
	static async updateSidebarPermissions(req, res) {
		try {
			const { permissions } = req.body || {};
			if (!permissions || typeof permissions !== 'object') {
				return ApiResponse.badRequest(res, 'permissions object is required');
			}
			await BranchSidebarPermissionModel.setAll(permissions);
			return ApiResponse.success(res, null, 'Sidebar permissions updated successfully');
		} catch (error) {
			console.error('Error updating sidebar permissions:', error);
			return ApiResponse.error(res, 'Failed to update sidebar permissions', 500, error.message);
		}
	}
}

module.exports = BranchController;
