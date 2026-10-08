const MenuIngredientModel = require('../models/menuIngredientModel');
const ApiResponse = require('../utils/apiResponse');

class MenuIngredientController {
	static async getByMenuId(req, res) {
		try {
			const { menuId } = req.params;
			const rows = await MenuIngredientModel.getByMenuId(menuId);
			return ApiResponse.success(res, rows, 'Menu ingredients retrieved successfully');
		} catch (error) {
			console.error('[MenuIngredientController.getByMenuId]', error?.message || error);
			return ApiResponse.error(res, 'Failed to fetch menu ingredients', 500, error.message);
		}
	}

	static async getByIngredientId(req, res) {
		try {
			const { ingredientId } = req.params;
			const rows = await MenuIngredientModel.getByIngredientId(ingredientId);
			return ApiResponse.success(res, rows, 'Menus using ingredient retrieved successfully');
		} catch (error) {
			console.error('[MenuIngredientController.getByIngredientId]', error?.message || error);
			return ApiResponse.error(res, 'Failed to fetch menus', 500, error.message);
		}
	}

	static async create(req, res) {
		try {
			const payload = {
				MENU_ID: req.body.MENU_ID ?? req.body.menuId ?? null,
				INGREDIENT_ID: req.body.INGREDIENT_ID ?? req.body.ingredientId ?? null,
				QTY_PER_SERVE: req.body.QTY_PER_SERVE ?? req.body.qtyPerServe ?? 1,
				UNIT: req.body.UNIT ?? req.body.unit ?? 'pcs',
				ENCODED_BY: req.session?.user_id ?? req.user?.user_id ?? null,
			};
			if (!payload.MENU_ID || !payload.INGREDIENT_ID) {
				return ApiResponse.badRequest(res, 'Menu ID and Ingredient ID are required');
			}

			const id = await MenuIngredientModel.create(payload);
			return ApiResponse.success(res, { id }, 'Menu ingredient added successfully', 201);
		} catch (error) {
			console.error('[MenuIngredientController.create]', error?.message || error);
			return ApiResponse.error(res, 'Failed to add menu ingredient', 500, error.message);
		}
	}

	static async update(req, res) {
		try {
			const { id } = req.params;
			const payload = {
				QTY_PER_SERVE: req.body.QTY_PER_SERVE ?? req.body.qtyPerServe ?? null,
				UNIT: req.body.UNIT ?? req.body.unit ?? null,
				EDITED_BY: req.session?.user_id ?? req.user?.user_id ?? null,
			};
			const ok = await MenuIngredientModel.update(id, payload);
			if (!ok) return ApiResponse.notFound(res, 'Menu ingredient');
			return ApiResponse.success(res, null, 'Menu ingredient updated successfully');
		} catch (error) {
			console.error('[MenuIngredientController.update]', error?.message || error);
			return ApiResponse.error(res, 'Failed to update menu ingredient', 500, error.message);
		}
	}

	static async delete(req, res) {
		try {
			const { id } = req.params;
			const ok = await MenuIngredientModel.delete(id);
			if (!ok) return ApiResponse.notFound(res, 'Menu ingredient');
			return ApiResponse.success(res, null, 'Menu ingredient removed successfully');
		} catch (error) {
			console.error('[MenuIngredientController.delete]', error?.message || error);
			return ApiResponse.error(res, 'Failed to remove menu ingredient', 500, error.message);
		}
	}
}

module.exports = MenuIngredientController;
