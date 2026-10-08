const pool = require('../config/db');
const BranchModel = require('./branchModel');

class MasterCategoryModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (MasterCategoryModel._schemaReady) return;
		if (MasterCategoryModel._schemaPromise) return MasterCategoryModel._schemaPromise;

		MasterCategoryModel._schemaPromise = (async () => {
			await BranchModel.ensureSchema();

			await pool.execute(`
				CREATE TABLE IF NOT EXISTS master_categories (
					IDNo INT AUTO_INCREMENT PRIMARY KEY,
					BRANCH_ID INT NOT NULL,
					CATEGORY_NAME VARCHAR(120) NOT NULL,
					CATEGORY_TYPE VARCHAR(80) NOT NULL DEFAULT 'Inventory',
					DESCRIPTION TEXT NULL,
					ICON VARCHAR(80) NULL,
					ACTIVE TINYINT(1) NOT NULL DEFAULT 1,
					ENCODED_BY INT NULL,
					ENCODED_DT DATETIME DEFAULT CURRENT_TIMESTAMP,
					EDITED_BY INT NULL,
					EDITED_DT DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
					INDEX idx_master_categories_branch (BRANCH_ID),
					INDEX idx_master_categories_active (ACTIVE),
					INDEX idx_master_categories_type (CATEGORY_TYPE),
					CONSTRAINT fk_master_categories_branch
						FOREIGN KEY (BRANCH_ID) REFERENCES branches(IDNo)
						ON UPDATE CASCADE ON DELETE RESTRICT
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
			`);

			// Migration: add IS_MANUAL_STOCK for manual stock adjustment (e.g. seasonings)
			try {
				const [has] = await pool.execute(
					`SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
					 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_categories' AND COLUMN_NAME = 'IS_MANUAL_STOCK' LIMIT 1`
				);
				if (!has.length) {
					await pool.execute(`ALTER TABLE master_categories ADD COLUMN IS_MANUAL_STOCK TINYINT(1) NOT NULL DEFAULT 0 AFTER ICON`);
					console.log('[MasterCategoryModel] Added IS_MANUAL_STOCK to master_categories');
				}
			} catch (migErr) {
				console.warn('[MasterCategoryModel] IS_MANUAL_STOCK migration skipped:', migErr?.message);
			}

			MasterCategoryModel._schemaReady = true;
			MasterCategoryModel._schemaPromise = null;
		})().catch((error) => {
			MasterCategoryModel._schemaPromise = null;
			throw error;
		});

		return MasterCategoryModel._schemaPromise;
	}

	static async getAll(branchId = null, categoryType = 'Inventory') {
		try {
			await MasterCategoryModel.ensureSchema();
		} catch (schemaErr) {
			console.warn('[MasterCategoryModel.getAll] ensureSchema failed:', schemaErr?.message);
			// Table may already exist; continue with query
		}
		const isInventoryOnly = categoryType === 'Inventory' || (categoryType && String(categoryType).trim().toLowerCase() === 'inventory');
		let query;
		const params = [];

		if (isInventoryOnly) {
			// Inventory page categories:
			// 1) linked to operation_category.STATE = 1 (inventory type), OR
			// 2) already used by active inventory stock for this branch
			// Semi-join (not correlated EXISTS) so cost stays stable as inventory grows.
			query = `
				SELECT
					mc.IDNo,
					mc.BRANCH_ID,
					mc.OP_CAT_ID,
					mc.CATEGORY_NAME,
					COALESCE(mc.CATEGORY_TYPE, 'Inventory') AS CATEGORY_TYPE,
					mc.DESCRIPTION,
					mc.ICON,
					COALESCE(mc.IS_MANUAL_STOCK, 0) AS IS_MANUAL_STOCK,
					mc.ACTIVE,
					mc.ENCODED_BY,
					mc.ENCODED_DT,
					mc.EDITED_BY,
					mc.EDITED_DT
				FROM master_categories mc
				LEFT JOIN operation_category oc
					ON oc.IDNo = mc.OP_CAT_ID
					AND oc.ACTIVE = 1
				LEFT JOIN (
					SELECT DISTINCT i.MASTER_CAT_ID AS cat_id
					FROM inventory inv
					INNER JOIN ingredients i
						ON i.IDNo = inv.INGREDIENT_ID
					   AND i.ACTIVE = 1
					WHERE inv.ACTIVE = 1
					  AND i.MASTER_CAT_ID IS NOT NULL
					  ${branchId !== null && branchId !== undefined ? 'AND inv.BRANCH_ID = ?' : ''}
				) used ON used.cat_id = mc.IDNo
				WHERE mc.ACTIVE = 1
				  AND (oc.STATE = 1 OR used.cat_id IS NOT NULL)
			`;
			if (branchId !== null && branchId !== undefined) {
				params.push(branchId);
				query += ` AND mc.BRANCH_ID = ?`;
				params.push(branchId);
			}
		} else {
			query = `
				SELECT
					IDNo,
					BRANCH_ID,
					OP_CAT_ID,
					CATEGORY_NAME,
					CATEGORY_TYPE,
					DESCRIPTION,
					ICON,
					COALESCE(IS_MANUAL_STOCK, 0) AS IS_MANUAL_STOCK,
					ACTIVE,
					ENCODED_BY,
					ENCODED_DT,
					EDITED_BY,
					EDITED_DT
				FROM master_categories
				WHERE ACTIVE = 1
			`;
			if (branchId !== null && branchId !== undefined) {
				query += ` AND BRANCH_ID = ?`;
				params.push(branchId);
			}
			if (categoryType !== null && categoryType !== undefined && String(categoryType).trim() !== '') {
				query += ` AND CATEGORY_TYPE = ?`;
				params.push(String(categoryType).trim());
			}
		}

		query += isInventoryOnly ? ` ORDER BY mc.IDNo DESC` : ` ORDER BY IDNo DESC`;
		try {
			const [rows] = await pool.execute(query, params);
			return rows;
		} catch (selectErr) {
			// If JOIN/STATE fails (operation_category missing or no STATE column), fall back to simple query
			if (selectErr.message && (selectErr.message.includes('Unknown column') || selectErr.message.includes("doesn't exist") || selectErr.message.includes('STATE'))) {
				const fallbackParams = [];
				let fallbackQuery = `SELECT * FROM master_categories WHERE ACTIVE = 1`;
				if (branchId !== null && branchId !== undefined) {
					fallbackQuery += ` AND BRANCH_ID = ?`;
					fallbackParams.push(branchId);
				}
				// No CATEGORY_TYPE filter - only scope=all uses categoryType for non-inventory requests
				if (!isInventoryOnly && categoryType !== null && categoryType !== undefined && String(categoryType).trim() !== '') {
					fallbackQuery += ` AND CATEGORY_TYPE = ?`;
					fallbackParams.push(String(categoryType).trim());
				}
				fallbackQuery += ` ORDER BY IDNo DESC`;
				const [fallbackRows] = await pool.execute(fallbackQuery, fallbackParams);
				return fallbackRows;
			}
			throw selectErr;
		}
	}

	static async getById(id) {
		await MasterCategoryModel.ensureSchema();
		try {
		const [rows] = await pool.execute(
			`SELECT mc.* FROM master_categories mc
			 WHERE mc.IDNo = ? AND mc.ACTIVE = 1`,
			[id]
		);
			return rows[0] || null;
		} catch (err) {
			if (err.message && (err.message.includes('Unknown column') || err.message.includes("doesn't exist") || err.message.includes('STATE'))) {
				const [rows] = await pool.execute(`SELECT * FROM master_categories WHERE IDNo = ? AND ACTIVE = 1`, [id]);
				return rows[0] || null;
			}
			throw err;
		}
	}

	/** Returns true if master category is inventory type (operation_category.STATE = 1) */
	static async isInventoryCategory(masterCategoryId) {
		await MasterCategoryModel.ensureSchema();
		try {
			const [rows] = await pool.execute(
				`SELECT oc.STATE FROM master_categories mc
				 INNER JOIN operation_category oc ON oc.IDNo = mc.OP_CAT_ID AND oc.ACTIVE = 1
				 WHERE mc.IDNo = ? AND mc.ACTIVE = 1 LIMIT 1`,
				[Number(masterCategoryId)]
			);
			return rows[0]?.STATE === 1;
		} catch (_) {
			return false;
		}
	}

	static async getByIdForBranch(branchId, id) {
		await MasterCategoryModel.ensureSchema();
		const [rows] = await pool.execute(
			`
			SELECT
				IDNo,
				BRANCH_ID,
				CATEGORY_NAME,
				CATEGORY_TYPE,
				DESCRIPTION,
				ICON,
				ACTIVE
			FROM master_categories
			WHERE ACTIVE = 1
				AND BRANCH_ID = ?
				AND IDNo = ?
			LIMIT 1
			`,
			[Number(branchId), Number(id)]
		);
		return rows[0] || null;
	}

	static async getByTypeAndName(branchId, categoryType, categoryName) {
		await MasterCategoryModel.ensureSchema();
		const [rows] = await pool.execute(
			`
			SELECT
				IDNo,
				BRANCH_ID,
				CATEGORY_NAME,
				CATEGORY_TYPE,
				DESCRIPTION,
				ICON,
				ACTIVE
			FROM master_categories
			WHERE ACTIVE = 1
				AND BRANCH_ID = ?
				AND CATEGORY_TYPE = ?
				AND CATEGORY_NAME = ?
			LIMIT 1
			`,
			[Number(branchId), String(categoryType), String(categoryName)]
		);
		return rows[0] || null;
	}

	static async create(data) {
		await MasterCategoryModel.ensureSchema();
		const currentDate = new Date();
		const opCatId = data.OP_CAT_ID !== undefined && data.OP_CAT_ID !== null && data.OP_CAT_ID !== ''
			? Number(data.OP_CAT_ID)
			: null;
		const isManualStock = data.IS_MANUAL_STOCK !== undefined && data.IS_MANUAL_STOCK !== null
			? (Number(data.IS_MANUAL_STOCK) ? 1 : 0)
			: 0;
		const values = [
			Number(data.BRANCH_ID),
			String(data.CATEGORY_NAME).trim(),
			String(data.CATEGORY_TYPE || 'Inventory'),
			data.DESCRIPTION || null,
			data.ICON || null,
			data.user_id || null,
			currentDate,
		];
		try {
			const [result] = await pool.execute(
				`INSERT INTO master_categories (
					BRANCH_ID,
					CATEGORY_NAME,
					CATEGORY_TYPE,
					DESCRIPTION,
					ICON,
					IS_MANUAL_STOCK,
					ACTIVE,
					ENCODED_BY,
					ENCODED_DT,
					OP_CAT_ID
				) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
				[...values.slice(0, 5), isManualStock, values[5], values[6], opCatId]
			);
			return result.insertId;
		} catch (err) {
			const msg = String(err.message || '');
			if (msg.includes('IDNo') && msg.includes('default')) {
				const [rows] = await pool.execute(
					`SELECT COALESCE(MAX(IDNo), 0) + 1 AS nextId FROM master_categories`
				);
				const nextId = Number(rows[0]?.nextId ?? rows[0]?.nextid ?? 1) || 1;
				await pool.execute(
					`INSERT INTO master_categories (
						IDNo,
						BRANCH_ID,
						CATEGORY_NAME,
						CATEGORY_TYPE,
						DESCRIPTION,
						ICON,
						IS_MANUAL_STOCK,
						ACTIVE,
						ENCODED_BY,
						ENCODED_DT,
						OP_CAT_ID
					) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
					[nextId, ...values.slice(0, 5), isManualStock, values[5], values[6], opCatId]
				);
				return nextId;
			}
			// Column OP_CAT_ID might not exist on older schemas; try without it
			if (msg.includes('Unknown column') && (msg.includes('OP_CAT_ID') || msg.includes('IS_MANUAL_STOCK'))) {
				const [result] = await pool.execute(
					`INSERT INTO master_categories (
						BRANCH_ID,
						CATEGORY_NAME,
						CATEGORY_TYPE,
						DESCRIPTION,
						ICON,
						ACTIVE,
						ENCODED_BY,
						ENCODED_DT
					) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
					values
				);
				return result.insertId;
			}
			throw err;
		}
	}

	static async update(id, data) {
		await MasterCategoryModel.ensureSchema();
		const currentDate = new Date();
		const opCatId = data.OP_CAT_ID !== undefined && data.OP_CAT_ID !== null && data.OP_CAT_ID !== ''
			? Number(data.OP_CAT_ID)
			: null;
		const isManualStock = data.IS_MANUAL_STOCK !== undefined && data.IS_MANUAL_STOCK !== null
			? (Number(data.IS_MANUAL_STOCK) ? 1 : 0)
			: 0;
		const [result] = await pool.execute(
			`UPDATE master_categories
			SET CATEGORY_NAME = ?,
				CATEGORY_TYPE = ?,
				DESCRIPTION = ?,
				ICON = ?,
				IS_MANUAL_STOCK = ?,
				OP_CAT_ID = ?,
				EDITED_BY = ?,
				EDITED_DT = ?
			WHERE IDNo = ? AND ACTIVE = 1`,
			[
				String(data.CATEGORY_NAME).trim(),
				String(data.CATEGORY_TYPE || 'Inventory'),
				data.DESCRIPTION || null,
				data.ICON || null,
				isManualStock,
				opCatId,
				data.user_id || null,
				currentDate,
				id,
			]
		);
		return result.affectedRows > 0;
	}

	static async delete(id, userId = null) {
		await MasterCategoryModel.ensureSchema();
		const currentDate = new Date();
		const [result] = await pool.execute(
			`UPDATE master_categories
			SET ACTIVE = 0, EDITED_BY = ?, EDITED_DT = ?
			WHERE IDNo = ? AND ACTIVE = 1`,
			[userId, currentDate, id]
		);
		return result.affectedRows > 0;
	}
}

module.exports = MasterCategoryModel;
