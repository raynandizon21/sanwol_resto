// ============================================
// TABLE MODEL
// ============================================
// File: models/tableModel.js
// Description: Database operations for restaurant tables
// ============================================

const pool = require('../config/db');
const socketService = require('../utils/socketService');

class TableModel {
	// Get all restaurant tables
	static async getAll(branchId = null) {
		let query = `
			SELECT 
				rt.IDNo,
				rt.BRANCH_ID,
				b.BRANCH_NAME,
				b.BRANCH_CODE,
				b.BRANCH_NAME AS BRANCH_LABEL,
				rt.TABLE_NUMBER,
				rt.FLOOR,
				rt.CAPACITY,
				rt.ROOM_CHARGE,
				rt.STATUS,
				rt.ENCODED_BY,
				rt.ENCODED_DT
			FROM restaurant_tables rt
			LEFT JOIN branches b ON b.IDNo = rt.BRANCH_ID
			WHERE rt.ACTIVE = 1
		`;

		const params = [];
		if (branchId) {
			query += ` AND rt.BRANCH_ID = ?`;
			params.push(branchId);
		}

		query += ` ORDER BY rt.TABLE_NUMBER ASC`;

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	// Get single table by ID
	static async getById(id) {
		const query = `
			SELECT
				IDNo,
				BRANCH_ID,
				TABLE_NUMBER,
				FLOOR,
				CAPACITY,
				ROOM_CHARGE,
				STATUS
			FROM restaurant_tables
			WHERE IDNo = ?
			LIMIT 1
		`;

		const [rows] = await pool.execute(query, [id]);
		return rows[0] || null;
	}

	static async existsByBranchAndNumber(branchId, tableNumber) {
		const query = `
			SELECT 1
			FROM restaurant_tables
			WHERE BRANCH_ID = ?
				AND TABLE_NUMBER = ?
				AND ACTIVE = 1
			LIMIT 1
		`;
		const [rows] = await pool.execute(query, [branchId, tableNumber]);
		return rows.length > 0;
	}

	// Create new restaurant table
	static async create(data) {
		const { TABLE_NUMBER, FLOOR, CAPACITY, ROOM_CHARGE, STATUS, BRANCH_ID, user_id } = data;
		const currentDate = new Date();
		const roomChargeSql = TableModel.normalizeRoomCharge(ROOM_CHARGE);
		const floorSql = TableModel.normalizeFloor(FLOOR);

		const query = `
			INSERT INTO restaurant_tables (
				BRANCH_ID,
				TABLE_NUMBER,
				FLOOR,
				CAPACITY,
				ROOM_CHARGE,
				STATUS,
				ACTIVE,
				ENCODED_BY,
				ENCODED_DT
			) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
		`;

		const [result] = await pool.execute(query, [
			BRANCH_ID,
			TABLE_NUMBER,
			floorSql,
			parseInt(CAPACITY) || 0,
			roomChargeSql,
			parseInt(STATUS) || 1,
			user_id,
			currentDate
		]);

		const newId = result.insertId;
		if (newId) {
			const table = await TableModel.getById(newId);
			if (table) {
				socketService.emitTableUpdated({
					id: table.IDNo,
					table_number: table.TABLE_NUMBER,
					floor: table.FLOOR ?? null,
					capacity: table.CAPACITY,
					room_charge: table.ROOM_CHARGE,
					status: table.STATUS,
					branch_id: table.BRANCH_ID ?? null
				}, 'created');
			}
		}
		return newId;
	}

	// Update restaurant table
	static async update(id, data) {
		const { TABLE_NUMBER, FLOOR, CAPACITY, ROOM_CHARGE, STATUS } = data;
		const roomChargeSql = TableModel.normalizeRoomCharge(ROOM_CHARGE);
		const floorSql = TableModel.normalizeFloor(FLOOR);

		const query = `
			UPDATE restaurant_tables SET
				TABLE_NUMBER = ?,
				FLOOR = ?,
				CAPACITY = ?,
				ROOM_CHARGE = ?,
				STATUS = ?
			WHERE IDNo = ?
		`;

		const [result] = await pool.execute(query, [
			TABLE_NUMBER,
			floorSql,
			parseInt(CAPACITY) || 0,
			roomChargeSql,
			parseInt(STATUS) || 1,
			id
		]);
		const updated = result.affectedRows > 0;
		if (updated) {
			const table = await TableModel.getById(id);
			if (table) {
				socketService.emitTableUpdated({
					id: table.IDNo,
					table_number: table.TABLE_NUMBER,
					floor: table.FLOOR ?? null,
					capacity: table.CAPACITY,
					room_charge: table.ROOM_CHARGE,
					status: table.STATUS,
					branch_id: table.BRANCH_ID ?? null
				}, 'updated');
			}
		}
		return updated;
	}

	// Delete restaurant table (soft delete - set ACTIVE = 0)
	static async delete(id) {
		const query = `
			UPDATE restaurant_tables SET
				ACTIVE = 0
			WHERE IDNo = ?
		`;

		const [result] = await pool.execute(query, [id]);
		const updated = result.affectedRows > 0;
		if (updated) {
			const table = await TableModel.getById(id);
			socketService.emitTableUpdated({
				id,
				table_number: table?.TABLE_NUMBER,
				floor: table?.FLOOR ?? null,
				capacity: table?.CAPACITY,
				room_charge: table?.ROOM_CHARGE,
				status: table?.STATUS,
				branch_id: table?.BRANCH_ID ?? null
			}, 'deleted');
		}
		return updated;
	}

	static async updateStatus(id, status) {
		const query = `
			UPDATE restaurant_tables 
			SET STATUS = ?
			WHERE IDNo = ?
		`;
		const [result] = await pool.execute(query, [status, id]);
		const updated = result.affectedRows > 0;
		if (updated) {
			const table = await TableModel.getById(id);
			if (table) {
				socketService.emitTableUpdated({
					id: table.IDNo,
					table_number: table.TABLE_NUMBER,
					floor: table.FLOOR ?? null,
					capacity: table.CAPACITY,
					room_charge: table.ROOM_CHARGE,
					status: table.STATUS,
					branch_id: table.BRANCH_ID ?? null
				}, 'updated');
			}
		}
		return updated;
	}

	/** @param {unknown} value */
	static normalizeRoomCharge(value) {
		if (value === undefined || value === null || value === '') {
			return null;
		}
		const n = parseFloat(String(value));
		return Number.isFinite(n) ? n : null;
	}

	// FLOOR is only meaningful for the handful of multi-floor branches (see
	// src/utils/floorScope.ts on the frontend) — any other value collapses to
	// null rather than being stored as free-form text.
	/** @param {unknown} value */
	static normalizeFloor(value) {
		const v = value == null ? '' : String(value).trim().toLowerCase();
		return v === 'gf' || v === '2f' ? v : null;
	}

	// Get transaction history for a specific table
	static async getTransactionHistory(tableId, branchId = null) {
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
				o.ENCODED_BY,
				o.EDITED_DT,
				o.EDITED_BY,
				t.TABLE_NUMBER,
				u.USERNAME as ENCODED_BY_USERNAME,
				u2.USERNAME as EDITED_BY_USERNAME
			FROM orders o
			LEFT JOIN restaurant_tables t ON t.IDNo = o.TABLE_ID
			LEFT JOIN user_info u ON u.IDNo = o.ENCODED_BY
			LEFT JOIN user_info u2 ON u2.IDNo = o.EDITED_BY
			WHERE o.TABLE_ID = ?
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
}

module.exports = TableModel;

