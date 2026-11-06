// ============================================
// ATTENDANCE SETTINGS MODEL
// ============================================
// File: models/attendanceSettingsModel.js
// Description: Per-branch attendance rules used by services/attendanceEngine.js: the standard
// day, the longest shift, the grace period for late arrivals and the payroll cutoff. A branch
// without a row uses the defaults. Work schedules are per employee per day (models/scheduleModel.js;
// the branch schedule was removed 2026-11-06). Edited on the Schedules page. See docs/attendance.md.
// ============================================

const pool = require('../config/db');
const { DEFAULT_RULES } = require('../services/attendanceEngine');
const { isValidYmd } = require('../utils/wallClock');

// Cutoff types: two periods a month (they start on day1 and day2), one a month (starts on day1),
// weekly (starts on `weekday`, 0 = Sunday) and every two weeks (from `anchor`, a first day).
const CUTOFF_TYPES = ['semi_monthly', 'monthly', 'weekly', 'biweekly'];
const DEFAULT_CUTOFF = Object.freeze({ type: 'semi_monthly', day1: 1, day2: 16, weekday: 1, anchor: null });

const DEFAULTS = Object.freeze({
	...DEFAULT_RULES,
	// Minutes after a shift's start before a time-in counts as late.
	graceMinutes: 15,
	cutoff: DEFAULT_CUTOFF,
});

// Number rules: column <-> rule name, with the limits the API accepts.
const NUMBER_FIELDS = [
	{ column: 'STANDARD_HOURS', rule: 'standardHours', min: 1, max: 16, decimals: true },
	{ column: 'MAX_SHIFT_HOURS', rule: 'maxShiftHours', min: 8, max: 24 },
	{ column: 'LATE_GRACE_MINUTES', rule: 'graceMinutes', min: 0, max: 120 },
];

// Added 2026-11-05 (late, cutoffs).
const ADDED_COLUMNS = [
	{ name: 'LATE_GRACE_MINUTES', ddl: `ADD COLUMN LATE_GRACE_MINUTES SMALLINT NOT NULL DEFAULT ${DEFAULTS.graceMinutes} COMMENT 'Minutes after a shift starts before a time-in is late' AFTER MAX_SHIFT_HOURS` },
	{ name: 'CUTOFF_TYPE', ddl: "ADD COLUMN CUTOFF_TYPE VARCHAR(20) NOT NULL DEFAULT 'semi_monthly' COMMENT 'semi_monthly, monthly, weekly or biweekly' AFTER LATE_GRACE_MINUTES" },
	{ name: 'CUTOFF_DAY_1', ddl: "ADD COLUMN CUTOFF_DAY_1 TINYINT NOT NULL DEFAULT 1 COMMENT 'Day of the month a period starts (semi_monthly, monthly)' AFTER CUTOFF_TYPE" },
	{ name: 'CUTOFF_DAY_2', ddl: "ADD COLUMN CUTOFF_DAY_2 TINYINT NOT NULL DEFAULT 16 COMMENT 'Day of the month the second period starts (semi_monthly)' AFTER CUTOFF_DAY_1" },
	{ name: 'CUTOFF_WEEKDAY', ddl: "ADD COLUMN CUTOFF_WEEKDAY TINYINT NOT NULL DEFAULT 1 COMMENT 'Weekday a period starts (weekly; 0=Sun)' AFTER CUTOFF_DAY_2" },
	{ name: 'CUTOFF_ANCHOR', ddl: "ADD COLUMN CUTOFF_ANCHOR DATE NULL DEFAULT NULL COMMENT 'First day of any period (biweekly)' AFTER CUTOFF_WEEKDAY" },
];

// Rules from the first version (overtime, automatic break, the old grace period), removed
// 2026-11-04 when attendance became basic time tracking. Dropped from existing tables. The grace
// period came back on 2026-11-05 as LATE_GRACE_MINUTES. The branch schedule (call time, end time,
// days closed) was dropped 2026-11-06: schedules are per employee per day now.
const DROPPED_COLUMNS = [
	'GRACE_MINUTES', 'OT_MODE', 'OT_MIN_MINUTES', 'OT_ROUND_MINUTES', 'DEFAULT_BREAK_MINUTES',
	'SCHEDULE_START', 'SCHEDULE_END', 'CLOSED_DAYS',
];

const SELECT = `
	BRANCH_ID, STANDARD_HOURS, MAX_SHIFT_HOURS, LATE_GRACE_MINUTES, CUTOFF_TYPE, CUTOFF_DAY_1, CUTOFF_DAY_2, CUTOFF_WEEKDAY,
	DATE_FORMAT(CUTOFF_ANCHOR, '%Y-%m-%d') AS CUTOFF_ANCHOR`;

const fromRow = (row) => {
	if (!row) return { ...DEFAULTS, cutoff: { ...DEFAULT_CUTOFF } };
	const rules = {};
	for (const f of NUMBER_FIELDS) {
		const value = row[f.column];
		rules[f.rule] = value == null ? DEFAULTS[f.rule] : Number(value);
	}
	rules.cutoff = {
		type: CUTOFF_TYPES.includes(row.CUTOFF_TYPE) ? row.CUTOFF_TYPE : DEFAULT_CUTOFF.type,
		day1: Number(row.CUTOFF_DAY_1) || DEFAULT_CUTOFF.day1,
		day2: Number(row.CUTOFF_DAY_2) || DEFAULT_CUTOFF.day2,
		weekday: row.CUTOFF_WEEKDAY == null ? DEFAULT_CUTOFF.weekday : Number(row.CUTOFF_WEEKDAY),
		anchor: row.CUTOFF_ANCHOR || null,
	};
	return rules;
};

