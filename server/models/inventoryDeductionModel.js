// ============================================
// INVENTORY DEDUCTION MODEL
// ============================================
// Records deductions from inventory when orders are confirmed.
// Flow: orders -> order_items -> menu_ingredients -> inventory_deductions -> inventory
// STATUS: same as orders — 3=PENDING, 2=CONFIRMED, 1=SETTLED, -1=CANCELLED
// ACTIVE: 1=active deduction, 0=voided (reversed)
// ============================================

const pool = require('../config/db');

const STATUS = { PENDING: 3, CONFIRMED: 2, SETTLED: 1, CANCELLED: -1 };

class InventoryDeductionModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static get STATUS() {
		return STATUS;
	}

	static async ensureSchema() {
		if (InventoryDeductionModel._schemaReady) return;
		if (InventoryDeductionModel._schemaPromise) return InventoryDeductionModel._schemaPromise;

		InventoryDeductionModel._schemaPromise = (async () => {
			await pool.execute(`
				CREATE TABLE IF NOT EXISTS inventory_deductions (
					IDNo INT NOT NULL AUTO_INCREMENT,
					ORDER_ID INT NOT NULL,
					ORDER_ITEM_ID INT NULL,
					BRANCH_ID INT NOT NULL,
					INGREDIENT_ID INT NOT NULL,
					MENU_ID INT NOT NULL,
					DEDUCTED_QTY DECIMAL(12,3) NOT NULL DEFAULT 0,
					UNIT VARCHAR(20) NOT NULL DEFAULT 'pcs',
					STATUS INT NOT NULL DEFAULT 2 COMMENT '3=PENDING, 2=CONFIRMED, 1=SETTLED, -1=CANCELLED',
					ACTIVE TINYINT(1) NOT NULL DEFAULT 1,
					ENCODED_BY INT NULL,
					ENCODED_DT DATETIME DEFAULT CURRENT_TIMESTAMP,
					EDITED_BY INT NULL,
					EDITED_DT DATETIME DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
					PRIMARY KEY (IDNo),
					INDEX idx_order_id (ORDER_ID),
					INDEX idx_branch_ingredient (BRANCH_ID, INGREDIENT_ID),
					INDEX idx_active (ACTIVE),
					INDEX idx_status (STATUS),
					CONSTRAINT fk_inv_ded_order FOREIGN KEY (ORDER_ID) REFERENCES orders(IDNo) ON UPDATE CASCADE ON DELETE RESTRICT,
					CONSTRAINT fk_inv_ded_order_item FOREIGN KEY (ORDER_ITEM_ID) REFERENCES order_items(IDNo) ON UPDATE CASCADE ON DELETE SET NULL,
					CONSTRAINT fk_inv_ded_branch FOREIGN KEY (BRANCH_ID) REFERENCES branches(IDNo) ON UPDATE CASCADE ON DELETE RESTRICT,
					CONSTRAINT fk_inv_ded_ingredient FOREIGN KEY (INGREDIENT_ID) REFERENCES ingredients(IDNo) ON UPDATE CASCADE ON DELETE RESTRICT,
					CONSTRAINT fk_inv_ded_menu FOREIGN KEY (MENU_ID) REFERENCES menu(IDNo) ON UPDATE CASCADE ON DELETE RESTRICT
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
			`);

			// Normalize DEDUCTED_QTY type/scale across environments
			try {
				await pool.execute(`ALTER TABLE inventory_deductions MODIFY COLUMN DEDUCTED_QTY DECIMAL(12,3) NOT NULL DEFAULT 0`);
			} catch (alterErr) {
				const code = String(alterErr?.code || '').toUpperCase();
				const message = String(alterErr?.message || '');
				const isLockIssue =
					code === 'ER_LOCK_DEADLOCK' ||
					code === 'ER_LOCK_WAIT_TIMEOUT' ||
					/Deadlock found when trying to get lock/i.test(message) ||
					/Lock wait timeout exceeded/i.test(message);

				if (!isLockIssue) {
					console.warn('[InventoryDeductionModel] DEDUCTED_QTY type normalization skipped:', message);
				}
			}

			InventoryDeductionModel._schemaReady = true;
			InventoryDeductionModel._schemaPromise = null;
		})().catch((error) => {
			InventoryDeductionModel._schemaPromise = null;
			throw error;
		});

		return InventoryDeductionModel._schemaPromise;
	}

	static async getByOrderId(orderId, activeOnly = true) {
		await InventoryDeductionModel.ensureSchema();
		let where = 'WHERE inv_ded.ORDER_ID = ?';
		if (activeOnly) where += ' AND inv_ded.ACTIVE = 1';
		const [rows] = await pool.execute(
			`SELECT inv_ded.IDNo, inv_ded.ORDER_ID, inv_ded.ORDER_ITEM_ID, inv_ded.BRANCH_ID, inv_ded.INGREDIENT_ID, inv_ded.MENU_ID,
				inv_ded.DEDUCTED_QTY, inv_ded.UNIT, inv_ded.STATUS, inv_ded.ACTIVE, inv_ded.ENCODED_BY, inv_ded.ENCODED_DT, inv_ded.EDITED_BY, inv_ded.EDITED_DT,
				i.NAME AS INGREDIENT_NAME
			 FROM inventory_deductions inv_ded
			 LEFT JOIN ingredients i ON i.IDNo = inv_ded.INGREDIENT_ID
			 ${where}
			 ORDER BY inv_ded.ENCODED_DT ASC`,
			[Number(orderId)]
		);
		return rows;
	}

	static async create(data) {
		await InventoryDeductionModel.ensureSchema();
		const [result] = await pool.execute(
			`INSERT INTO inventory_deductions (
				ORDER_ID, ORDER_ITEM_ID, BRANCH_ID, INGREDIENT_ID, MENU_ID,
				DEDUCTED_QTY, UNIT, STATUS, ACTIVE, ENCODED_BY, ENCODED_DT
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
			[
				Number(data.ORDER_ID),
				data.ORDER_ITEM_ID != null ? Number(data.ORDER_ITEM_ID) : null,
				Number(data.BRANCH_ID),
				Number(data.INGREDIENT_ID),
				Number(data.MENU_ID),
				Number(data.DEDUCTED_QTY),
				String(data.UNIT || 'pcs').trim().toLowerCase() || 'pcs',
				Number(data.STATUS) || STATUS.CONFIRMED,
				data.ENCODED_BY != null ? Number(data.ENCODED_BY) : null,
			]
		);
		return result.insertId;
	}

	static async markCancelledByOrderId(orderId, userId) {
		await InventoryDeductionModel.ensureSchema();
		const [result] = await pool.execute(
			`UPDATE inventory_deductions
			 SET STATUS = -1, ACTIVE = 0, EDITED_BY = ?, EDITED_DT = NOW()
			 WHERE ORDER_ID = ? AND ACTIVE = 1`,
			[userId != null ? Number(userId) : null, Number(orderId)]
		);
		return result.affectedRows;
	}

	/** Reflect order status in inventory_deductions. Same values as orders: 3=PENDING, 2=CONFIRMED, 1=SETTLED, -1=CANCELLED */
	static async updateStatusByOrderId(orderId, orderStatus, userId) {
		await InventoryDeductionModel.ensureSchema();
		const status = Number(orderStatus);
		if (status === -1) {
			return InventoryDeductionModel.markCancelledByOrderId(orderId, userId);
		}
		const [result] = await pool.execute(
			`UPDATE inventory_deductions SET STATUS = ?, EDITED_BY = ?, EDITED_DT = NOW() WHERE ORDER_ID = ? AND ACTIVE = 1`,
			[status, userId != null ? Number(userId) : null, Number(orderId)]
		);
		return result.affectedRows;
	}

	static async hasActiveDeductionsForOrder(orderId) {
		await InventoryDeductionModel.ensureSchema();
		const [rows] = await pool.execute(
			`SELECT 1 FROM inventory_deductions WHERE ORDER_ID = ? AND ACTIVE = 1 LIMIT 1`,
			[Number(orderId)]
		);
		return rows.length > 0;
	}

	/** Get active deductions for a specific order item (for partial reversal when item is removed) */
	static async getByOrderItemId(orderItemId, activeOnly = true) {
		await InventoryDeductionModel.ensureSchema();
		let where = 'WHERE inv_ded.ORDER_ITEM_ID = ?';
		if (activeOnly) where += ' AND inv_ded.ACTIVE = 1';
		const [rows] = await pool.execute(
			`SELECT inv_ded.IDNo, inv_ded.ORDER_ID, inv_ded.ORDER_ITEM_ID, inv_ded.BRANCH_ID, inv_ded.INGREDIENT_ID, inv_ded.MENU_ID,
				inv_ded.DEDUCTED_QTY, inv_ded.UNIT, inv_ded.STATUS, inv_ded.ACTIVE
			 FROM inventory_deductions inv_ded
			 ${where}
			 ORDER BY inv_ded.ENCODED_DT ASC`,
			[Number(orderItemId)]
		);
		return rows;
	}
}

module.exports = InventoryDeductionModel;

InventoryDeductionModel.ensureSchema().catch((error) => {
	console.error('[INVENTORY DEDUCTION MODEL] Failed to ensure schema:', error.message);
});