// ============================================
// ORDER MODEL
// ============================================
// File: models/orderModel.js
// Description: Database queries for orders
// ============================================

const pool = require('../config/db');
const TableModel = require('./tableModel');
const { phLocalDayRangeFilter } = require('../utils/phDateRange');

class OrderModel {
	static async getAll(branchId = null, options = {}) {
		const {
			start_date: startDate = null,
			end_date: endDate = null,
			limit = null,
			includeItemMeta = false,
		} = options;

		// Latest payment via index lookup per returned row (ORDER_ID, IDNo) —
		// avoids aggregating the entire billing table for the branch on every list load.
		let query = `
			SELECT 
				o.IDNo,
				o.BRANCH_ID,
				b.BRANCH_NAME,
				b.BRANCH_CODE,
				b.BRANCH_NAME AS BRANCH_LABEL,
				o.ORDER_NO,
				o.TABLE_ID,
				o.FLOOR,
				t.TABLE_NUMBER,
				t.ROOM_CHARGE,
				o.ORDER_TYPE,
				o.STATUS,
				o.SUBTOTAL,
				o.TAX_AMOUNT,
				o.SERVICE_CHARGE,
				o.DISCOUNT_AMOUNT,
				o.GRAND_TOTAL,
				o.ENCODED_DT,
				o.ENCODED_BY,
				ui.FIRSTNAME AS ENCODED_BY_NAME,
				(SELECT bill.PAYMENT_METHOD
				   FROM billing bill
				  WHERE bill.ORDER_ID = o.IDNo
				  ORDER BY bill.IDNo DESC
				  LIMIT 1) AS payment_method,
				(SELECT bill.AMOUNT_PAID
				   FROM billing bill
				  WHERE bill.ORDER_ID = o.IDNo
				  ORDER BY bill.IDNo DESC
				  LIMIT 1) AS amount_paid,
				(SELECT bill.PAYMENT_REF
				   FROM billing bill
				  WHERE bill.ORDER_ID = o.IDNo
				  ORDER BY bill.IDNo DESC
				  LIMIT 1) AS payment_ref
				${includeItemMeta ? `,
				(SELECT COUNT(*) FROM order_items oi WHERE oi.ORDER_ID = o.IDNo AND oi.STATUS != -1) AS item_line_count,
				(SELECT COALESCE(SUM(oi.QTY), 0) FROM order_items oi WHERE oi.ORDER_ID = o.IDNo AND oi.STATUS != -1) AS item_total_qty` : ''}
			FROM orders o
			LEFT JOIN restaurant_tables t ON t.IDNo = o.TABLE_ID
			LEFT JOIN branches b ON b.IDNo = o.BRANCH_ID
			LEFT JOIN user_info ui ON ui.IDNo = o.ENCODED_BY
			WHERE 1=1
			  AND o.STATUS != -2
		`;

		const params = [];
		if (branchId) {
			query += ` AND o.BRANCH_ID = ?`;
			params.push(branchId);
		}
		const range = phLocalDayRangeFilter('o.ENCODED_DT', startDate, endDate, 'o.BRANCH_ID');
		if (range.sql) {
			query += range.sql;
			params.push(...range.params);
		}

		query += ` ORDER BY o.ENCODED_DT DESC`;

		const parsedLimit = limit != null ? parseInt(String(limit), 10) : 0;
		if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
			query += ` LIMIT ${Math.min(parsedLimit, 2000)}`;
		} else if (range.sql) {
			query += ` LIMIT 500`;
		} else {
			// Undated callers (e.g. waiter) — hard cap, never unbounded.
			query += ` LIMIT 2000`;
		}

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	/** Aggregate counts for list header cards — O(index range), not O(rows returned). */
	static async getListStats(branchId = null, options = {}) {
		const { start_date: startDate = null, end_date: endDate = null } = options;
		let query = `
			SELECT
				COUNT(*) AS total,
				COALESCE(SUM(o.STATUS = 3), 0) AS pending,
				COALESCE(SUM(o.STATUS = 2), 0) AS confirmed,
				COALESCE(SUM(o.STATUS = 1), 0) AS settled,
				COALESCE(SUM(o.STATUS = -1), 0) AS cancelled,
				COALESCE(SUM(CASE WHEN o.STATUS = 1 THEN o.GRAND_TOTAL ELSE 0 END), 0) AS totalRevenue
			FROM orders o
			WHERE o.STATUS != -2
		`;
		const params = [];
		if (branchId) {
			query += ` AND o.BRANCH_ID = ?`;
			params.push(branchId);
		}
		const range = phLocalDayRangeFilter('o.ENCODED_DT', startDate, endDate, 'o.BRANCH_ID');
		if (range.sql) {
			query += range.sql;
			params.push(...range.params);
		}
		const [rows] = await pool.execute(query, params);
		const r = rows[0] || {};
		return {
			total: Number(r.total) || 0,
			pending: Number(r.pending) || 0,
			confirmed: Number(r.confirmed) || 0,
			settled: Number(r.settled) || 0,
			cancelled: Number(r.cancelled) || 0,
			totalRevenue: Number(r.totalRevenue) || 0,
		};
	}

