const IngredientModel = require('../models/ingredientModel');
const ApiResponse = require('../utils/apiResponse');

class IngredientController {
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

	static async getAll(req, res) {
		try {
			const branchId = IngredientController._resolveBranchId(req);
			const categoryId = req.query?.category_id ?? req.query?.categoryId ?? null;
			const rows = await IngredientModel.getAll(branchId, categoryId);
			return ApiResponse.success(res, rows, 'Ingredients retrieved successfully');
		} catch (error) {
			console.error('[IngredientController.getAll]', error?.message || error);
			return ApiResponse.error(res, 'Failed to fetch ingredients', 500, error.message);
		}
	}

	static async getById(req, res) {
		try {
			const { id } = req.params;
			const row = await IngredientModel.getById(id);
			if (!row) return ApiResponse.notFound(res, 'Ingredient');
			return ApiResponse.success(res, row, 'Ingredient retrieved successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to fetch ingredient', 500, error.message);
		}
	}

	static async create(req, res) {
		try {
			const branchId = IngredientController._resolveBranchId(req);
			if (!branchId) return ApiResponse.badRequest(res, 'Branch ID is required');

			const payload = {
				BRANCH_ID: branchId,
				NAME: req.body.NAME ?? req.body.name ?? '',
				MASTER_CAT_ID: req.body.MASTER_CAT_ID ?? req.body.CATEGORY_ID ?? req.body.categoryId ?? null,
				UNIT: req.body.UNIT ?? req.body.unit ?? 'pcs',
				ENCODED_BY: req.session?.user_id ?? req.user?.user_id ?? null,
			};
			if (!payload.NAME || String(payload.NAME).trim() === '') {
				return ApiResponse.badRequest(res, 'Ingredient name is required');
			}

			const id = await IngredientModel.create(payload);
			return ApiResponse.success(res, { id }, 'Ingredient created successfully', 201);
		} catch (error) {
			console.error('[IngredientController.create]', error?.message || error);
			return ApiResponse.error(res, 'Failed to create ingredient', 500, error.message);
		}
	}

	static async update(req, res) {
		try {
			const { id } = req.params;
			const payload = {
				NAME: req.body.NAME ?? req.body.name ?? null,
				MASTER_CAT_ID: req.body.MASTER_CAT_ID ?? req.body.CATEGORY_ID ?? req.body.categoryId ?? null,
				UNIT: req.body.UNIT ?? req.body.unit ?? null,
				EDITED_BY: req.session?.user_id ?? req.user?.user_id ?? null,
			};
			const ok = await IngredientModel.update(id, payload);
			if (!ok) return ApiResponse.notFound(res, 'Ingredient');
			return ApiResponse.success(res, null, 'Ingredient updated successfully');
		} catch (error) {
			console.error('[IngredientController.update]', error?.message || error);
			return ApiResponse.error(res, 'Failed to update ingredient', 500, error.message);
		}
	}

	static async delete(req, res) {
		try {
			const { id } = req.params;
			const ok = await IngredientModel.setInactive(id);
			if (!ok) return ApiResponse.notFound(res, 'Ingredient');
			return ApiResponse.success(res, null, 'Ingredient deleted successfully');
		} catch (error) {
			console.error('[IngredientController.delete]', error?.message || error);
			return ApiResponse.error(res, 'Failed to delete ingredient', 500, error.message);
		}
	}

	static async syncFromExpenses(req, res) {
		try {
			await IngredientModel.syncFromExpenses();
			return ApiResponse.success(res, null, 'Ingredients synced from expenses successfully');
		} catch (error) {
			console.error('[IngredientController.syncFromExpenses]', error?.message || error);
			return ApiResponse.error(res, 'Failed to sync ingredients', 500, error.message);
		}
	}
}

module.exports = IngredientController;
