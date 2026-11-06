// ============================================
// SCHEDULE MODEL
// ============================================
// File: models/scheduleModel.js
// Description: Work schedules, set per employee per day on the Schedules page (since 2026-11-06):
// - attendance_shift_types: a branch's shifts. Fixed since 2026-11-06 (FIXED_SHIFTS: Opening, Mid,
//   Closing, Whole day, each allowed on certain weekdays), kept in the table so days can point to
//   them; there's no editing them in the app.
// - attendance_schedule_days: one entry per person and date: a shift (one of those, on a weekday
//   it's allowed), a day off, leave, or a recorded absence. No entry = not scheduled (not checked).
// A shift day keeps its own copy of the times. Custom times were removed 2026-11-06. See
// docs/attendance.md.
// The per-branch attendance rules (attendance_settings) and holidays (attendance_holidays) were
// removed 2026-11-06 and their tables are dropped here (dropRemovedTables).
// ============================================

const pool = require('../config/db');

// What a day can be. 'shift' has times; the rest are off duty (leave and absent take a note).
const DAY_TYPES = ['shift', 'day_off', 'leave', 'absent'];
const OFF_DUTY_TYPES = ['day_off', 'leave', 'absent'];

const NAME_MAX = 40;
const NOTE_MAX = 255;

// Tables of removed features, dropped on start: the attendance rules (standard day, longest
// shift, grace period, cutoff) and branch holidays, both removed 2026-11-06 (they held test data).
const REMOVED_TABLES = ['attendance_settings', 'attendance_holidays'];

// Sanwol's shifts (FOH schedule, November 2026), the only ones (fixed 2026-11-06, senior's
// request). Weekdays: 0 = Sunday. Mon–Thu have Opening and Closing; Fri–Sun also Mid and Whole day.
// In this order on the page, in the dialog and in the printed legend. Every branch's table rows are
// kept in line with this list on start (syncFixedShifts).
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const FRI_TO_SUN = [5, 6, 0];
const FIXED_SHIFTS = [
	{ name: 'Opening', start: '10:00', end: '19:00', color: '#FCD34D', weekdays: EVERY_DAY },
	{ name: 'Mid', start: '12:00', end: '21:00', color: '#78350F', weekdays: FRI_TO_SUN },
	{ name: 'Closing', start: '14:00', end: '23:00', color: '#15803D', weekdays: EVERY_DAY },
	{ name: 'Whole day', start: '11:00', end: '23:00', color: '#C2410C', weekdays: FRI_TO_SUN },
];

// Columns added 2026-11-06 to existing tables.
const SHIFT_TYPE_COLUMNS = [
	{ name: 'WEEKDAYS', ddl: "ADD COLUMN WEEKDAYS VARCHAR(13) NOT NULL DEFAULT '0,1,2,3,4,5,6' COMMENT 'Weekdays it can be given (0=Sun), comma-separated' AFTER COLOR" },
	{ name: 'SORT_ORDER', ddl: "ADD COLUMN SORT_ORDER TINYINT NOT NULL DEFAULT 0 COMMENT 'Order on the page and the printed legend' AFTER WEEKDAYS" },
];

const SHIFT_TYPE_SELECT = `IDNo, BRANCH_ID, NAME, TIME_FORMAT(START_TIME, '%H:%i') AS START_TIME,
	TIME_FORMAT(END_TIME, '%H:%i') AS END_TIME, COLOR, WEEKDAYS, ACTIVE`;

const mapShiftType = (r) => ({
	id: Number(r.IDNo),
	branchId: Number(r.BRANCH_ID),
	name: r.NAME,
	start: r.START_TIME,
	end: r.END_TIME,
	color: r.COLOR,
	// Weekdays it can be given (0 = Sunday).
	weekdays: String(r.WEEKDAYS ?? '').split(',').filter((d) => d !== '').map(Number),
	active: Boolean(Number(r.ACTIVE)),
});

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "every day", "Fri–Sun", "Mon, Wed": the weekdays a shift is for (weeks run Monday to Sunday). */
function weekdaysLabel(weekdays) {
	const set = new Set(weekdays);
	if (set.size === 7) return 'every day';
	const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => set.has(d));
	const runs = [];
	for (const d of order) {
		const last = runs[runs.length - 1];
		if (last && [1, 2, 3, 4, 5, 6, 0].indexOf(d) === [1, 2, 3, 4, 5, 6, 0].indexOf(last[last.length - 1]) + 1) last.push(d);
		else runs.push([d]);
	}
	return runs.map((r) => (r.length > 2 ? `${WEEKDAY_SHORT[r[0]]}–${WEEKDAY_SHORT[r[r.length - 1]]}` : r.map((d) => WEEKDAY_SHORT[d]).join(', '))).join(', ');
}

