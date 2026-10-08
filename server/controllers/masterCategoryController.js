const MasterCategoryModel = require('../models/masterCategoryModel');
const ApiResponse = require('../utils/apiResponse');

class MasterCategoryController {
	static _resolveBranchId(req) {
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

	static _resolvePayload(req) {
		const rawOpCatId = req.body.OP_CAT_ID ?? req.body.opCategoryId ?? req.body.op_cat_id ?? null;
		const OP_CAT_ID = rawOpCatId !== null && rawOpCatId !== undefined && rawOpCatId !== ''
			? Number(rawOpCatId)
			: null;
		const rawManual = req.body.IS_MANUAL_STOCK ?? req.body.isManualStock ?? req.body.is_manual_stock ?? null;
		const IS_MANUAL_STOCK = rawManual !== null && rawManual !== undefined
			? (Boolean(rawManual) || Number(rawManual) ? 1 : 0)
			: 0;
		return {
			CATEGORY_NAME: req.body.CATEGORY_NAME || req.body.name || '',
			CATEGORY_TYPE: req.body.CATEGORY_TYPE || req.body.categoryType || 'Inventory',
			DESCRIPTION: req.body.DESCRIPTION || req.body.description || null,
			ICON: req.body.ICON || req.body.icon || null,
			OP_CAT_ID: Number.isFinite(OP_CAT_ID) ? OP_CAT_ID : null,
			IS_MANUAL_STOCK,
		};
	}

	static async getAll(req, res) {
		try {
			const branchId = MasterCategoryController._resolveBranchId(req);
			const scope = String(req.query?.scope || '').trim().toLowerCase();
			const requestedType = String(req.query?.category_type || '').trim();
			let categoryType = requestedType || 'Inventory';
			if (scope === 'all' || requestedType.toLowerCase() === 'all') {
				categoryType = null;
			}

			const rows = await MasterCategoryModel.getAll(branchId, categoryType);
			return ApiResponse.success(res, rows, 'Inventory categories retrieved successfully');
		} catch (error) {
			console.error('[MasterCategoryController.getAll]', error?.message || error);
			return ApiResponse.error(res, 'Failed to fetch inventory categories', 500, error.message);
		}
	}

	static async getById(req, res) {
		try {
			const { id } = req.params;
			const row = await MasterCategoryModel.getById(id);
			if (!row) return ApiResponse.notFound(res, 'Inventory category');
			return ApiResponse.success(res, row, 'Inventory category retrieved successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to fetch inventory category', 500, error.message);
		}
	}

	static async create(req, res) {
		try {
			const payload = MasterCategoryController._resolvePayload(req);
			if (!payload.CATEGORY_NAME || String(payload.CATEGORY_NAME).trim() === '') {
				return ApiResponse.badRequest(res, 'Category name is required');
			}

			const branchId = MasterCategoryController._resolveBranchId(req);
			if (!branchId) return ApiResponse.badRequest(res, 'Branch ID is required');

			const userId = req.session?.user_id || req.user?.user_id || null;
			const id = await MasterCategoryModel.create({
				BRANCH_ID: branchId,
				CATEGORY_NAME: payload.CATEGORY_NAME,
				CATEGORY_TYPE: payload.CATEGORY_TYPE,
				DESCRIPTION: payload.DESCRIPTION,
				ICON: payload.ICON,
				OP_CAT_ID: payload.OP_CAT_ID ?? null,
				IS_MANUAL_STOCK: payload.IS_MANUAL_STOCK ?? 0,
				user_id: userId,
			});

			return ApiResponse.created(res, { id }, 'Inventory category created successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to create inventory category', 500, error.message);
		}
	}

	static async update(req, res) {
		try {
			const { id } = req.params;
			const payload = MasterCategoryController._resolvePayload(req);
			if (!payload.CATEGORY_NAME || String(payload.CATEGORY_NAME).trim() === '') {
				return ApiResponse.badRequest(res, 'Category name is required');
			}

			const userId = req.session?.user_id || req.user?.user_id || null;
			const ok = await MasterCategoryModel.update(id, {
				CATEGORY_NAME: payload.CATEGORY_NAME,
				CATEGORY_TYPE: payload.CATEGORY_TYPE,
				DESCRIPTION: payload.DESCRIPTION,
				ICON: payload.ICON,
				OP_CAT_ID: payload.OP_CAT_ID ?? null,
				IS_MANUAL_STOCK: payload.IS_MANUAL_STOCK ?? 0,
				user_id: userId,
			});

			if (!ok) return ApiResponse.notFound(res, 'Inventory category');

			return ApiResponse.success(res, null, 'Inventory category updated successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to update inventory category', 500, error.message);
		}
	}

	static async delete(req, res) {
		try {
			const { id } = req.params;
			const userId = req.session?.user_id || req.user?.user_id || null;
			const ok = await MasterCategoryModel.delete(id, userId);
			if (!ok) return ApiResponse.notFound(res, 'Inventory category');
			return ApiResponse.success(res, null, 'Inventory category deleted successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to delete inventory category', 500, error.message);
		}
	}
}

module.exports = MasterCategoryController;
