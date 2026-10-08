// ============================================
// AUDIT LOG MODEL
// ============================================
// File: models/auditLogModel.js
// Description: Database operations for audit logs
// ============================================

const pool = require('../config/db');
const { ensureIdNoAutoIncrement } = require('../utils/mysqlSchemaHelpers');

class AuditLogModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	/**
	 * Ensures audit_logs exists and IDNo is AUTO_INCREMENT (legacy dumps had IDNo NOT NULL without auto increment).
	 */
	static async ensureSchema() {
		if (AuditLogModel._schemaReady) return;
		if (AuditLogModel._schemaPromise) return AuditLogModel._schemaPromise;

		AuditLogModel._schemaPromise = (async () => {
			await pool.execute(`
				CREATE TABLE IF NOT EXISTS audit_logs (
					IDNo INT NOT NULL AUTO_INCREMENT,
					USER_ID INT DEFAULT NULL,
					BRANCH_ID INT DEFAULT NULL,
					ACTION VARCHAR(100) DEFAULT NULL,
					TABLE_NAME VARCHAR(50) DEFAULT NULL,
					RECORD_ID INT DEFAULT NULL,
					CREATED_DT DATETIME DEFAULT CURRENT_TIMESTAMP,
					PRIMARY KEY (IDNo),
					KEY idx_audit_logs_created (CREATED_DT)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
			`);

			const ok = await ensureIdNoAutoIncrement(pool, 'audit_logs');
			if (!ok) {
				throw new Error(
					'audit_logs.IDNo is not AUTO_INCREMENT. Check PRIMARY KEY on IDNo and run: ' +
						'ALTER TABLE audit_logs MODIFY COLUMN IDNo INT NOT NULL AUTO_INCREMENT;'
				);
			}

			AuditLogModel._schemaReady = true;
			AuditLogModel._schemaPromise = null;
		})().catch((error) => {
			AuditLogModel._schemaPromise = null;
			AuditLogModel._schemaReady = false;
			throw error;
		});

		return AuditLogModel._schemaPromise;
	}

	// Create audit log entry
	static async create(data) {
		await AuditLogModel.ensureSchema();

		const {
			user_id,
			branch_id,
			action,
			table_name,
			record_id
		} = data;

		const query = `
			INSERT INTO audit_logs (
				USER_ID,
				BRANCH_ID,
				ACTION,
				TABLE_NAME,
				RECORD_ID
			) VALUES (?, ?, ?, ?, ?)
		`;

		await pool.execute(query, [
			user_id || null,
			branch_id || null,
			action,
			table_name || null,
			record_id || null
		]);
	}

	// Get audit logs with filters
	static async getAll(filters = {}) {
		await AuditLogModel.ensureSchema();

		let query = `
			SELECT 
				al.IDNo,
				al.USER_ID,
				al.BRANCH_ID,
				al.ACTION,
				al.TABLE_NAME,
				al.RECORD_ID,
				al.CREATED_DT,
				u.USERNAME,
				u.FIRSTNAME,
				u.LASTNAME,
				b.BRANCH_NAME
			FROM audit_logs al
			LEFT JOIN user_info u ON u.IDNo = al.USER_ID
			LEFT JOIN branches b ON b.IDNo = al.BRANCH_ID
			WHERE 1=1
		`;

		const params = [];

		if (filters.user_id) {
			query += ` AND al.USER_ID = ?`;
			params.push(filters.user_id);
		}

		if (filters.branch_id) {
			query += ` AND al.BRANCH_ID = ?`;
			params.push(filters.branch_id);
		}

		if (filters.table_name) {
			query += ` AND al.TABLE_NAME = ?`;
			params.push(filters.table_name);
		}

		if (filters.action) {
			query += ` AND al.ACTION = ?`;
			params.push(filters.action);
		}

		if (filters.start_date) {
			query += ` AND al.CREATED_DT >= ?`;
			params.push(filters.start_date);
		}

		if (filters.end_date) {
			query += ` AND al.CREATED_DT <= ?`;
			params.push(filters.end_date);
		}

		// Some MySQL/MariaDB builds reject bound parameters for LIMIT/OFFSET in prepared statements.
		const safeLimit = Math.min(Math.max(1, Number(filters.limit) || 100), 500);
		const safeOffset = Math.max(0, Number(filters.offset) || 0);
		query += ` ORDER BY al.CREATED_DT DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`;

		// Use text protocol to avoid server-side prepared statement paging edge-cases.
		const [rows] = await pool.query(query, params);
		return rows;
	}

	// Get audit logs by branch
	static async getByBranchId(branchId, limit = 100) {
		return this.getAll({ branch_id: branchId, limit });
	}

	// Get audit logs by user
	static async getByUserId(userId, limit = 100) {
		return this.getAll({ user_id: userId, limit });
	}
}

module.exports = AuditLogModel;

