// ============================================
// ATTENDANCE CALENDAR MODEL
// ============================================
// File: models/attendanceCalendarModel.js
// Description: Branch holidays (attendance_holidays), edited on the Schedules page. Someone
// without a shift that day isn't absent; someone given a shift is expected (the restaurant is
// open). Soft-deleted (ACTIVE = 0) and brought back on re-adding. Per-person days off and leave
// are schedule days (models/scheduleModel.js; the old attendance_excused_days table moved there
// on 2026-11-06). See docs/attendance.md.
// ============================================

const pool = require('../config/db');

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
				COMMENT='Branch holidays (shown on the Schedules page; only people given a shift are expected)'
			`);
			AttendanceCalendarModel._schemaReady = true;
			AttendanceCalendarModel._schemaPromise = null;
		})().catch((error) => {
			AttendanceCalendarModel._schemaPromise = null;
			throw error;
		});
		return AttendanceCalendarModel._schemaPromise;
	}

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
}

module.exports = AttendanceCalendarModel;
