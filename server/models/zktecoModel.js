// ============================================
// ZKTECO MODEL
// ============================================
// File: models/zktecoModel.js
// Description: Schema + read queries for the ZKTeco (MB160) database.
// Writes from the device itself live in services/admsService.js.
// Tables are in their own DB (config/zktecoDb.js); see docs/zkteco-mb160.md.
// ============================================

const zkPool = require('../config/zktecoDb');

// Soft delete for device users. A removed user's row stays (ACTIVE = 0) so past punches keep
// their name; a reused PIN gets a new row. ACTIVE_PIN is the PIN while active and NULL after,
// so the unique key allows one active row per PIN plus any number of removed ones.
// Shared by the CREATE TABLE below and the migration of existing tables (ADDED_COLUMNS).
const DEVICE_USER_ACTIVE_COLUMNS = {
	active: "ACTIVE TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0 = removed from the device (kept so past punches keep their name)'",
	activePin: "ACTIVE_PIN VARCHAR(32) GENERATED ALWAYS AS (IF(ACTIVE = 1, PIN, NULL)) STORED COMMENT 'PIN while active, NULL once removed'",
	editedBy: "EDITED_BY INT NULL DEFAULT NULL COMMENT 'sanwol_resto user who removed it from the app (NULL = change came from the device)'",
	readdedAs: "READDED_AS_ID INT NULL DEFAULT NULL COMMENT 'Latest row of this person after Add again (hidden from Show deleted)'",
};

// "Add again": the removed device_users row an add command brings back. Linked to the new row
// (READDED_AS_ID) once the device confirms the add.
const COMMAND_READD_OF_COLUMN =
	"READD_OF_ID INT NULL DEFAULT NULL COMMENT 'device_users row being added again (Add again)'";

// The person's profile in sanwol_resto (employee.IDNo). No foreign key: the two DBs can live on
// different servers. Set by services/employeeLinkService.js; all rows of one person share it.
const DEVICE_USER_EMPLOYEE_COLUMN =
	"EMPLOYEE_ID INT NULL DEFAULT NULL COMMENT 'sanwol_resto.employee.IDNo (the app-only profile)'";

// Add employee: the profile details typed in the form, as JSON (employee columns). They ride on
// the add command and, once the device confirms it, move to the new device_users row in the same
// transaction; the link pass (employeeLinkService) then turns them into the profile and clears
// them. Cleared on the command when it fails or is cancelled, so personal details don't linger.
const COMMAND_PROFILE_COLUMN =
	"PROFILE_JSON TEXT NULL DEFAULT NULL COMMENT 'Add employee: profile fields to apply once the device confirms'";
const DEVICE_USER_PENDING_PROFILE_COLUMN =
	"PENDING_PROFILE_JSON TEXT NULL DEFAULT NULL COMMENT 'Profile fields from Add employee, not yet applied to the profile'";

