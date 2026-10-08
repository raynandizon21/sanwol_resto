const InventoryModel = require('../models/inventoryModel');
const ApiResponse = require('../utils/apiResponse');

class InventoryController {
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
		return {
			ITEM_NAME: req.body.ITEM_NAME || req.body.name || '',
			MASTER_CAT_ID: req.body.MASTER_CAT_ID ?? req.body.CATEGORY_ID ?? req.body.categoryId ?? null,
			CATEGORY_NAME: req.body.CATEGORY_NAME || req.body.category || null,
			STOCK_QTY: req.body.STOCK_QTY ?? req.body.stock ?? 0,
			UNIT: req.body.UNIT || req.body.unit || 'pcs',
			UNIT_COST: req.body.UNIT_COST ?? req.body.unitCost ?? 0,
			REORDER_LEVEL: req.body.REORDER_LEVEL ?? req.body.reorderLevel ?? 0,
			STATUS_FLAG: req.body.STATUS_FLAG || req.body.status || 'In Stock',
		};
	}

	static async getCategoryMetrics(req, res) {
		try {
			const branchId = InventoryController._resolveBranchId(req);
			if (!branchId) return ApiResponse.badRequest(res, 'Branch ID is required');
			const metrics = await InventoryModel.getCategoryMetrics(branchId);
			return ApiResponse.success(res, metrics, 'Inventory category metrics retrieved successfully');
		} catch (error) {
			console.error('[InventoryController.getCategoryMetrics]', error?.message || error);
			return ApiResponse.error(res, 'Failed to fetch inventory category metrics', 500, error.message);
		}
	}

	static async getAll(req, res) {
		try {
			const branchId = InventoryController._resolveBranchId(req);
			const categoryId = req.query?.category_id ?? req.query?.categoryId ?? null;
			const rows = await InventoryModel.getAll(branchId, categoryId);
			return ApiResponse.success(res, rows, 'Inventory items retrieved successfully');
		} catch (error) {
			console.error('[InventoryController.getAll] Error:', error?.message, error?.stack);
			return ApiResponse.error(res, error?.message || 'Failed to fetch inventory items', 500, error?.stack);
		}
	}

	static async getById(req, res) {
		try {
			const { id } = req.params;
			const row = await InventoryModel.getById(id);
			if (!row) return ApiResponse.notFound(res, 'Inventory item');
			return ApiResponse.success(res, row, 'Inventory item retrieved successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to fetch inventory item', 500, error.message);
		}
	}

	static async create(req, res) {
		try {
			const payload = InventoryController._resolvePayload(req);
			if (!payload.ITEM_NAME || String(payload.ITEM_NAME).trim() === '') {
				return ApiResponse.badRequest(res, 'Item name is required');
			}

			const branchId = InventoryController._resolveBranchId(req);
			if (!branchId) return ApiResponse.badRequest(res, 'Branch ID is required');

			const userId = req.session?.user_id || req.user?.user_id || null;
			const id = await InventoryModel.create({
				BRANCH_ID: branchId,
				...payload,
				user_id: userId,
			});

			return ApiResponse.created(res, { id }, 'Inventory item created successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to create inventory item', 500, error.message);
		}
	}

	static async update(req, res) {
		try {
			const { id } = req.params;
			const payload = InventoryController._resolvePayload(req);
			if (!payload.ITEM_NAME || String(payload.ITEM_NAME).trim() === '') {
				return ApiResponse.badRequest(res, 'Item name is required');
			}

			const userId = req.session?.user_id || req.user?.user_id || null;
			const ok = await InventoryModel.update(id, {
				...payload,
				user_id: userId,
			});
			if (!ok) return ApiResponse.notFound(res, 'Inventory item');
			return ApiResponse.success(res, null, 'Inventory item updated successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to update inventory item', 500, error.message);
		}
	}

	static async delete(req, res) {
		try {
			const { id } = req.params;
			const userId = req.session?.user_id || req.user?.user_id || null;
			const ok = await InventoryModel.delete(id, userId);
			if (!ok) return ApiResponse.notFound(res, 'Inventory item');
			return ApiResponse.success(res, null, 'Inventory item deleted successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to delete inventory item', 500, error.message);
		}
	}

	/**
	 * Manual stock adjustment (add/deduct) for items not in menu_ingredients (e.g. seasonings).
	 * Body: { ingredientId, branchId, qty, type: 'add'|'deduct' }
	 */
	static async adjustStock(req, res) {
		try {
			const ingredientId = req.body?.ingredientId ?? req.body?.INGREDIENT_ID ?? null;
			const branchId = InventoryController._resolveBranchId(req) ?? req.body?.branchId ?? req.body?.BRANCH_ID ?? null;
			const qty = Number(req.body?.qty ?? req.body?.QTY ?? 0);
			const type = String(req.body?.type ?? req.body?.TYPE ?? 'add').toLowerCase();

			if (!ingredientId || !branchId) {
				return ApiResponse.badRequest(res, 'ingredientId and branchId are required');
			}
			if (!Number.isFinite(qty) || qty <= 0) {
				return ApiResponse.badRequest(res, 'qty must be a positive number');
			}
			if (type !== 'add' && type !== 'deduct') {
				return ApiResponse.badRequest(res, 'type must be "add" or "deduct"');
			}

			const userId = req.session?.user_id || req.user?.user_id || null;

			if (type === 'add') {
				const ok = await InventoryModel.addStock(Number(branchId), Number(ingredientId), qty, userId);
				if (!ok) return ApiResponse.badRequest(res, 'Failed to add stock');
			} else {
				const ok = await InventoryModel.deductStock(Number(branchId), Number(ingredientId), qty, userId);
				if (!ok) return ApiResponse.badRequest(res, 'Insufficient stock or item not found');
			}

			return ApiResponse.success(res, null, 'Stock adjusted successfully');
		} catch (error) {
			console.error('[InventoryController.adjustStock] Error:', error?.message);
			return ApiResponse.error(res, error?.message || 'Failed to adjust stock', 500, error?.stack);
		}
	}

	static async updateStockByExpenseId(req, res) {
		try {
			const { expenseId } = req.params;
			const stockQty = req.body?.stockQty ?? req.body?.STOCK_QTY ?? req.body?.qty ?? 0;
			const branchId = InventoryController._resolveBranchId(req);
			const addToExisting = Boolean(req.body?.addToExisting ?? req.body?.add_to_existing ?? false);
			const unit = req.body?.unit ?? req.body?.UNIT ?? null;
			const ok = await InventoryModel.updateStockByExpenseId(expenseId, stockQty, branchId, addToExisting, unit);
			if (!ok) return ApiResponse.badRequest(res, 'Expense not found or not an inventory category');
			return ApiResponse.success(res, null, 'Inventory stock updated successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to update inventory stock', 500, error.message);
		}
	}
}

module.exports = InventoryController;
