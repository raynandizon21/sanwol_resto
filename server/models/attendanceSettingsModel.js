// ============================================
// ATTENDANCE SETTINGS MODEL
// ============================================
// File: models/attendanceSettingsModel.js
// Description: Per-branch attendance rules (standard day, longest shift) used by
// services/attendanceEngine.js. A branch without a row uses DEFAULT_RULES.
// See docs/attendance.md.
// ============================================

const pool = require('../config/db');
const { DEFAULT_RULES } = require('../services/attendanceEngine');

// Column <-> rule name, with the limits the API accepts.
const FIELDS = [
	{ column: 'STANDARD_HOURS', rule: 'standardHours', min: 1, max: 16, decimals: true },
	{ column: 'MAX_SHIFT_HOURS', rule: 'maxShiftHours', min: 8, max: 24 },
];

// Rules from the first version (schedules, overtime, grace period, automatic break), removed
// 2026-11-04 when attendance became basic time tracking. Dropped from existing tables.
const DROPPED_COLUMNS = ['GRACE_MINUTES', 'OT_MODE', 'OT_MIN_MINUTES', 'OT_ROUND_MINUTES', 'DEFAULT_BREAK_MINUTES'];

const fromRow = (row) => {
	if (!row) return { ...DEFAULT_RULES };
	const rules = {};
	for (const f of FIELDS) {
		const value = row[f.column];
		rules[f.rule] = value == null ? DEFAULT_RULES[f.rule] : Number(value);
	}
	return rules;
};

class AttendanceSettingsModel {
	static _schemaReady = false;

	static async ensureSchema() {
		if (AttendanceSettingsModel._schemaReady) return;
		await pool.query(`
			CREATE TABLE IF NOT EXISTS attendance_settings (
				BRANCH_ID INT NOT NULL,
				STANDARD_HOURS DECIMAL(4,2) NOT NULL DEFAULT ${DEFAULT_RULES.standardHours} COMMENT 'Hours a day counted as regular; more is shown as over',
				MAX_SHIFT_HOURS SMALLINT NOT NULL DEFAULT ${DEFAULT_RULES.maxShiftHours} COMMENT 'No time-out within this = missing time-out',
				ENCODED_BY INT NULL DEFAULT NULL,
				ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				EDITED_BY INT NULL DEFAULT NULL,
				EDITED_DT DATETIME NULL DEFAULT NULL,
				PRIMARY KEY (BRANCH_ID)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
		`);
		const [cols] = await pool.query(
			`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_settings'`
		);
		const existing = new Set(cols.map((c) => c.COLUMN_NAME));
		for (const column of DROPPED_COLUMNS) {
			if (existing.has(column)) {
				await pool.query(`ALTER TABLE attendance_settings DROP COLUMN ${column}`);
				console.log(`[Schema] attendance_settings.${column} dropped`);
			}
		}
		AttendanceSettingsModel._schemaReady = true;
	}

	/** Rules for one branch (defaults when none are saved). */
	static async getRules(branchId) {
		return (await AttendanceSettingsModel.getRulesForBranches([branchId])).get(Number(branchId)) || { ...DEFAULT_RULES };
	}

	/** Map of branch ID -> rules for each given branch (null/unknown branches get the defaults). */
	static async getRulesForBranches(branchIds) {
		await AttendanceSettingsModel.ensureSchema();
		const ids = [...new Set(branchIds.filter((id) => id != null).map(Number))];
		const map = new Map();
		if (ids.length) {
			const [rows] = await pool.query(
				`SELECT * FROM attendance_settings WHERE BRANCH_ID IN (${ids.map(() => '?').join(',')})`,
				ids
			);
			for (const row of rows) map.set(Number(row.BRANCH_ID), fromRow(row));
		}
		for (const id of ids) if (!map.has(id)) map.set(id, { ...DEFAULT_RULES });
		return map;
	}

	/**
	 * Checks a rules payload (camelCase names, as getRules returns them).
	 * Returns { rules } with every field, or { error }.
	 */
	static validate(input) {
		const rules = {};
		for (const f of FIELDS) {
			const raw = input?.[f.rule];
			if (raw === undefined || raw === null || raw === '') return { error: `${f.rule} is required` };
			const value = Number(raw);
			if (!Number.isFinite(value) || value < f.min || value > f.max) {
				return { error: `${f.rule} must be between ${f.min} and ${f.max}` };
			}
			rules[f.rule] = f.decimals ? Math.round(value * 100) / 100 : Math.round(value);
		}
		return { rules };
	}

	static async saveRules(branchId, rules, userId) {
		await AttendanceSettingsModel.ensureSchema();
		const columns = FIELDS.map((f) => f.column);
		const values = FIELDS.map((f) => rules[f.rule]);
		await pool.query(
			`INSERT INTO attendance_settings (BRANCH_ID, ${columns.join(', ')}, ENCODED_BY)
			 VALUES (?, ${columns.map(() => '?').join(', ')}, ?)
			 ON DUPLICATE KEY UPDATE ${columns.map((c) => `${c} = VALUES(${c})`).join(', ')}, EDITED_BY = ?, EDITED_DT = NOW()`,
			[branchId, ...values, userId, userId]
		);
	}
}

module.exports = AttendanceSettingsModel;
