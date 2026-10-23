// ============================================
// MENU MODEL
// ============================================
// File: models/menuModel.js
// Description: Database operations for menus
// ============================================

const pool = require('../config/db');
const CategoryModel = require('./categoryModel');
const { isWithinHours, storeNowMinutes } = require('../utils/menuSchedule');

class MenuModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	/** AVAILABLE_FROM/TO = daily hours the item shows (e.g. breakfast). */
	static async ensureSchema() {
		if (MenuModel._schemaReady) return;
		if (MenuModel._schemaPromise) return MenuModel._schemaPromise;

		MenuModel._schemaPromise = (async () => {
			for (const [col, sql] of [
				['AVAILABLE_FROM', 'ALTER TABLE menu ADD COLUMN AVAILABLE_FROM TIME NULL'],
				['AVAILABLE_TO', 'ALTER TABLE menu ADD COLUMN AVAILABLE_TO TIME NULL'],
			]) {
				try {
					await pool.execute(sql);
				} catch (e) {
					const msg = String(e?.message || '');
					if (!/Duplicate column name/i.test(msg)) {
						console.warn(`[MenuModel] ensureSchema ${col}:`, msg);
					}
				}
			}
			MenuModel._schemaReady = true;
			MenuModel._schemaPromise = null;
		})().catch((err) => {
			MenuModel._schemaPromise = null;
			throw err;
		});

		return MenuModel._schemaPromise;
	}

	/**
	 * Whether a row from getByCategory shows on the tablets right now: the
	 * item, its category and that category's main category must each be
	 * switched on and inside their available hours.
	 */
	static isVisibleNow(row, now = storeNowMinutes()) {
		const on = (v) => v === null || v === undefined || Number(v) === 1;
		return Number(row.IS_AVAILABLE) === 1
			&& isWithinHours(row.AVAILABLE_FROM, row.AVAILABLE_TO, now)
			&& on(row.CAT_AVAILABLE)
			&& isWithinHours(row.CAT_FROM, row.CAT_TO, now)
			&& on(row.PCAT_AVAILABLE)
			&& isWithinHours(row.PCAT_FROM, row.PCAT_TO, now);
	}

	// Get all active menus with category name
	static async getAll(branchId = null, options = {}) {
		await MenuModel.ensureSchema();
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
				c.CAT_NAME_KO AS CATEGORY_NAME_KO,
				m.MENU_NAME,
				m.MENU_NAME_KO,
				${includeDescription ? 'm.MENU_DESCRIPTION, m.MENU_DESCRIPTION_KO,' : ''}
				m.MENU_IMG,
				m.MENU_PRICE,
				m.IS_AVAILABLE,
				m.AVAILABLE_FROM,
				m.AVAILABLE_TO,
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
			MENU_NAME_KO,
			MENU_DESCRIPTION,
			MENU_DESCRIPTION_KO,
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
				MENU_NAME_KO,
				MENU_DESCRIPTION,
				MENU_DESCRIPTION_KO,
				MENU_IMG,
				MENU_PRICE,
				IS_AVAILABLE,
				ACTIVE,
				ENCODED_BY,
				ENCODED_DT
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
		`;

		const [result] = await pool.execute(query, [
			BRANCH_ID,
			CATEGORY_ID || null,
			MENU_NAME,
			MENU_NAME_KO || null,
			MENU_DESCRIPTION || null,
			MENU_DESCRIPTION_KO || null,
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
			MENU_NAME_KO,
			MENU_DESCRIPTION,
			MENU_DESCRIPTION_KO,
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
				MENU_NAME_KO = ?,
				MENU_DESCRIPTION = ?,
				MENU_DESCRIPTION_KO = ?,
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
			MENU_NAME_KO || null,
			MENU_DESCRIPTION || null,
			MENU_DESCRIPTION_KO || null,
			MENU_IMG || null,
			MENU_PRICE || 0,
			IS_AVAILABLE || 0,
			user_id,
			currentDate,
			id
		]);

		return result.affectedRows > 0;
	}

	/** Show (true) or hide (false) a menu item on the tablets. */
	static async setAvailability(id, isAvailable, user_id) {
		const [result] = await pool.execute(
			'UPDATE menu SET IS_AVAILABLE = ?, EDITED_BY = ?, EDITED_DT = ? WHERE IDNo = ? AND ACTIVE = 1',
			[isAvailable ? 1 : 0, user_id ?? null, new Date(), id]
		);
		return result.affectedRows > 0;
	}

	/** Daily hours the item shows ('HH:MM:00' or null = all day). */
	static async setHours(id, from, to) {
		await MenuModel.ensureSchema();
		const [result] = await pool.execute(
			'UPDATE menu SET AVAILABLE_FROM = ?, AVAILABLE_TO = ? WHERE IDNo = ? AND ACTIVE = 1',
			[from ?? null, to ?? null, id]
		);
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
			SELECT IDNo, CAT_NAME AS CATEGORY_NAME, CAT_NAME_KO AS CATEGORY_NAME_KO, PARENT_CAT_ID,
				IS_AVAILABLE, AVAILABLE_FROM, AVAILABLE_TO
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

	// Get menus filtered by category (for API). Leaves out what is switched
	// off or outside its available hours (item, category or main category),
	// unless includeUnavailable (kitchen slip names, availability screen).
	static async getByCategory(categoryId = null, branchId = null, { includeUnavailable = false } = {}) {
		await CategoryModel.ensureSchema();
		await MenuModel.ensureSchema();
		let query = `
			SELECT 
				m.IDNo,
				m.BRANCH_ID,
				m.CATEGORY_ID,
				c.CAT_NAME AS CATEGORY_NAME,
				c.CAT_NAME_KO AS CATEGORY_NAME_KO,
				m.MENU_NAME,
				m.MENU_NAME_KO,
				m.MENU_DESCRIPTION,
				m.MENU_DESCRIPTION_KO,
				m.MENU_IMG,
				m.MENU_PRICE,
				m.IS_AVAILABLE,
				m.AVAILABLE_FROM,
				m.AVAILABLE_TO,
				c.PARENT_CAT_ID AS CATEGORY_PARENT_ID,
				c.IS_AVAILABLE AS CAT_AVAILABLE,
				c.AVAILABLE_FROM AS CAT_FROM,
				c.AVAILABLE_TO AS CAT_TO,
				pc.IS_AVAILABLE AS PCAT_AVAILABLE,
				pc.AVAILABLE_FROM AS PCAT_FROM,
				pc.AVAILABLE_TO AS PCAT_TO,
				COALESCE(sales.total_qty, 0) AS total_qty,
				COALESCE(sales.total_revenue, 0) AS total_revenue
			FROM menu m
			LEFT JOIN categories c ON m.CATEGORY_ID = c.IDNo
			LEFT JOIN categories pc ON pc.IDNo = c.PARENT_CAT_ID
			LEFT JOIN (
				SELECT 
					oi.MENU_ID,
					SUM(oi.QTY) as total_qty,
					SUM(oi.LINE_TOTAL) as total_revenue
				FROM order_items oi
				GROUP BY oi.MENU_ID
			) sales ON sales.MENU_ID = m.IDNo
			WHERE m.ACTIVE = 1
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
		
		const [allRows] = await pool.execute(query, params);
		const now = storeNowMinutes();
		const rows = includeUnavailable ? allRows : allRows.filter((row) => MenuModel.isVisibleNow(row, now));
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

