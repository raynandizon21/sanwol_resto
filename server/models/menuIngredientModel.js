// ============================================
// MENU INGREDIENT MODEL
// ============================================
// Links menu items to ingredients (recipe).
// QTY_PER_SERVE = quantity per 1 serving of the menu item.
// ============================================

const pool = require('../config/db');
const IngredientModel = require('./ingredientModel');

// Same valid units as inventory (lowercase)
const VALID_UNITS = ['pcs', 'case', 'box', 'pack', 'bottle', 'jar', 'can', 'bag', 'head', 'bunch', 'cup', 'kg', 'g', 'l', 'ml'];

function sanitizeUnit(unit) {
	const u = unit && String(unit).trim() ? String(unit).trim().toLowerCase() : 'pcs';
	return VALID_UNITS.includes(u) ? u : 'pcs';
}

class MenuIngredientModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (MenuIngredientModel._schemaReady) return;
		if (MenuIngredientModel._schemaPromise) return MenuIngredientModel._schemaPromise;

		MenuIngredientModel._schemaPromise = (async () => {
			await IngredientModel.ensureSchema();

			// Check if menu table exists (may be created by external migration)
			const [menuTable] = await pool.execute(
				`SELECT 1 FROM INFORMATION_SCHEMA.TABLES
				 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu' LIMIT 1`
			);
			if (!menuTable.length) {
				console.warn('[MenuIngredientModel] menu table not found; skipping menu_ingredients creation');
				MenuIngredientModel._schemaReady = true;
				MenuIngredientModel._schemaPromise = null;
				return;
			}

			await pool.execute(`
				CREATE TABLE IF NOT EXISTS menu_ingredients (
					IDNo INT AUTO_INCREMENT PRIMARY KEY,
					MENU_ID INT NOT NULL,
					INGREDIENT_ID INT NOT NULL,
					QTY_PER_SERVE DECIMAL(12,3) NOT NULL DEFAULT 1,
					UNIT VARCHAR(20) NOT NULL DEFAULT 'pcs',
					ACTIVE TINYINT(1) NOT NULL DEFAULT 1,
					ENCODED_BY INT NULL,
					ENCODED_DT DATETIME DEFAULT CURRENT_TIMESTAMP,
					EDITED_BY INT NULL,
					EDITED_DT DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
					INDEX idx_menu_ingredients_menu (MENU_ID),
					INDEX idx_menu_ingredients_ingredient (INGREDIENT_ID),
					INDEX idx_menu_ingredients_active (ACTIVE),
					UNIQUE KEY uk_menu_ingredient (MENU_ID, INGREDIENT_ID),
					CONSTRAINT fk_menu_ingredients_menu
						FOREIGN KEY (MENU_ID) REFERENCES menu(IDNo)
						ON UPDATE CASCADE ON DELETE CASCADE,
					CONSTRAINT fk_menu_ingredients_ingredient
						FOREIGN KEY (INGREDIENT_ID) REFERENCES ingredients(IDNo)
						ON UPDATE CASCADE ON DELETE RESTRICT
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
			`);

			// Normalize QTY_PER_SERVE type/scale across environments
			try {
				await pool.execute(`ALTER TABLE menu_ingredients MODIFY COLUMN QTY_PER_SERVE DECIMAL(12,3) NOT NULL DEFAULT 1`);
			} catch (alterErr) {
				console.warn('[MenuIngredientModel] QTY_PER_SERVE type normalization skipped:', alterErr.message);
			}

			MenuIngredientModel._schemaReady = true;
			MenuIngredientModel._schemaPromise = null;
		})().catch((error) => {
			MenuIngredientModel._schemaPromise = null;
			throw error;
		});

		return MenuIngredientModel._schemaPromise;
	}

	static async getByMenuId(menuId) {
		await MenuIngredientModel.ensureSchema();
		const [rows] = await pool.execute(
			`SELECT
				mi.IDNo,
				mi.MENU_ID,
				mi.INGREDIENT_ID,
				i.NAME AS INGREDIENT_NAME,
				mc.CATEGORY_NAME AS INGREDIENT_CATEGORY,
				mi.QTY_PER_SERVE,
				mi.UNIT,
				mi.ACTIVE
			 FROM menu_ingredients mi
			 INNER JOIN ingredients i ON i.IDNo = mi.INGREDIENT_ID AND i.ACTIVE = 1
			 LEFT JOIN master_categories mc ON mc.IDNo = i.MASTER_CAT_ID AND mc.ACTIVE = 1
			 WHERE mi.MENU_ID = ? AND mi.ACTIVE = 1
			 ORDER BY i.NAME ASC`,
			[Number(menuId)]
		);
		return rows;
	}

	static async getByIngredientId(ingredientId) {
		await MenuIngredientModel.ensureSchema();
		const [rows] = await pool.execute(
			`SELECT
				mi.IDNo,
				mi.MENU_ID,
				m.MENU_NAME,
				mi.INGREDIENT_ID,
				mi.QTY_PER_SERVE,
				mi.UNIT,
				mi.ACTIVE
			 FROM menu_ingredients mi
			 INNER JOIN menu m ON m.IDNo = mi.MENU_ID AND m.ACTIVE = 1
			 WHERE mi.INGREDIENT_ID = ? AND mi.ACTIVE = 1
			 ORDER BY m.MENU_NAME ASC`,
			[Number(ingredientId)]
		);
		return rows;
	}

	static async create(data) {
		await MenuIngredientModel.ensureSchema();
		const safeUnit = sanitizeUnit(data.UNIT);
		const [result] = await pool.execute(
			`INSERT INTO menu_ingredients (MENU_ID, INGREDIENT_ID, QTY_PER_SERVE, UNIT, ACTIVE, ENCODED_BY, ENCODED_DT)
			 VALUES (?, ?, ?, ?, 1, ?, NOW())`,
			[
				Number(data.MENU_ID),
				Number(data.INGREDIENT_ID),
				Number(data.QTY_PER_SERVE) || 1,
				safeUnit,
				data.ENCODED_BY != null ? Number(data.ENCODED_BY) : null,
			]
		);
		return result.insertId;
	}

	static async update(id, data) {
		await MenuIngredientModel.ensureSchema();
		let safeUnit;
		if (data.UNIT != null && data.UNIT !== '') {
			safeUnit = sanitizeUnit(data.UNIT);
		} else {
			const [row] = await pool.execute(
				`SELECT UNIT FROM menu_ingredients WHERE IDNo = ? AND ACTIVE = 1 LIMIT 1`,
				[Number(id)]
			);
			safeUnit = row.length ? sanitizeUnit(row[0].UNIT) : 'pcs';
		}
		const [result] = await pool.execute(
			`UPDATE menu_ingredients SET
				QTY_PER_SERVE = ?,
				UNIT = ?,
				EDITED_BY = ?,
				EDITED_DT = NOW()
			 WHERE IDNo = ? AND ACTIVE = 1`,
			[
				Number(data.QTY_PER_SERVE) ?? 1,
				safeUnit,
				data.EDITED_BY != null ? Number(data.EDITED_BY) : null,
				Number(id),
			]
		);
		return result.affectedRows > 0;
	}

	static async delete(id) {
		await MenuIngredientModel.ensureSchema();
		const [result] = await pool.execute(
			`UPDATE menu_ingredients SET ACTIVE = 0, EDITED_DT = NOW() WHERE IDNo = ? AND ACTIVE = 1`,
			[Number(id)]
		);
		return result.affectedRows > 0;
	}

	static async deleteByMenuId(menuId) {
		await MenuIngredientModel.ensureSchema();
		const [result] = await pool.execute(
			`UPDATE menu_ingredients SET ACTIVE = 0, EDITED_DT = NOW() WHERE MENU_ID = ?`,
			[Number(menuId)]
		);
		return result.affectedRows;
	}
}

module.exports = MenuIngredientModel;
