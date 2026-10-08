const pool = require('../config/db');
const IngredientModel = require('./ingredientModel');
const MasterCategoryModel = require('./masterCategoryModel');

class InventoryModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (InventoryModel._schemaReady) return;
		if (InventoryModel._schemaPromise) return InventoryModel._schemaPromise;

		InventoryModel._schemaPromise = (async () => {
			await IngredientModel.ensureSchema();
			await MasterCategoryModel.ensureSchema();

			await pool.execute(`
				CREATE TABLE IF NOT EXISTS inventory (
					IDNo INT AUTO_INCREMENT PRIMARY KEY,
					BRANCH_ID INT NOT NULL,
					INGREDIENT_ID INT NULL,
					STOCK_QTY DECIMAL(12,3) NOT NULL DEFAULT 0,
					STATUS_FLAG VARCHAR(20) NOT NULL DEFAULT 'In Stock',
					ACTIVE TINYINT(1) NOT NULL DEFAULT 1,
					ENCODED_BY INT NULL,
					ENCODED_DT DATETIME DEFAULT CURRENT_TIMESTAMP,
					EDITED_BY INT NULL,
					EDITED_DT DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
					INDEX idx_inventory_branch (BRANCH_ID),
					INDEX idx_inventory_ingredient (INGREDIENT_ID),
					INDEX idx_inventory_active (ACTIVE)
				)
			`);

			// Normalize STOCK_QTY type/scale across existing databases
			try {
				await pool.execute(`ALTER TABLE inventory MODIFY COLUMN STOCK_QTY DECIMAL(12,3) NOT NULL DEFAULT 0`);
			} catch (alterErr) {
				console.warn('[InventoryModel] STOCK_QTY type normalization skipped:', alterErr.message);
			}

			InventoryModel._schemaReady = true;
			InventoryModel._schemaPromise = null;
		})().catch((error) => {
			InventoryModel._schemaPromise = null;
			throw error;
		});

		return InventoryModel._schemaPromise;
	}

	static async getAll(branchId = null, categoryId = null) {
		await InventoryModel.ensureSchema();
		const params = [];
		let invWhere = 'WHERE ACTIVE = 1 AND INGREDIENT_ID IS NOT NULL';
		if (branchId != null && branchId !== undefined) {
			invWhere += ' AND BRANCH_ID = ?';
			params.push(branchId);
		}
		let where = 'WHERE ing.ACTIVE = 1';
		if (branchId != null && branchId !== undefined) {
			where += ' AND ing.BRANCH_ID = ?';
			params.push(branchId);
		}
		if (categoryId != null && categoryId !== undefined && String(categoryId).trim() !== '') {
			where += ' AND ing.MASTER_CAT_ID = ?';
			params.push(Number(categoryId) || categoryId);
		}
		const query = `
			SELECT
				COALESCE(agg.FIRST_ID, ing.IDNo) AS IDNo,
				ing.IDNo AS INGREDIENT_ID,
				ing.BRANCH_ID,
				ing.NAME AS ITEM_NAME,
				ing.MASTER_CAT_ID,
				mc.CATEGORY_NAME AS CATEGORY_NAME,
				COALESCE(mc.IS_MANUAL_STOCK, 0) AS IS_MANUAL_STOCK,
				COALESCE(agg.STOCK_QTY, 0) AS STOCK_QTY,
				ing.UNIT,
				COALESCE(ing.UNIT_COST, 0) AS UNIT_COST,
				COALESCE(ing.REORDER_LEVEL, 0) AS REORDER_LEVEL,
				COALESCE(agg.STATUS_FLAG, 'In Stock') AS STATUS_FLAG,
				1 AS ACTIVE,
				ing.ENCODED_BY,
				ing.ENCODED_DT,
				ing.EDITED_BY,
				ing.EDITED_DT
			FROM ingredients ing
			LEFT JOIN master_categories mc ON mc.IDNo = ing.MASTER_CAT_ID AND mc.ACTIVE = 1
			LEFT JOIN (
				SELECT INGREDIENT_ID, BRANCH_ID, MAX(IDNo) AS FIRST_ID, SUM(STOCK_QTY) AS STOCK_QTY, MAX(STATUS_FLAG) AS STATUS_FLAG
				FROM inventory ${invWhere}
				GROUP BY INGREDIENT_ID, BRANCH_ID
			) agg ON agg.INGREDIENT_ID = ing.IDNo AND agg.BRANCH_ID = ing.BRANCH_ID
			${where}
			ORDER BY ing.NAME ASC, ing.IDNo ASC
		`;
		const [rows] = await pool.execute(query, params);
		return rows;
	}

	/** Per-category stock metrics for Inventory landing page (no full item payload). */
	static async getCategoryMetrics(branchId) {
		await InventoryModel.ensureSchema();
		if (branchId == null || branchId === undefined) {
			return { byCategory: [], totals: { totalItems: 0, totalValue: 0, needsAttention: 0 } };
		}
		const bid = Number(branchId);
		const [rows] = await pool.execute(
			`
			SELECT
				ing.MASTER_CAT_ID AS category_id,
				COUNT(*) AS item_count,
				COALESCE(SUM(COALESCE(inv_sum.stock, 0) * COALESCE(ing.UNIT_COST, 0)), 0) AS total_value,
				COALESCE(SUM(
					CASE
						WHEN COALESCE(inv_sum.stock, 0) <= COALESCE(ing.REORDER_LEVEL, 0) THEN 1
						ELSE 0
					END
				), 0) AS needs_attention
			FROM ingredients ing
			LEFT JOIN (
				SELECT INGREDIENT_ID, SUM(STOCK_QTY) AS stock
				FROM inventory
				WHERE ACTIVE = 1 AND BRANCH_ID = ? AND INGREDIENT_ID IS NOT NULL
				GROUP BY INGREDIENT_ID
			) inv_sum ON inv_sum.INGREDIENT_ID = ing.IDNo
			WHERE ing.ACTIVE = 1
			  AND ing.BRANCH_ID = ?
			  AND ing.MASTER_CAT_ID IS NOT NULL
			GROUP BY ing.MASTER_CAT_ID
			`,
			[bid, bid],
		);
		const byCategory = rows.map((r) => ({
			categoryId: String(r.category_id),
			itemCount: Number(r.item_count) || 0,
			totalValue: Number(r.total_value) || 0,
			needsAttention: Number(r.needs_attention) || 0,
		}));
		const totals = byCategory.reduce(
			(acc, row) => {
				acc.totalItems += row.itemCount;
				acc.totalValue += row.totalValue;
				acc.needsAttention += row.needsAttention;
				return acc;
			},
			{ totalItems: 0, totalValue: 0, needsAttention: 0 },
		);
		return { byCategory, totals };
	}

	static async getById(id) {
		await InventoryModel.ensureSchema();
		const [rows] = await pool.execute(
			`SELECT inv.IDNo, inv.BRANCH_ID, inv.INGREDIENT_ID, inv.STOCK_QTY, inv.STATUS_FLAG, inv.ACTIVE,
				inv.ENCODED_BY, inv.ENCODED_DT, inv.EDITED_BY, inv.EDITED_DT,
				ing.NAME AS ITEM_NAME, ing.MASTER_CAT_ID, mc.CATEGORY_NAME AS CATEGORY_NAME,
				ing.UNIT, COALESCE(ing.UNIT_COST, 0) AS UNIT_COST, COALESCE(ing.REORDER_LEVEL, 0) AS REORDER_LEVEL
			 FROM inventory inv
			 LEFT JOIN ingredients ing ON ing.IDNo = inv.INGREDIENT_ID AND ing.ACTIVE = 1
			 LEFT JOIN master_categories mc ON mc.IDNo = ing.MASTER_CAT_ID AND mc.ACTIVE = 1
			 WHERE inv.IDNo = ? AND inv.ACTIVE = 1 LIMIT 1`,
			[id]
		);
		return rows[0] || null;
	}

	static async create(data) {
		await InventoryModel.ensureSchema();
		const currentDate = new Date();
		const [ingResult] = await pool.execute(
			`INSERT INTO ingredients (BRANCH_ID, NAME, MASTER_CAT_ID, UNIT, UNIT_COST, REORDER_LEVEL, ACTIVE, ENCODED_BY, ENCODED_DT)
			 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
			[
				Number(data.BRANCH_ID),
				String(data.ITEM_NAME || '').trim(),
				(data.MASTER_CAT_ID ?? data.CATEGORY_ID) != null ? Number(data.MASTER_CAT_ID ?? data.CATEGORY_ID) : null,
				String(data.UNIT || 'pcs'),
				Number(data.UNIT_COST || 0),
				Number(data.REORDER_LEVEL || 0),
				data.user_id || null,
				currentDate,
			]
		);
		const ingredientId = ingResult.insertId;
		await pool.execute(
			`INSERT INTO inventory (BRANCH_ID, INGREDIENT_ID, STOCK_QTY, STATUS_FLAG, ACTIVE, ENCODED_BY, ENCODED_DT)
			 VALUES (?, ?, ?, ?, 1, ?, ?)`,
			[
				Number(data.BRANCH_ID),
				ingredientId,
				Number(data.STOCK_QTY || 0),
				String(data.STATUS_FLAG || 'In Stock'),
				data.user_id || null,
				currentDate,
			]
		);
		const [idRows] = await pool.execute(`SELECT LAST_INSERT_ID() AS id`);
		return Number(idRows[0]?.id || 0);
	}

	static async update(id, data) {
		await InventoryModel.ensureSchema();
		const currentDate = new Date();
		const [existingRows] = await pool.execute(
			`SELECT INGREDIENT_ID FROM inventory WHERE IDNo = ? AND ACTIVE = 1 LIMIT 1`,
			[id]
		);
		if (!existingRows.length) return false;
		const ingredientId = existingRows[0].INGREDIENT_ID;
		if (!ingredientId) return false;
		await pool.execute(
			`UPDATE ingredients SET NAME = ?, MASTER_CAT_ID = ?, UNIT = ?, UNIT_COST = ?, REORDER_LEVEL = ?, EDITED_BY = ?, EDITED_DT = ?
			 WHERE IDNo = ? AND ACTIVE = 1`,
			[
				String(data.ITEM_NAME || '').trim(),
				(data.MASTER_CAT_ID ?? data.CATEGORY_ID) != null ? Number(data.MASTER_CAT_ID ?? data.CATEGORY_ID) : null,
				String(data.UNIT || 'pcs'),
				Number(data.UNIT_COST || 0),
				Number(data.REORDER_LEVEL || 0),
				data.user_id || null,
				currentDate,
				ingredientId,
			]
		);
		const [result] = await pool.execute(
			`UPDATE inventory SET STOCK_QTY = ?, STATUS_FLAG = ?, EDITED_BY = ?, EDITED_DT = ?
			 WHERE IDNo = ? AND ACTIVE = 1`,
			[
				Number(data.STOCK_QTY || 0),
				String(data.STATUS_FLAG || 'In Stock'),
				data.user_id || null,
				currentDate,
				id,
			]
		);
		return result.affectedRows > 0;
	}

	static async delete(id, userId = null) {
		await InventoryModel.ensureSchema();
		const currentDate = new Date();
		const [result] = await pool.execute(
			`UPDATE inventory SET ACTIVE = 0, EDITED_BY = ?, EDITED_DT = ? WHERE IDNo = ? AND ACTIVE = 1`,
			[userId, currentDate, id]
		);
		return result.affectedRows > 0;
	}

	static async updateStockByExpenseId(expenseId, stockQty, branchId = null, addToExisting = false, unit = null) {
		await InventoryModel.ensureSchema();
		const qty = Number(stockQty);
		if (!Number.isFinite(qty)) return false;
		if (!addToExisting && qty < 0) return false;
		const validUnits = ['pcs', 'case', 'box', 'pack', 'bottle', 'jar', 'can', 'bag', 'head', 'bunch', 'cup', 'kg', 'g', 'l', 'ml'];
		const unitVal = unit && String(unit).trim() ? String(unit).trim().toLowerCase() : 'pcs';
		const safeUnit = validUnits.includes(unitVal) ? unitVal : 'pcs';
		try {
			// Load expense by ID only — INNER JOINs to master_categories/operation_category could drop rows
			// (e.g. category moved, join quirks) even though the expense exists and appears in the UI list.
			const [exp] = await pool.execute(
				`SELECT e.BRANCH_ID, e.EXP_DESC, e.EXP_AMOUNT, e.MASTER_CAT_ID, e.INGREDIENT_ID, e.ENCODED_BY, e.ENCODED_DT
				 FROM expenses e
				 WHERE e.IDNo = ? AND e.ACTIVE = 1
				 LIMIT 1`,
				[expenseId]
			);
			if (!exp.length) return false;
			const brId = branchId ?? exp[0].BRANCH_ID ?? 1;

			let ingredientId = exp[0].INGREDIENT_ID != null && Number.isFinite(Number(exp[0].INGREDIENT_ID))
				? Number(exp[0].INGREDIENT_ID)
				: null;

			if (!ingredientId) {
				const [ing] = await pool.execute(
					`SELECT IDNo FROM ingredients WHERE BRANCH_ID = ? AND TRIM(NAME) = TRIM(?) AND MASTER_CAT_ID <=> ? AND ACTIVE = 1 LIMIT 1`,
					[brId, exp[0].EXP_DESC, exp[0].MASTER_CAT_ID]
				);
				if (ing.length) {
					ingredientId = ing[0].IDNo;
				} else {
					const [ins] = await pool.execute(
						`INSERT INTO ingredients (BRANCH_ID, NAME, MASTER_CAT_ID, UNIT, ACTIVE, ENCODED_BY, ENCODED_DT)
						 VALUES (?, ?, ?, ?, 1, ?, ?)`,
						[brId, String(exp[0].EXP_DESC || '').trim(), exp[0].MASTER_CAT_ID, safeUnit, exp[0].ENCODED_BY, exp[0].ENCODED_DT]
					);
					ingredientId = ins.insertId;
				}
				await pool.execute(`UPDATE expenses SET INGREDIENT_ID = ? WHERE IDNo = ? AND ACTIVE = 1`, [ingredientId, expenseId]);
			}
			// After resolving ingredient (including first-time link to an existing row), sync UNIT when the client sends it.
			if (ingredientId != null && unit != null && String(unit).trim()) {
				await pool.execute(`UPDATE ingredients SET UNIT = ? WHERE IDNo = ? AND ACTIVE = 1`, [safeUnit, ingredientId]);
			}

			const [rows] = await pool.execute(
				`SELECT IDNo, STOCK_QTY FROM inventory WHERE INGREDIENT_ID = ? AND BRANCH_ID = ? AND ACTIVE = 1 LIMIT 1`,
				[ingredientId, brId]
			);
			if (rows.length) {
				const firstId = rows[0].IDNo;
				const newQty = addToExisting ? Math.max(0, (Number(rows[0].STOCK_QTY) || 0) + qty) : qty;
				await pool.execute(
					`UPDATE inventory SET STOCK_QTY = CASE WHEN IDNo = ? THEN ? ELSE 0 END, EDITED_DT = CURRENT_TIMESTAMP
					 WHERE INGREDIENT_ID = ? AND BRANCH_ID = ? AND ACTIVE = 1`,
					[firstId, newQty, ingredientId, brId]
				);
				return true;
			}
			await pool.execute(
				`INSERT INTO inventory (BRANCH_ID, INGREDIENT_ID, STOCK_QTY, STATUS_FLAG, ACTIVE, ENCODED_BY, ENCODED_DT)
				 VALUES (?, ?, ?, 'In Stock', 1, ?, ?)`,
				[brId, ingredientId, qty, exp[0].ENCODED_BY, exp[0].ENCODED_DT]
			);
			return true;
		} catch (err) {
			if (err.message && (err.message.includes('INGREDIENT_ID') || err.message.includes('ingredients') || err.message.includes('EXPENSES_ID'))) return false;
			throw err;
		}
	}

	/**
	 * Deduct stock for order confirmation. Reduces STOCK_QTY for (branchId, ingredientId).
	 * @returns {boolean} true if deducted, false if no inventory row or insufficient
	 */
	static async deductStock(branchId, ingredientId, qty, userId = null) {
		await InventoryModel.ensureSchema();
		const deductQty = Number(qty);
		if (!Number.isFinite(deductQty) || deductQty <= 0) return false;
		const [rows] = await pool.execute(
			`SELECT IDNo, STOCK_QTY FROM inventory WHERE INGREDIENT_ID = ? AND BRANCH_ID = ? AND ACTIVE = 1 LIMIT 1`,
			[Number(ingredientId), Number(branchId)]
		);
		if (!rows.length) return false;
		const current = Number(rows[0].STOCK_QTY) || 0;
		if (deductQty > current) return false;
		const newQty = current - deductQty;
		await pool.execute(
			`UPDATE inventory SET STOCK_QTY = ?, EDITED_BY = ?, EDITED_DT = CURRENT_TIMESTAMP WHERE IDNo = ?`,
			[newQty, userId != null ? Number(userId) : null, rows[0].IDNo]
		);
		return true;
	}

	/**
	 * Add stock back (reversal). Increases STOCK_QTY for (branchId, ingredientId).
	 */
	static async addStock(branchId, ingredientId, qty, userId = null) {
		await InventoryModel.ensureSchema();
		const addQty = Number(qty);
		if (!Number.isFinite(addQty) || addQty <= 0) return false;
		const [rows] = await pool.execute(
			`SELECT IDNo, STOCK_QTY FROM inventory WHERE INGREDIENT_ID = ? AND BRANCH_ID = ? AND ACTIVE = 1 LIMIT 1`,
			[Number(ingredientId), Number(branchId)]
		);
		if (!rows.length) {
			await pool.execute(
				`INSERT INTO inventory (BRANCH_ID, INGREDIENT_ID, STOCK_QTY, STATUS_FLAG, ACTIVE, ENCODED_BY, ENCODED_DT)
				 VALUES (?, ?, ?, 'In Stock', 1, ?, NOW())`,
				[Number(branchId), Number(ingredientId), addQty, userId != null ? Number(userId) : null]
			);
			return true;
		}
		const current = Number(rows[0].STOCK_QTY) || 0;
		const newQty = current + addQty;
		await pool.execute(
			`UPDATE inventory SET STOCK_QTY = ?, EDITED_BY = ?, EDITED_DT = CURRENT_TIMESTAMP WHERE IDNo = ?`,
			[newQty, userId != null ? Number(userId) : null, rows[0].IDNo]
		);
		return true;
	}
}

module.exports = InventoryModel;

InventoryModel.ensureSchema().catch((error) => {
	console.error('[INVENTORY MODEL] Failed to ensure schema:', error.message);
});
