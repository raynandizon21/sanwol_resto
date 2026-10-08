// ============================================
// ORDER ITEMS MODEL
// ============================================
// File: models/orderItemsModel.js
// Description: Database queries for order items
// ============================================

const pool = require('../config/db');

class OrderItemsModel {
	static async getByOrderId(orderId) {
		// Use scalar subqueries for menu/user labels — a JOIN against `menu` can multiply rows if
		// duplicate MENU_ID rows exist in `menu`, which makes the Orders detail view show inflated line lists.
		const query = `
			SELECT
				oi.IDNo,
				oi.ORDER_ID,
				oi.MENU_ID,
				(SELECT m.MENU_NAME FROM menu m WHERE m.IDNo = oi.MENU_ID ORDER BY m.IDNo ASC LIMIT 1) AS MENU_NAME,
				oi.QTY,
				oi.UNIT_PRICE,
				oi.LINE_TOTAL,
				oi.STATUS,
				oi.REMARKS,
				oi.EDITED_BY,
				(SELECT u.FIRSTNAME FROM user_info u WHERE u.IDNo = oi.EDITED_BY LIMIT 1) AS PREPARED_BY
			FROM order_items oi
			WHERE oi.ORDER_ID = ?
			ORDER BY oi.ENCODED_DT ASC
		`;

		const [rows] = await pool.execute(query, [orderId]);
		return rows;
	}

	/**
	 * Same shape as getByOrderId but for many orders in ONE query — used by
	 * list endpoints (e.g. waiter orders) that used to call getByOrderId once
	 * per order in a loop (N+1 queries; the dominant slowdown on branches
	 * with a lot of order history). Returns a Map<orderId, items[]> so
	 * callers can look items up per order the same way a per-order fetch
	 * would have returned them.
	 */
	static async getByOrderIds(orderIds) {
		const ids = [...new Set(orderIds)].filter((id) => id != null);
		if (ids.length === 0) return new Map();

		const placeholders = ids.map(() => '?').join(',');
		const query = `
			SELECT
				oi.IDNo,
				oi.ORDER_ID,
				oi.MENU_ID,
				(SELECT m.MENU_NAME FROM menu m WHERE m.IDNo = oi.MENU_ID ORDER BY m.IDNo ASC LIMIT 1) AS MENU_NAME,
				oi.QTY,
				oi.UNIT_PRICE,
				oi.LINE_TOTAL,
				oi.STATUS,
				oi.REMARKS,
				oi.EDITED_BY,
				(SELECT u.FIRSTNAME FROM user_info u WHERE u.IDNo = oi.EDITED_BY LIMIT 1) AS PREPARED_BY
			FROM order_items oi
			WHERE oi.ORDER_ID IN (${placeholders})
			ORDER BY oi.ORDER_ID ASC, oi.ENCODED_DT ASC
		`;

		const [rows] = await pool.query(query, ids);
		const byOrderId = new Map();
		for (const row of rows) {
			const list = byOrderId.get(row.ORDER_ID);
			if (list) {
				list.push(row);
			} else {
				byOrderId.set(row.ORDER_ID, [row]);
			}
		}
		return byOrderId;
	}

	static async createForOrder(orderId, items, user_id, encoded_dt = null) {
		if (!items.length) {
			return;
		}
		const encodedDtValue =
			encoded_dt != null && String(encoded_dt).trim() !== '' ? encoded_dt : null;
		const query = `
			INSERT INTO order_items (
				ORDER_ID,
				MENU_ID,
				QTY,
				UNIT_PRICE,
				LINE_TOTAL,
				STATUS,
				REMARKS,
				ENCODED_BY,
				ENCODED_DT
			) VALUES ?
		`;

		const values = items.map(item => [
			orderId,
			item.menu_id,
			item.qty,
			item.unit_price,
			item.line_total,
			item.status || 3,  // Default: 3=PENDING
			item.remarks || item.notes || null,
			user_id,
			encodedDtValue || new Date()
		]);

		await pool.query(query, [values]);
	}

	static async replaceForOrder(orderId, items, user_id, encoded_dt = null) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();
			await connection.execute('DELETE FROM order_items WHERE ORDER_ID = ?', [orderId]);

			if (items.length) {
				const encodedDtValue =
					encoded_dt != null && String(encoded_dt).trim() !== '' ? encoded_dt : null;
				const query = `
					INSERT INTO order_items (
						ORDER_ID,
						MENU_ID,
						QTY,
						UNIT_PRICE,
						LINE_TOTAL,
						STATUS,
						REMARKS,
						ENCODED_BY,
						ENCODED_DT
					) VALUES ?
				`;

				const values = items.map(item => [
					orderId,
					item.menu_id,
					item.qty,
					item.unit_price,
					item.line_total,
					item.status || 3,  // Default: 3=PENDING
					item.remarks || item.notes || null,
					user_id,
					encodedDtValue || new Date()
				]);

				await connection.query(query, [values]);
			}

			await connection.commit();
		} catch (err) {
			await connection.rollback();
			throw err;
		} finally {
			connection.release();
		}
	}

	static async updateStatus(id, status, user_id) {
		const query = `
			UPDATE order_items 
			SET STATUS = ?, EDITED_BY = ?, EDITED_DT = CURRENT_TIMESTAMP
			WHERE IDNo = ?
		`;
		const [result] = await pool.execute(query, [status, user_id, id]);
		return result.affectedRows > 0;
	}
}

module.exports = OrderItemsModel;
