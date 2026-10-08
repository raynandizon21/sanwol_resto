const pool = require('../config/db');

class BranchModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (BranchModel._schemaReady) return;
		if (BranchModel._schemaPromise) return BranchModel._schemaPromise;

		BranchModel._schemaPromise = (async () => {
			await pool.execute(`
				CREATE TABLE IF NOT EXISTS branches (
					IDNo INT AUTO_INCREMENT PRIMARY KEY,
					BRANCH_CODE VARCHAR(20) NULL,
					BRANCH_NAME VARCHAR(120) NOT NULL,
					ADDRESS VARCHAR(255) NULL,
					PHONE VARCHAR(40) NULL,
					MENU_CATEGORY_LEVEL TINYINT NOT NULL DEFAULT 1,
					ACTIVE TINYINT(1) NOT NULL DEFAULT 1,
					CREATED_DT DATETIME DEFAULT CURRENT_TIMESTAMP,
					INDEX idx_branches_active (ACTIVE),
					INDEX idx_branches_branch_code (BRANCH_CODE)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
			`);

			// Fix existing table: ensure IDNo has AUTO_INCREMENT (if table was created without it)
			try {
				await pool.execute(`
					ALTER TABLE branches
					MODIFY COLUMN IDNo INT NOT NULL AUTO_INCREMENT
				`);
			} catch (alterErr) {
				const code = String(alterErr?.code || '').toUpperCase();
				const message = String(alterErr?.message || '');
				const isLockIssue =
					code === 'ER_LOCK_DEADLOCK' ||
					code === 'ER_LOCK_WAIT_TIMEOUT' ||
					/Deadlock found when trying to get lock/i.test(message) ||
					/Lock wait timeout exceeded/i.test(message);

				// Deadlock/lock-timeout can happen under concurrent startup; ignore to avoid noisy logs.
				if (!isLockIssue) {
					console.warn('[BranchModel] ensureSchema ALTER IDNo:', message);
				}
			}

			// 1 = single tier (main category only); 2 = main category + subcategory
			try {
				await pool.execute(`
					ALTER TABLE branches
					ADD COLUMN MENU_CATEGORY_LEVEL TINYINT NOT NULL DEFAULT 1
				`);
			} catch (colErr) {
				const code = String(colErr?.code || '');
				const msg = String(colErr?.message || '');
				const isDup = code === 'ER_DUP_FIELDNAME' || /Duplicate column name/i.test(msg);
				if (!isDup) {
					console.warn('[BranchModel] ensureSchema MENU_CATEGORY_LEVEL:', msg);
				}
			}

			try {
				await pool.execute(`
					ALTER TABLE branches
					ADD COLUMN BRANCH_LOGO VARCHAR(255) NULL DEFAULT NULL
				`);
			} catch (colErr) {
				const code = String(colErr?.code || '');
				const msg = String(colErr?.message || '');
				const isDup = code === 'ER_DUP_FIELDNAME' || /Duplicate column name/i.test(msg);
				if (!isDup) {
					console.warn('[BranchModel] ensureSchema BRANCH_LOGO:', msg);
				}
			}

			BranchModel._schemaReady = true;
			BranchModel._schemaPromise = null;
		})().catch((error) => {
			BranchModel._schemaPromise = null;
			throw error;
		});

		return BranchModel._schemaPromise;
	}

	static async getAllActive() {
		await BranchModel.ensureSchema();
		const [rows] = await pool.execute(
			`
			SELECT IDNo, BRANCH_CODE, BRANCH_NAME, ADDRESS, PHONE, BRANCH_LOGO, ACTIVE, CREATED_DT, MENU_CATEGORY_LEVEL
			FROM branches
			WHERE ACTIVE = 1
			ORDER BY BRANCH_NAME ASC, IDNo ASC
			`
		);
		return rows;
	}

	static async getById(id) {
		await BranchModel.ensureSchema();
		const [rows] = await pool.execute(
			`SELECT * FROM branches WHERE IDNo = ? AND ACTIVE = 1 LIMIT 1`,
			[Number(id)]
		);
		return rows[0] || null;
	}

	static async getByCode(code) {
		await BranchModel.ensureSchema();
		const [rows] = await pool.execute(
			`SELECT * FROM branches WHERE BRANCH_CODE = ? AND ACTIVE = 1 LIMIT 1`,
			[String(code)]
		);
		return rows[0] || null;
	}

	static async create(data) {
		await BranchModel.ensureSchema();
		const code = data?.BRANCH_CODE != null ? String(data.BRANCH_CODE).trim() : null;
		const name = data?.BRANCH_NAME != null ? String(data.BRANCH_NAME).trim() : '';
		const address = data?.ADDRESS != null && String(data.ADDRESS).trim() !== '' ? String(data.ADDRESS).trim() : null;
		const phone = data?.PHONE != null && String(data.PHONE).trim() !== '' ? String(data.PHONE).trim() : null;
		const menuCategoryLevel = BranchModel._normalizeMenuCategoryLevel(data?.MENU_CATEGORY_LEVEL);
		const logo = data?.BRANCH_LOGO != null && String(data.BRANCH_LOGO).trim() !== ''
			? String(data.BRANCH_LOGO).trim()
			: null;
		const [result] = await pool.execute(
			`
			INSERT INTO branches (
				BRANCH_CODE,
				BRANCH_NAME,
				ADDRESS,
				PHONE,
				BRANCH_LOGO,
				MENU_CATEGORY_LEVEL,
				ACTIVE,
				CREATED_DT
			) VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
			`,
			[code, name, address, phone, logo, menuCategoryLevel]
		);
		return result.insertId;
	}

	static _normalizeMenuCategoryLevel(value) {
		const n = parseInt(String(value ?? '1'), 10);
		return n === 2 ? 2 : 1;
	}

	static async update(id, data) {
		await BranchModel.ensureSchema();
		const menuCategoryLevel = BranchModel._normalizeMenuCategoryLevel(data?.MENU_CATEGORY_LEVEL);
		const hasLogo = Object.prototype.hasOwnProperty.call(data, 'BRANCH_LOGO');
		const logo = hasLogo
			? (data.BRANCH_LOGO != null && String(data.BRANCH_LOGO).trim() !== '' ? String(data.BRANCH_LOGO).trim() : null)
			: undefined;
		const params = [
			data.BRANCH_CODE ? String(data.BRANCH_CODE).trim() : null,
			String(data.BRANCH_NAME).trim(),
			data.ADDRESS ? String(data.ADDRESS).trim() : null,
			data.PHONE ? String(data.PHONE).trim() : null,
			menuCategoryLevel,
		];
		let logoSql = '';
		if (hasLogo) {
			logoSql = ', BRANCH_LOGO = ?';
			params.push(logo);
		}
		params.push(Number(id));
		const [result] = await pool.execute(
			`
			UPDATE branches
			SET
				BRANCH_CODE = ?,
				BRANCH_NAME = ?,
				ADDRESS = ?,
				PHONE = ?,
				MENU_CATEGORY_LEVEL = ?${logoSql}
			WHERE IDNo = ? AND ACTIVE = 1
			`,
			params
		);
		return result.affectedRows > 0;
	}

	static async delete(id) {
		await BranchModel.ensureSchema();
		const [result] = await pool.execute(
			`UPDATE branches SET ACTIVE = 0 WHERE IDNo = ? AND ACTIVE = 1`,
			[Number(id)]
		);
		return result.affectedRows > 0;
	}
}

module.exports = BranchModel;