/** Checks a cutoff payload. Returns { cutoff } or { error }. */
function validateCutoff(input) {
	const type = input?.type;
	if (!CUTOFF_TYPES.includes(type)) return { error: `cutoff.type must be one of ${CUTOFF_TYPES.join(', ')}` };
	const int = (v) => (Number.isInteger(Number(v)) && v !== '' && v != null ? Number(v) : NaN);
	const cutoff = { ...DEFAULT_CUTOFF, type };
	// Days 1-28 so every month has them.
	if (type === 'semi_monthly' || type === 'monthly') {
		cutoff.day1 = int(input.day1);
		if (!(cutoff.day1 >= 1 && cutoff.day1 <= 28)) return { error: 'The cutoff start day must be from 1 to 28' };
	}
	if (type === 'semi_monthly') {
		cutoff.day2 = int(input.day2);
		if (!(cutoff.day2 > cutoff.day1 && cutoff.day2 <= 28)) {
			return { error: 'The second cutoff must start after the first, on day 28 at the latest' };
		}
	}
	if (type === 'weekly') {
		cutoff.weekday = int(input.weekday);
		if (!(cutoff.weekday >= 0 && cutoff.weekday <= 6)) return { error: 'Choose the weekday the cutoff starts on' };
	}
	if (type === 'biweekly') {
		if (!isValidYmd(input.anchor)) return { error: 'Choose the first day of one of the two-week periods' };
		cutoff.anchor = input.anchor;
	}
	return { cutoff };
}

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
		for (const col of ADDED_COLUMNS) {
			if (!existing.has(col.name)) {
				await pool.query(`ALTER TABLE attendance_settings ${col.ddl}`);
				console.log(`[Schema] attendance_settings.${col.name} created`);
			}
		}
		AttendanceSettingsModel._schemaReady = true;
	}

	/** Rules for one branch (defaults when none are saved). */
	static async getRules(branchId) {
		return (await AttendanceSettingsModel.getRulesForBranches([branchId])).get(Number(branchId)) || fromRow(null);
	}

	/** Map of branch ID -> rules for each given branch (null/unknown branches get the defaults). */
	static async getRulesForBranches(branchIds) {
		await AttendanceSettingsModel.ensureSchema();
		const ids = [...new Set(branchIds.filter((id) => id != null).map(Number))];
		const map = new Map();
		if (ids.length) {
			const [rows] = await pool.query(
				`SELECT ${SELECT} FROM attendance_settings WHERE BRANCH_ID IN (${ids.map(() => '?').join(',')})`,
				ids
			);
			for (const row of rows) map.set(Number(row.BRANCH_ID), fromRow(row));
		}
		for (const id of ids) if (!map.has(id)) map.set(id, fromRow(null));
		return map;
	}

	/**
	 * Checks a rules payload (camelCase names, as getRules returns them).
	 * Returns { rules } with every field, or { error }.
	 */
	static validate(input) {
		const rules = {};
		for (const f of NUMBER_FIELDS) {
			let raw = input?.[f.rule];
			// Older pages don't send the grace period.
			if ((raw === undefined || raw === null || raw === '') && f.rule === 'graceMinutes') raw = DEFAULTS.graceMinutes;
			if (raw === undefined || raw === null || raw === '') return { error: `${f.rule} is required` };
			const value = Number(raw);
			if (!Number.isFinite(value) || value < f.min || value > f.max) {
				return { error: `${f.rule} must be between ${f.min} and ${f.max}` };
			}
			rules[f.rule] = f.decimals ? Math.round(value * 100) / 100 : Math.round(value);
		}
		const { cutoff, error } = validateCutoff(input?.cutoff ?? DEFAULT_CUTOFF);
		if (error) return { error };
		rules.cutoff = cutoff;
		return { rules };
	}

	static async saveRules(branchId, rules, userId) {
		await AttendanceSettingsModel.ensureSchema();
		const values = {
			STANDARD_HOURS: rules.standardHours,
			MAX_SHIFT_HOURS: rules.maxShiftHours,
			LATE_GRACE_MINUTES: rules.graceMinutes,
			CUTOFF_TYPE: rules.cutoff.type,
			CUTOFF_DAY_1: rules.cutoff.day1,
			CUTOFF_DAY_2: rules.cutoff.day2,
			CUTOFF_WEEKDAY: rules.cutoff.weekday,
			CUTOFF_ANCHOR: rules.cutoff.anchor,
		};
		const columns = Object.keys(values);
		await pool.query(
			`INSERT INTO attendance_settings (BRANCH_ID, ${columns.join(', ')}, ENCODED_BY)
			 VALUES (?, ${columns.map(() => '?').join(', ')}, ?)
			 ON DUPLICATE KEY UPDATE ${columns.map((c) => `${c} = VALUES(${c})`).join(', ')}, EDITED_BY = ?, EDITED_DT = NOW()`,
			[branchId, ...Object.values(values), userId, userId]
		);
	}
}

AttendanceSettingsModel.DEFAULT_CUTOFF = DEFAULT_CUTOFF;

module.exports = AttendanceSettingsModel;
