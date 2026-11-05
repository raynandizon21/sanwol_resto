// ============================================
// ATTENDANCE CALENDAR MODEL
// ============================================
// File: models/attendanceCalendarModel.js
// Description: Days that aren't absences even when nobody punches: branch holidays
// (attendance_holidays) and days marked for one person as leave, day off or holiday
// (attendance_excused_days). Both are soft-deleted (ACTIVE = 0) and come back on re-adding.
// See docs/attendance.md.
// ============================================

const pool = require('../config/db');

const EXCUSE_TYPES = ['leave', 'day_off', 'holiday'];

class AttendanceCalendarModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (AttendanceCalendarModel._schemaReady) return;
		if (AttendanceCalendarModel._schemaPromise) return AttendanceCalendarModel._schemaPromise;
		AttendanceCalendarModel._schemaPromise = (async () => {
			await pool.query(`
				CREATE TABLE IF NOT EXISTS attendance_holidays (
					IDNo INT NOT NULL AUTO_INCREMENT,
					BRANCH_ID INT NOT NULL COMMENT 'Link to branches table',
					HOLIDAY_DATE DATE NOT NULL,
					NAME VARCHAR(100) NOT NULL,
					ACTIVE TINYINT(1) NOT NULL DEFAULT 1,
					ENCODED_BY INT NULL DEFAULT NULL,
					ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
					EDITED_BY INT NULL DEFAULT NULL,
					EDITED_DT DATETIME NULL DEFAULT NULL,
					PRIMARY KEY (IDNo),
					UNIQUE KEY uq_attendance_holidays_branch_date (BRANCH_ID, HOLIDAY_DATE)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
				COMMENT='Branch holidays: nobody is absent on these dates'
			`);
			await pool.query(`
				CREATE TABLE IF NOT EXISTS attendance_excused_days (
					IDNo INT NOT NULL AUTO_INCREMENT,
					EMPLOYEE_ID INT NOT NULL COMMENT 'Link to employee table',
					WORK_DATE DATE NOT NULL,
					EXCUSE_TYPE VARCHAR(20) NOT NULL COMMENT 'leave, day_off or holiday',
					NOTE VARCHAR(255) NULL DEFAULT NULL,
					ACTIVE TINYINT(1) NOT NULL DEFAULT 1,
					ENCODED_BY INT NULL DEFAULT NULL,
					ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
					EDITED_BY INT NULL DEFAULT NULL,
					EDITED_DT DATETIME NULL DEFAULT NULL,
					PRIMARY KEY (IDNo),
					UNIQUE KEY uq_attendance_excused_employee_date (EMPLOYEE_ID, WORK_DATE)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
				COMMENT='Days one person is excused (leave, day off, holiday): not absences'
			`);
			AttendanceCalendarModel._schemaReady = true;
			AttendanceCalendarModel._schemaPromise = null;
		})().catch((error) => {
			AttendanceCalendarModel._schemaPromise = null;
			throw error;
		});
		return AttendanceCalendarModel._schemaPromise;
	}

	// ---- Branch holidays ----

	/** Holidays of the given branches between two dates: Map branchId -> Map date -> name. */
	static async getHolidayMaps(branchIds, startYmd, endYmd) {
		await AttendanceCalendarModel.ensureSchema();
		const ids = [...new Set(branchIds.filter((id) => id != null).map(Number))];
		const maps = new Map(ids.map((id) => [id, new Map()]));
		if (!ids.length) return maps;
		const [rows] = await pool.query(
			`SELECT BRANCH_ID, DATE_FORMAT(HOLIDAY_DATE, '%Y-%m-%d') AS HOLIDAY_DATE, NAME
			 FROM attendance_holidays
			 WHERE ACTIVE = 1 AND BRANCH_ID IN (${ids.map(() => '?').join(',')}) AND HOLIDAY_DATE BETWEEN ? AND ?`,
			[...ids, startYmd, endYmd]
		);
		for (const r of rows) maps.get(Number(r.BRANCH_ID)).set(r.HOLIDAY_DATE, r.NAME);
		return maps;
	}

	/** One branch's holidays, newest first (for the rules dialog). */
	static async listHolidays(branchId) {
		await AttendanceCalendarModel.ensureSchema();
		const [rows] = await pool.query(
			`SELECT IDNo, DATE_FORMAT(HOLIDAY_DATE, '%Y-%m-%d') AS HOLIDAY_DATE, NAME
			 FROM attendance_holidays WHERE ACTIVE = 1 AND BRANCH_ID = ? ORDER BY HOLIDAY_DATE DESC`,
			[branchId]
		);
		return rows;
	}

	/** Adds a holiday (or renames the one on that date, bringing back a removed one). */
	static async saveHoliday(branchId, ymd, name, userId) {
		await AttendanceCalendarModel.ensureSchema();
		await pool.query(
			`INSERT INTO attendance_holidays (BRANCH_ID, HOLIDAY_DATE, NAME, ENCODED_BY) VALUES (?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE NAME = VALUES(NAME), ACTIVE = 1, EDITED_BY = ?, EDITED_DT = NOW()`,
			[branchId, ymd, name, userId, userId]
		);
	}

	/** Removes a holiday of the branch. False when there was none. */
	static async removeHoliday(branchId, id, userId) {
		await AttendanceCalendarModel.ensureSchema();
		const [result] = await pool.query(
			`UPDATE attendance_holidays SET ACTIVE = 0, EDITED_BY = ?, EDITED_DT = NOW()
			 WHERE IDNo = ? AND BRANCH_ID = ? AND ACTIVE = 1`,
			[userId, id, branchId]
		);
		return result.affectedRows > 0;
	}

	// ---- Excused days (one person) ----

	/** Excused days of the given people between two dates: Map employeeId -> Map date -> { type, note }. */
	static async getExcusedMaps(employeeIds, startYmd, endYmd) {
		await AttendanceCalendarModel.ensureSchema();
		const ids = [...new Set(employeeIds.filter((id) => id != null).map(Number))];
		const maps = new Map();
		if (!ids.length) return maps;
		const [rows] = await pool.query(
			`SELECT EMPLOYEE_ID, DATE_FORMAT(WORK_DATE, '%Y-%m-%d') AS WORK_DATE, EXCUSE_TYPE, NOTE
			 FROM attendance_excused_days
			 WHERE ACTIVE = 1 AND EMPLOYEE_ID IN (${ids.map(() => '?').join(',')}) AND WORK_DATE BETWEEN ? AND ?`,
			[...ids, startYmd, endYmd]
		);
		for (const r of rows) {
			const id = Number(r.EMPLOYEE_ID);
			if (!maps.has(id)) maps.set(id, new Map());
			maps.get(id).set(r.WORK_DATE, { type: r.EXCUSE_TYPE, note: r.NOTE || null });
		}
		return maps;
	}

	/** Marks one person's date (replacing an earlier mark on it). */
	static async saveExcusedDay(employeeId, ymd, type, note, userId) {
		await AttendanceCalendarModel.ensureSchema();
		await pool.query(
			`INSERT INTO attendance_excused_days (EMPLOYEE_ID, WORK_DATE, EXCUSE_TYPE, NOTE, ENCODED_BY) VALUES (?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE EXCUSE_TYPE = VALUES(EXCUSE_TYPE), NOTE = VALUES(NOTE), ACTIVE = 1, EDITED_BY = ?, EDITED_DT = NOW()`,
			[employeeId, ymd, type, note, userId, userId]
		);
	}

	/** Removes one person's mark on a date. False when there was none. */
	static async removeExcusedDay(employeeId, ymd, userId) {
		await AttendanceCalendarModel.ensureSchema();
		const [result] = await pool.query(
			`UPDATE attendance_excused_days SET ACTIVE = 0, EDITED_BY = ?, EDITED_DT = NOW()
			 WHERE EMPLOYEE_ID = ? AND WORK_DATE = ? AND ACTIVE = 1`,
			[userId, employeeId, ymd]
		);
		return result.affectedRows > 0;
	}
}

AttendanceCalendarModel.EXCUSE_TYPES = EXCUSE_TYPES;

module.exports = AttendanceCalendarModel;
