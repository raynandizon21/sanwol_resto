const pool = require('../config/db');
const BranchModel = require('./branchModel');

class CashReconciliationModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (CashReconciliationModel._schemaReady) return;
		if (CashReconciliationModel._schemaPromise) return CashReconciliationModel._schemaPromise;

		CashReconciliationModel._schemaPromise = (async () => {
			await BranchModel.ensureSchema();

			await pool.execute(`
				CREATE TABLE IF NOT EXISTS cash_reconciliation (
					IDNo INT AUTO_INCREMENT PRIMARY KEY,
					BRANCH_ID INT NOT NULL,
					BUSINESS_DATE DATE NOT NULL,
					AMOUNT DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
					ACTIVE TINYINT(1) DEFAULT 1,
					ENCODED_DT DATETIME DEFAULT CURRENT_TIMESTAMP,
					ENCODED_BY INT NULL,
					EDITED_DT DATETIME DEFAULT NULL,
					EDITED_BY INT NULL,
					INDEX idx_cr_branch_date (BRANCH_ID, BUSINESS_DATE),
					INDEX idx_cr_active (ACTIVE),
					CONSTRAINT fk_cash_reconciliation_branch
						FOREIGN KEY (BRANCH_ID) REFERENCES branches(IDNo)
						ON UPDATE CASCADE ON DELETE RESTRICT
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
			`);

			CashReconciliationModel._schemaReady = true;
			CashReconciliationModel._schemaPromise = null;
		})().catch((error) => {
			CashReconciliationModel._schemaPromise = null;
			throw error;
		});

		return CashReconciliationModel._schemaPromise;
	}

	/**
	 * @param {number} branchId
	 * @param {string|null} startDate YYYY-MM-DD
	 * @param {string|null} endDate YYYY-MM-DD
	 */
	static async list(branchId, startDate = null, endDate = null) {
		await CashReconciliationModel.ensureSchema();
		const params = [Number(branchId)];
		let sql = `
			SELECT
				cr.IDNo,
				cr.BRANCH_ID,
				b.BRANCH_NAME,
				DATE_FORMAT(cr.BUSINESS_DATE, '%Y-%m-%d') AS BUSINESS_DATE,
				cr.AMOUNT,
				cr.ACTIVE,
				cr.ENCODED_DT,
				cr.ENCODED_BY,
				cr.EDITED_DT,
				cr.EDITED_BY
			FROM cash_reconciliation cr
			INNER JOIN branches b ON b.IDNo = cr.BRANCH_ID
			WHERE cr.BRANCH_ID = ? AND cr.ACTIVE = 1
		`;
		if (startDate) {
			sql += ' AND cr.BUSINESS_DATE >= ?';
			params.push(String(startDate).slice(0, 10));
		}
		if (endDate) {
			sql += ' AND cr.BUSINESS_DATE <= ?';
			params.push(String(endDate).slice(0, 10));
		}
		sql += ' ORDER BY cr.BUSINESS_DATE DESC, cr.IDNo DESC';
		const [rows] = await pool.execute(sql, params);
		return rows;
	}

	static async getById(id, branchId = null) {
		await CashReconciliationModel.ensureSchema();
		const params = [Number(id)];
		let sql = `
			SELECT
				cr.IDNo,
				cr.BRANCH_ID,
				b.BRANCH_NAME,
				DATE_FORMAT(cr.BUSINESS_DATE, '%Y-%m-%d') AS BUSINESS_DATE,
				cr.AMOUNT,
				cr.ACTIVE,
				cr.ENCODED_DT,
				cr.ENCODED_BY,
				cr.EDITED_DT,
				cr.EDITED_BY
			FROM cash_reconciliation cr
			INNER JOIN branches b ON b.IDNo = cr.BRANCH_ID
			WHERE cr.IDNo = ? AND cr.ACTIVE = 1
		`;
		if (branchId !== null && branchId !== undefined) {
			sql += ' AND cr.BRANCH_ID = ?';
			params.push(Number(branchId));
		}
		const [rows] = await pool.execute(sql, params);
		return rows[0] || null;
	}

	static async create({ BRANCH_ID, BUSINESS_DATE, AMOUNT, ENCODED_BY }) {
		await CashReconciliationModel.ensureSchema();
		const [result] = await pool.execute(
			`
			INSERT INTO cash_reconciliation (BRANCH_ID, BUSINESS_DATE, AMOUNT, ACTIVE, ENCODED_BY)
			VALUES (?, ?, ?, 1, ?)
			`,
			[Number(BRANCH_ID), String(BUSINESS_DATE).slice(0, 10), Number(AMOUNT), ENCODED_BY != null ? Number(ENCODED_BY) : null]
		);
		return result.insertId;
	}

	static async update(id, branchId, { BUSINESS_DATE, AMOUNT, EDITED_BY }) {
		await CashReconciliationModel.ensureSchema();
		const [result] = await pool.execute(
			`
			UPDATE cash_reconciliation
			SET BUSINESS_DATE = ?, AMOUNT = ?, EDITED_BY = ?, EDITED_DT = CURRENT_TIMESTAMP
			WHERE IDNo = ? AND BRANCH_ID = ? AND ACTIVE = 1
			`,
			[
				String(BUSINESS_DATE).slice(0, 10),
				Number(AMOUNT),
				EDITED_BY != null ? Number(EDITED_BY) : null,
				Number(id),
				Number(branchId),
			]
		);
		return result.affectedRows > 0;
	}

	static async softDelete(id, branchId, userId) {
		await CashReconciliationModel.ensureSchema();
		const [result] = await pool.execute(
			`
			UPDATE cash_reconciliation
			SET ACTIVE = 0, EDITED_BY = ?, EDITED_DT = CURRENT_TIMESTAMP
			WHERE IDNo = ? AND BRANCH_ID = ? AND ACTIVE = 1
			`,
			[userId != null ? Number(userId) : null, Number(id), Number(branchId)]
		);
		return result.affectedRows > 0;
	}

	/**
	 * Period totals and per–business-date sums for merging into net sales.
	 * @param {number|null|undefined} branchId — omit or null to include all branches
	 * @param {string|null} startDate
	 * @param {string|null} endDate
	 * @returns {{ total: number, byDate: Record<string, number> }}
	 */
	static async aggregatesForRange(branchId, startDate = null, endDate = null) {
		await CashReconciliationModel.ensureSchema();
		const params = [];
		let sql = `
			SELECT DATE_FORMAT(BUSINESS_DATE, '%Y-%m-%d') AS BUSINESS_DATE, COALESCE(SUM(AMOUNT), 0) AS day_total
			FROM cash_reconciliation
			WHERE ACTIVE = 1
		`;
		if (branchId !== null && branchId !== undefined && branchId !== '') {
			sql += ' AND BRANCH_ID = ?';
			params.push(Number(branchId));
		} else {
			sql += ' AND BRANCH_ID NOT IN (4)'; // All Branches: leave out 3Core (developer/testing)
		}
		if (startDate) {
			sql += ' AND BUSINESS_DATE >= ?';
			params.push(String(startDate).slice(0, 10));
		}
		if (endDate) {
			sql += ' AND BUSINESS_DATE <= ?';
			params.push(String(endDate).slice(0, 10));
		}
		sql += ' GROUP BY BUSINESS_DATE';
		const [rows] = await pool.execute(sql, params);
		/** @type {Record<string, number>} */
		const byDate = {};
		let total = 0;
		for (const r of rows) {
			const raw = r.BUSINESS_DATE;
			const key = String(raw).slice(0, 10);
			const v = Number(r.day_total) || 0;
			byDate[key] = v;
			total += v;
		}
		return { total, byDate };
	}

	/**
	 * Per-branch period totals in one query (replaces N separate aggregate calls).
	 * @returns {Record<number, number>} branchId → total recon amount
	 */
	static async totalsByBranchForRange(startDate = null, endDate = null) {
		await CashReconciliationModel.ensureSchema();
		const params = [];
		let sql = `
			SELECT BRANCH_ID, COALESCE(SUM(AMOUNT), 0) AS branch_total
			FROM cash_reconciliation
			WHERE ACTIVE = 1 AND BRANCH_ID NOT IN (4) -- 3Core developer/testing branch, excluded from All-Branches totals
		`;
		if (startDate) {
			sql += ' AND BUSINESS_DATE >= ?';
			params.push(String(startDate).slice(0, 10));
		}
		if (endDate) {
			sql += ' AND BUSINESS_DATE <= ?';
			params.push(String(endDate).slice(0, 10));
		}
		sql += ' GROUP BY BRANCH_ID';
		const [rows] = await pool.execute(sql, params);
		/** @type {Record<number, number>} */
		const byBranch = {};
		for (const r of rows) {
			const bid = Number(r.BRANCH_ID);
			if (!Number.isFinite(bid)) continue;
			byBranch[bid] = Number(r.branch_total) || 0;
		}
		return byBranch;
	}
}

module.exports = CashReconciliationModel;
