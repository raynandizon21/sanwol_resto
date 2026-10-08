/**
 * Idempotent DDL: add order_items.LINE_COST if missing (per-line product cost used for gross profit).
 */
const pool = require('../config/db');

async function ensureOrderItemsLineCostColumn() {
	const connection = await pool.getConnection();
	try {
		const [rows] = await connection.execute(
			`SELECT 1 FROM information_schema.COLUMNS
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'LINE_COST'
			 LIMIT 1`
		);
		if (rows.length > 0) {
			return;
		}
		await connection.execute(
			`ALTER TABLE order_items
			 ADD COLUMN LINE_COST DECIMAL(12,2) NULL DEFAULT NULL
			 COMMENT 'Per-line product cost (report Product unit price column); used for gross profit'
			 AFTER LINE_TOTAL`
		);
		console.log('[Schema] order_items.LINE_COST created');
	} catch (err) {
		console.error('[Schema] ensure order_items.LINE_COST failed:', err.message || err);
	} finally {
		connection.release();
	}
}

/**
 * orders.FLOOR ('gf' / '2f' / NULL): the floor an order belongs to, stamped at
 * creation (see OrderModel.create). Lets floor-scoped tablet accounts filter
 * orders that have no table (takeout) and orders on tables with no FLOOR set.
 */
async function ensureOrdersFloorColumn() {
	const connection = await pool.getConnection();
	try {
		const [rows] = await connection.execute(
			`SELECT 1 FROM information_schema.COLUMNS
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'FLOOR'
			 LIMIT 1`
		);
		if (rows.length > 0) {
			return;
		}
		await connection.execute(
			`ALTER TABLE orders
			 ADD COLUMN FLOOR VARCHAR(10) NULL DEFAULT NULL
			 AFTER TABLE_ID`
		);
		console.log('[Schema] orders.FLOOR created');
	} catch (err) {
		console.error('[Schema] ensure orders.FLOOR failed:', err.message || err);
	} finally {
		connection.release();
	}
}

/**
 * restaurant_tables columns set from the Table Settings page:
 * - FLOOR ('gf' / '2f' / NULL): only multi-floor branches (FLOOR_ENABLED_BRANCH_IDS in src/utils/floorScope.ts) set it.
 * - ROOM_CHARGE: per-table room/service charge used by tableModel and the Orders UI.
 */
async function ensureRestaurantTablesColumns() {
	const columns = [
		{ name: 'FLOOR', ddl: 'ADD COLUMN FLOOR VARCHAR(10) NULL DEFAULT NULL AFTER TABLE_NUMBER' },
		{ name: 'ROOM_CHARGE', ddl: 'ADD COLUMN ROOM_CHARGE DECIMAL(12,2) NULL DEFAULT NULL AFTER CAPACITY' },
	];
	const connection = await pool.getConnection();
	try {
		for (const col of columns) {
			const [rows] = await connection.execute(
				`SELECT 1 FROM information_schema.COLUMNS
				 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurant_tables' AND COLUMN_NAME = ?
				 LIMIT 1`,
				[col.name]
			);
			if (rows.length > 0) continue;
			await connection.execute(`ALTER TABLE restaurant_tables ${col.ddl}`);
			console.log(`[Schema] restaurant_tables.${col.name} created`);
		}
	} catch (err) {
		console.error('[Schema] ensure restaurant_tables columns failed:', err.message || err);
	} finally {
		connection.release();
	}
}

