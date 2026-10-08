// ============================================
// BILLING MODEL
// ============================================
// File: models/billingModel.js
// Description: Database queries for billing records
// ============================================

const pool = require('../config/db');
const { phLocalDayRangeFilter } = require('../utils/phDateRange');

class BillingModel {
	static async getAll(branchId = null, options = {}) {
		const {
			start_date: startDate = null,
			end_date: endDate = null,
			limit = null,
		} = options;

		let query = `
			SELECT 
				b.IDNo,
				b.BRANCH_ID,
				br.BRANCH_NAME,
				br.BRANCH_CODE,
				br.BRANCH_NAME AS BRANCH_LABEL,
				b.ORDER_ID,
				o.ORDER_NO,
				o.TABLE_ID,
				t.TABLE_NUMBER,
				b.PAYMENT_METHOD,
				b.AMOUNT_DUE,
				b.AMOUNT_PAID,
				b.PAYMENT_REF,
				b.STATUS,
				b.ENCODED_BY,
				ui.FIRSTNAME AS ENCODED_BY_NAME,
				ui.FIRSTNAME AS ENCODED_BY_USERNAME,
				b.ENCODED_DT
			FROM billing b
			LEFT JOIN orders o ON o.IDNo = b.ORDER_ID
			LEFT JOIN restaurant_tables t ON t.IDNo = o.TABLE_ID
			LEFT JOIN branches br ON br.IDNo = b.BRANCH_ID
			LEFT JOIN user_info ui ON ui.IDNo = b.ENCODED_BY
			WHERE o.STATUS IN (2, 1)
		`;

		const params = [];
		if (branchId != null && branchId !== '' && String(branchId) !== 'all') {
			query += ` AND b.BRANCH_ID = ?`;
			params.push(branchId);
		}
		const range = phLocalDayRangeFilter('b.ENCODED_DT', startDate, endDate, 'b.BRANCH_ID');
		if (range.sql) {
			query += range.sql;
			params.push(...range.params);
		}

		query += ` ORDER BY b.ENCODED_DT DESC, b.IDNo DESC`;

		const parsedLimit = limit != null ? parseInt(String(limit), 10) : 0;
		if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
			query += ` LIMIT ${Math.min(parsedLimit, 2000)}`;
		} else {
			// Always cap list payloads so growth cannot unbounded-scan the table.
			query += ` LIMIT 500`;
		}

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	static async getListStats(branchId = null, options = {}) {
		const { start_date: startDate = null, end_date: endDate = null } = options;
		let query = `
			SELECT
				COALESCE(SUM(GREATEST(COALESCE(b.AMOUNT_DUE, 0) - COALESCE(b.AMOUNT_PAID, 0), 0)), 0) AS totalDue,
				COALESCE(SUM(b.AMOUNT_PAID), 0) AS totalPaid,
				COALESCE(SUM(b.STATUS = 1), 0) AS paidCount,
				COALESCE(SUM(b.STATUS = 2), 0) AS partialCount,
				COALESCE(SUM(b.STATUS = 3), 0) AS unpaidCount
			FROM billing b
			INNER JOIN orders o ON o.IDNo = b.ORDER_ID AND o.STATUS IN (2, 1)
			WHERE 1=1
		`;
		const params = [];
		if (branchId) {
			query += ` AND b.BRANCH_ID = ?`;
			params.push(branchId);
		}
		const range = phLocalDayRangeFilter('b.ENCODED_DT', startDate, endDate, 'b.BRANCH_ID');
		if (range.sql) {
			query += range.sql;
			params.push(...range.params);
		}
		const [rows] = await pool.execute(query, params);
		const r = rows[0] || {};
		return {
			totalDue: Number(r.totalDue) || 0,
			totalPaid: Number(r.totalPaid) || 0,
			paidCount: Number(r.paidCount) || 0,
			partialCount: Number(r.partialCount) || 0,
			unpaidCount: Number(r.unpaidCount) || 0,
		};
	}

	static async getByOrderId(orderId) {
		const query = `
			SELECT 
				b.IDNo,
				b.ORDER_ID,
				o.ORDER_NO,
				b.PAYMENT_METHOD,
				b.AMOUNT_DUE,
				b.AMOUNT_PAID,
				b.PAYMENT_REF,
				b.STATUS,
				b.ENCODED_BY,
				ui.FIRSTNAME AS ENCODED_BY_NAME,
				b.ENCODED_DT
			FROM billing b
			LEFT JOIN orders o ON o.IDNo = b.ORDER_ID
			LEFT JOIN user_info ui ON ui.IDNo = b.ENCODED_BY
			WHERE b.ORDER_ID = ?
			LIMIT 1
		`;

		const [rows] = await pool.execute(query, [orderId]);
		return rows[0] || null;
	}

