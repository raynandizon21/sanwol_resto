// ============================================
// EMPLOYEE MODEL
// ============================================
// File: models/employeeModel.js
// Description: Database operations for employees
// ============================================

const pool = require('../config/db');

// Profile columns added for the Employees page (one profile per MB160 device user, linked by
// zkteco.device_users.EMPLOYEE_ID). See docs/attendance.md.
const ADDED_COLUMNS = [
	{ name: 'BIRTHDATE', ddl: 'ADD COLUMN BIRTHDATE DATE NULL DEFAULT NULL AFTER ADDRESS' },
	{ name: 'DATE_SEPARATED', ddl: "ADD COLUMN DATE_SEPARATED DATE NULL DEFAULT NULL COMMENT 'Last day of work' AFTER DATE_STARTED" },
	{ name: 'NOTES', ddl: 'ADD COLUMN NOTES VARCHAR(255) NULL DEFAULT NULL AFTER EMERGENCY_CONTACT_PHONE' },
];

// Added by the first version of the Employees page (employment type, work schedule) and removed
// 2026-11-04: Sanwol's staff have no fixed schedules, and attendance is basic time tracking.
// Dropped from existing tables; none of them is used by the legacy employee API.
const DROPPED_COLUMNS = ['EMPLOYMENT_TYPE', 'SHIFT_START', 'SHIFT_END', 'BREAK_MINUTES', 'REST_DAYS'];

// Kitchen and floor staff have no login account, and a device's branch can be unset.
const NULLABLE_COLUMNS = [
	{ name: 'USER_INFO_ID', ddl: "MODIFY COLUMN USER_INFO_ID INT NULL DEFAULT NULL COMMENT 'Link to user_info table (login account, optional)'" },
	{ name: 'BRANCH_ID', ddl: "MODIFY COLUMN BRANCH_ID INT NULL DEFAULT NULL COMMENT 'Link to branches table'" },
];

// The profile fields the Employees page reads and edits (dates as text, times as HH:MM).
const PROFILE_SELECT = `
	e.IDNo, e.BRANCH_ID, e.USER_INFO_ID, e.FIRSTNAME, e.LASTNAME, e.CONTACTNo, e.DEPARTMENT,
	e.ADDRESS, DATE_FORMAT(e.BIRTHDATE, '%Y-%m-%d') AS BIRTHDATE,
	DATE_FORMAT(e.DATE_STARTED, '%Y-%m-%d') AS DATE_STARTED, DATE_FORMAT(e.DATE_SEPARATED, '%Y-%m-%d') AS DATE_SEPARATED,
	e.EMERGENCY_CONTACT_NAME, e.EMERGENCY_CONTACT_PHONE, e.NOTES, e.ACTIVE,
	DATE_FORMAT(e.EDITED_DT, '%Y-%m-%d %H:%i:%s') AS EDITED_DT`;

// Columns updateProfile may write; anything else in the payload is ignored.
const PROFILE_EDITABLE = [
	'FIRSTNAME', 'LASTNAME', 'CONTACTNo', 'DEPARTMENT', 'ADDRESS', 'BIRTHDATE',
	'DATE_STARTED', 'DATE_SEPARATED', 'EMERGENCY_CONTACT_NAME', 'EMERGENCY_CONTACT_PHONE', 'NOTES',
];

class EmployeeModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (EmployeeModel._schemaReady) return;
		if (EmployeeModel._schemaPromise) return EmployeeModel._schemaPromise;

		EmployeeModel._schemaPromise = (async () => {
			await pool.query(`
				CREATE TABLE IF NOT EXISTS employee (
					IDNo INT NOT NULL AUTO_INCREMENT,
					BRANCH_ID INT NULL DEFAULT NULL COMMENT 'Link to branches table',
					USER_INFO_ID INT NULL DEFAULT NULL COMMENT 'Link to user_info table (login account, optional)',
					PHOTO VARCHAR(255) NULL DEFAULT NULL,
					FIRSTNAME VARCHAR(100) NULL DEFAULT NULL,
					LASTNAME VARCHAR(100) NULL DEFAULT NULL,
					CONTACTNo VARCHAR(20) NULL DEFAULT NULL,
					DEPARTMENT VARCHAR(50) NULL DEFAULT NULL,
					ADDRESS VARCHAR(255) NULL DEFAULT NULL,
					DATE_STARTED DATETIME NULL DEFAULT NULL,
					SALARY VARCHAR(255) NULL DEFAULT NULL,
					EMERGENCY_CONTACT_NAME VARCHAR(100) NULL DEFAULT NULL,
					EMERGENCY_CONTACT_PHONE VARCHAR(20) NULL DEFAULT NULL,
					STATUS TINYINT(1) NULL DEFAULT 1 COMMENT '1=ACTIVE, 0=INACTIVE',
					ENCODED_BY INT NULL DEFAULT NULL,
					ENCODED_DT DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
					EDITED_BY INT NULL DEFAULT NULL,
					EDITED_DT DATETIME NULL DEFAULT NULL,
					ACTIVE TINYINT(1) NULL DEFAULT 1,
					PRIMARY KEY (IDNo)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
			`);
			const [cols] = await pool.query(
				`SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
				 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee'`
			);
			const existing = new Map(cols.map((c) => [c.COLUMN_NAME, c.IS_NULLABLE]));
			for (const col of NULLABLE_COLUMNS) {
				if (existing.get(col.name) === 'NO') {
					await pool.query(`ALTER TABLE employee ${col.ddl}`);
					console.log(`[Schema] employee.${col.name} made optional`);
				}
			}
			for (const col of ADDED_COLUMNS) {
				if (!existing.has(col.name)) {
					await pool.query(`ALTER TABLE employee ${col.ddl}`);
					console.log(`[Schema] employee.${col.name} created`);
				}
			}
			for (const name of DROPPED_COLUMNS) {
				if (existing.has(name)) {
					await pool.query(`ALTER TABLE employee DROP COLUMN ${name}`);
					console.log(`[Schema] employee.${name} dropped`);
				}
			}
			EmployeeModel._schemaReady = true;
			EmployeeModel._schemaPromise = null;
		})().catch((error) => {
			EmployeeModel._schemaPromise = null;
			throw error;
		});

		return EmployeeModel._schemaPromise;
	}

	// ---- Profiles for the Employees page (one per device user; see employeeLinkService) ----

	static async getProfilesByIds(ids) {
		const unique = [...new Set(ids.map(Number).filter(Boolean))];
		if (unique.length === 0) return [];
		await EmployeeModel.ensureSchema();
		const [rows] = await pool.query(
			`SELECT ${PROFILE_SELECT} FROM employee e WHERE e.IDNo IN (${unique.map(() => '?').join(',')})`,
			unique
		);
		return rows;
	}

	static async getProfileById(id) {
		return (await EmployeeModel.getProfilesByIds([id]))[0] || null;
	}

	/** Active profiles in a branch scope (null = all branches). */
	static async getProfilesInScope(branchIds) {
		await EmployeeModel.ensureSchema();
		if (branchIds && branchIds.length === 0) return [];
		const [rows] = await pool.query(
			`SELECT ${PROFILE_SELECT} FROM employee e
			 WHERE e.ACTIVE = 1${branchIds ? ` AND e.BRANCH_ID IN (${branchIds.map(() => '?').join(',')})` : ''}
			 ORDER BY e.FIRSTNAME, e.LASTNAME`,
			branchIds || []
		);
		return rows;
	}

	/**
	 * A new profile for a device user: from `fields` (employee columns, validated when the person
	 * was added in the app) or, for someone added on the device, named as on the device.
	 */
	static async createForDeviceUser({ name, branchId, fields = null, userId = null }) {
		await EmployeeModel.ensureSchema();
		const entries = Object.entries(fields || {}).filter(([key]) => PROFILE_EDITABLE.includes(key));
		const data = new Map(entries);
		if (!String(data.get('FIRSTNAME') ?? '').trim()) data.set('FIRSTNAME', String(name || '').trim() || null);
		const columns = [...data.keys()];
		const [result] = await pool.query(
			`INSERT INTO employee (BRANCH_ID, ${columns.join(', ')}, STATUS, ACTIVE, ENCODED_BY, ENCODED_DT)
			 VALUES (?, ${columns.map(() => '?').join(', ')}, 1, 1, ?, NOW())`,
			[branchId ?? null, ...data.values(), userId]
		);
		return result.insertId;
	}

	/** Writes the given profile fields (validated by the caller). */
	static async updateProfile(id, fields, userId) {
		await EmployeeModel.ensureSchema();
		const entries = Object.entries(fields).filter(([key]) => PROFILE_EDITABLE.includes(key));
		if (entries.length === 0) return false;
		const [result] = await pool.query(
			`UPDATE employee SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, EDITED_BY = ?, EDITED_DT = NOW()
			 WHERE IDNo = ? AND ACTIVE = 1`,
			[...entries.map(([, value]) => value), userId, id]
		);
		return result.affectedRows > 0;
	}

	/** Soft-deletes a profile no device user points at any more (e.g. after linking to an older one). */
	static async deactivateProfile(id, userId) {
		await EmployeeModel.ensureSchema();
		await pool.query('UPDATE employee SET ACTIVE = 0, EDITED_BY = ?, EDITED_DT = NOW() WHERE IDNo = ?', [userId, id]);
	}

	static get PROFILE_EDITABLE() {
		return PROFILE_EDITABLE;
	}

	// ---- Legacy employee API (/employees_list, /employee/:id) ----


	// Get all active employees
	static async getAll(branchId = null) {
		let query = `
			SELECT 
				e.IDNo,
				e.BRANCH_ID,
				b.BRANCH_NAME,
				b.BRANCH_CODE,
				b.BRANCH_NAME AS BRANCH_LABEL,
				e.USER_INFO_ID,
				ui.USERNAME AS USERNAME,
				CASE 
					WHEN ui.FIRSTNAME IS NOT NULL AND ui.LASTNAME IS NOT NULL 
					THEN CONCAT(ui.FIRSTNAME, ' ', ui.LASTNAME)
					ELSE NULL
				END AS USER_INFO_NAME,
				e.PHOTO,
				e.FIRSTNAME,
				e.LASTNAME,
				CONCAT(e.FIRSTNAME, ' ', e.LASTNAME) AS FULLNAME,
				e.CONTACTNo,
				e.DEPARTMENT,
				e.ADDRESS,
				e.DATE_STARTED,
				e.SALARY,
				e.STATUS,
				e.ENCODED_BY,
				e.ENCODED_DT,
				e.EDITED_BY,
				e.EDITED_DT,
				e.ACTIVE,
				e.EMERGENCY_CONTACT_NAME,
				e.EMERGENCY_CONTACT_PHONE
			FROM employee e
			LEFT JOIN branches b ON b.IDNo = e.BRANCH_ID AND b.ACTIVE = 1
			LEFT JOIN user_info ui ON ui.IDNo = e.USER_INFO_ID AND ui.ACTIVE = 1
			WHERE e.ACTIVE = 1
		`;

		const params = [];
		if (branchId) {
			query += ` AND e.BRANCH_ID = ?`;
			params.push(branchId);
		}

		query += ` ORDER BY e.LASTNAME ASC, e.FIRSTNAME ASC`;

		try {
			const [rows] = await pool.execute(query, params);
			return rows;
		} catch (error) {
			console.error('SQL Error in EmployeeModel.getAll:');
			console.error('Query:', query);
			console.error('Params:', params);
			console.error('Error:', error.message);
			console.error('Error Code:', error.code);
			throw error;
		}
	}

	// Get employee by ID
	static async getById(id) {
		const query = `
			SELECT 
				e.IDNo,
				e.BRANCH_ID,
				e.USER_INFO_ID,
				e.PHOTO,
				e.FIRSTNAME,
				e.LASTNAME,
				CONCAT(e.FIRSTNAME, ' ', e.LASTNAME) AS FULLNAME,
				e.CONTACTNo,
				e.DEPARTMENT,
				e.ADDRESS,
				DATE_FORMAT(e.DATE_STARTED, '%Y-%m-%d') AS DATE_STARTED,
				e.SALARY,
				e.STATUS,
				e.EMERGENCY_CONTACT_NAME,
				e.EMERGENCY_CONTACT_PHONE,
				e.ENCODED_BY,
				e.ENCODED_DT,
				e.EDITED_BY,
				e.EDITED_DT,
				e.ACTIVE,
				b.BRANCH_NAME,
				b.BRANCH_CODE,
				ui.USERNAME,
				CONCAT(ui.FIRSTNAME, ' ', ui.LASTNAME) AS USER_INFO_NAME
			FROM employee e
			LEFT JOIN branches b ON b.IDNo = e.BRANCH_ID
			LEFT JOIN user_info ui ON ui.IDNo = e.USER_INFO_ID
			WHERE e.IDNo = ? AND e.ACTIVE = 1
			LIMIT 1
		`;
		const [rows] = await pool.execute(query, [id]);
		return rows[0] || null;
	}

	// Create new employee
	static async create(data) {
		const { 
			BRANCH_ID, 
			USER_INFO_ID, 
			PHOTO, 
			FIRSTNAME, 
			LASTNAME, 
			CONTACTNo, 
			DEPARTMENT, 
			ADDRESS, 
			DATE_STARTED, 
			SALARY,
			STATUS,
			EMERGENCY_CONTACT_NAME,
			EMERGENCY_CONTACT_PHONE,
			user_id 
		} = data;
		const currentDate = new Date();

		const query = `
			INSERT INTO employee (
				BRANCH_ID,
				USER_INFO_ID,
				PHOTO,
				FIRSTNAME,
				LASTNAME,
				CONTACTNo,
				DEPARTMENT,
				ADDRESS,
				DATE_STARTED,
				SALARY,
				STATUS,
				ACTIVE,
				ENCODED_BY,
				ENCODED_DT,
				EMERGENCY_CONTACT_NAME,
				EMERGENCY_CONTACT_PHONE
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
		`;

		const [result] = await pool.execute(query, [
			BRANCH_ID || null,
			USER_INFO_ID || null,
			PHOTO || null,
			(FIRSTNAME || '').trim(),
			(LASTNAME || '').trim(),
			CONTACTNo || null,
			DEPARTMENT || null,
			ADDRESS || null,
			DATE_STARTED || null,
			SALARY || null,
			parseInt(STATUS) || 1,
			user_id,
			currentDate,
			EMERGENCY_CONTACT_NAME || null,
			EMERGENCY_CONTACT_PHONE || null
		]);

		return result.insertId;
	}

	// Update employee
	static async update(id, data) {
		const { 
			BRANCH_ID, 
			USER_INFO_ID, 
			PHOTO, 
			FIRSTNAME, 
			LASTNAME, 
			CONTACTNo, 
			DEPARTMENT, 
			ADDRESS, 
			DATE_STARTED, 
			SALARY,
			STATUS,
			EMERGENCY_CONTACT_NAME,
			EMERGENCY_CONTACT_PHONE,
			user_id 
		} = data;
		const currentDate = new Date();

		const query = `
			UPDATE employee SET
				BRANCH_ID = ?,
				USER_INFO_ID = ?,
				PHOTO = ?,
				FIRSTNAME = ?,
				LASTNAME = ?,
				CONTACTNo = ?,
				DEPARTMENT = ?,
				ADDRESS = ?,
				DATE_STARTED = ?,
				SALARY = ?,
				STATUS = ?,
				EDITED_BY = ?,
				EDITED_DT = ?,
				EMERGENCY_CONTACT_NAME = ?,
				EMERGENCY_CONTACT_PHONE = ?
			WHERE IDNo = ? AND ACTIVE = 1
		`;

		const [result] = await pool.execute(query, [
			BRANCH_ID || null,
			USER_INFO_ID || null,
			PHOTO || null,
			(FIRSTNAME || '').trim(),
			(LASTNAME || '').trim(),
			CONTACTNo || null,
			DEPARTMENT || null,
			ADDRESS || null,
			DATE_STARTED || null,
			SALARY || null,
			STATUS !== undefined && STATUS !== null ? parseInt(STATUS) : 1,
			user_id,
			currentDate,
			EMERGENCY_CONTACT_NAME || null,
			EMERGENCY_CONTACT_PHONE || null,
			id
		]);

		return result.affectedRows > 0;
	}

	// Soft delete employee
	static async delete(id, user_id) {
		const currentDate = new Date();

		const query = `
			UPDATE employee SET
				ACTIVE = 0,
				EDITED_BY = ?,
				EDITED_DT = ?
			WHERE IDNo = ?
		`;

		const [result] = await pool.execute(query, [user_id, currentDate, id]);
		return result.affectedRows > 0;
	}
}

module.exports = EmployeeModel;