async function ensureReceiptScanHistoryTable() {
	const connection = await pool.getConnection();
	try {
		const [rows] = await connection.execute(
			`SELECT 1 FROM information_schema.TABLES
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipt_scan_history'
			 LIMIT 1`
		);
		if (rows.length === 0) {
			// Align to existing installs: store image as path (varchar), not blob.
			await connection.query(`
				CREATE TABLE receipt_scan_history (
					IDNo INT NOT NULL AUTO_INCREMENT,
					BRANCH_ID INT NOT NULL,
					ORDER_ID INT(11) NULL,
					RECEIPT_IMAGE VARCHAR(255) NULL,
					RECEIPT_GRAND_TOTAL DECIMAL(14, 2) NULL,
					SOURCE VARCHAR(255) NOT NULL DEFAULT 'receiptscan',
					ENCODED_BY INT NULL,
					ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
					PRIMARY KEY (IDNo),
					KEY idx_rsh_branch_dt (BRANCH_ID, ENCODED_DT),
					KEY idx_rsh_encoded_dt (ENCODED_DT),
					KEY idx_rsh_order_id (ORDER_ID),
					CONSTRAINT fk_receipt_order FOREIGN KEY (ORDER_ID) REFERENCES orders(IDNo)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
			`);
			console.log('[Schema] receipt_scan_history created');
			return;
		}

		// Table exists: align to ORDER_ID FK schema.
		const [cols] = await connection.execute(
			`SELECT COLUMN_NAME, DATA_TYPE
			 FROM information_schema.COLUMNS
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipt_scan_history'`
		);
		const byName = new Set(cols.map((c) => String(c.COLUMN_NAME).toUpperCase()));

		// 1) Rename ORDER_NO -> ORDER_ID (if needed)
		if (!byName.has('ORDER_ID') && byName.has('ORDER_NO')) {
			try {
				await connection.query('SET FOREIGN_KEY_CHECKS = 0');
				await connection.execute(`ALTER TABLE receipt_scan_history CHANGE ORDER_NO ORDER_ID INT(11) NULL`);
			} finally {
				await connection.query('SET FOREIGN_KEY_CHECKS = 1');
			}
			console.log('[Schema] receipt_scan_history.ORDER_NO renamed to ORDER_ID');
		}

		// 2) Add ORDER_ID column if missing
		if (!byName.has('ORDER_ID')) {
			await connection.execute(`ALTER TABLE receipt_scan_history ADD COLUMN ORDER_ID INT(11) NULL AFTER BRANCH_ID`);
			console.log('[Schema] receipt_scan_history.ORDER_ID created');
		}

		// 3) Add FK if missing
		const [fkRows] = await connection.execute(
			`SELECT CONSTRAINT_NAME
			 FROM information_schema.KEY_COLUMN_USAGE
			 WHERE TABLE_SCHEMA = DATABASE()
			   AND TABLE_NAME = 'receipt_scan_history'
			   AND COLUMN_NAME = 'ORDER_ID'
			   AND REFERENCED_TABLE_NAME = 'orders'
			   AND REFERENCED_COLUMN_NAME = 'IDNo'
			 LIMIT 1`
		);
		if (!Array.isArray(fkRows) || fkRows.length === 0) {
			try {
				await connection.query('SET FOREIGN_KEY_CHECKS = 0');
				await connection.execute(
					`ALTER TABLE receipt_scan_history
					 ADD CONSTRAINT fk_receipt_order
					 FOREIGN KEY (ORDER_ID) REFERENCES orders(IDNo)`
				);
			} finally {
				await connection.query('SET FOREIGN_KEY_CHECKS = 1');
			}
			console.log('[Schema] receipt_scan_history fk_receipt_order created');
		}
	} catch (err) {
		console.error('[Schema] ensure receipt_scan_history failed:', err.message || err);
	} finally {
		connection.release();
	}
}

async function ensureTelegramSettingsTable() {
	try {
		const TelegramSettingsModel = require('../models/telegramSettingsModel');
		await TelegramSettingsModel.ensureSchema();
	} catch (err) {
		console.error('[Schema] ensure telegram_settings failed:', err.message || err);
	}
}

/**
 * UI allows BANK; older DBs may only have enum('CASH','GCASH','MAYA','CARD').
 */
async function ensureBankPaymentMethodEnum() {
	const tables = ['billing', 'payment_transactions'];
	const connection = await pool.getConnection();
	try {
		for (const tableName of tables) {
			const [cols] = await connection.execute(
				`SELECT COLUMN_TYPE
				 FROM information_schema.COLUMNS
				 WHERE TABLE_SCHEMA = DATABASE()
				   AND TABLE_NAME = ?
				   AND COLUMN_NAME = 'PAYMENT_METHOD'
				 LIMIT 1`,
				[tableName]
			);
			if (!cols.length) continue;

			const columnType = String(cols[0].COLUMN_TYPE || '');
			const match = columnType.match(/^enum\((.*)\)$/i);
			if (!match || /'BANK'/i.test(columnType)) continue;

			await connection.execute(
				`ALTER TABLE \`${tableName}\`
				 MODIFY COLUMN PAYMENT_METHOD enum(${match[1]},'BANK')
				 CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL`
			);
			console.log(`[Schema] ${tableName}.PAYMENT_METHOD now includes BANK`);
		}
	} catch (err) {
		console.error('[Schema] ensure BANK payment method enum failed:', err.message || err);
	} finally {
		connection.release();
	}
}