	static async createForOrder(data) {
		const {
			branch_id,
			order_id,
			payment_method,
			amount_due,
			amount_paid,
			payment_ref,
			status,
			user_id,
			encoded_dt
		} = data;
		const encodedDtValue =
			encoded_dt != null && String(encoded_dt).trim() !== '' ? encoded_dt : null;

		const query = `
			INSERT INTO billing (
				IDNo,
				BRANCH_ID,
				ORDER_ID,
				PAYMENT_METHOD,
				AMOUNT_DUE,
				AMOUNT_PAID,
				PAYMENT_REF,
				STATUS,
				ENCODED_BY,
				ENCODED_DT
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`;

		// Same atomic max-then-insert as OrderModel.create — see that comment.
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();
			const [idRows] = await connection.execute('SELECT COALESCE(MAX(IDNo), 0) + 1 AS nextId FROM billing FOR UPDATE');
			const nextId = Number(idRows?.[0]?.nextId) || 1;

			await connection.execute(query, [
				nextId,
				branch_id,
				order_id,
				payment_method || 'CASH',
				amount_due || 0,
				amount_paid || 0,
				payment_ref || null,
				status || 3,
				user_id,
				encodedDtValue || new Date()
			]);
			await connection.commit();
		} catch (err) {
			await connection.rollback();
			throw err;
		} finally {
			connection.release();
		}
	}

	static async updateForOrder(orderId, data) {
		const {
			payment_method,
			amount_due,
			amount_paid,
			payment_ref,
			status,
			encoded_dt
		} = data;

		// Fetch current billing record to preserve values if they aren't provided
		const current = await this.getByOrderId(orderId);
		if (!current) return false;
		const encodedDtValue =
			encoded_dt != null && String(encoded_dt).trim() !== '' ? encoded_dt : null;

		const query = `
			UPDATE billing SET
				PAYMENT_METHOD = ?,
				AMOUNT_DUE = ?,
				AMOUNT_PAID = ?,
				PAYMENT_REF = ?,
				STATUS = ?,
				ENCODED_DT = COALESCE(?, ENCODED_DT)
			WHERE ORDER_ID = ?
		`;

		await pool.execute(query, [
			payment_method || current.PAYMENT_METHOD || 'CASH',
			amount_due !== undefined ? amount_due : current.AMOUNT_DUE,
			amount_paid !== undefined ? amount_paid : current.AMOUNT_PAID,
			payment_ref || current.PAYMENT_REF || null,
			status !== undefined ? status : current.STATUS,
			encodedDtValue,
			orderId
		]);
		return true;
	}

	static async recordTransaction(data) {
		const { order_id, payment_method, amount_paid, payment_ref, user_id, encoded_dt } = data;
		const encodedDtValue =
			encoded_dt != null && String(encoded_dt).trim() !== '' ? encoded_dt : null;
		const query = `
			INSERT INTO payment_transactions (
				IDNo, ORDER_ID, PAYMENT_METHOD, AMOUNT_PAID, PAYMENT_REF, ENCODED_BY, ENCODED_DT
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`;

		// Same atomic max-then-insert as OrderModel.create — see that comment.
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();
			const [idRows] = await connection.execute('SELECT COALESCE(MAX(IDNo), 0) + 1 AS nextId FROM payment_transactions FOR UPDATE');
			const nextId = Number(idRows?.[0]?.nextId) || 1;

			await connection.execute(query, [
				nextId,
				order_id,
				payment_method,
				amount_paid,
				payment_ref,
				user_id,
				encodedDtValue || new Date(),
			]);
			await connection.commit();
		} catch (err) {
			await connection.rollback();
			throw err;
		} finally {
			connection.release();
		}
	}

	static async getPaymentHistory(orderId) {
		const query = `SELECT * FROM payment_transactions WHERE ORDER_ID = ? ORDER BY ENCODED_DT DESC`;
		const [rows] = await pool.execute(query, [orderId]);
		return rows;
	}
}

module.exports = BillingModel;