/** Weekday of a "YYYY-MM-DD" (0 = Sunday). */
const weekdayOfYmd = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

/** Minutes a shift lasts (an end at or before the start is the next day's). */
const shiftMinutes = (start, end) => {
	const toM = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
	const diff = toM(end) - toM(start);
	return diff > 0 ? diff : diff + 1440;
};

/**
 * Checks what to put in schedule cells. Returns { value } or { error }:
 * { type: 'clear' } | { type: 'shift', shiftTypeId } | { type: 'day_off' | 'leave' | 'absent', note }.
 * (Custom times were removed 2026-11-06.)
 */
function validateDayValue(input) {
	const type = input?.type;
	if (type === 'clear') return { value: { type } };
	if (!DAY_TYPES.includes(type)) return { error: `type must be one of clear, ${DAY_TYPES.join(', ')}` };
	if (type === 'shift') {
		const shiftTypeId = Number(input.shift_type_id ?? input.shiftTypeId);
		if (Number.isInteger(shiftTypeId) && shiftTypeId > 0) return { value: { type, shiftTypeId } };
		return { error: 'Choose a shift' };
	}
	const note = String(input.note ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) || null;
	return { value: { type, note: type === 'day_off' ? null : note } };
}

class ScheduleModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (ScheduleModel._schemaReady) return;
		if (ScheduleModel._schemaPromise) return ScheduleModel._schemaPromise;
		ScheduleModel._schemaPromise = (async () => {
			// employee must exist for the foreign key.
			await require('./employeeModel').ensureSchema();
			// First run of Schedules on this database (the permission copy below happens only then).
			const [[fresh]] = await pool.query(
				`SELECT COUNT(*) = 0 AS FRESH FROM information_schema.TABLES
				 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_shift_types'`
			);
			await pool.query(`
				CREATE TABLE IF NOT EXISTS attendance_shift_types (
					IDNo INT NOT NULL AUTO_INCREMENT,
					BRANCH_ID INT NOT NULL COMMENT 'Link to branches table',
					NAME VARCHAR(${NAME_MAX}) NOT NULL,
					START_TIME TIME NOT NULL,
					END_TIME TIME NOT NULL COMMENT 'At or before START_TIME = the next day',
					COLOR CHAR(7) NOT NULL COMMENT 'Hex color shown on the Schedules page',
					WEEKDAYS VARCHAR(13) NOT NULL DEFAULT '0,1,2,3,4,5,6' COMMENT 'Weekdays it can be given (0=Sun), comma-separated',
					SORT_ORDER TINYINT NOT NULL DEFAULT 0 COMMENT 'Order on the page and the printed legend',
					ACTIVE TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0 = not one of the fixed shifts (days already given it keep their copy)',
					ENCODED_BY INT NULL DEFAULT NULL,
					ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
					EDITED_BY INT NULL DEFAULT NULL,
					EDITED_DT DATETIME NULL DEFAULT NULL,
					PRIMARY KEY (IDNo),
					KEY idx_attendance_shift_types_branch (BRANCH_ID, ACTIVE)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
				COMMENT='Named shifts of a branch (Opening, Mid, Closing, ...) for the Schedules page'
			`);
			const [shiftCols] = await pool.query(
				`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_shift_types'`
			);
			const haveShiftCols = new Set(shiftCols.map((c) => c.COLUMN_NAME));
			for (const col of SHIFT_TYPE_COLUMNS) {
				if (!haveShiftCols.has(col.name)) {
					await pool.query(`ALTER TABLE attendance_shift_types ${col.ddl}`);
					console.log(`[Schema] attendance_shift_types.${col.name} created`);
				}
			}
			await pool.query(`
				CREATE TABLE IF NOT EXISTS attendance_schedule_days (
					IDNo INT NOT NULL AUTO_INCREMENT,
					EMPLOYEE_ID INT NOT NULL COMMENT 'employee.IDNo',
					WORK_DATE DATE NOT NULL,
					DAY_TYPE VARCHAR(10) NOT NULL COMMENT 'shift, day_off, leave or absent',
					SHIFT_TYPE_ID INT NULL DEFAULT NULL COMMENT 'attendance_shift_types.IDNo (set on every shift day)',
					START_TIME TIME NULL DEFAULT NULL COMMENT 'Shift start (a copy, so editing the shift type leaves past days alone)',
					END_TIME TIME NULL DEFAULT NULL COMMENT 'Shift end; at or before START_TIME = the next day',
					NOTE VARCHAR(${NOTE_MAX}) NULL DEFAULT NULL COMMENT 'Leave / absent note',
					ENCODED_BY INT NULL DEFAULT NULL,
					ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
					EDITED_BY INT NULL DEFAULT NULL,
					EDITED_DT DATETIME NULL DEFAULT NULL,
					PRIMARY KEY (IDNo),
					UNIQUE KEY uq_attendance_schedule_days (EMPLOYEE_ID, WORK_DATE),
					KEY idx_attendance_schedule_days_date (WORK_DATE),
					KEY idx_attendance_schedule_days_shift (SHIFT_TYPE_ID),
					CONSTRAINT fk_attendance_schedule_days_employee FOREIGN KEY (EMPLOYEE_ID) REFERENCES employee (IDNo)
						ON UPDATE CASCADE ON DELETE CASCADE,
					CONSTRAINT fk_attendance_schedule_days_shift FOREIGN KEY (SHIFT_TYPE_ID) REFERENCES attendance_shift_types (IDNo)
						ON UPDATE CASCADE ON DELETE SET NULL
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
				COMMENT='Each employee''s schedule per day (Schedules page); no row = not scheduled'
			`);
			await ScheduleModel.migrateExcusedDays();
			await ScheduleModel.dropRemovedTables();
			await ScheduleModel.syncFixedShifts();
			await ScheduleModel.clearDisallowedDays();
			if (Number(fresh.FRESH)) await ScheduleModel.grantFromAttendanceLogs();
			ScheduleModel._schemaReady = true;
			ScheduleModel._schemaPromise = null;
		})().catch((error) => {
			ScheduleModel._schemaPromise = null;
			throw error;
		});
		return ScheduleModel._schemaPromise;
	}

	/**
	 * Keeps every branch's shift types in line with FIXED_SHIFTS (names, times, colors, weekdays,
	 * order); shifts not in the list are deactivated (days already given one keep it). Branches
	 * with no shift types yet get them on first use (listShiftTypes).
	 */
	static async syncFixedShifts() {
		const [branches] = await pool.query('SELECT DISTINCT BRANCH_ID FROM attendance_shift_types');
		for (const { BRANCH_ID: branchId } of branches) await ScheduleModel.applyFixedShifts(pool, branchId);
	}

	/** Puts FIXED_SHIFTS into one branch's rows (by name), adding missing ones. `db`: pool or connection. */
	static async applyFixedShifts(db, branchId) {
		const [rows] = await db.query('SELECT IDNo, NAME FROM attendance_shift_types WHERE BRANCH_ID = ?', [branchId]);
		const byName = new Map(rows.map((r) => [String(r.NAME).toLowerCase(), Number(r.IDNo)]));
		const keep = [];
		for (const [i, s] of FIXED_SHIFTS.entries()) {
			const id = byName.get(s.name.toLowerCase());
			const values = [s.name, s.start, s.end, s.color, s.weekdays.join(','), i + 1];
			if (id) {
				await db.query(
					`UPDATE attendance_shift_types SET NAME = ?, START_TIME = ?, END_TIME = ?, COLOR = ?, WEEKDAYS = ?, SORT_ORDER = ?, ACTIVE = 1
					 WHERE IDNo = ? AND (NAME <> ? OR START_TIME <> ? OR END_TIME <> ? OR COLOR <> ? OR WEEKDAYS <> ? OR SORT_ORDER <> ? OR ACTIVE <> 1)`,
					[...values, id, ...values]
				);
				keep.push(id);
			} else {
				const [result] = await db.query(
					'INSERT INTO attendance_shift_types (BRANCH_ID, NAME, START_TIME, END_TIME, COLOR, WEEKDAYS, SORT_ORDER) VALUES (?, ?, ?, ?, ?, ?, ?)',
					[branchId, ...values]
				);
				keep.push(result.insertId);
			}
		}
		await db.query(
			`UPDATE attendance_shift_types SET ACTIVE = 0 WHERE BRANCH_ID = ? AND ACTIVE = 1 AND IDNo NOT IN (${keep.map(() => '?').join(',')})`,
			[branchId, ...keep]
		);
	}

	/**
	 * Deletes schedule days the fixed shifts don't allow (2026-11-06): a shift on a weekday it isn't
	 * for (Mid or Whole day on Mon–Thu), and custom-time shifts (no shift type). The app can't set
	 * them any more, so this only finds days from before the rule.
	 */
	static async clearDisallowedDays() {
		const [wrongDay] = await pool.query(
			`DELETE d FROM attendance_schedule_days d
			 JOIN attendance_shift_types s ON s.IDNo = d.SHIFT_TYPE_ID
			 WHERE d.DAY_TYPE = 'shift' AND s.ACTIVE = 1 AND FIND_IN_SET(DAYOFWEEK(d.WORK_DATE) - 1, s.WEEKDAYS) = 0`
		);
		const [custom] = await pool.query(`DELETE FROM attendance_schedule_days WHERE DAY_TYPE = 'shift' AND SHIFT_TYPE_ID IS NULL`);
		if (wrongDay.affectedRows || custom.affectedRows) {
			console.log(
				`[Schema] attendance_schedule_days: cleared ${wrongDay.affectedRows} shift(s) on a weekday they aren't for and ${custom.affectedRows} custom-time shift(s)`
			);
		}
	}

	/** Drops the tables of removed features (REMOVED_TABLES) if they're still there. */
	static async dropRemovedTables() {
		const [rows] = await pool.query(
			`SELECT TABLE_NAME FROM information_schema.TABLES
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${REMOVED_TABLES.map(() => '?').join(',')})`,
			REMOVED_TABLES
		);
		for (const { TABLE_NAME: name } of rows) {
			await pool.query(`DROP TABLE IF EXISTS \`${name}\``);
			console.log(`[Schema] ${name} dropped (feature removed 2026-11-06)`);
		}
	}

	/**
	 * Day marks (attendance_excused_days, 2026-11-05) became schedule days on 2026-11-06: leave and
	 * day off carry over; a "holiday" mark becomes leave noted "Holiday". The old table is dropped.
	 */
	static async migrateExcusedDays() {
		const [[exists]] = await pool.query(
			`SELECT COUNT(*) AS N FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_excused_days'`
		);
		if (!Number(exists.N)) return;
		await pool.query(
			`INSERT IGNORE INTO attendance_schedule_days (EMPLOYEE_ID, WORK_DATE, DAY_TYPE, NOTE, ENCODED_BY, ENCODED_DT, EDITED_BY, EDITED_DT)
			 SELECT x.EMPLOYEE_ID, x.WORK_DATE, IF(x.EXCUSE_TYPE = 'day_off', 'day_off', 'leave'),
				IF(x.EXCUSE_TYPE = 'holiday', COALESCE(CONCAT('Holiday: ', x.NOTE), 'Holiday'), x.NOTE),
				x.ENCODED_BY, x.ENCODED_DT, x.EDITED_BY, x.EDITED_DT
			 FROM attendance_excused_days x JOIN employee e ON e.IDNo = x.EMPLOYEE_ID
			 WHERE x.ACTIVE = 1`
		);
		await pool.query('DROP TABLE attendance_excused_days');
		console.log('[Schema] attendance_excused_days moved into attendance_schedule_days and dropped');
	}

	/**
	 * The Schedules permission (CRUD module `schedules`, 2026-11-06) took over the (since removed) attendance rules
	 * from Attendance Logs → Edit. Roles get the same Add / Edit / Delete as on Attendance Logs,
	 * once: only when the schedule tables are first created. (A role with no Schedules rights has no
	 * row at all, so "no rows yet" can't tell a new install from an admin revoking them.)
	 */
	static async grantFromAttendanceLogs() {
		try {
			const [[has]] = await pool.query(`SELECT COUNT(*) AS N FROM user_role_crud_permissions WHERE module_key = 'schedules'`);
			if (Number(has.N)) return;
			const [result] = await pool.query(
				`INSERT IGNORE INTO user_role_crud_permissions (role_id, module_key, can_create, can_update, can_delete)
				 SELECT role_id, 'schedules', can_create, can_update, can_delete
				 FROM user_role_crud_permissions WHERE module_key = 'attendance_logs'`
			);
			if (result.affectedRows) console.log(`[Schema] Schedules permissions copied from Attendance Logs for ${result.affectedRows} role(s)`);
		} catch (error) {
			// The permissions table is created by its own model; nothing to copy before it exists.
			if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
		}
	}

	// ---- Shift types ----

	/** A branch's shift types (the fixed ones, added the first time), in FIXED_SHIFTS order. */
	static async listShiftTypes(branchId, { includeInactive = false } = {}) {
		await ScheduleModel.ensureSchema();
		const countFor = async (db) =>
			Number((await db.query('SELECT COUNT(*) AS N FROM attendance_shift_types WHERE BRANCH_ID = ?', [branchId]))[0][0].N);
		if (!(await countFor(pool))) {
			// Seed under a lock, checking again inside it, so two first loads can't both seed.
			const conn = await pool.getConnection();
			const lockName = `attendance_shift_types_seed_${Number(branchId)}`;
			try {
				const [[{ GOT }]] = await conn.query('SELECT GET_LOCK(?, 10) AS GOT', [lockName]);
				if (Number(GOT) === 1) {
					try {
						if (!(await countFor(conn))) await ScheduleModel.applyFixedShifts(conn, branchId);
					} finally {
						await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
					}
				}
			} finally {
				conn.release();
			}
		}
		const [rows] = await pool.query(
			`SELECT ${SHIFT_TYPE_SELECT} FROM attendance_shift_types
			 WHERE BRANCH_ID = ?${includeInactive ? '' : ' AND ACTIVE = 1'}
			 ORDER BY ACTIVE DESC, SORT_ORDER, START_TIME, NAME`,
			[branchId]
		);
		return rows.map(mapShiftType);
	}

	static async getShiftType(branchId, id) {
		await ScheduleModel.ensureSchema();
		const [[row]] = await pool.query(`SELECT ${SHIFT_TYPE_SELECT} FROM attendance_shift_types WHERE IDNo = ? AND BRANCH_ID = ?`, [id, branchId]);
		return row ? mapShiftType(row) : null;
	}

	// ---- Schedule days ----

	/**
	 * Schedule entries of the given people between two dates:
	 * Map employeeId -> Map "YYYY-MM-DD" -> entry. A shift entry: { type: 'shift', shiftTypeId,
	 * name, color, start, end }; off duty: { type, note }.
	 */
	static async getDayMaps(employeeIds, startYmd, endYmd) {
		await ScheduleModel.ensureSchema();
		const ids = [...new Set(employeeIds.filter((id) => id != null).map(Number))];
		const maps = new Map();
		if (!ids.length) return maps;
		const [rows] = await pool.query(
			`SELECT d.EMPLOYEE_ID, DATE_FORMAT(d.WORK_DATE, '%Y-%m-%d') AS WORK_DATE, d.DAY_TYPE, d.SHIFT_TYPE_ID,
				TIME_FORMAT(d.START_TIME, '%H:%i') AS START_TIME, TIME_FORMAT(d.END_TIME, '%H:%i') AS END_TIME, d.NOTE,
				s.NAME AS SHIFT_NAME, s.COLOR AS SHIFT_COLOR
			 FROM attendance_schedule_days d
			 LEFT JOIN attendance_shift_types s ON s.IDNo = d.SHIFT_TYPE_ID
			 WHERE d.EMPLOYEE_ID IN (${ids.map(() => '?').join(',')}) AND d.WORK_DATE BETWEEN ? AND ?`,
			[...ids, startYmd, endYmd]
		);
		for (const r of rows) {
			const id = Number(r.EMPLOYEE_ID);
			if (!maps.has(id)) maps.set(id, new Map());
			const entry =
				r.DAY_TYPE === 'shift' && r.START_TIME && r.END_TIME
					? {
							type: 'shift',
							shiftTypeId: r.SHIFT_TYPE_ID == null ? null : Number(r.SHIFT_TYPE_ID),
							name: r.SHIFT_TYPE_ID == null ? null : r.SHIFT_NAME,
							color: r.SHIFT_TYPE_ID == null ? null : r.SHIFT_COLOR,
							start: r.START_TIME,
							end: r.END_TIME,
						}
					: { type: r.DAY_TYPE, note: r.NOTE || null };
			maps.get(id).set(r.WORK_DATE, entry);
		}
		return maps;
	}

	/**
	 * Sets every cell ({ employeeId, date }) to `value` (validateDayValue), in one transaction.
	 * A shift is copied by its current times (the caller checks its weekdays). 'clear' deletes the
	 * entries.
	 */
	static async setDays(cells, value, userId, shiftType = null) {
		await ScheduleModel.ensureSchema();
		if (!cells.length) return 0;
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			// In batches: a month for a whole team is over a thousand cells.
			const BATCH = 500;
			if (value.type === 'clear') {
				for (let i = 0; i < cells.length; i += BATCH) {
					const chunk = cells.slice(i, i + BATCH);
					await conn.query(
						`DELETE FROM attendance_schedule_days WHERE (EMPLOYEE_ID, WORK_DATE) IN (${chunk.map(() => '(?, ?)').join(', ')})`,
						chunk.flatMap((c) => [c.employeeId, c.date])
					);
				}
			} else {
				const isShift = value.type === 'shift';
				const start = isShift ? shiftType.start : null;
				const end = isShift ? shiftType.end : null;
				const shiftTypeId = isShift && shiftType ? shiftType.id : null;
				const note = isShift ? null : value.note;
				for (let i = 0; i < cells.length; i += BATCH) {
					const chunk = cells.slice(i, i + BATCH);
					await conn.query(
						`INSERT INTO attendance_schedule_days (EMPLOYEE_ID, WORK_DATE, DAY_TYPE, SHIFT_TYPE_ID, START_TIME, END_TIME, NOTE, ENCODED_BY)
						 VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
						 ON DUPLICATE KEY UPDATE DAY_TYPE = VALUES(DAY_TYPE), SHIFT_TYPE_ID = VALUES(SHIFT_TYPE_ID),
							START_TIME = VALUES(START_TIME), END_TIME = VALUES(END_TIME), NOTE = VALUES(NOTE),
							EDITED_BY = VALUES(ENCODED_BY), EDITED_DT = NOW()`,
						chunk.flatMap((c) => [c.employeeId, c.date, value.type, shiftTypeId, start, end, note, userId])
					);
				}
			}
			await conn.commit();
			return cells.length;
		} catch (error) {
			await conn.rollback();
			throw error;
		} finally {
			conn.release();
		}
	}

}

ScheduleModel.DAY_TYPES = DAY_TYPES;
ScheduleModel.OFF_DUTY_TYPES = OFF_DUTY_TYPES;
ScheduleModel.FIXED_SHIFTS = FIXED_SHIFTS;
ScheduleModel.weekdaysLabel = weekdaysLabel;
ScheduleModel.weekdayOfYmd = weekdayOfYmd;
ScheduleModel.validateDayValue = validateDayValue;
ScheduleModel.shiftMinutes = shiftMinutes;

module.exports = ScheduleModel;