	static async getById(id) {
		const query = `
			SELECT 
				o.IDNo,
				o.BRANCH_ID,
				o.ORDER_NO,
				o.TABLE_ID,
				o.FLOOR,
				o.ORDER_TYPE,
				o.STATUS,
				o.SUBTOTAL,
				o.TAX_AMOUNT,
				o.SERVICE_CHARGE,
				o.DISCOUNT_AMOUNT,
				o.GRAND_TOTAL,
				(SELECT bill.PAYMENT_METHOD FROM billing bill WHERE bill.ORDER_ID = o.IDNo ORDER BY bill.IDNo DESC LIMIT 1) AS payment_method
			FROM orders o
			WHERE o.IDNo = ?
			LIMIT 1
		`;
		const [rows] = await pool.execute(query, [id]);
		return rows[0] || null;
	}

	static async findLatestByOrderNo(branchId, orderNo) {
		if (!branchId || !orderNo || String(orderNo).trim() === '') {
			return null;
		}
		const query = `
			SELECT IDNo, BRANCH_ID, ORDER_NO, STATUS, ENCODED_DT
			FROM orders
			WHERE BRANCH_ID = ? AND ORDER_NO = ? AND STATUS != -2
			ORDER BY IDNo DESC
			LIMIT 1
		`;
		const [rows] = await pool.execute(query, [branchId, String(orderNo).trim()]);
		return rows[0] || null;
	}

	// Find the table's already-open order (CONFIRMED=2 or PENDING=3), if any.
	// Used to stop a second order (and a second Room Charge) from being created
	// for a table that's already occupied by an unsettled order.
	static async getActiveByTable(branchId, tableId) {
		const id = tableId != null && tableId !== '' ? parseInt(tableId, 10) : NaN;
		if (!branchId || !Number.isFinite(id) || id <= 0) {
			return null;
		}
		const query = `
			SELECT IDNo, BRANCH_ID, ORDER_NO, TABLE_ID, STATUS
			FROM orders
			WHERE BRANCH_ID = ? AND TABLE_ID = ? AND STATUS IN (2, 3)
			ORDER BY IDNo DESC
			LIMIT 1
		`;
		const [rows] = await pool.execute(query, [branchId, id]);
		return rows[0] || null;
	}