/**
 * Critical analytics indexes — without these, category/top-selling scan all order_items.
 * Also covering indexes so list pages stay fast as order/billing/inventory grow.
 */
async function ensureAnalyticsPerformanceIndexes() {
	const connection = await pool.getConnection();
	const indexes = [
		{
			table: 'orders',
			name: 'idx_orders_branch_encoded',
			ddl: 'CREATE INDEX idx_orders_branch_encoded ON orders (BRANCH_ID, ENCODED_DT)',
		},
		{
			table: 'orders',
			name: 'idx_orders_branch_status_encoded',
			ddl: 'CREATE INDEX idx_orders_branch_status_encoded ON orders (BRANCH_ID, STATUS, ENCODED_DT)',
		},
		{
			table: 'menu',
			name: 'idx_menu_branch_active',
			ddl: 'CREATE INDEX idx_menu_branch_active ON menu (BRANCH_ID, ACTIVE)',
		},
		{
			table: 'order_items',
			name: 'idx_order_items_order_id',
			ddl: 'CREATE INDEX idx_order_items_order_id ON order_items (ORDER_ID)',
		},
		{
			table: 'order_items',
			name: 'idx_order_items_menu_id',
			ddl: 'CREATE INDEX idx_order_items_menu_id ON order_items (MENU_ID)',
		},
		{
			table: 'billing',
			name: 'idx_billing_branch_encoded',
			ddl: 'CREATE INDEX idx_billing_branch_encoded ON billing (BRANCH_ID, ENCODED_DT)',
		},
		{
			table: 'billing',
			name: 'idx_billing_status_encoded',
			ddl: 'CREATE INDEX idx_billing_status_encoded ON billing (STATUS, ENCODED_DT)',
		},
		{
			table: 'billing',
			name: 'idx_billing_order_idno',
			ddl: 'CREATE INDEX idx_billing_order_idno ON billing (ORDER_ID, IDNo)',
		},
		{
			table: 'expenses',
			name: 'idx_expenses_branch_encoded',
			ddl: 'CREATE INDEX idx_expenses_branch_encoded ON expenses (BRANCH_ID, ENCODED_DT)',
		},
		{
			table: 'inventory',
			name: 'idx_inventory_branch_active_ing',
			ddl: 'CREATE INDEX idx_inventory_branch_active_ing ON inventory (BRANCH_ID, ACTIVE, INGREDIENT_ID)',
		},
		{
			table: 'ingredients',
			name: 'idx_ingredients_branch_active_cat',
			ddl: 'CREATE INDEX idx_ingredients_branch_active_cat ON ingredients (BRANCH_ID, ACTIVE, MASTER_CAT_ID)',
		},
		{
			table: 'master_categories',
			name: 'idx_master_categories_branch_active_op',
			ddl: 'CREATE INDEX idx_master_categories_branch_active_op ON master_categories (BRANCH_ID, ACTIVE, OP_CAT_ID)',
		},
	];
	try {
		for (const idx of indexes) {
			const [rows] = await connection.execute(
				`SELECT 1 FROM information_schema.STATISTICS
				 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
				 LIMIT 1`,
				[idx.table, idx.name],
			);
			if (rows.length > 0) continue;
			try {
				await connection.query(idx.ddl);
				console.log(`[Schema] ${idx.name} created on ${idx.table}`);
			} catch (err) {
				console.warn(`[Schema] ${idx.name} skipped:`, err.message || err);
			}
		}
	} catch (err) {
		console.error('[Schema] ensureAnalyticsPerformanceIndexes failed:', err.message || err);
	} finally {
		connection.release();
	}
}

module.exports = {
	ensureOrderItemsLineCostColumn,
	ensureOrdersFloorColumn,
	ensureRestaurantTablesColumns,
	ensureReceiptScanHistoryTable,
	ensureTelegramSettingsTable,
	ensureBankPaymentMethodEnum,
	ensureAnalyticsPerformanceIndexes,
};
