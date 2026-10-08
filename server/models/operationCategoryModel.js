// ============================================
// OPERATION CATEGORY MODEL
// ============================================
// File: models/operationCategoryModel.js
// Description: Database operations for operation_category table
// ============================================

const pool = require('../config/db');
const BranchModel = require('./branchModel');

class OperationCategoryModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (OperationCategoryModel._schemaReady) return;
		if (OperationCategoryModel._schemaPromise) return OperationCategoryModel._schemaPromise;

		OperationCategoryModel._schemaPromise = (async () => {
			await BranchModel.ensureSchema();

			await pool.execute(`
				CREATE TABLE IF NOT EXISTS operation_category (
					IDNo INT(11) NOT NULL AUTO_INCREMENT,
					BRANCH_ID INT(11) NULL,
					NAME VARCHAR(255) NOT NULL,
					DESCRIPTION VARCHAR(255) NULL,
					STATE INT(11) NULL DEFAULT 0 COMMENT '1=inventory; 0=expense',
					ACTIVE INT(11) NOT NULL DEFAULT 1,
					ENCODED_BY INT(11) NULL,
					ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
					EDITED_BY INT(11) NULL,
					EDITED_DT DATETIME NULL,
					PRIMARY KEY (IDNo),
					INDEX idx_operation_category_branch (BRANCH_ID),
					INDEX idx_operation_category_active (ACTIVE),
					CONSTRAINT fk_operation_category_branch
						FOREIGN KEY (BRANCH_ID) REFERENCES branches(IDNo)
						ON UPDATE CASCADE ON DELETE SET NULL
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
			`);

			// Add STATE column after DESCRIPTION if missing (migration for existing tables)
			const [stateColumn] = await pool.execute(
				`SELECT 1
				 FROM INFORMATION_SCHEMA.COLUMNS
				 WHERE TABLE_SCHEMA = DATABASE()
				   AND TABLE_NAME = 'operation_category'
				   AND COLUMN_NAME = 'STATE'
				 LIMIT 1`
			);
			if (!stateColumn.length) {
				await pool.execute(
					`ALTER TABLE operation_category
					 ADD COLUMN STATE INT(11) NULL DEFAULT 0 COMMENT '1=inventory; 0=expense' AFTER DESCRIPTION`
				);
				console.log('[OperationCategoryModel] Added STATE column after DESCRIPTION');
			}

			OperationCategoryModel._schemaReady = true;
			OperationCategoryModel._schemaPromise = null;
		})().catch((error) => {
			OperationCategoryModel._schemaPromise = null;
			throw error;
		});

		return OperationCategoryModel._schemaPromise;
	}

	// Get all active operation categories, optionally filtered by branch
	static async getAll(branchId = null) {
		try {
			await OperationCategoryModel.ensureSchema();
		} catch (schemaErr) {
			console.warn('[OperationCategoryModel.getAll] ensureSchema failed:', schemaErr?.message);
		}
		let query = `
			SELECT
				IDNo,
				BRANCH_ID,
				NAME,
				DESCRIPTION,
				STATE,
				ACTIVE,
				ENCODED_BY,
				ENCODED_DT,
				EDITED_BY,
				EDITED_DT
			FROM operation_category
			WHERE ACTIVE = 1
		`;

		const params = [];

		if (branchId !== null && branchId !== undefined) {
			query += ' AND BRANCH_ID = ?';
			params.push(branchId);
		}

		query += ' ORDER BY NAME ASC, IDNo ASC';

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	// Create operation category
	static async create(data) {
		const encodedBy = data.ENCODED_BY != null ? Number(data.ENCODED_BY) : 0;
		const stateVal = data.STATE === 1 || data.STATE === true ? 1 : 0;
		const [result] = await pool.execute(
			`INSERT INTO operation_category (BRANCH_ID, NAME, DESCRIPTION, STATE, ACTIVE, ENCODED_BY, ENCODED_DT)
			 VALUES (?, ?, ?, ?, 1, ?, NOW())`,
			[
				data.BRANCH_ID != null ? Number(data.BRANCH_ID) : null,
				String(data.NAME || '').trim(),
				data.DESCRIPTION != null ? String(data.DESCRIPTION).trim() : null,
				stateVal,
				encodedBy,
			]
		);
		return result.insertId;
	}

	// Update operation category
	static async update(id, data) {
		const editedBy = data.EDITED_BY != null ? Number(data.EDITED_BY) : 0;
		const stateVal = data.STATE === 1 || data.STATE === true ? 1 : 0;
		const [result] = await pool.execute(
			`UPDATE operation_category
			 SET NAME = ?, DESCRIPTION = ?, STATE = ?, EDITED_BY = ?, EDITED_DT = NOW()
			 WHERE IDNo = ? AND ACTIVE = 1`,
			[
				String(data.NAME || '').trim(),
				data.DESCRIPTION != null ? String(data.DESCRIPTION).trim() : null,
				stateVal,
				editedBy,
				Number(id),
			]
		);
		return result.affectedRows > 0;
	}

	// Soft delete (set ACTIVE = 0)
	static async setInactive(id) {
		const [result] = await pool.execute(
			`UPDATE operation_category SET ACTIVE = 0, EDITED_DT = NOW() WHERE IDNo = ? AND ACTIVE = 1`,
			[Number(id)]
		);
		return result.affectedRows > 0;
	}
}

module.exports = OperationCategoryModel;