	/**
	 * Floor ('gf' / '2f') an order belongs to, or null when unknown. A table's own
	 * FLOOR (set in Table Settings) wins; otherwise the creating account's
	 * user_info.FLOOR. Derived server-side so the client can't stamp an arbitrary
	 * floor. Never throws — a lookup failure must not block taking an order.
	 */
	static async resolveFloor(tableId, userId) {
		try {
			if (tableId) {
				const [tableRows] = await pool.execute('SELECT FLOOR FROM restaurant_tables WHERE IDNo = ? LIMIT 1', [tableId]);
				const tableFloor = TableModel.normalizeFloor(tableRows[0]?.FLOOR);
				if (tableFloor) return tableFloor;
			}
			if (userId) {
				const [userRows] = await pool.execute('SELECT FLOOR FROM user_info WHERE IDNo = ? LIMIT 1', [userId]);
				return TableModel.normalizeFloor(userRows[0]?.FLOOR);
			}
		} catch (err) {
			console.warn('[OrderModel] resolveFloor failed:', err.message || err);
		}
		return null;
	}

	static async create(data) {
		const {
			BRANCH_ID,
			ORDER_NO,
			TABLE_ID,
			ORDER_TYPE,
			STATUS,
			SUBTOTAL,
			TAX_AMOUNT,
			SERVICE_CHARGE,
			DISCOUNT_AMOUNT,
			GRAND_TOTAL,
			ENCODED_DT,
			user_id
		} = data;

		const hasEncodedDt = ENCODED_DT != null && String(ENCODED_DT).trim() !== '';
		// Callers that need the floor afterwards (e.g. to emit it) resolve it up front and pass FLOOR in.
		const floor = data.FLOOR !== undefined
			? TableModel.normalizeFloor(data.FLOOR)
			: await OrderModel.resolveFloor(TABLE_ID, user_id);

		const columnsBase = [
			'IDNo',
			'BRANCH_ID',
			'ORDER_NO',
			'TABLE_ID',
			'FLOOR',
			'ORDER_TYPE',
			'STATUS',
			'SUBTOTAL',
			'TAX_AMOUNT',
			'SERVICE_CHARGE',
			'DISCOUNT_AMOUNT',
			'GRAND_TOTAL',
			'ENCODED_BY',
		];

		// IDNo is app-assigned (not AUTO_INCREMENT), so the max-then-insert has to
		// be one atomic unit or two concurrent orders can compute the same next id.
		// `FOR UPDATE` inside a transaction locks the max row (IDNo is the PK) so a
		// second concurrent transaction blocks until this one commits, then re-reads
		// the now-correct max — the standard pattern for a manually-assigned PK.
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();
			const [idRows] = await connection.execute('SELECT COALESCE(MAX(IDNo), 0) + 1 AS nextId FROM orders FOR UPDATE');
			const nextId = Number(idRows?.[0]?.nextId) || 1;

			const valuesBase = [
				nextId,
				BRANCH_ID,
				ORDER_NO,
				TABLE_ID || null,
				floor,
				ORDER_TYPE || null,
				STATUS || 3,
				SUBTOTAL || 0,
				TAX_AMOUNT || 0,
				SERVICE_CHARGE || 0,
				DISCOUNT_AMOUNT || 0,
				GRAND_TOTAL || 0,
				user_id,
			];

			const query = hasEncodedDt
				? `
					INSERT INTO orders (
						${columnsBase.slice(0, -1).join(', ')},
						ENCODED_DT,
						${columnsBase[columnsBase.length - 1]}
					) VALUES (${valuesBase.slice(0, -1).map(() => '?').join(', ')}, ?, ?) `
				: `
					INSERT INTO orders (
						${columnsBase.join(', ')}
					) VALUES (${valuesBase.map(() => '?').join(', ')})
				`;

			const values = hasEncodedDt
				? valuesBase.slice(0, -1).concat([ENCODED_DT, valuesBase[valuesBase.length - 1]])
				: valuesBase;

			const [result] = await connection.execute(query, values);
			await connection.commit();
			return result.insertId || nextId;
		} catch (err) {
			await connection.rollback();
			throw err;
		} finally {
			connection.release();
		}
	}

	static async update(id, data) {
		const {
			TABLE_ID,
			ORDER_TYPE,
			STATUS,
			SUBTOTAL,
			TAX_AMOUNT,
			SERVICE_CHARGE,
			DISCOUNT_AMOUNT,
			GRAND_TOTAL,
			user_id
		} = data;

		const query = `
			UPDATE orders SET
				TABLE_ID = ?,
				ORDER_TYPE = ?,
				STATUS = ?,
				SUBTOTAL = ?,
				TAX_AMOUNT = ?,
				SERVICE_CHARGE = ?,
				DISCOUNT_AMOUNT = ?,
				GRAND_TOTAL = ?,
				EDITED_BY = ?,
				EDITED_DT = CURRENT_TIMESTAMP
			WHERE IDNo = ?
		`;

		const values = [
			TABLE_ID || null,
			ORDER_TYPE || null,
			STATUS || 3,
			SUBTOTAL || 0,
			TAX_AMOUNT || 0,
			SERVICE_CHARGE || 0,
			DISCOUNT_AMOUNT || 0,
			GRAND_TOTAL || 0,
			user_id,
			id
		];

		await pool.execute(query, values);
		return true; // Return true as long as no exception occurred
	}

	static async updateStatus(id, status, user_id) {
		const query = `
			UPDATE orders SET
				STATUS = ?,
				EDITED_BY = ?,
				EDITED_DT = CURRENT_TIMESTAMP
			WHERE IDNo = ?
		`;
		const [result] = await pool.execute(query, [status, user_id, id]);
		return result.affectedRows > 0;
	}

	// Get orders by user ID (for mobile app sync)
	static async getByUserId(userId, branchId = null) {
		let query = `
			SELECT 
				o.IDNo,
				o.BRANCH_ID,
				o.ORDER_NO,
				o.TABLE_ID,
				o.ORDER_TYPE,
				o.STATUS,
				o.SUBTOTAL,
				o.TAX_AMOUNT,
				o.SERVICE_CHARGE,
				o.DISCOUNT_AMOUNT,
				o.GRAND_TOTAL,
				o.ENCODED_DT,
				o.ENCODED_BY
			FROM orders o
			WHERE o.ENCODED_BY = ?
		`;

		const params = [userId];
		if (branchId) {
			query += ` AND o.BRANCH_ID = ?`;
			params.push(branchId);
		}

		query += ` ORDER BY o.ENCODED_DT DESC`;

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	// Get orders by table ID (for mobile app sync after login/restart)
	static async getByTableId(tableId, branchId = null) {
		let query = `
			SELECT 
				o.IDNo,
				o.BRANCH_ID,
				o.ORDER_NO,
				o.TABLE_ID,
				o.ORDER_TYPE,
				o.STATUS,
				o.SUBTOTAL,
				o.TAX_AMOUNT,
				o.SERVICE_CHARGE,
				o.DISCOUNT_AMOUNT,
				o.GRAND_TOTAL,
				o.ENCODED_DT,
				o.ENCODED_BY
			FROM orders o
			WHERE o.TABLE_ID = ? AND o.STATUS != 1
		`;

		const params = [tableId];
		if (branchId) {
			query += ` AND o.BRANCH_ID = ?`;
			params.push(branchId);
		}

		query += ` ORDER BY o.ENCODED_DT DESC`;

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	// Get orders by user ID or table ID (for mobile app sync)
	static async getByUserIdOrTableId(userId, tableId, branchId = null) {
		let query, params;
		
		if (tableId != null) {
			// Get orders by table_id (priority) or user_id, exclude SETTLED orders (STATUS = 1)
			query = `
				SELECT 
					o.IDNo,
					o.BRANCH_ID,
					o.ORDER_NO,
					o.TABLE_ID,
					o.FLOOR,
					o.ORDER_TYPE,
					o.STATUS,
					o.SUBTOTAL,
					o.TAX_AMOUNT,
					o.SERVICE_CHARGE,
					o.DISCOUNT_AMOUNT,
					o.GRAND_TOTAL,
					o.ENCODED_DT,
					o.ENCODED_BY
				FROM orders o
				WHERE (o.TABLE_ID = ? OR o.ENCODED_BY = ?) AND o.STATUS != 1
			`;
			params = [tableId, userId];
		} else {
			// Get orders by user_id only, exclude SETTLED orders
			query = `
				SELECT 
					o.IDNo,
					o.BRANCH_ID,
					o.ORDER_NO,
					o.TABLE_ID,
					o.FLOOR,
					o.ORDER_TYPE,
					o.STATUS,
					o.SUBTOTAL,
					o.TAX_AMOUNT,
					o.SERVICE_CHARGE,
					o.DISCOUNT_AMOUNT,
					o.GRAND_TOTAL,
					o.ENCODED_DT,
					o.ENCODED_BY
				FROM orders o
				WHERE o.ENCODED_BY = ? AND o.STATUS != 1
			`;
			params = [userId];
		}

		if (branchId) {
			query += ` AND o.BRANCH_ID = ?`;
			params.push(branchId);
		}

		query += ` ORDER BY o.ENCODED_DT DESC`;

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	// Get kitchen orders - orders that have items with PENDING (3) or PREPARING (2) status
	// Kitchen needs to see all active orders based on order_items status, not orders.status
	static async getKitchenOrders(branchId = null) {
		let query = `
			SELECT DISTINCT
				o.IDNo,
				o.BRANCH_ID,
				o.ORDER_NO,
				o.TABLE_ID,
				t.TABLE_NUMBER,
				o.ORDER_TYPE,
				o.STATUS,
				o.SUBTOTAL,
				o.TAX_AMOUNT,
				o.SERVICE_CHARGE,
				o.DISCOUNT_AMOUNT,
				o.GRAND_TOTAL,
				o.ENCODED_DT,
				o.ENCODED_BY
			FROM orders o
			LEFT JOIN restaurant_tables t ON t.IDNo = o.TABLE_ID
			INNER JOIN order_items oi ON oi.ORDER_ID = o.IDNo
			WHERE oi.STATUS IN (3, 2)  -- PENDING (3) or PREPARING (2) items
		`;

		const params = [];
		if (branchId) {
			query += ` AND o.BRANCH_ID = ?`;
			params.push(branchId);
		}

		query += ` ORDER BY o.ENCODED_DT ASC -- Oldest first (FIFO)`;

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	// Merge restaurant_tables.ROOM_CHARGE into orders.SERVICE_CHARGE
	// so GRAND_TOTAL always follows: SUBTOTAL + TAX + SERVICE_CHARGE - DISCOUNT.
	static async resolveServiceChargeWithRoomCharge(tableId, explicitServiceCharge) {
		const explicit = parseFloat(explicitServiceCharge) || 0;
		const id = tableId != null && tableId !== '' ? parseInt(tableId, 10) : NaN;
		if (!Number.isFinite(id) || id <= 0) {
			return Number(explicit.toFixed(2));
		}

		const table = await TableModel.getById(id);
		const room = parseFloat(table?.ROOM_CHARGE) || 0;
		return Number((room + explicit).toFixed(2));
	}

	static computeGrandTotal(subtotal, taxAmount, serviceCharge, discountAmount) {
		return Number(
			(
				(parseFloat(subtotal) || 0) +
				(parseFloat(taxAmount) || 0) +
				(parseFloat(serviceCharge) || 0) -
				(parseFloat(discountAmount) || 0)
			).toFixed(2)
		);
	}

	/** Normalize UI/API datetime to MySQL DATETIME `YYYY-MM-DD HH:MM:SS`. */
	static normalizeEncodedDt(raw) {
		const s = String(raw ?? '').trim().replace('T', ' ');
		const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
		if (!m) return null;
		return `${m[1]} ${m[2]}:${m[3]}:${m[4] ?? '00'}`;
	}

	/**
	 * Set ENCODED_DT on orders + related sales tables (same calendar timestamp).
	 */
	static async updateEncodedDtCascade(orderId, encodedDt, userId = null) {
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();

			// Manual/receipt orders embed their date in the number (ORD-YYYYMMDD-HHMMSS);
			// keep that date in step with ENCODED_DT. Other formats stay as-is.
			const [[current]] = await conn.execute(
				`SELECT ORDER_NO, BRANCH_ID FROM orders WHERE IDNo = ? FOR UPDATE`,
				[orderId]
			);
			let orderNo = current?.ORDER_NO ?? null;
			const orderNoMatch = String(orderNo ?? '').match(/^ORD-\d{8}-(\d{6})$/);
			if (orderNoMatch) {
				const nextOrderNo = `ORD-${encodedDt.slice(0, 10).replace(/-/g, '')}-${orderNoMatch[1]}`;
				if (nextOrderNo !== orderNo) {
					const [dupes] = await conn.execute(
						`SELECT IDNo FROM orders WHERE ORDER_NO = ? AND BRANCH_ID = ? AND IDNo <> ? LIMIT 1`,
						[nextOrderNo, current.BRANCH_ID, orderId]
					);
					if (dupes.length) {
						const err = new Error(`Order #${nextOrderNo} already exists`);
						err.code = 'ORDER_NO_CONFLICT';
						throw err;
					}
					orderNo = nextOrderNo;
				}
			}

			const [orderResult] = await conn.execute(
				`UPDATE orders
				 SET ENCODED_DT = ?, ORDER_NO = ?, EDITED_BY = COALESCE(?, EDITED_BY), EDITED_DT = CURRENT_TIMESTAMP
				 WHERE IDNo = ?`,
				[encodedDt, orderNo, userId, orderId]
			);
			const [billingResult] = await conn.execute(
				`UPDATE billing SET ENCODED_DT = ? WHERE ORDER_ID = ?`,
				[encodedDt, orderId]
			);
			const [itemsResult] = await conn.execute(
				`UPDATE order_items SET ENCODED_DT = ? WHERE ORDER_ID = ?`,
				[encodedDt, orderId]
			);
			const [payResult] = await conn.execute(
				`UPDATE payment_transactions SET ENCODED_DT = ? WHERE ORDER_ID = ?`,
				[encodedDt, orderId]
			);
			const [scanResult] = await conn.execute(
				`UPDATE receipt_scan_history SET ENCODED_DT = ? WHERE ORDER_ID = ?`,
				[encodedDt, orderId]
			);
			await conn.commit();
			return {
				order_no: orderNo,
				orders: orderResult.affectedRows,
				billing: billingResult.affectedRows,
				order_items: itemsResult.affectedRows,
				payment_transactions: payResult.affectedRows,
				receipt_scan_history: scanResult.affectedRows,
			};
		} catch (err) {
			await conn.rollback();
			throw err;
		} finally {
			conn.release();
		}
	}

	/** Soft delete: STATUS = -2 on orders and billing. */
	static async softDeleteCascade(orderId, userId = null) {
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			const [orderResult] = await conn.execute(
				`UPDATE orders
				 SET STATUS = -2, EDITED_BY = COALESCE(?, EDITED_BY), EDITED_DT = CURRENT_TIMESTAMP
				 WHERE IDNo = ?`,
				[userId, orderId]
			);
			const [billingResult] = await conn.execute(
				`UPDATE billing SET STATUS = -2 WHERE ORDER_ID = ?`,
				[orderId]
			);
			await conn.commit();
			return {
				orders: orderResult.affectedRows,
				billing: billingResult.affectedRows,
			};
		} catch (err) {
			await conn.rollback();
			throw err;
		} finally {
			conn.release();
		}
	}
}

module.exports = OrderModel;