const TABLES = [
	`CREATE TABLE IF NOT EXISTS devices (
		IDNo INT NOT NULL AUTO_INCREMENT,
		SERIAL_NO VARCHAR(32) NOT NULL,
		BRANCH_ID INT NULL DEFAULT NULL COMMENT 'sanwol_resto.branches.IDNo',
		DEVICE_NAME VARCHAR(64) NULL DEFAULT NULL,
		IP_ADDRESS VARCHAR(45) NULL DEFAULT NULL,
		FIRMWARE VARCHAR(64) NULL DEFAULT NULL,
		PUSH_VERSION VARCHAR(16) NULL DEFAULT NULL,
		LANGUAGE VARCHAR(8) NULL DEFAULT NULL,
		USER_COUNT INT NULL DEFAULT NULL,
		FP_COUNT INT NULL DEFAULT NULL,
		FACE_COUNT INT NULL DEFAULT NULL,
		ATT_COUNT INT NULL DEFAULT NULL,
		INFO_RAW VARCHAR(255) NULL DEFAULT NULL,
		OPTIONS_JSON TEXT NULL DEFAULT NULL,
		ATTLOG_STAMP VARCHAR(32) NULL DEFAULT NULL COMMENT 'NULL = handshake asks the device to upload everything',
		OPERLOG_STAMP VARCHAR(32) NULL DEFAULT NULL,
		ATTPHOTO_STAMP VARCHAR(32) NULL DEFAULT NULL,
		LAST_HANDSHAKE_DT DATETIME NULL DEFAULT NULL,
		LAST_SEEN_DT DATETIME NULL DEFAULT NULL,
		ACTIVE TINYINT(1) NOT NULL DEFAULT 1,
		ENCODED_BY INT NULL DEFAULT NULL,
		ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		EDITED_BY INT NULL DEFAULT NULL,
		EDITED_DT DATETIME NULL DEFAULT NULL,
		PRIMARY KEY (IDNo),
		UNIQUE KEY uq_devices_serial (SERIAL_NO),
		KEY idx_devices_branch (BRANCH_ID)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// Raw punches: never edited; the source of truth for any computed attendance.
	`CREATE TABLE IF NOT EXISTS attendance_logs (
		IDNo BIGINT NOT NULL AUTO_INCREMENT,
		DEVICE_ID INT NOT NULL,
		BRANCH_ID INT NULL DEFAULT NULL COMMENT 'Device branch at the time of the punch',
		PIN VARCHAR(32) NOT NULL,
		PUNCH_DT DATETIME NOT NULL COMMENT 'Device-local time, stored as sent',
		PUNCH_STATUS SMALLINT NULL DEFAULT NULL COMMENT '0 in, 1 out, 2 break out, 3 break in, 4 OT in, 5 OT out, 255 none',
		VERIFY_TYPE SMALLINT NULL DEFAULT NULL COMMENT '1 fingerprint, 3 password, 4 card, 15 face (firmware-dependent)',
		WORK_CODE VARCHAR(32) NULL DEFAULT NULL,
		RAW_LINE VARCHAR(500) NOT NULL,
		RECEIVED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (IDNo),
		UNIQUE KEY uq_attendance_punch (DEVICE_ID, PIN, PUNCH_DT),
		KEY idx_attendance_branch_dt (BRANCH_ID, PUNCH_DT),
		KEY idx_attendance_dt (PUNCH_DT),
		KEY idx_attendance_pin (PIN)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	`CREATE TABLE IF NOT EXISTS device_users (
		IDNo INT NOT NULL AUTO_INCREMENT,
		DEVICE_ID INT NOT NULL,
		PIN VARCHAR(32) NOT NULL,
		NAME VARCHAR(100) NULL DEFAULT NULL,
		PRIVILEGE SMALLINT NULL DEFAULT NULL COMMENT '0 user, 14 super admin (older firmware: 2 enroller, 6 admin)',
		PASSWORD VARCHAR(32) NULL DEFAULT NULL COMMENT 'Device password; never returned by the API',
		CARD_NO VARCHAR(32) NULL DEFAULT NULL,
		GROUP_NO VARCHAR(8) NULL DEFAULT NULL,
		USER_TZ VARCHAR(32) NULL DEFAULT NULL,
		VERIFY_MODE VARCHAR(8) NULL DEFAULT NULL,
		FIELDS_JSON TEXT NULL DEFAULT NULL COMMENT 'Original key/values as sent, used to restore the user',
		SOURCE VARCHAR(16) NOT NULL DEFAULT 'device' COMMENT 'device = enrolled on the device, server = pushed by this app',
		${DEVICE_USER_ACTIVE_COLUMNS.active},
		${DEVICE_USER_ACTIVE_COLUMNS.activePin},
		ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		EDITED_DT DATETIME NULL DEFAULT NULL COMMENT 'Last real change of the fields (or removal)',
		${DEVICE_USER_ACTIVE_COLUMNS.editedBy},
		${DEVICE_USER_ACTIVE_COLUMNS.readdedAs},
		${DEVICE_USER_EMPLOYEE_COLUMN},
		${DEVICE_USER_PENDING_PROFILE_COLUMN},
		SYNCED_DT DATETIME NULL DEFAULT NULL COMMENT 'Last time the device reported this user',
		PRIMARY KEY (IDNo),
		UNIQUE KEY uq_device_users_active (DEVICE_ID, ACTIVE_PIN),
		KEY idx_device_users_pin (DEVICE_ID, PIN),
		KEY idx_device_users_employee (EMPLOYEE_ID)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// Punches added in the app for a forgotten time-in/out. They count like device punches
	// but never touch attendance_logs. ACTIVE = 0 is a soft delete (restorable).
	`CREATE TABLE IF NOT EXISTS attendance_manual_punches (
		IDNo INT NOT NULL AUTO_INCREMENT,
		DEVICE_ID INT NOT NULL,
		BRANCH_ID INT NULL DEFAULT NULL COMMENT 'Device branch when the punch was added',
		DEVICE_USER_ID INT NOT NULL COMMENT 'device_users row the punch belongs to',
		PIN VARCHAR(32) NOT NULL,
		PUNCH_DT DATETIME NOT NULL COMMENT 'Device-local time, like attendance_logs.PUNCH_DT',
		PUNCH_STATUS SMALLINT NOT NULL COMMENT '0 in, 1 out, 2 break out, 3 break in, 4 OT in, 5 OT out',
		REASON VARCHAR(255) NOT NULL COMMENT 'Why it was added (or the latest change)',
		ACTIVE TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0 = deleted (restorable)',
		ENCODED_BY INT NULL DEFAULT NULL,
		ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		EDITED_BY INT NULL DEFAULT NULL,
		EDITED_DT DATETIME NULL DEFAULT NULL,
		PRIMARY KEY (IDNo),
		KEY idx_manual_punches_branch_dt (BRANCH_ID, PUNCH_DT),
		KEY idx_manual_punches_user (DEVICE_ID, PIN, PUNCH_DT)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// Corrections to raw punches, made in the app. attendance_logs rows are never edited:
	// a punch is matched here by its original (device, PIN, time), so a correction still
	// applies if the device uploads its history again (e.g. after a DB move).
	`CREATE TABLE IF NOT EXISTS attendance_log_corrections (
		IDNo INT NOT NULL AUTO_INCREMENT,
		DEVICE_ID INT NOT NULL,
		PIN VARCHAR(32) NOT NULL,
		PUNCH_DT DATETIME NOT NULL COMMENT 'Original punch time (identifies the punch)',
		PUNCH_DT_NEW DATETIME NULL DEFAULT NULL COMMENT 'Corrected time; NULL = unchanged',
		PUNCH_STATUS_NEW SMALLINT NULL DEFAULT NULL COMMENT 'Corrected status (255 = none); NULL = unchanged',
		IS_DELETED TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Soft delete: hidden from attendance, restorable',
		REASON VARCHAR(255) NULL DEFAULT NULL COMMENT 'Reason given for the latest change',
		ENCODED_BY INT NULL DEFAULT NULL,
		ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		EDITED_BY INT NULL DEFAULT NULL,
		EDITED_DT DATETIME NULL DEFAULT NULL,
		PRIMARY KEY (IDNo),
		UNIQUE KEY uq_attendance_log_corrections (DEVICE_ID, PIN, PUNCH_DT)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// Sensitive (biometric data): kept for restore / multi-device sync, never returned by the API.
	`CREATE TABLE IF NOT EXISTS biometric_templates (
		IDNo BIGINT NOT NULL AUTO_INCREMENT,
		DEVICE_ID INT NOT NULL,
		PIN VARCHAR(32) NOT NULL,
		TEMPLATE_KIND VARCHAR(16) NOT NULL COMMENT 'FP, FACE, BIODATA, USERPIC, BIOPHOTO',
		BIO_TYPE SMALLINT NOT NULL DEFAULT 0 COMMENT '1 fingerprint, 2 face, 8 palm, 9 visible-light face',
		TEMPLATE_NO INT NOT NULL DEFAULT 0,
		TEMPLATE_INDEX INT NOT NULL DEFAULT 0,
		TEMPLATE_SIZE INT NULL DEFAULT NULL,
		VALID TINYINT NULL DEFAULT NULL,
		TEMPLATE_KEY VARCHAR(16) NULL DEFAULT NULL COMMENT 'Original key of the payload (TMP, Tmp, Content)',
		TEMPLATE MEDIUMTEXT NULL DEFAULT NULL COMMENT 'base64 payload',
		FIELDS_JSON TEXT NULL DEFAULT NULL,
		ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		EDITED_DT DATETIME NULL DEFAULT NULL COMMENT 'Last time the template itself changed',
		SYNCED_DT DATETIME NULL DEFAULT NULL COMMENT 'Last time the device reported this template',
		PRIMARY KEY (IDNo),
		UNIQUE KEY uq_biometric_templates (DEVICE_ID, PIN, TEMPLATE_KIND, BIO_TYPE, TEMPLATE_NO, TEMPLATE_INDEX)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	`CREATE TABLE IF NOT EXISTS operation_logs (
		IDNo BIGINT NOT NULL AUTO_INCREMENT,
		DEVICE_ID INT NOT NULL,
		OP_TYPE SMALLINT NULL DEFAULT NULL,
		OPERATOR VARCHAR(32) NULL DEFAULT NULL,
		OP_DT DATETIME NULL DEFAULT NULL,
		OBJ1 VARCHAR(64) NULL DEFAULT NULL,
		OBJ2 VARCHAR(64) NULL DEFAULT NULL,
		OBJ3 VARCHAR(64) NULL DEFAULT NULL,
		OBJ4 VARCHAR(64) NULL DEFAULT NULL,
		RAW_LINE VARCHAR(500) NOT NULL,
		LINE_HASH CHAR(40) NOT NULL,
		RECEIVED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (IDNo),
		UNIQUE KEY uq_operation_logs (DEVICE_ID, LINE_HASH),
		KEY idx_operation_logs_dt (OP_DT)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// Server -> device queue. IDNo is sent to the device as C:<IDNo>:<COMMAND>.
	`CREATE TABLE IF NOT EXISTS device_commands (
		IDNo INT NOT NULL AUTO_INCREMENT,
		DEVICE_ID INT NOT NULL,
		LABEL VARCHAR(120) NULL DEFAULT NULL,
		COMMAND MEDIUMTEXT NOT NULL,
		STATUS VARCHAR(10) NOT NULL DEFAULT 'pending' COMMENT 'pending, sent, done, failed',
		RETURN_CODE INT NULL DEFAULT NULL,
		RESULT MEDIUMTEXT NULL DEFAULT NULL,
		${COMMAND_READD_OF_COLUMN},
		${COMMAND_PROFILE_COLUMN},
		ENCODED_BY INT NULL DEFAULT NULL,
		ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		SENT_DT DATETIME NULL DEFAULT NULL,
		COMPLETED_DT DATETIME NULL DEFAULT NULL,
		PRIMARY KEY (IDNo),
		KEY idx_device_commands_queue (DEVICE_ID, STATUS, IDNo)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// Every device request/response, verbatim (debugging). Pruned after ZK_RAW_LOG_DAYS.
	`CREATE TABLE IF NOT EXISTS raw_requests (
		IDNo BIGINT NOT NULL AUTO_INCREMENT,
		SERIAL_NO VARCHAR(32) NULL DEFAULT NULL,
		METHOD VARCHAR(8) NOT NULL,
		PATH VARCHAR(255) NOT NULL,
		QUERY_STRING TEXT NULL DEFAULT NULL,
		REMOTE_IP VARCHAR(45) NULL DEFAULT NULL,
		HEADERS TEXT NULL DEFAULT NULL,
		BODY MEDIUMBLOB NULL DEFAULT NULL,
		BODY_LENGTH INT NOT NULL DEFAULT 0,
		RESPONSE TEXT NULL DEFAULT NULL,
		STATUS_CODE SMALLINT NOT NULL,
		DURATION_MS INT NULL DEFAULT NULL,
		CREATED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (IDNo),
		KEY idx_raw_requests_serial (SERIAL_NO, IDNo),
		KEY idx_raw_requests_created (CREATED_DT)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

// Columns added after the first release; ensureSchema adds them to existing tables.
const ADDED_COLUMNS = [
	{ table: 'device_users', name: 'SYNCED_DT', ddl: "ADD COLUMN SYNCED_DT DATETIME NULL DEFAULT NULL COMMENT 'Last time the device reported this user' AFTER EDITED_DT" },
	{ table: 'biometric_templates', name: 'SYNCED_DT', ddl: "ADD COLUMN SYNCED_DT DATETIME NULL DEFAULT NULL COMMENT 'Last time the device reported this template' AFTER EDITED_DT" },
	{ table: 'device_users', name: 'ACTIVE', ddl: `ADD COLUMN ${DEVICE_USER_ACTIVE_COLUMNS.active} AFTER SOURCE` },
	{ table: 'device_users', name: 'ACTIVE_PIN', ddl: `ADD COLUMN ${DEVICE_USER_ACTIVE_COLUMNS.activePin} AFTER ACTIVE` },
	{ table: 'device_users', name: 'EDITED_BY', ddl: `ADD COLUMN ${DEVICE_USER_ACTIVE_COLUMNS.editedBy} AFTER EDITED_DT` },
	{ table: 'device_users', name: 'READDED_AS_ID', ddl: `ADD COLUMN ${DEVICE_USER_ACTIVE_COLUMNS.readdedAs} AFTER EDITED_BY` },
	{ table: 'device_commands', name: 'READD_OF_ID', ddl: `ADD COLUMN ${COMMAND_READD_OF_COLUMN} AFTER RESULT` },
	{ table: 'device_users', name: 'EMPLOYEE_ID', ddl: `ADD COLUMN ${DEVICE_USER_EMPLOYEE_COLUMN} AFTER READDED_AS_ID` },
	{ table: 'device_commands', name: 'PROFILE_JSON', ddl: `ADD COLUMN ${COMMAND_PROFILE_COLUMN} AFTER READD_OF_ID` },
	{ table: 'device_users', name: 'PENDING_PROFILE_JSON', ddl: `ADD COLUMN ${DEVICE_USER_PENDING_PROFILE_COLUMN} AFTER EMPLOYEE_ID` },
];

// Index changes after the first release, applied in order: `add` when the index is missing,
// `drop` when it still exists. device_users moved from one row per PIN to one ACTIVE row per PIN.
const INDEX_CHANGES = [
	{ table: 'device_users', add: 'uq_device_users_active', ddl: 'ADD UNIQUE KEY uq_device_users_active (DEVICE_ID, ACTIVE_PIN)' },
	{ table: 'device_users', add: 'idx_device_users_pin', ddl: 'ADD KEY idx_device_users_pin (DEVICE_ID, PIN)' },
	{ table: 'device_users', drop: 'uq_device_users' },
	{ table: 'device_users', add: 'idx_device_users_employee', ddl: 'ADD KEY idx_device_users_employee (EMPLOYEE_ID)' },
];

// A device counts as online if it polled within this many seconds (it polls every handshake Delay = 10s).
const ONLINE_THRESHOLD_SECONDS = 60;

// The MB160 keeps its enrollment prompt open ~60 s (RETRY=3) before answering; past this,
// a 'sent' enrollment with no answer is treated as over. Return codes seen on the MB160:
// 6 = nobody scanned in time, 4 = that fingerprint is already enrolled for another user.
const ENROLL_PROMPT_MAX_SECONDS = 180;
const ENROLL_TIMEOUT_CODE = 6;
const ENROLL_DUPLICATE_CODE = 4;

// Privilege codes that can open the device menu (14 super admin; 6 admin on older firmware).
const ADMIN_PRIVILEGES = [14, 6];

/**
 * Which device_users row a punch (alias `a`) belongs to, since a PIN can be reused after a
 * user is removed: the row created most recently at or before the punch, or else the
 * earliest row (punches older than every row, e.g. history uploaded on first connect).
 */
const punchOwnerId = (a) => `COALESCE(
	(SELECT o.IDNo FROM device_users o WHERE o.DEVICE_ID = ${a}.DEVICE_ID AND o.PIN = ${a}.PIN AND o.ENCODED_DT <= ${a}.PUNCH_DT
	 ORDER BY o.ENCODED_DT DESC, o.IDNo DESC LIMIT 1),
	(SELECT o.IDNo FROM device_users o WHERE o.DEVICE_ID = ${a}.DEVICE_ID AND o.PIN = ${a}.PIN
	 ORDER BY o.ENCODED_DT, o.IDNo LIMIT 1))`;

/** The app's correction (edit / soft delete) of punch `a`, if any. */
const correctionJoin = (a, c) => `LEFT JOIN attendance_log_corrections ${c}
	ON ${c}.DEVICE_ID = ${a}.DEVICE_ID AND ${c}.PIN = ${a}.PIN AND ${c}.PUNCH_DT = ${a}.PUNCH_DT`;

/** "DATA DELETE USERINFO" for one user; built in one place so pending deletes can be matched exactly. */
const userDeleteCommand = (pin) => `DATA DELETE USERINFO PIN=${pin}`;

// Adds and edits are both DATA UPDATE USERINFO; edits are told apart by their LABEL, which
// zktecoController.updateDeviceUser sets with this prefix.
const USER_EDIT_LABEL_PREFIX = 'Edit user ';

/** 'add' | 'edit' | 'delete' for a queued user command. */
const userCommandKind = (command, label) => {
	if (String(command).startsWith('DATA DELETE USERINFO ')) return 'delete';
	return String(label || '').startsWith(USER_EDIT_LABEL_PREFIX) ? 'edit' : 'add';
};

/** "Key=Value\tKey2=Value2" after `prefix` -> { Key: Value }. */
const commandFields = (command, prefix) =>
	Object.fromEntries(
		String(command)
			.slice(prefix.length)
			.split('\t')
			.filter((pair) => pair.includes('='))
			.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
	);

/**
 * Branch scope for a request: null = every device (admin, All Branches),
 * otherwise an array of sanwol branch IDs.
 */
const branchClause = (alias, branchIds) => {
	if (branchIds == null) return { sql: '', params: [] };
	if (branchIds.length === 0) return { sql: ' AND 1 = 0', params: [] };
	return {
		sql: ` AND ${alias}.BRANCH_ID IN (${branchIds.map(() => '?').join(',')})`,
		params: branchIds,
	};
};

class ZktecoModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (ZktecoModel._schemaReady) return;
		if (ZktecoModel._schemaPromise) return ZktecoModel._schemaPromise;

		ZktecoModel._schemaPromise = (async () => {
			try {
				await zkPool.ensureDatabase();
			} catch (err) {
				// Expected on hosts where the app user cannot CREATE DATABASE; it must already exist there.
				console.warn(`[ZKTeco] could not ensure database ${zkPool.databaseName}:`, err.message || err);
			}
			for (const ddl of TABLES) {
				await zkPool.query(ddl);
			}
			for (const col of ADDED_COLUMNS) {
				const [rows] = await zkPool.query(
					`SELECT 1 FROM information_schema.COLUMNS
					 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
					[col.table, col.name]
				);
				if (rows.length === 0) {
					await zkPool.query(`ALTER TABLE ${col.table} ${col.ddl}`);
					console.log(`[Schema] zkteco ${col.table}.${col.name} created`);
				}
			}
			for (const change of INDEX_CHANGES) {
				const name = change.add || change.drop;
				const [rows] = await zkPool.query(
					`SELECT 1 FROM information_schema.STATISTICS
					 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
					[change.table, name]
				);
				if (change.add && rows.length === 0) {
					await zkPool.query(`ALTER TABLE ${change.table} ${change.ddl}`);
					console.log(`[Schema] zkteco ${change.table}.${name} created`);
				} else if (change.drop && rows.length > 0) {
					await zkPool.query(`ALTER TABLE ${change.table} DROP INDEX ${name}`);
					console.log(`[Schema] zkteco ${change.table}.${name} dropped`);
				}
			}
			ZktecoModel._schemaReady = true;
			ZktecoModel._schemaPromise = null;
		})().catch((error) => {
			ZktecoModel._schemaPromise = null;
			ZktecoModel._schemaReady = false;
			throw error;
		});

		return ZktecoModel._schemaPromise;
	}

	static async getDevices(branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('d', branchIds);
		const [rows] = await zkPool.query(
			`SELECT
				d.IDNo, d.SERIAL_NO, d.BRANCH_ID, d.DEVICE_NAME, d.IP_ADDRESS, d.FIRMWARE, d.PUSH_VERSION,
				d.USER_COUNT, d.FP_COUNT, d.FACE_COUNT, d.ATT_COUNT,
				d.LAST_HANDSHAKE_DT, d.LAST_SEEN_DT, d.ACTIVE,
				(d.LAST_SEEN_DT IS NOT NULL AND d.LAST_SEEN_DT >= NOW() - INTERVAL ${ONLINE_THRESHOLD_SECONDS} SECOND) AS IS_ONLINE,
				(SELECT COUNT(*) FROM attendance_logs a WHERE a.DEVICE_ID = d.IDNo) AS STORED_PUNCHES,
				(SELECT COUNT(*) FROM device_users u WHERE u.DEVICE_ID = d.IDNo AND u.ACTIVE = 1) AS STORED_USERS
			 FROM devices d
			 WHERE 1 = 1${scope.sql}
			 ORDER BY d.SERIAL_NO`,
			scope.params
		);
		return rows;
	}

	/**
	 * Punches newest first, at most `limit` (default 5000). Dates are device-local YYYY-MM-DD (inclusive).
	 * PUNCH_DT / PUNCH_STATUS include the app's corrections (originals in ORIGINAL_*); soft-deleted
	 * punches are left out unless include_deleted. The punch belongs to a user row (punchOwnerId),
	 * so removed users keep their name; if that person was added again, name and status come from
	 * their latest row (READDED_AS_ID), with CURRENT_PIN when they came back under another User ID.
	 * PERSON_ID is that latest row, the same for all of one person's punches.
	 * Punches added in the app (attendance_manual_punches) are merged in with SOURCE = 'manual';
	 * device punches have SOURCE = 'device'. The two kinds have separate IDNo sequences.
	 */
	static async getAttendanceLogs(branchIds, filters = {}) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('a', branchIds);
		// Range and order use the corrected time, so this can't use the PUNCH_DT index; fine at a
		// restaurant's volume (tens of thousands of punches a year).
		const effectiveDt = 'COALESCE(c.PUNCH_DT_NEW, a.PUNCH_DT)';
		let sql = `
			SELECT
				'device' AS SOURCE,
				a.IDNo, a.DEVICE_ID, a.BRANCH_ID, a.PIN,
				${effectiveDt} AS PUNCH_DT,
				COALESCE(c.PUNCH_STATUS_NEW, a.PUNCH_STATUS) AS PUNCH_STATUS,
				a.PUNCH_DT AS ORIGINAL_PUNCH_DT, a.PUNCH_STATUS AS ORIGINAL_PUNCH_STATUS,
				a.VERIFY_TYPE, a.WORK_CODE, a.RECEIVED_DT,
				p.IDNo AS PERSON_ID, p.NAME, p.ACTIVE AS USER_ACTIVE,
				IF(p.PIN <> a.PIN, p.PIN, NULL) AS CURRENT_PIN,
				(c.PUNCH_DT_NEW IS NOT NULL OR c.PUNCH_STATUS_NEW IS NOT NULL) AS IS_EDITED,
				COALESCE(c.IS_DELETED, 0) AS IS_DELETED,
				c.REASON AS CORRECTION_REASON,
				COALESCE(c.EDITED_BY, c.ENCODED_BY) AS CORRECTED_BY,
				COALESCE(c.EDITED_DT, c.ENCODED_DT) AS CORRECTED_DT,
				d.SERIAL_NO, d.DEVICE_NAME
			FROM attendance_logs a
			JOIN devices d ON d.IDNo = a.DEVICE_ID
			${correctionJoin('a', 'c')}
			LEFT JOIN device_users u ON u.IDNo = ${punchOwnerId('a')}
			LEFT JOIN device_users p ON p.IDNo = COALESCE(u.READDED_AS_ID, u.IDNo)
			WHERE 1 = 1${scope.sql}`;
		const params = [...scope.params];

		if (!filters.include_deleted) sql += ' AND COALESCE(c.IS_DELETED, 0) = 0';
		if (filters.start_date) {
			sql += ` AND ${effectiveDt} >= ?`;
			params.push(`${filters.start_date} 00:00:00`);
		}
		if (filters.end_date) {
			sql += ` AND ${effectiveDt} < DATE_ADD(?, INTERVAL 1 DAY)`;
			params.push(filters.end_date);
		}
		if (filters.device_id) {
			sql += ' AND a.DEVICE_ID = ?';
			params.push(filters.device_id);
		}

		const safeLimit = Math.min(Math.max(1, Number(filters.limit) || 5000), 20000);
		// One extra row tells the caller the range had more punches than the limit.
		sql += ` ORDER BY ${effectiveDt} DESC, a.IDNo DESC LIMIT ${safeLimit + 1}`;

		const [deviceRows] = await zkPool.query(sql, params);
		const manualRows = await ZktecoModel.getManualPunchRows(branchIds, { ...filters, limit: safeLimit + 1 });
		const rows = [...deviceRows, ...manualRows].sort((x, y) =>
			x.PUNCH_DT === y.PUNCH_DT ? Number(y.IDNo) - Number(x.IDNo) : x.PUNCH_DT < y.PUNCH_DT ? 1 : -1
		);
		return { rows: rows.slice(0, safeLimit), truncated: rows.length > safeLimit, limit: safeLimit };
	}

	/**
	 * Manual punches in the same shape as getAttendanceLogs rows. IS_EDITED = changed after it was
	 * added; IS_DELETED = soft-deleted; CORRECTION_REASON = the reason given; ADDED_BY = who added it.
	 */
	static async getManualPunchRows(branchIds, filters = {}) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('m', branchIds);
		let sql = `
			SELECT
				'manual' AS SOURCE,
				m.IDNo, m.DEVICE_ID, m.BRANCH_ID, m.PIN,
				m.PUNCH_DT, m.PUNCH_STATUS,
				m.PUNCH_DT AS ORIGINAL_PUNCH_DT, m.PUNCH_STATUS AS ORIGINAL_PUNCH_STATUS,
				NULL AS VERIFY_TYPE, NULL AS WORK_CODE, m.ENCODED_DT AS RECEIVED_DT,
				p.IDNo AS PERSON_ID, p.NAME, p.ACTIVE AS USER_ACTIVE,
				IF(p.PIN <> m.PIN, p.PIN, NULL) AS CURRENT_PIN,
				(m.EDITED_DT IS NOT NULL) AS IS_EDITED,
				(m.ACTIVE = 0) AS IS_DELETED,
				m.REASON AS CORRECTION_REASON,
				COALESCE(m.EDITED_BY, m.ENCODED_BY) AS CORRECTED_BY,
				COALESCE(m.EDITED_DT, m.ENCODED_DT) AS CORRECTED_DT,
				m.ENCODED_BY AS ADDED_BY, m.ENCODED_DT AS ADDED_DT,
				d.SERIAL_NO, d.DEVICE_NAME
			FROM attendance_manual_punches m
			JOIN devices d ON d.IDNo = m.DEVICE_ID
			JOIN device_users u ON u.IDNo = m.DEVICE_USER_ID
			LEFT JOIN device_users p ON p.IDNo = COALESCE(u.READDED_AS_ID, u.IDNo)
			WHERE 1 = 1${scope.sql}`;
		const params = [...scope.params];

		if (!filters.include_deleted) sql += ' AND m.ACTIVE = 1';
		if (filters.start_date) {
			sql += ' AND m.PUNCH_DT >= ?';
			params.push(`${filters.start_date} 00:00:00`);
		}
		if (filters.end_date) {
			sql += ' AND m.PUNCH_DT < DATE_ADD(?, INTERVAL 1 DAY)';
			params.push(filters.end_date);
		}
		if (filters.device_id) {
			sql += ' AND m.DEVICE_ID = ?';
			params.push(filters.device_id);
		}
		const limit = Math.min(Math.max(1, Number(filters.limit) || 5000), 20001);
		sql += ` ORDER BY m.PUNCH_DT DESC, m.IDNo DESC LIMIT ${limit}`;
		const [rows] = await zkPool.query(sql, params);
		return rows;
	}

	/**
	 * Every counted punch (device punches with corrections applied, deleted ones left out, plus
	 * active manual punches) with time >= startDt and < endDt, oldest first, for computing
	 * attendance. EMPLOYEE_ID is the profile of the person the punch belongs to (null when that
	 * User ID isn't on the device).
	 */
	static async getPunchesForAttendance(branchIds, startDt, endDt) {
		await ZktecoModel.ensureSchema();
		const deviceScope = branchClause('a', branchIds);
		const manualScope = branchClause('m', branchIds);
		const effectiveDt = 'COALESCE(c.PUNCH_DT_NEW, a.PUNCH_DT)';
		const [rows] = await zkPool.query(
			`SELECT * FROM (
				SELECT 'device' AS SOURCE, a.IDNo, a.DEVICE_ID, a.BRANCH_ID, a.PIN,
					${effectiveDt} AS PUNCH_DT,
					COALESCE(c.PUNCH_STATUS_NEW, a.PUNCH_STATUS) AS PUNCH_STATUS,
					a.PUNCH_DT AS ORIGINAL_PUNCH_DT, a.PUNCH_STATUS AS ORIGINAL_PUNCH_STATUS,
					(c.PUNCH_DT_NEW IS NOT NULL OR c.PUNCH_STATUS_NEW IS NOT NULL) AS IS_EDITED,
					c.REASON, a.VERIFY_TYPE,
					p.IDNo AS PERSON_ID, p.NAME, COALESCE(u.EMPLOYEE_ID, p.EMPLOYEE_ID) AS EMPLOYEE_ID
				FROM attendance_logs a
				${correctionJoin('a', 'c')}
				LEFT JOIN device_users u ON u.IDNo = ${punchOwnerId('a')}
				LEFT JOIN device_users p ON p.IDNo = COALESCE(u.READDED_AS_ID, u.IDNo)
				WHERE COALESCE(c.IS_DELETED, 0) = 0
				  AND ${effectiveDt} >= ? AND ${effectiveDt} < ?${deviceScope.sql}
				UNION ALL
				SELECT 'manual' AS SOURCE, m.IDNo, m.DEVICE_ID, m.BRANCH_ID, m.PIN,
					m.PUNCH_DT, m.PUNCH_STATUS,
					m.PUNCH_DT AS ORIGINAL_PUNCH_DT, m.PUNCH_STATUS AS ORIGINAL_PUNCH_STATUS,
					(m.EDITED_DT IS NOT NULL) AS IS_EDITED,
					m.REASON, NULL AS VERIFY_TYPE,
					p.IDNo AS PERSON_ID, p.NAME, COALESCE(u.EMPLOYEE_ID, p.EMPLOYEE_ID) AS EMPLOYEE_ID
				FROM attendance_manual_punches m
				JOIN device_users u ON u.IDNo = m.DEVICE_USER_ID
				LEFT JOIN device_users p ON p.IDNo = COALESCE(u.READDED_AS_ID, u.IDNo)
				WHERE m.ACTIVE = 1 AND m.PUNCH_DT >= ? AND m.PUNCH_DT < ?${manualScope.sql}
			) x
			ORDER BY PUNCH_DT, SOURCE, IDNo`,
			[startDt, endDt, ...deviceScope.params, startDt, endDt, ...manualScope.params]
		);
		return rows;
	}

	// ---- Employee profiles (links to sanwol_resto.employee) ----

	/**
	 * Device user rows in scope with what employeeLinkService needs to link them to a profile
	 * (PENDING_PROFILE_JSON: details from Add employee still to be applied; not for API output).
	 */
	static async getUserRowsForLinking(branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('d', branchIds);
		const [rows] = await zkPool.query(
			`SELECT u.IDNo, u.DEVICE_ID, u.PIN, u.NAME, u.ACTIVE, u.ENCODED_DT, u.EDITED_DT, u.READDED_AS_ID, u.EMPLOYEE_ID,
				u.PENDING_PROFILE_JSON, d.BRANCH_ID
			 FROM device_users u
			 JOIN devices d ON d.IDNo = u.DEVICE_ID
			 WHERE 1 = 1${scope.sql}
			 ORDER BY u.IDNo`,
			scope.params
		);
		return rows;
	}

	/** Links rows to a profile, skipping rows already linked. Returns how many were linked. */
	static async linkUnlinkedRows(userIds, employeeId) {
		if (userIds.length === 0) return 0;
		await ZktecoModel.ensureSchema();
		const [result] = await zkPool.query(
			`UPDATE device_users SET EMPLOYEE_ID = ? WHERE EMPLOYEE_ID IS NULL AND IDNo IN (${userIds.map(() => '?').join(',')})`,
			[employeeId, ...userIds]
		);
		return result.affectedRows;
	}

	/** Clears Add employee details once they're on the profile (only if unchanged since read). */
	static async clearPendingProfile(userId, json) {
		await ZktecoModel.ensureSchema();
		await zkPool.query('UPDATE device_users SET PENDING_PROFILE_JSON = NULL WHERE IDNo = ? AND PENDING_PROFILE_JSON = ?', [
			userId,
			json,
		]);
	}

	/** Moves a person (the row and their earlier rows after Add again) to another profile. */
	static async relinkPerson(personId, employeeId) {
		await ZktecoModel.ensureSchema();
		await zkPool.query('UPDATE device_users SET EMPLOYEE_ID = ? WHERE IDNo = ? OR READDED_AS_ID = ?', [
			employeeId,
			personId,
			personId,
		]);
	}

	/** How many device rows still point at this profile. */
	static async countRowsForEmployee(employeeId) {
		await ZktecoModel.ensureSchema();
		const [[row]] = await zkPool.query('SELECT COUNT(*) AS n FROM device_users WHERE EMPLOYEE_ID = ?', [employeeId]);
		return Number(row.n);
	}

	/** One device user row with its device's branch, or null. */
	static async getDeviceUserById(userId) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT u.IDNo, u.DEVICE_ID, u.PIN, u.NAME, u.ACTIVE, u.READDED_AS_ID, u.EMPLOYEE_ID, d.BRANCH_ID
			 FROM device_users u JOIN devices d ON d.IDNo = u.DEVICE_ID
			 WHERE u.IDNo = ?`,
			[userId]
		);
		return rows[0] || null;
	}

	// ---- Manual punches (attendance_manual_punches) ----

	/**
	 * True when this person already has a counted punch at exactly `punchDt` (a device punch at
	 * its corrected time, or an active manual punch other than `excludeManualId`).
	 */
	static async punchExistsAt(deviceId, pin, punchDt, excludeManualId = null) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT 1 FROM attendance_logs a
			 ${correctionJoin('a', 'c')}
			 WHERE a.DEVICE_ID = ? AND a.PIN = ? AND COALESCE(c.PUNCH_DT_NEW, a.PUNCH_DT) = ? AND COALESCE(c.IS_DELETED, 0) = 0
			 UNION ALL
			 SELECT 1 FROM attendance_manual_punches m
			 WHERE m.DEVICE_ID = ? AND m.PIN = ? AND m.PUNCH_DT = ? AND m.ACTIVE = 1 AND m.IDNo <> ?
			 LIMIT 1`,
			[deviceId, pin, punchDt, deviceId, pin, punchDt, excludeManualId ?? 0]
		);
		return rows.length > 0;
	}

	static async insertManualPunch({ deviceId, branchId, deviceUserId, pin, punchDt, status, reason }, userId) {
		await ZktecoModel.ensureSchema();
		const [result] = await zkPool.query(
			`INSERT INTO attendance_manual_punches
				(DEVICE_ID, BRANCH_ID, DEVICE_USER_ID, PIN, PUNCH_DT, PUNCH_STATUS, REASON, ENCODED_BY)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[deviceId, branchId, deviceUserId, pin, punchDt, status, reason, userId]
		);
		return result.insertId;
	}

	/** One manual punch in the caller's branch scope (by the branch it was added under). */
	static async getManualPunch(id, branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('m', branchIds);
		const [rows] = await zkPool.query(
			`SELECT m.IDNo, m.DEVICE_ID, m.BRANCH_ID AS DEVICE_BRANCH_ID, m.DEVICE_USER_ID, m.PIN, m.PUNCH_DT, m.PUNCH_STATUS,
				m.REASON, m.ACTIVE
			 FROM attendance_manual_punches m
			 WHERE m.IDNo = ?${scope.sql}`,
			[id, ...scope.params]
		);
		return rows[0] || null;
	}

	static async updateManualPunch(id, { punchDt, status, reason }, userId) {
		await ZktecoModel.ensureSchema();
		await zkPool.query(
			`UPDATE attendance_manual_punches
			 SET PUNCH_DT = ?, PUNCH_STATUS = ?, REASON = ?, EDITED_BY = ?, EDITED_DT = NOW()
			 WHERE IDNo = ?`,
			[punchDt, status, reason, userId, id]
		);
	}

	static async setManualPunchActive(id, active, reason, userId) {
		await ZktecoModel.ensureSchema();
		await zkPool.query(
			`UPDATE attendance_manual_punches
			 SET ACTIVE = ?, REASON = COALESCE(?, REASON), EDITED_BY = ?, EDITED_DT = NOW()
			 WHERE IDNo = ?`,
			[active ? 1 : 0, reason, userId, id]
		);
	}

	/**
	 * Users registered on each device, with biometric counts and last punch. Never returns
	 * passwords or templates. Removed users (ACTIVE = 0) only with include_deleted.
	 */
	static async getDeviceUsers(branchIds, filters = {}) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('d', branchIds);
		let sql = `
			SELECT
				u.IDNo, u.DEVICE_ID, u.PIN, u.NAME, u.PRIVILEGE, u.SOURCE, u.ACTIVE, u.ENCODED_DT, u.EDITED_DT, u.EDITED_BY,
				u.EMPLOYEE_ID,
				(u.PASSWORD IS NOT NULL AND u.PASSWORD <> '') AS HAS_PASSWORD,
				(u.CARD_NO IS NOT NULL AND u.CARD_NO <> '' AND u.CARD_NO <> '0') AS HAS_CARD,
				d.SERIAL_NO, d.DEVICE_NAME, d.BRANCH_ID,
				COALESCE(bt.FP_COUNT, 0) AS FP_COUNT,
				COALESCE(bt.HAS_FACE, 0) AS HAS_FACE,
				COALESCE(bt.PALM_COUNT, 0) AS PALM_COUNT,
				bt.FP_FINGERS,
				COALESCE(bt.HAS_PHOTO, 0) AS HAS_PHOTO,
				-- This person's punches only (a reused PIN's earlier punches belong to the earlier row),
				-- including those of their earlier rows when they were added again, and punches added
				-- in the app (the latest of the two; NULL when neither exists).
				NULLIF(GREATEST(
					COALESCE((SELECT MAX(COALESCE(c.PUNCH_DT_NEW, a.PUNCH_DT))
					 FROM attendance_logs a
					 ${correctionJoin('a', 'c')}
					 WHERE a.DEVICE_ID = u.DEVICE_ID AND COALESCE(c.IS_DELETED, 0) = 0
					   AND a.PIN IN (SELECT p.PIN FROM device_users p WHERE p.IDNo = u.IDNo OR p.READDED_AS_ID = u.IDNo)
					   AND ${punchOwnerId('a')} IN (SELECT p.IDNo FROM device_users p WHERE p.IDNo = u.IDNo OR p.READDED_AS_ID = u.IDNo)
					), '1000-01-01 00:00:00'),
					COALESCE((SELECT MAX(m.PUNCH_DT) FROM attendance_manual_punches m
					 WHERE m.ACTIVE = 1
					   AND m.DEVICE_USER_ID IN (SELECT p.IDNo FROM device_users p WHERE p.IDNo = u.IDNo OR p.READDED_AS_ID = u.IDNo)
					), '1000-01-01 00:00:00')
				), '1000-01-01 00:00:00') AS LAST_PUNCH_DT
			FROM device_users u
			JOIN devices d ON d.IDNo = u.DEVICE_ID
			LEFT JOIN (
				SELECT DEVICE_ID, PIN,
					SUM(TEMPLATE_KIND = 'FP' OR (TEMPLATE_KIND = 'BIODATA' AND BIO_TYPE = 1)) AS FP_COUNT,
					-- One enrolled face arrives as several FACE templates (12 on the MB160), so it is a yes/no flag.
					MAX(TEMPLATE_KIND = 'FACE' OR (TEMPLATE_KIND = 'BIODATA' AND BIO_TYPE IN (2, 9))) AS HAS_FACE,
					SUM(TEMPLATE_KIND = 'BIODATA' AND BIO_TYPE = 8) AS PALM_COUNT,
					-- Finger numbers (FID 0-9) that have a fingerprint, e.g. "0,6"
					GROUP_CONCAT(CASE WHEN TEMPLATE_KIND = 'FP' OR (TEMPLATE_KIND = 'BIODATA' AND BIO_TYPE = 1)
						THEN TEMPLATE_NO END ORDER BY TEMPLATE_NO) AS FP_FINGERS,
					MAX(TEMPLATE_KIND IN ('USERPIC', 'BIOPHOTO')) AS HAS_PHOTO
				FROM biometric_templates
				GROUP BY DEVICE_ID, PIN
			) bt ON u.ACTIVE = 1 AND bt.DEVICE_ID = u.DEVICE_ID AND bt.PIN = u.PIN
			WHERE u.READDED_AS_ID IS NULL${scope.sql}`;
		const params = [...scope.params];

		// Removed users who were added again are left out (their newest row stands for them).
		// Templates belong to whoever holds the PIN now; a removed user's were erased (bt join above).
		if (!filters.include_deleted) sql += ' AND u.ACTIVE = 1';
		if (filters.device_id) {
			sql += ' AND u.DEVICE_ID = ?';
			params.push(filters.device_id);
		}

		sql += ' ORDER BY d.SERIAL_NO, u.ACTIVE DESC, CAST(u.PIN AS UNSIGNED), u.PIN, u.ENCODED_DT DESC';
		const [rows] = await zkPool.query(sql, params);
		return rows;
	}

	static async getDeviceById(deviceId) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query('SELECT IDNo, SERIAL_NO, BRANCH_ID, ACTIVE FROM devices WHERE IDNo = ?', [
			deviceId,
		]);
		return rows[0] || null;
	}

	/**
	 * Why removed user `userId` can't be added again on `deviceId` (null when it can): it must be
	 * a removed row of that device, not already added again, and not already in a pending add.
	 */
	static async readdBlocker(deviceId, userId) {
		await ZktecoModel.ensureSchema();
		const [[row]] = await zkPool.query(
			`SELECT u.ACTIVE, u.READDED_AS_ID,
				EXISTS(SELECT 1 FROM device_commands c
					WHERE c.READD_OF_ID = u.IDNo AND c.STATUS IN ('pending', 'sent')) AS PENDING
			 FROM device_users u WHERE u.IDNo = ? AND u.DEVICE_ID = ?`,
			[userId, deviceId]
		);
		if (!row || Number(row.ACTIVE)) return 'That removed user was not found on this device';
		if (row.READDED_AS_ID || Number(row.PENDING)) return 'This user has already been added again';
		return null;
	}

	/** True when the PIN is on the device or an add for it is still waiting to be delivered. */
	static async isPinTaken(deviceId, pin) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT 1 FROM device_users WHERE DEVICE_ID = ? AND ACTIVE_PIN = ?
			 UNION ALL
			 SELECT 1 FROM device_commands
			 WHERE DEVICE_ID = ? AND STATUS IN ('pending', 'sent') AND COMMAND LIKE ?
			 LIMIT 1`,
			[deviceId, pin, deviceId, `DATA UPDATE USERINFO PIN=${pin}\t%`]
		);
		return rows.length > 0;
	}

	/**
	 * An enrollment still waiting for the device or showing its prompt. The device handles
	 * one prompt at a time. A 'sent' one older than ENROLL_PROMPT_MAX_SECONDS is treated as
	 * over (the device can reboot mid-prompt and never answer).
	 */
	static async getActiveEnrollment(deviceId) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT IDNo FROM device_commands
			 WHERE DEVICE_ID = ? AND COMMAND LIKE 'ENROLL\\_%'
			   AND (STATUS = 'pending' OR (STATUS = 'sent' AND SENT_DT >= NOW() - INTERVAL ${ENROLL_PROMPT_MAX_SECONDS} SECOND))
			 ORDER BY IDNo DESC LIMIT 1`,
			[deviceId]
		);
		return rows[0] || null;
	}

	/** True when the user has a fingerprint stored for this finger (FID). */
	static async hasFingerprint(deviceId, pin, finger) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT 1 FROM biometric_templates
			 WHERE DEVICE_ID = ? AND PIN = ? AND TEMPLATE_NO = ?
			   AND (TEMPLATE_KIND = 'FP' OR (TEMPLATE_KIND = 'BIODATA' AND BIO_TYPE = 1))
			 LIMIT 1`,
			[deviceId, pin, finger]
		);
		return rows.length > 0;
	}

	/**
	 * Where a fingerprint command is, as one STATE. KIND 'enroll' (ENROLL_FP):
	 * waiting (device hasn't picked it up), prompting (device shows "place finger"),
	 * enrolled, timed_out (nobody scanned), duplicate (finger already enrolled for someone),
	 * expired (device never picked it up), cancelled, failed (other device code).
	 * FP_RECEIVED: the new template has arrived.
	 * KIND 'remove' (DATA DELETE FINGERTMP): waiting, removed, cancelled, failed.
	 */
	static async getEnrollment(commandId, branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('d', branchIds);
		const [rows] = await zkPool.query(
			`SELECT c.IDNo, c.DEVICE_ID, c.COMMAND, c.STATUS, c.RETURN_CODE, c.ENCODED_DT, c.SENT_DT, c.COMPLETED_DT,
				(c.STATUS = 'sent' AND c.SENT_DT < NOW() - INTERVAL ${ENROLL_PROMPT_MAX_SECONDS} SECOND) AS PROMPT_STALE,
				d.BRANCH_ID
			 FROM device_commands c
			 JOIN devices d ON d.IDNo = c.DEVICE_ID
			 WHERE c.IDNo = ? AND (c.COMMAND LIKE 'ENROLL\\_FP %' OR c.COMMAND LIKE 'DATA DELETE FINGERTMP %')${scope.sql}`,
			[commandId, ...scope.params]
		);
		const row = rows[0];
		if (!row) return null;

		const command = String(row.COMMAND);
		const kind = command.startsWith('ENROLL_FP ') ? 'enroll' : 'remove';
		const fields = Object.fromEntries(
			command
				.slice(kind === 'enroll' ? 'ENROLL_FP '.length : 'DATA DELETE FINGERTMP '.length)
				.split('\t')
				.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
		);
		const pin = fields.PIN ?? null;
		const finger = fields.FID != null ? Number(fields.FID) : null;

		if (kind === 'remove') {
			const removeState = { pending: 'waiting', sent: 'waiting', done: 'removed', cancelled: 'cancelled' };
			return {
				IDNo: row.IDNo,
				DEVICE_ID: row.DEVICE_ID,
				KIND: kind,
				PIN: pin,
				FINGER: finger,
				STATE: removeState[row.STATUS] || 'failed',
				RETURN_CODE: row.RETURN_CODE,
				FP_RECEIVED: false,
				ENCODED_DT: row.ENCODED_DT,
				SENT_DT: row.SENT_DT,
				COMPLETED_DT: row.COMPLETED_DT,
			};
		}

		// The template upload belongs to this enrollment only if it landed between the prompt
		// and shortly after the device's answer (a later enrollment of the same finger doesn't count).
		let received = false;
		if (row.SENT_DT) {
			const [tpl] = await zkPool.query(
				`SELECT 1 FROM biometric_templates
				 WHERE DEVICE_ID = ? AND PIN = ? AND TEMPLATE_KIND = 'FP' AND TEMPLATE_NO = ?
				   AND COALESCE(EDITED_DT, ENCODED_DT) BETWEEN ? AND COALESCE(? + INTERVAL 10 SECOND, NOW())
				 LIMIT 1`,
				[row.DEVICE_ID, pin, finger, row.SENT_DT, row.COMPLETED_DT]
			);
			received = tpl.length > 0;
		}

		let state;
		if (row.STATUS === 'pending') state = 'waiting';
		else if (row.STATUS === 'sent') state = Number(row.PROMPT_STALE) ? 'timed_out' : 'prompting';
		else if (row.STATUS === 'done' && Number(row.RETURN_CODE) === 0) state = 'enrolled';
		else if (row.STATUS === 'expired') state = 'expired';
		else if (row.STATUS === 'cancelled') state = 'cancelled';
		else if (Number(row.RETURN_CODE) === ENROLL_TIMEOUT_CODE) state = 'timed_out';
		else if (Number(row.RETURN_CODE) === ENROLL_DUPLICATE_CODE) state = 'duplicate';
		else state = 'failed';

		return {
			IDNo: row.IDNo,
			DEVICE_ID: row.DEVICE_ID,
			KIND: kind,
			PIN: pin,
			FINGER: finger,
			STATE: state,
			RETURN_CODE: row.RETURN_CODE,
			FP_RECEIVED: received,
			ENCODED_DT: row.ENCODED_DT,
			SENT_DT: row.SENT_DT,
			COMPLETED_DT: row.COMPLETED_DT,
		};
	}

	/** Withdraws a command the device hasn't picked up yet. Returns false once it was sent. */
	static async cancelPendingCommand(commandId) {
		await ZktecoModel.ensureSchema();
		const [result] = await zkPool.query(
			`UPDATE device_commands SET STATUS = 'cancelled', COMPLETED_DT = NOW(), PROFILE_JSON = NULL
			 WHERE IDNo = ? AND STATUS = 'pending'`,
			[commandId]
		);
		return result.affectedRows > 0;
	}

	/**
	 * User adds, edits and removals from the app that haven't landed yet (waiting/sent) or failed
	 * in the last day. KIND: 'add' | 'edit' | 'delete'. Raw COMMAND is not returned: it contains
	 * the device password.
	 */
	static async getPendingUserCommands(branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('d', branchIds);
		const [rows] = await zkPool.query(
			`SELECT c.IDNo, c.DEVICE_ID, c.LABEL, c.COMMAND, c.STATUS, c.RETURN_CODE, c.ENCODED_BY, c.ENCODED_DT, c.SENT_DT, c.COMPLETED_DT,
				d.SERIAL_NO, d.DEVICE_NAME, d.BRANCH_ID
			 FROM device_commands c
			 JOIN devices d ON d.IDNo = c.DEVICE_ID
			 WHERE (c.COMMAND LIKE 'DATA UPDATE USERINFO %' OR c.COMMAND LIKE 'DATA DELETE USERINFO %')
			   AND (c.STATUS IN ('pending', 'sent') OR (c.STATUS = 'failed' AND c.COMPLETED_DT >= NOW() - INTERVAL 1 DAY))${scope.sql}
			 ORDER BY c.IDNo DESC
			 LIMIT 100`,
			scope.params
		);
		const out = rows.map(({ COMMAND, LABEL, ...row }) => {
			const kind = userCommandKind(COMMAND, LABEL);
			const fields = commandFields(COMMAND, kind === 'delete' ? 'DATA DELETE USERINFO ' : 'DATA UPDATE USERINFO ');
			return { ...row, KIND: kind, PIN: fields.PIN ?? null, NAME: fields.Name ?? null };
		});
		// A removal names only the PIN; show the name of the user being removed.
		for (const row of out) {
			if (row.KIND !== 'delete' || row.PIN == null) continue;
			const user = await ZktecoModel.getActiveDeviceUser(row.DEVICE_ID, row.PIN);
			row.NAME = user?.NAME ?? null;
		}
		return out;
	}

	/** One queued user add/removal (for cancelling), in the caller's branch scope. */
	static async getUserCommand(commandId, branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('d', branchIds);
		const [rows] = await zkPool.query(
			`SELECT c.IDNo, c.DEVICE_ID, c.LABEL, c.COMMAND, c.STATUS
			 FROM device_commands c
			 JOIN devices d ON d.IDNo = c.DEVICE_ID
			 WHERE c.IDNo = ? AND (c.COMMAND LIKE 'DATA UPDATE USERINFO %' OR c.COMMAND LIKE 'DATA DELETE USERINFO %')${scope.sql}`,
			[commandId, ...scope.params]
		);
		const row = rows[0];
		if (!row) return null;
		return { IDNo: row.IDNo, DEVICE_ID: row.DEVICE_ID, STATUS: row.STATUS, KIND: userCommandKind(row.COMMAND, row.LABEL) };
	}

	static userEditLabel(pin, name) {
		return `${USER_EDIT_LABEL_PREFIX}${pin} (${name || 'no name'})`;
	}

	/**
	 * The active user's full record, including PASSWORD and CARD_NO, for building an edit
	 * command (the device needs the whole record). Internal only: never return it from the API.
	 */
	static async getDeviceUserForEdit(deviceId, pin) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT IDNo, PIN, NAME, PRIVILEGE, PASSWORD, CARD_NO, GROUP_NO, USER_TZ, VERIFY_MODE
			 FROM device_users WHERE DEVICE_ID = ? AND ACTIVE_PIN = ?`,
			[deviceId, pin]
		);
		return rows[0] || null;
	}

	/** An edit or removal of this PIN still waiting for the device, or null. */
	static async getPendingUserChange(deviceId, pin) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT IDNo FROM device_commands
			 WHERE DEVICE_ID = ? AND STATUS IN ('pending', 'sent') AND (COMMAND = ? OR COMMAND LIKE ?)
			 LIMIT 1`,
			[deviceId, userDeleteCommand(pin), `DATA UPDATE USERINFO PIN=${pin}\t%`]
		);
		return rows[0] || null;
	}

	// ---- Removing device users ----

	/** The user currently holding this PIN on the device (removed users don't count). */
	static async getActiveDeviceUser(deviceId, pin) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			'SELECT IDNo, DEVICE_ID, PIN, NAME, PRIVILEGE FROM device_users WHERE DEVICE_ID = ? AND ACTIVE_PIN = ?',
			[deviceId, pin]
		);
		return rows[0] || null;
	}

	static isAdminPrivilege(privilege) {
		return ADMIN_PRIVILEGES.includes(Number(privilege));
	}

	/** Admins left on the device besides `pin`, not counting ones already being removed. */
	static async countOtherAdmins(deviceId, pin) {
		await ZktecoModel.ensureSchema();
		const [[row]] = await zkPool.query(
			`SELECT COUNT(*) AS n FROM device_users u
			 WHERE u.DEVICE_ID = ? AND u.ACTIVE = 1 AND u.PIN <> ? AND u.PRIVILEGE IN (${ADMIN_PRIVILEGES.join(',')})
			   AND NOT EXISTS (
				SELECT 1 FROM device_commands c
				WHERE c.DEVICE_ID = u.DEVICE_ID AND c.STATUS IN ('pending', 'sent')
				  AND c.COMMAND = CONCAT('DATA DELETE USERINFO PIN=', u.PIN)
			   )`,
			[deviceId, pin]
		);
		return Number(row.n);
	}

	static userDeleteCommand(pin) {
		return userDeleteCommand(pin);
	}

	// ---- Correcting punches (attendance_log_corrections) ----

	/** One raw punch with its current correction, in the caller's branch scope. */
	static async getAttendanceLog(id, branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('a', branchIds);
		const [rows] = await zkPool.query(
			`SELECT a.IDNo, a.DEVICE_ID, a.PIN, a.PUNCH_DT, a.PUNCH_STATUS, d.BRANCH_ID AS DEVICE_BRANCH_ID,
				c.IDNo AS CORRECTION_ID, c.PUNCH_DT_NEW, c.PUNCH_STATUS_NEW, COALESCE(c.IS_DELETED, 0) AS IS_DELETED, c.REASON
			 FROM attendance_logs a
			 JOIN devices d ON d.IDNo = a.DEVICE_ID
			 ${correctionJoin('a', 'c')}
			 WHERE a.IDNo = ?${scope.sql}`,
			[id, ...scope.params]
		);
		return rows[0] || null;
	}

	/**
	 * Writes the full correction state of a punch (the caller merges it with the current one).
	 * PUNCH_DT_NEW / PUNCH_STATUS_NEW are null when equal to the original, so "back to the
	 * original" clears the edit instead of storing it.
	 */
	static async saveAttendanceCorrection(punch, { punchDtNew, punchStatusNew, isDeleted, reason }, userId) {
		await ZktecoModel.ensureSchema();
		await zkPool.query(
			`INSERT INTO attendance_log_corrections
				(DEVICE_ID, PIN, PUNCH_DT, PUNCH_DT_NEW, PUNCH_STATUS_NEW, IS_DELETED, REASON, ENCODED_BY)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE
				PUNCH_DT_NEW = VALUES(PUNCH_DT_NEW), PUNCH_STATUS_NEW = VALUES(PUNCH_STATUS_NEW),
				IS_DELETED = VALUES(IS_DELETED), REASON = VALUES(REASON), EDITED_BY = ?, EDITED_DT = NOW()`,
			[
				punch.DEVICE_ID,
				punch.PIN,
				punch.PUNCH_DT,
				punchDtNew,
				punchStatusNew,
				isDeleted ? 1 : 0,
				reason,
				userId,
				userId,
			]
		);
	}

	/** Device-local "now" (the pool runs in the device timezone), for rejecting future punch times. */
	static async deviceNow() {
		const [[row]] = await zkPool.query('SELECT NOW() AS now');
		return row.now;
	}
}

module.exports = ZktecoModel;
