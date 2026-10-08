// ============================================
// INGREDIENT MODEL
// ============================================
// Master list of ingredients for menu recipes.
// Populated from expenses (STATE=1) - survives expense deletion.
// ============================================

const pool = require('../config/db');
const BranchModel = require('./branchModel');
const { ensureIdNoAutoIncrement } = require('../utils/mysqlSchemaHelpers');

class IngredientModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (IngredientModel._schemaReady) return;
		if (IngredientModel._schemaPromise) return IngredientModel._schemaPromise;

		IngredientModel._schemaPromise = (async () => {
			await BranchModel.ensureSchema();

			await pool.execute(`
				CREATE TABLE IF NOT EXISTS ingredients (
					IDNo INT AUTO_INCREMENT PRIMARY KEY,
					BRANCH_ID INT NOT NULL,
					MASTER_CAT_ID INT NULL,
					NAME VARCHAR(255) NOT NULL,
					UNIT VARCHAR(20) NOT NULL DEFAULT 'pcs',
					UNIT_COST DECIMAL(12,2) NOT NULL DEFAULT 0,
					REORDER_LEVEL DECIMAL(12,3) NOT NULL DEFAULT 0,
					ACTIVE TINYINT(1) NOT NULL DEFAULT 1,
					ENCODED_BY INT NULL,
					ENCODED_DT DATETIME DEFAULT CURRENT_TIMESTAMP,
					EDITED_BY INT NULL,
					EDITED_DT DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
					INDEX idx_ingredients_branch (BRANCH_ID),
					INDEX idx_ingredients_master_cat (MASTER_CAT_ID),
					INDEX idx_ingredients_active (ACTIVE),
					UNIQUE KEY uk_ingredients_branch_name_category (BRANCH_ID, NAME(100), MASTER_CAT_ID),
					CONSTRAINT fk_ingredients_branch
						FOREIGN KEY (BRANCH_ID) REFERENCES branches(IDNo)
						ON UPDATE CASCADE ON DELETE RESTRICT
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
			`);

			// Add UNIT_COST, REORDER_LEVEL to existing ingredients tables
			for (const col of ['UNIT_COST', 'REORDER_LEVEL']) {
				const [has] = await pool.execute(
					`SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
					 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ingredients' AND COLUMN_NAME = ? LIMIT 1`,
					[col]
				);
				if (!has.length) {
					const def = col === 'UNIT_COST' ? 'DECIMAL(12,2) NOT NULL DEFAULT 0' : 'DECIMAL(12,3) NOT NULL DEFAULT 0';
					await pool.execute(`ALTER TABLE ingredients ADD COLUMN ${col} ${def} AFTER UNIT`);
					console.log(`[IngredientModel] Added ${col} to ingredients`);
				}
			}

			// Normalize REORDER_LEVEL type/scale across environments
			try {
				await pool.execute(`ALTER TABLE ingredients MODIFY COLUMN REORDER_LEVEL DECIMAL(12,3) NOT NULL DEFAULT 0`);
			} catch (alterErr) {
				console.warn('[IngredientModel] REORDER_LEVEL type normalization skipped:', alterErr?.message);
			}

			// Migration: rename CATEGORY_ID to MASTER_CAT_ID (para iwas confuse - same as expenses)
			try {
				const [cols] = await pool.execute(
					`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ingredients'`
				);
				const colSet = new Set(cols.map((c) => c.COLUMN_NAME));
				if (colSet.has('CATEGORY_ID') && !colSet.has('MASTER_CAT_ID')) {
					try { await pool.execute(`ALTER TABLE ingredients DROP INDEX idx_ingredients_category`); } catch (_) {}
					try { await pool.execute(`ALTER TABLE ingredients DROP INDEX uk_ingredients_branch_name_category`); } catch (_) {}
					await pool.execute(`ALTER TABLE ingredients CHANGE COLUMN CATEGORY_ID MASTER_CAT_ID INT NULL`);
					await pool.execute(`ALTER TABLE ingredients ADD INDEX idx_ingredients_master_cat (MASTER_CAT_ID)`);
					await pool.execute(`ALTER TABLE ingredients ADD UNIQUE KEY uk_ingredients_branch_name_category (BRANCH_ID, NAME(100), MASTER_CAT_ID)`);
					console.log('[IngredientModel] Renamed CATEGORY_ID to MASTER_CAT_ID');
				}
			} catch (alterErr) {
				console.warn('[IngredientModel] CATEGORY_ID rename skipped:', alterErr?.message);
			}

			// Legacy DBs: ingredients may exist without AUTO_INCREMENT on IDNo (CREATE IF NOT EXISTS does not upgrade).
			const ingredientsIdOk = await ensureIdNoAutoIncrement(pool, 'ingredients');
			if (!ingredientsIdOk) {
				throw new Error(
					'ingredients.IDNo is not AUTO_INCREMENT. Add PRIMARY KEY on IDNo if missing, then: ' +
						'ALTER TABLE ingredients MODIFY COLUMN IDNo INT NOT NULL AUTO_INCREMENT;'
				);
			}

			// Migrate: insert distinct expenses (STATE=1) into ingredients as master list
			// No inventory join - inventory schema uses INGREDIENT_ID; UNIT comes from ingredients. Default 'pcs'.
			try {
				const [inserted] = await pool.execute(`
					INSERT INTO ingredients (BRANCH_ID, NAME, MASTER_CAT_ID, UNIT, UNIT_COST, REORDER_LEVEL, ACTIVE, ENCODED_BY, ENCODED_DT)
					SELECT
						sub.BRANCH_ID,
						sub.NAME,
						sub.MASTER_CAT_ID,
						'pcs' AS UNIT,
						0 AS UNIT_COST,
						0 AS REORDER_LEVEL,
						1 AS ACTIVE,
						sub.ENCODED_BY,
						sub.ENCODED_DT
					FROM (
						SELECT
							e.BRANCH_ID,
							TRIM(e.EXP_DESC) AS NAME,
							e.MASTER_CAT_ID,
							MAX(e.ENCODED_BY) AS ENCODED_BY,
							MAX(COALESCE(e.ENCODED_DT, CURRENT_TIMESTAMP)) AS ENCODED_DT
						FROM expenses e
						INNER JOIN master_categories mc ON mc.IDNo = e.MASTER_CAT_ID AND mc.ACTIVE = 1
						INNER JOIN operation_category oc ON oc.IDNo = mc.OP_CAT_ID AND oc.ACTIVE = 1 AND oc.STATE = 1
						WHERE e.ACTIVE = 1
						  AND e.EXP_DESC IS NOT NULL
						  AND TRIM(e.EXP_DESC) <> ''
						GROUP BY e.BRANCH_ID, TRIM(e.EXP_DESC), e.MASTER_CAT_ID
					) sub
					WHERE NOT EXISTS (
						SELECT 1 FROM ingredients i
						WHERE i.BRANCH_ID = sub.BRANCH_ID
						  AND i.MASTER_CAT_ID <=> sub.MASTER_CAT_ID
						  AND TRIM(i.NAME) = sub.NAME
					)
				`);
				if (inserted.affectedRows > 0) {
					console.log(`[IngredientModel] Migrated ${inserted.affectedRows} ingredients from expenses (STATE=1)`);
				}
			} catch (migErr) {
				console.warn('[IngredientModel] Migration from expenses skipped:', migErr?.message);
			}

			IngredientModel._schemaReady = true;
			IngredientModel._schemaPromise = null;
		})().catch((error) => {
			IngredientModel._schemaPromise = null;
			throw error;
		});

		return IngredientModel._schemaPromise;
	}

	static async getAll(branchId = null, categoryId = null) {
		await IngredientModel.ensureSchema();
		let query = `
			SELECT
				i.IDNo,
				i.BRANCH_ID,
				i.MASTER_CAT_ID,
				i.NAME,
				mc.CATEGORY_NAME,
				i.UNIT,
				i.UNIT_COST,
				i.REORDER_LEVEL,
				i.ACTIVE,
				i.ENCODED_BY,
				i.ENCODED_DT,
				i.EDITED_BY,
				i.EDITED_DT
			FROM ingredients i
			LEFT JOIN master_categories mc ON mc.IDNo = i.MASTER_CAT_ID AND mc.ACTIVE = 1
			WHERE i.ACTIVE = 1
		`;
		const params = [];
		if (branchId != null && branchId !== undefined) {
			query += ' AND i.BRANCH_ID = ?';
			params.push(Number(branchId));
		}
		if (categoryId != null && categoryId !== undefined && String(categoryId).trim() !== '') {
			query += ' AND i.MASTER_CAT_ID = ?';
			params.push(Number(categoryId));
		}
		query += ' ORDER BY i.NAME ASC, i.IDNo ASC';
		const [rows] = await pool.execute(query, params);
		return rows;
	}

	static async getById(id) {
		await IngredientModel.ensureSchema();
		const [rows] = await pool.execute(
			`SELECT i.*, mc.CATEGORY_NAME
			 FROM ingredients i
			 LEFT JOIN master_categories mc ON mc.IDNo = i.MASTER_CAT_ID AND mc.ACTIVE = 1
			 WHERE i.IDNo = ? AND i.ACTIVE = 1 LIMIT 1`,
			[id]
		);
		return rows[0] || null;
	}

	static async create(data) {
		await IngredientModel.ensureSchema();
		const [result] = await pool.execute(
			`INSERT INTO ingredients (BRANCH_ID, NAME, MASTER_CAT_ID, UNIT, UNIT_COST, REORDER_LEVEL, ACTIVE, ENCODED_BY, ENCODED_DT)
			 VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
			[
				Number(data.BRANCH_ID),
				String(data.NAME || '').trim(),
				(data.MASTER_CAT_ID ?? data.CATEGORY_ID) != null ? Number(data.MASTER_CAT_ID ?? data.CATEGORY_ID) : null,
				String(data.UNIT || 'pcs').trim() || 'pcs',
				Number(data.UNIT_COST ?? 0),
				Number(data.REORDER_LEVEL ?? 0),
				data.ENCODED_BY != null ? Number(data.ENCODED_BY) : null,
			]
		);
		return result.insertId;
	}

	static async update(id, data) {
		await IngredientModel.ensureSchema();
		const [result] = await pool.execute(
			`UPDATE ingredients SET
				NAME = ?,
				MASTER_CAT_ID = ?,
				UNIT = ?,
				UNIT_COST = ?,
				REORDER_LEVEL = ?,
				EDITED_BY = ?,
				EDITED_DT = NOW()
			 WHERE IDNo = ? AND ACTIVE = 1`,
			[
				String(data.NAME || '').trim(),
				(data.MASTER_CAT_ID ?? data.CATEGORY_ID) != null ? Number(data.MASTER_CAT_ID ?? data.CATEGORY_ID) : null,
				String(data.UNIT || 'pcs').trim() || 'pcs',
				Number(data.UNIT_COST ?? 0),
				Number(data.REORDER_LEVEL ?? 0),
				data.EDITED_BY != null ? Number(data.EDITED_BY) : null,
				Number(id),
			]
		);
		return result.affectedRows > 0;
	}

	static async setInactive(id) {
		await IngredientModel.ensureSchema();
		const [result] = await pool.execute(
			`UPDATE ingredients SET ACTIVE = 0, EDITED_DT = NOW() WHERE IDNo = ? AND ACTIVE = 1`,
			[Number(id)]
		);
		return result.affectedRows > 0;
	}

	/** Re-run migration: add any new expenses (STATE=1) to ingredients */
	static async syncFromExpenses() {
		await IngredientModel.ensureSchema();
		IngredientModel._schemaReady = false;
		IngredientModel._schemaPromise = null;
		await IngredientModel.ensureSchema();
	}

	/** Sync expenses under a specific master category (inventory type) to ingredients */
	static async syncFromExpensesForCategory(masterCategoryId, branchId = null) {
		await IngredientModel.ensureSchema();
		try {
			const params = [Number(masterCategoryId)];
			const branchFilter = branchId != null && branchId !== undefined
				? ' AND e.BRANCH_ID = ?'
				: '';
			if (branchFilter) params.push(Number(branchId));

			const [result] = await pool.execute(
				`INSERT INTO ingredients (BRANCH_ID, NAME, MASTER_CAT_ID, UNIT, UNIT_COST, REORDER_LEVEL, ACTIVE, ENCODED_BY, ENCODED_DT)
				SELECT
					sub.BRANCH_ID,
					sub.NAME,
					sub.MASTER_CAT_ID,
					COALESCE(sub.UNIT, 'pcs') AS UNIT,
					0 AS UNIT_COST,
					0 AS REORDER_LEVEL,
					1 AS ACTIVE,
					sub.ENCODED_BY,
					sub.ENCODED_DT
				FROM (
					SELECT
						e.BRANCH_ID,
						TRIM(e.EXP_DESC) AS NAME,
						e.MASTER_CAT_ID,
						'pcs' AS UNIT,
						MAX(e.ENCODED_BY) AS ENCODED_BY,
						MAX(COALESCE(e.ENCODED_DT, CURRENT_TIMESTAMP)) AS ENCODED_DT
					FROM expenses e
					INNER JOIN master_categories mc ON mc.IDNo = e.MASTER_CAT_ID AND mc.ACTIVE = 1
					INNER JOIN operation_category oc ON oc.IDNo = mc.OP_CAT_ID AND oc.ACTIVE = 1 AND oc.STATE = 1
					WHERE e.ACTIVE = 1
					  AND e.MASTER_CAT_ID = ?
					  ${branchFilter}
					  AND e.EXP_DESC IS NOT NULL
					  AND TRIM(e.EXP_DESC) <> ''
					GROUP BY e.BRANCH_ID, TRIM(e.EXP_DESC), e.MASTER_CAT_ID
				) sub
				WHERE NOT EXISTS (
					SELECT 1 FROM ingredients i
					WHERE i.BRANCH_ID = sub.BRANCH_ID
					  AND i.MASTER_CAT_ID <=> sub.MASTER_CAT_ID
					  AND TRIM(i.NAME) = sub.NAME
				)`,
				params
			);

			// Update expenses.INGREDIENT_ID so direct link is stored (para iwas confuse)
			try {
				const [cols] = await pool.execute(
					`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'expenses' AND COLUMN_NAME = 'INGREDIENT_ID' LIMIT 1`
				);
				if (cols.length) {
					const updParams = [Number(masterCategoryId)];
					const updBranch = branchId != null && branchId !== undefined ? ' AND e.BRANCH_ID = ?' : '';
					if (updBranch) updParams.push(Number(branchId));
					await pool.execute(
						`UPDATE expenses e
						 INNER JOIN ingredients ing ON ing.BRANCH_ID = e.BRANCH_ID
						   AND TRIM(ing.NAME) = TRIM(e.EXP_DESC)
						   AND ing.MASTER_CAT_ID <=> e.MASTER_CAT_ID
						   AND ing.ACTIVE = 1
						 SET e.INGREDIENT_ID = ing.IDNo
						 WHERE e.ACTIVE = 1 AND e.MASTER_CAT_ID = ? ${updBranch}`,
						updParams
					);
				}
			} catch (updErr) {
				console.warn('[IngredientModel.syncFromExpensesForCategory] update INGREDIENT_ID:', updErr?.message);
			}
			return result.affectedRows || 0;
		} catch (err) {
			console.warn('[IngredientModel.syncFromExpensesForCategory]', err?.message);
			return 0;
		}
	}

	/** Link expense to ingredient: find or create ingredient, set expense.INGREDIENT_ID (para iwas confuse) */
	static async linkExpenseToIngredient(expenseId) {
		await IngredientModel.ensureSchema();
		try {
			const [cols] = await pool.execute(
				`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'expenses' AND COLUMN_NAME = 'INGREDIENT_ID' LIMIT 1`
			);
			if (!cols.length) return null;

			const [exp] = await pool.execute(
				`SELECT e.BRANCH_ID, e.EXP_DESC, e.MASTER_CAT_ID, e.INGREDIENT_ID, e.ENCODED_BY, e.ENCODED_DT
				 FROM expenses e
				 INNER JOIN master_categories mc ON mc.IDNo = e.MASTER_CAT_ID AND mc.ACTIVE = 1
				 INNER JOIN operation_category oc ON oc.IDNo = mc.OP_CAT_ID AND oc.ACTIVE = 1 AND oc.STATE = 1
				 WHERE e.IDNo = ? AND e.ACTIVE = 1 LIMIT 1`,
				[expenseId]
			);
			if (!exp.length || !exp[0].EXP_DESC || String(exp[0].EXP_DESC).trim() === '') return null;

			const brId = exp[0].BRANCH_ID;
			const masterCatId = exp[0].MASTER_CAT_ID;
			const name = String(exp[0].EXP_DESC).trim();

			let [ing] = await pool.execute(
				`SELECT IDNo FROM ingredients WHERE BRANCH_ID = ? AND TRIM(NAME) = ? AND MASTER_CAT_ID <=> ? AND ACTIVE = 1 LIMIT 1`,
				[brId, name, masterCatId]
			);
			let ingredientId;
			if (ing.length) {
				ingredientId = ing[0].IDNo;
			} else {
				const [ins] = await pool.execute(
					`INSERT INTO ingredients (BRANCH_ID, NAME, MASTER_CAT_ID, UNIT, ACTIVE, ENCODED_BY, ENCODED_DT)
					 VALUES (?, ?, ?, 'pcs', 1, ?, ?)`,
					[brId, name, masterCatId, exp[0].ENCODED_BY, exp[0].ENCODED_DT]
				);
				ingredientId = ins.insertId;
			}

			await pool.execute(
				`UPDATE expenses SET INGREDIENT_ID = ? WHERE IDNo = ? AND ACTIVE = 1`,
				[ingredientId, expenseId]
			);
			return ingredientId;
		} catch (err) {
			console.warn('[IngredientModel.linkExpenseToIngredient]', err?.message);
			return null;
		}
	}
}

module.exports = IngredientModel;
