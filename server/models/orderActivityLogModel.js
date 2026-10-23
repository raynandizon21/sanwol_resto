// ============================================
// ORDER ACTIVITY LOG MODEL
// ============================================
// File: models/orderActivityLogModel.js
// Description: What the tablets (menu / cashier) did to orders — new order,
// items added / edited, transferred, confirmed, cancelled, settled. Read by the
// cashier app's Activity tab (GET /api/activity-logs).
// ============================================

const pool = require('../config/db');
const { phLocalDtSql } = require('../utils/businessDay');
const { phLocalDayRangeFilter } = require('../utils/phDateRange');

class OrderActivityLogModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	/** Creates order_activity_logs on first use (idempotent). */
	static async ensureSchema() {
		if (OrderActivityLogModel._schemaReady) return;
		if (OrderActivityLogModel._schemaPromise) return OrderActivityLogModel._schemaPromise;

		OrderActivityLogModel._schemaPromise = (async () => {
			await pool.execute(`
				CREATE TABLE IF NOT EXISTS order_activity_logs (
					IDNo INT NOT NULL AUTO_INCREMENT,
					BRANCH_ID INT DEFAULT NULL,
					ORDER_ID INT DEFAULT NULL,
					ORDER_NO VARCHAR(100) DEFAULT NULL,
					TABLE_NUMBER VARCHAR(100) DEFAULT NULL,
					FLOOR VARCHAR(10) DEFAULT NULL,
					ACTION VARCHAR(30) NOT NULL,
					SUMMARY VARCHAR(500) NOT NULL DEFAULT '',
					DETAILS TEXT NULL,
					AMOUNT DECIMAL(12,2) DEFAULT NULL,
					USER_ID INT DEFAULT NULL,
					CREATED_DT DATETIME DEFAULT CURRENT_TIMESTAMP,
					PRIMARY KEY (IDNo),
					KEY idx_order_activity_branch_created (BRANCH_ID, CREATED_DT),
					KEY idx_order_activity_order (ORDER_ID)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
			`);
			OrderActivityLogModel._schemaReady = true;
			OrderActivityLogModel._schemaPromise = null;
		})().catch((error) => {
			OrderActivityLogModel._schemaPromise = null;
			OrderActivityLogModel._schemaReady = false;
			throw error;
		});

		return OrderActivityLogModel._schemaPromise;
	}

	/**
	 * Records one action. Never throws: a failed log must not fail the order
	 * change it describes.
	 * @param {object} e
	 * @param {number|string|null} e.branchId
	 * @param {number|string|null} e.orderId
	 * @param {string|null} e.orderNo
	 * @param {string|null} e.tableNumber
	 * @param {string|null} e.floor
	 * @param {string} e.action order_created | items_added | items_edited | transferred | confirmed | cancelled | settled
	 * @param {string} e.summary one-line description
	 * @param {object|null} [e.details] JSON details (items, payment, from/to table…)
	 * @param {number|null} [e.amount]
	 * @param {number|string|null} e.userId
	 */
	static async log(e) {
		try {
			await OrderActivityLogModel.ensureSchema();
			await pool.execute(
				`INSERT INTO order_activity_logs
					(BRANCH_ID, ORDER_ID, ORDER_NO, TABLE_NUMBER, FLOOR, ACTION, SUMMARY, DETAILS, AMOUNT, USER_ID)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					e.branchId != null ? parseInt(e.branchId, 10) || null : null,
					e.orderId != null ? parseInt(e.orderId, 10) || null : null,
					e.orderNo || null,
					e.tableNumber || null,
					e.floor || null,
					e.action,
					String(e.summary || '').slice(0, 500),
					e.details ? JSON.stringify(e.details) : null,
					e.amount != null && Number.isFinite(Number(e.amount)) ? Number(e.amount) : null,
					e.userId != null ? parseInt(e.userId, 10) || null : null,
				]
			);
		} catch (error) {
			console.error('[ACTIVITY LOG] failed to record:', error.message || error);
		}
	}

	/** order_items rows (getByOrderId) -> [{ name, qty, line_total }] for DETAILS. */
	static itemsOf(rows) {
		return (rows || []).map((it) => ({
			name: it.MENU_NAME || it.menu_name || 'Item',
			qty: parseFloat(it.QTY ?? it.qty ?? 0),
			line_total: parseFloat(it.LINE_TOTAL ?? it.line_total ?? 0),
		}));
	}

	/** "2× Pork Belly, 1× Rice +2 more" */
	static itemsText(items) {
		const fmt = (q) => (Number(q) % 1 === 0 ? String(Number(q)) : Number(q).toFixed(2));
		const parts = items.slice(0, 3).map((i) => `${fmt(i.qty)}× ${i.name}`);
		if (items.length > 3) parts.push(`+${items.length - 3} more`);
		return parts.join(', ');
	}

	static peso(n) {
		return `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	}

	/**
	 * Before/after order_items rows -> what an edit changed, per menu item:
	 * { added: [{name, qty}], removed: [{name, qty}], changed: [{name, from, to}] }.
	 */
	static diffItems(beforeRows, afterRows) {
		const sum = (rows) => {
			const map = new Map();
			for (const r of rows || []) {
				const key = String(r.MENU_ID ?? r.menu_id ?? r.MENU_NAME);
				const cur = map.get(key) || { name: r.MENU_NAME || 'Item', qty: 0 };
				cur.qty += parseFloat(r.QTY || 0);
				map.set(key, cur);
			}
			return map;
		};
		const before = sum(beforeRows);
		const after = sum(afterRows);
		const added = [];
		const removed = [];
		const changed = [];
		for (const [key, a] of after) {
			const b = before.get(key);
			if (!b) added.push({ name: a.name, qty: a.qty });
			else if (Math.abs(b.qty - a.qty) > 0.0001) changed.push({ name: a.name, from: b.qty, to: a.qty });
		}
		for (const [key, b] of before) {
			if (!after.has(key)) removed.push({ name: b.name, qty: b.qty });
		}
		return { added, removed, changed };
	}

	/**
	 * One branch's activity on a business day (YYYY-MM-DD, Asia/Manila), newest
	 * first. created_at is Manila wall-clock time.
	 */
	static async listForDay(branchId, ymd) {
		await OrderActivityLogModel.ensureSchema();
		const range = phLocalDayRangeFilter('l.CREATED_DT', ymd, ymd, 'l.BRANCH_ID');
		const params = [];
		let where = 'WHERE 1=1';
		if (branchId != null && branchId !== '') {
			where += ' AND l.BRANCH_ID = ?';
			params.push(parseInt(branchId, 10));
		}
		const [rows] = await pool.execute(
			`SELECT
				l.IDNo AS id,
				l.ORDER_ID AS order_id,
				l.ORDER_NO AS order_no,
				l.TABLE_NUMBER AS table_number,
				l.FLOOR AS floor,
				l.ACTION AS action,
				l.SUMMARY AS summary,
				l.DETAILS AS details,
				l.AMOUNT AS amount,
				u.USERNAME AS username,
				NULLIF(TRIM(CONCAT(COALESCE(u.FIRSTNAME, ''), ' ', COALESCE(u.LASTNAME, ''))), '') AS user_fullname,
				ur.ROLE AS user_role,
				DATE_FORMAT(${phLocalDtSql('l.CREATED_DT')}, '%Y-%m-%d %H:%i:%s') AS created_at
			 FROM order_activity_logs l
			 LEFT JOIN user_info u ON u.IDNo = l.USER_ID
			 LEFT JOIN user_role ur ON ur.IDNo = u.PERMISSIONS
			 ${where}${range.sql}
			 ORDER BY l.CREATED_DT DESC, l.IDNo DESC
			 LIMIT 1000`,
			[...params, ...range.params]
		);
		return rows.map((r) => {
			let details = null;
			if (r.details) {
				try {
					details = JSON.parse(r.details);
				} catch (_) {
					details = null;
				}
			}
			return {
				...r,
				details,
				amount: r.amount != null ? parseFloat(r.amount) : null,
			};
		});
	}
}

module.exports = OrderActivityLogModel;
