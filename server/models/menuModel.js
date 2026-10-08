// ============================================
// MENU MODEL
// ============================================
// File: models/menuModel.js
// Description: Database operations for menus
// ============================================

const pool = require('../config/db');
const CategoryModel = require('./categoryModel');

class MenuModel {
	// Get all active menus with category name
	static async getAll(branchId = null, options = {}) {
		const includeDescription = options.includeDescription !== false;
		let query = `
			SELECT 
				m.IDNo,
				m.BRANCH_ID,
				b.BRANCH_NAME,
				b.BRANCH_CODE,
				b.BRANCH_NAME AS BRANCH_LABEL,
				m.CATEGORY_ID,
				c.CAT_NAME AS CATEGORY_NAME,
				m.MENU_NAME,
				${includeDescription ? 'm.MENU_DESCRIPTION,' : ''}
				m.MENU_IMG,
				m.MENU_PRICE,
				m.IS_AVAILABLE,
				m.ACTIVE,
				m.ENCODED_BY,
				m.ENCODED_DT,
				m.EDITED_BY,
				m.EDITED_DT
			FROM menu m
			LEFT JOIN categories c ON m.CATEGORY_ID = c.IDNo
			LEFT JOIN branches b ON b.IDNo = m.BRANCH_ID
			WHERE m.ACTIVE = 1
		`;

		const params = [];
		// Apply branch filter only when branchId is explicitly provided (can be 0)
		if (branchId !== null && branchId !== undefined) {
			query += ` AND m.BRANCH_ID = ?`;
			params.push(branchId);
		}

		query += ` ORDER BY m.IDNo ASC`;

		const [rows] = await pool.execute(query, params);
		return rows.map((row) => ({
			...row,
			INVENTORY_TRACKED: 0,
			INVENTORY_AVAILABLE: 1,
			INVENTORY_STOCK: null,
			EFFECTIVE_AVAILABLE: Number(row.IS_AVAILABLE) === 1 ? 1 : 0,
		}));
	}

	// Get menu by ID
	static async getById(id) {
		const query = `
			SELECT * FROM menu 
			WHERE IDNo = ? AND ACTIVE = 1
		`;
		const [rows] = await pool.execute(query, [id]);
		return rows[0];
	}

	// Create new menu
	static async create(data) {
		const {
			BRANCH_ID,
			CATEGORY_ID,
			MENU_NAME,
			MENU_DESCRIPTION,
			MENU_IMG,
			MENU_PRICE,
			IS_AVAILABLE,
			user_id
		} = data;
		const currentDate = new Date();

		const query = `
			INSERT INTO menu (
				BRANCH_ID,
				CATEGORY_ID,
				MENU_NAME,
				MENU_DESCRIPTION,
				MENU_IMG,
				MENU_PRICE,
				IS_AVAILABLE,
				ACTIVE,
				ENCODED_BY,
				ENCODED_DT
			) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
		`;

		const [result] = await pool.execute(query, [
			BRANCH_ID,
			CATEGORY_ID || null,
			MENU_NAME,
			MENU_DESCRIPTION || null,
			MENU_IMG || null,
			MENU_PRICE || 0,
			IS_AVAILABLE || 0,
			user_id,
			currentDate
		]);

		return result.insertId;
	}

	// Update menu
	static async update(id, data) {
		const {
			CATEGORY_ID,
			MENU_NAME,
			MENU_DESCRIPTION,
			MENU_IMG,
			MENU_PRICE,
			IS_AVAILABLE,
			user_id
		} = data;
		const currentDate = new Date();

		const query = `
			UPDATE menu SET
				CATEGORY_ID = ?,
				MENU_NAME = ?,
				MENU_DESCRIPTION = ?,
				MENU_IMG = ?,
				MENU_PRICE = ?,
				IS_AVAILABLE = ?,
				EDITED_BY = ?,
				EDITED_DT = ?
			WHERE IDNo = ? AND ACTIVE = 1
		`;

		const [result] = await pool.execute(query, [
			CATEGORY_ID || null,
			MENU_NAME,
			MENU_DESCRIPTION || null,
			MENU_IMG || null,
			MENU_PRICE || 0,
			IS_AVAILABLE || 0,
			user_id,
			currentDate,
			id
		]);

		return result.affectedRows > 0;
	}

	// Soft delete menu
	static async delete(id, user_id) {
		const currentDate = new Date();

		const query = `
			UPDATE menu SET
				ACTIVE = 0,
				EDITED_BY = ?,
				EDITED_DT = ?
			WHERE IDNo = ?
		`;

		const [result] = await pool.execute(query, [user_id, currentDate, id]);
		return result.affectedRows > 0;
	}

	// Get all categories for dropdown, optionally filtered by branch
	static async getCategories(branchId = null) {
		await CategoryModel.ensureSchema();
		let query = `
			SELECT IDNo, CAT_NAME AS CATEGORY_NAME, PARENT_CAT_ID
			FROM categories 
			WHERE ACTIVE = 1 
		`;

		const params = [];

		// Apply branch filter only when branchId is explicitly provided (can be 0)
		if (branchId !== null && branchId !== undefined) {
			query += ` AND BRANCH_ID = ?`;
			params.push(branchId);
		}

		query += ` ORDER BY CAT_NAME`;

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	// Get menus filtered by category (for API)
	static async getByCategory(categoryId = null, branchId = null) {
		let query = `
			SELECT 
				m.IDNo,
				m.BRANCH_ID,
				m.CATEGORY_ID,
				c.CAT_NAME AS CATEGORY_NAME,
				m.MENU_NAME,
				m.MENU_DESCRIPTION,
				m.MENU_IMG,
				m.MENU_PRICE,
				m.IS_AVAILABLE,
				COALESCE(sales.total_qty, 0) AS total_qty,
				COALESCE(sales.total_revenue, 0) AS total_revenue
			FROM menu m
			LEFT JOIN categories c ON m.CATEGORY_ID = c.IDNo
			LEFT JOIN (
				SELECT 
					oi.MENU_ID,
					SUM(oi.QTY) as total_qty,
					SUM(oi.LINE_TOTAL) as total_revenue
				FROM order_items oi
				GROUP BY oi.MENU_ID
			) sales ON sales.MENU_ID = m.IDNo
			WHERE m.ACTIVE = 1 AND m.IS_AVAILABLE = 1
		`;
		
		const params = [];
		if (categoryId) {
			query += ` AND m.CATEGORY_ID = ?`;
			params.push(categoryId);
		}

		// Apply branch filter only when branchId is explicitly provided (can be 0)
		if (branchId !== null && branchId !== undefined) {
			query += ` AND m.BRANCH_ID = ?`;
			params.push(branchId);
		}
		
		query += ` ORDER BY total_qty DESC, total_revenue DESC, m.IDNo ASC`;
		
		const [rows] = await pool.execute(query, params);
		return rows.map((row) => ({
			...row,
			INVENTORY_TRACKED: 0,
			INVENTORY_AVAILABLE: 1,
			INVENTORY_STOCK: null,
			EFFECTIVE_AVAILABLE: Number(row.IS_AVAILABLE) === 1 ? 1 : 0,
		}));
	}
}

module.exports = MenuModel;

