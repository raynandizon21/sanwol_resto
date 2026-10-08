// ============================================
// OPERATION CATEGORY CONTROLLER
// ============================================
// File: controllers/operationCategoryController.js
// Description: Handles operation_category-related business logic
// ============================================

const OperationCategoryModel = require('../models/operationCategoryModel');
const ApiResponse = require('../utils/apiResponse');

class OperationCategoryController {
	static _resolveBranchId(req) {
		// Prefer explicit query/body so admin can view any branch; session is fallback for branch users
		const raw =
			req.query?.branch_id ||
			req.body?.branch_id ||
			req.body?.BRANCH_ID ||
			req.session?.branch_id ||
			req.user?.branch_id ||
			null;

		if (raw === null || raw === undefined || raw === '' || raw === 'all') return null;
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : null;
	}

	static async getAll(req, res) {
		try {
			const branchId = OperationCategoryController._resolveBranchId(req);
			const rows = await OperationCategoryModel.getAll(branchId);
			return ApiResponse.success(res, rows, 'Operation categories retrieved successfully');
		} catch (error) {
			console.error('[OPERATION CATEGORY] getAll error:', error);
			return ApiResponse.error(res, 'Failed to fetch operation categories', 500, error.message);
		}
	}

		static async create(req, res) {
		try {
			const branchId = OperationCategoryController._resolveBranchId(req);
			const { NAME, DESCRIPTION, ACTIVE, STATE } = req.body || {};
			if (!NAME || String(NAME).trim() === '') {
				return ApiResponse.badRequest(res, 'NAME is required');
			}
			const id = await OperationCategoryModel.create({
				BRANCH_ID: branchId,
				NAME: String(NAME).trim(),
				DESCRIPTION: DESCRIPTION != null ? String(DESCRIPTION).trim() : null,
				STATE: STATE === 1 || STATE === true ? 1 : 0,
				ACTIVE: ACTIVE !== false && ACTIVE !== 0,
				ENCODED_BY: req.user?.user_id ?? null,
			});
			return ApiResponse.created(res, { id }, 'Operation category created');
		} catch (error) {
			console.error('[OPERATION CATEGORY] create error:', error);
			return ApiResponse.error(res, 'Failed to create operation category', 500, error.message);
		}
	}

		static async update(req, res) {
		try {
			const id = req.params.id;
			if (!id) return ApiResponse.badRequest(res, 'ID is required');
			const { NAME, DESCRIPTION, STATE } = req.body || {};
			if (!NAME || String(NAME).trim() === '') {
				return ApiResponse.badRequest(res, 'NAME is required');
			}
			const updated = await OperationCategoryModel.update(id, {
				NAME: String(NAME).trim(),
				DESCRIPTION: DESCRIPTION != null ? String(DESCRIPTION).trim() : null,
				STATE: STATE === 1 || STATE === true ? 1 : 0,
				EDITED_BY: req.user?.user_id ?? null,
			});
			if (!updated) return ApiResponse.notFound(res, 'Operation category');
			return ApiResponse.success(res, null, 'Operation category updated');
		} catch (error) {
			console.error('[OPERATION CATEGORY] update error:', error);
			return ApiResponse.error(res, 'Failed to update operation category', 500, error.message);
		}
	}

	static async delete(req, res) {
		try {
			const id = req.params.id;
			if (!id) return ApiResponse.badRequest(res, 'ID is required');
			const deleted = await OperationCategoryModel.setInactive(id);
			if (!deleted) return ApiResponse.notFound(res, 'Operation category');
			return ApiResponse.success(res, null, 'Operation category deleted');
		} catch (error) {
			console.error('[OPERATION CATEGORY] delete error:', error);
			return ApiResponse.error(res, 'Failed to delete operation category', 500, error.message);
		}
	}
}

module.exports = OperationCategoryController;

