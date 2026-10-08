// ============================================
// EMPLOYEE MODEL
// ============================================
// File: models/employeeModel.js
// Description: Database operations for employees
// ============================================

const pool = require('../config/db');

class EmployeeModel {
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

