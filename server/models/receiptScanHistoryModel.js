// ============================================
// RECEIPT SCAN HISTORY MODEL
// ============================================

const pool = require('../config/db');

class ReceiptScanHistoryModel {
	static _schemaCache = null;

	static async getSchema() {
		if (this._schemaCache) return this._schemaCache;
		const [rows] = await pool.execute(
			`SELECT COLUMN_NAME, DATA_TYPE
			 FROM information_schema.COLUMNS
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipt_scan_history'`
		);
		const cols = new Map(rows.map((r) => [String(r.COLUMN_NAME).toUpperCase(), String(r.DATA_TYPE).toLowerCase()]));
		this._schemaCache = cols;
		return cols;
	}

	/**
	 * @param {object} row
	 * @param {number|string} row.branch_id
	 * @param {number|string|null} row.order_id
	 * @param {number|null} row.encoded_by
	 * @param {string} row.source
	 * @param {number|null} row.receipt_grand_total
	 * @param {Buffer|string|null} row.receipt_image
	 */
	static async create(row) {
		const schema = await this.getSchema();
		const cols = [];
		const params = [];

		const add = (name, value) => {
			if (!schema.has(String(name).toUpperCase())) return;
			cols.push(name);
			params.push(value);
		};
		const addIf = (name, value) => {
			if (value == null) return;
			if (typeof value === 'string' && value.trim() === '') return;
			add(name, value);
		};

		add('BRANCH_ID', row.branch_id);
		add('ORDER_ID', row.order_id != null && String(row.order_id).trim() !== '' ? Number(row.order_id) : null);
		add('ENCODED_BY', row.encoded_by ?? null);
		add('SOURCE', row.source || 'receiptscan');
		add('RECEIPT_GRAND_TOTAL', row.receipt_grand_total != null ? Number(row.receipt_grand_total) : null);
		add('RECEIPT_IMAGE', row.receipt_image ?? null);
		// Let DB default apply unless explicitly provided.
		addIf('ENCODED_DT', row.encoded_dt);

		const q = `INSERT INTO receipt_scan_history (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
		const [res] = await pool.execute(q, params);
		return res.insertId;
	}

	/** Minimal row for PATCH permission + returning stored image path after linking ORDER_ID. */
	static async getBranchAndImageById(id) {
		const [rows] = await pool.execute(
			`SELECT IDNo, BRANCH_ID, RECEIPT_IMAGE FROM receipt_scan_history WHERE IDNo = ? LIMIT 1`,
			[id]
		);
		return rows[0] || null;
	}

	static async updateOrderId(id, orderId, encodedDt = null) {
		const enc =
			encodedDt != null && String(encodedDt).trim() !== '' ? String(encodedDt).trim().slice(0, 19) : null;
		if (enc) {
			const [res] = await pool.execute(
				`UPDATE receipt_scan_history SET ORDER_ID = ?, ENCODED_DT = ? WHERE IDNo = ?`,
				[orderId, enc, id]
			);
			return res.affectedRows > 0;
		}
		const [res] = await pool.execute(`UPDATE receipt_scan_history SET ORDER_ID = ? WHERE IDNo = ?`, [
			orderId,
			id,
		]);
		return res.affectedRows > 0;
	}

	/**
	 * List rows without image blob (for tables).
	 * @param {number|string|null} branchId - null = all branches
	 * @param {number} limit
	 * @param {number} offset
	 * @param {{ sources?: string[] }} [options] - optional normalized SOURCE values (e.g. resto_admin, receiptlens)
	 */
	static async list(branchId, limit = 100, offset = 0, options = {}) {
		let sql = `
			SELECT
				h.IDNo,
				h.BRANCH_ID,
				b.BRANCH_NAME,
				h.ENCODED_DT,
				h.ENCODED_BY,
				ui.FIRSTNAME AS ENCODED_BY_FIRSTNAME,
				ui.LASTNAME AS ENCODED_BY_LASTNAME,
				h.SOURCE,
				h.ORDER_ID,
				o.ORDER_NO,
				o.SUBTOTAL AS ORDER_SUBTOTAL,
				o.SERVICE_CHARGE AS ORDER_SERVICE_CHARGE,
				o.GRAND_TOTAL AS ORDER_GRAND_TOTAL,
				h.RECEIPT_GRAND_TOTAL
			FROM receipt_scan_history h
			LEFT JOIN branches b ON b.IDNo = h.BRANCH_ID
			LEFT JOIN user_info ui ON ui.IDNo = h.ENCODED_BY
			LEFT JOIN orders o ON o.IDNo = h.ORDER_ID
			WHERE 1 = 1
				-- Exclude scan history entries linked to cancelled orders (STATUS = -2).
				AND (h.ORDER_ID IS NULL OR COALESCE(o.STATUS, 0) <> -2)
		`;
		const params = [];
		if (branchId != null && String(branchId).trim() !== '' && String(branchId) !== 'all') {
			sql += ` AND h.BRANCH_ID = ?`;
			params.push(branchId);
		}
		const rawSources = Array.isArray(options.sources) ? options.sources : [];
		const sources = rawSources
			.map((s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_'))
			.filter(Boolean);
		if (sources.length) {
			const placeholders = sources.map(() => '?').join(',');
			sql += ` AND LOWER(REPLACE(TRIM(COALESCE(h.SOURCE, '')), ' ', '_')) IN (${placeholders})`;
			params.push(...sources);
		}
		// Some MySQL/MariaDB builds reject bound parameters for LIMIT/OFFSET in prepared statements.
		// Inline clamped integers instead (branchId remains parameterized).
		const safeLimit = Math.min(Math.max(1, Number(limit) || 100), 500);
		const safeOffset = Math.max(0, Number(offset) || 0);
		sql += ` ORDER BY h.ENCODED_DT DESC, h.IDNo DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`;
		// Use text protocol to avoid server-side prepared statement LIMIT/OFFSET issues on some builds.
		const [rows] = await pool.query(sql, params);
		return rows;
	}

	static async getById(id) {
		const [rows] = await pool.execute(
			`
			SELECT
				h.IDNo,
				h.BRANCH_ID,
				h.ORDER_ID,
				o.ORDER_NO,
				o.SUBTOTAL AS ORDER_SUBTOTAL,
				o.SERVICE_CHARGE AS ORDER_SERVICE_CHARGE,
				o.GRAND_TOTAL AS ORDER_GRAND_TOTAL,
				h.RECEIPT_IMAGE,
				h.RECEIPT_GRAND_TOTAL,
				h.SOURCE,
				h.ENCODED_BY,
				h.ENCODED_DT,
				b.BRANCH_NAME,
				ui.FIRSTNAME AS ENCODED_BY_FIRSTNAME,
				ui.LASTNAME AS ENCODED_BY_LASTNAME
			FROM receipt_scan_history h
			LEFT JOIN branches b ON b.IDNo = h.BRANCH_ID
			LEFT JOIN user_info ui ON ui.IDNo = h.ENCODED_BY
			LEFT JOIN orders o ON o.IDNo = h.ORDER_ID
			WHERE h.IDNo = ?
			LIMIT 1
			`,
			[id]
		);
		return rows[0] || null;
	}

	static async getLatestByOrderId(orderId) {
		const oid = orderId != null && String(orderId).trim() !== '' ? Number(orderId) : NaN;
		if (!Number.isFinite(oid) || oid <= 0) return null;
		const [rows] = await pool.execute(
			`
			SELECT
				h.IDNo,
				h.BRANCH_ID,
				h.ORDER_ID,
				o.ORDER_NO,
				o.SUBTOTAL AS ORDER_SUBTOTAL,
				o.SERVICE_CHARGE AS ORDER_SERVICE_CHARGE,
				o.GRAND_TOTAL AS ORDER_GRAND_TOTAL,
				h.RECEIPT_IMAGE,
				h.RECEIPT_GRAND_TOTAL,
				h.SOURCE,
				h.ENCODED_BY,
				h.ENCODED_DT,
				b.BRANCH_NAME,
				ui.FIRSTNAME AS ENCODED_BY_FIRSTNAME,
				ui.LASTNAME AS ENCODED_BY_LASTNAME
			FROM receipt_scan_history h
			LEFT JOIN branches b ON b.IDNo = h.BRANCH_ID
			LEFT JOIN user_info ui ON ui.IDNo = h.ENCODED_BY
			LEFT JOIN orders o ON o.IDNo = h.ORDER_ID
			WHERE h.ORDER_ID = ?
			ORDER BY h.ENCODED_DT DESC, h.IDNo DESC
			LIMIT 1
			`,
			[oid]
		);
		return rows[0] || null;
	}

	static async getOrderBundleByReceiptImage(receiptImagePath) {
		const img = receiptImagePath != null && String(receiptImagePath).trim() !== '' ? String(receiptImagePath).trim() : null;
		if (!img) return { orderIds: [], orders: [], items: [] };

		const [idRows] = await pool.execute(
			`
			SELECT h.ORDER_ID, o.ORDER_NO
			FROM receipt_scan_history h
			LEFT JOIN orders o ON o.IDNo = h.ORDER_ID
			WHERE h.RECEIPT_IMAGE = ? AND h.ORDER_ID IS NOT NULL
			ORDER BY h.IDNo ASC
			`,
			[img]
		);
		const orderIds = (idRows || [])
			.map((r) => (r?.ORDER_ID != null ? Number(r.ORDER_ID) : null))
			.filter((x) => Number.isFinite(x) && x > 0);
		if (!orderIds.length) return { orderIds: [], orders: [], items: [] };

		const placeholders = orderIds.map(() => '?').join(', ');

		const [orders] = await pool.execute(
			`
			SELECT
				o.IDNo AS ORDER_ID,
				o.ORDER_NO,
				o.ORDER_TYPE,
				o.TABLE_ID,
				t.TABLE_NUMBER,
				o.SUBTOTAL,
				o.SERVICE_CHARGE,
				o.GRAND_TOTAL,
				o.ENCODED_DT
			FROM orders o
			LEFT JOIN restaurant_tables t ON t.IDNo = o.TABLE_ID
			WHERE o.IDNo IN (${placeholders})
			ORDER BY FIELD(o.IDNo, ${placeholders})
			`,
			[...orderIds, ...orderIds]
		);

		const [items] = await pool.execute(
			`
			SELECT
				oi.ORDER_ID,
				oi.IDNo AS ORDER_ITEM_ID,
				oi.MENU_ID,
				(SELECT m.MENU_NAME FROM menu m WHERE m.IDNo = oi.MENU_ID LIMIT 1) AS MENU_NAME,
				oi.QTY,
				oi.UNIT_PRICE,
				oi.LINE_TOTAL,
				oi.REMARKS,
				oi.STATUS
			FROM order_items oi
			WHERE oi.ORDER_ID IN (${placeholders})
			ORDER BY oi.ORDER_ID ASC, oi.IDNo ASC
			`,
			[...orderIds]
		);

		return { orderIds, orders: orders || [], items: items || [] };
	}
}

module.exports = ReceiptScanHistoryModel;
