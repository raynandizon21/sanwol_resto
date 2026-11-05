// ============================================
// ZKTECO MODEL
// ============================================
// File: models/zktecoModel.js
// Description: Schema + queries for the ZKTeco (MB160) data. Writes from the device itself live
// in services/admsService.js. See docs/zkteco-mb160.md.
//
// Everything is in the main sanwol_resto DB. What came from the ZKTeco integration is named so
// it's recognisable at a glance: tables start with `zk_`, and the device columns added to
// `employee` start with `ZK_`. Queries run on config/zktecoDb.js (same DB, device-local times).
// ============================================

const zkPool = require('../config/zktecoDb');
const EmployeeModel = require('./employeeModel');

// Same collation as the rest of sanwol_resto (employee is utf8mb4_general_ci): PINs are compared
// across employee and the zk_ tables, and mixed collations make MariaDB refuse those comparisons.
const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

const TABLES = [
	`CREATE TABLE IF NOT EXISTS zk_devices (
		IDNo INT NOT NULL AUTO_INCREMENT,
		SERIAL_NO VARCHAR(32) NOT NULL,
		BRANCH_ID INT NULL DEFAULT NULL COMMENT 'branches.IDNo',
		DEVICE_NAME VARCHAR(64) NULL DEFAULT NULL,
		IP_ADDRESS VARCHAR(45) NULL DEFAULT NULL,
		FIRMWARE VARCHAR(64) NULL DEFAULT NULL,
		PUSH_VERSION VARCHAR(16) NULL DEFAULT NULL,
		LANGUAGE VARCHAR(8) NULL DEFAULT NULL,
		USER_COUNT INT NULL DEFAULT NULL COMMENT 'As reported by the device',
		FP_COUNT INT NULL DEFAULT NULL,
		FACE_COUNT INT NULL DEFAULT NULL,
		ATT_COUNT INT NULL DEFAULT NULL,
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
		UNIQUE KEY uq_zk_devices_serial (SERIAL_NO),
		KEY idx_zk_devices_branch (BRANCH_ID)
	) ${TABLE_OPTIONS} COMMENT='ZKTeco MB160: attendance devices (one row per serial number)'`,

	// Every punch: from the device (SOURCE = 'device') or added in the app for a forgotten
	// time-in/out (SOURCE = 'manual'). A device punch's own fields (PIN, PUNCH_DT, PUNCH_STATUS,
	// RAW_LINE) are never changed: edits go in PUNCH_DT_NEW / PUNCH_STATUS_NEW and deletes are
	// IS_DELETED, so "back to the device's record" is always possible. Manual punches have no
	// DEVICE_ID/PIN, so the unique key only applies to device punches.
	`CREATE TABLE IF NOT EXISTS zk_attendance_logs (
		IDNo BIGINT NOT NULL AUTO_INCREMENT,
		SOURCE VARCHAR(8) NOT NULL DEFAULT 'device' COMMENT 'device = punched on the MB160; manual = added in the app',
		EMPLOYEE_ID INT NULL DEFAULT NULL COMMENT 'employee.IDNo whose punch it is; NULL = that User ID is not on the device',
		BRANCH_ID INT NULL DEFAULT NULL COMMENT 'Device branch at the time of the punch',
		DEVICE_ID INT NULL DEFAULT NULL COMMENT 'zk_devices.IDNo (device punches only)',
		PIN VARCHAR(32) NULL DEFAULT NULL COMMENT 'User ID the device recorded (device punches only)',
		PUNCH_DT DATETIME NOT NULL COMMENT 'Device-local time. Device punches: as sent, never changed',
		PUNCH_STATUS SMALLINT NULL DEFAULT NULL COMMENT '0 in, 1 out, 2 break out, 3 break in, 4 OT in, 5 OT out, 255 none',
		VERIFY_TYPE SMALLINT NULL DEFAULT NULL COMMENT '1 fingerprint, 3 password, 4 card, 15 face (firmware-dependent)',
		WORK_CODE VARCHAR(32) NULL DEFAULT NULL,
		RAW_LINE VARCHAR(500) NULL DEFAULT NULL COMMENT 'The ATTLOG line as sent (device punches only)',
		PUNCH_DT_NEW DATETIME NULL DEFAULT NULL COMMENT 'Corrected time of a device punch; NULL = unchanged',
		PUNCH_STATUS_NEW SMALLINT NULL DEFAULT NULL COMMENT 'Corrected status of a device punch (255 = none); NULL = unchanged',
		EFFECTIVE_DT DATETIME GENERATED ALWAYS AS (COALESCE(PUNCH_DT_NEW, PUNCH_DT)) STORED COMMENT 'The time that counts (indexed)',
		IS_DELETED TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Soft delete: left out of attendance, restorable',
		REASON VARCHAR(255) NULL DEFAULT NULL COMMENT 'Why it was added or last changed',
		ENCODED_BY INT NULL DEFAULT NULL COMMENT 'Who added it (manual punches); NULL = the device',
		ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When it was received or added',
		EDITED_BY INT NULL DEFAULT NULL,
		EDITED_DT DATETIME NULL DEFAULT NULL COMMENT 'Last edit, delete or restore',
		PRIMARY KEY (IDNo),
		UNIQUE KEY uq_zk_attendance_punch (DEVICE_ID, PIN, PUNCH_DT),
		KEY idx_zk_attendance_branch_dt (BRANCH_ID, EFFECTIVE_DT),
		KEY idx_zk_attendance_employee_dt (EMPLOYEE_ID, EFFECTIVE_DT),
		KEY idx_zk_attendance_dt (EFFECTIVE_DT)
	) ${TABLE_OPTIONS} COMMENT='ZKTeco MB160: punches from the device and punches added in the app'`,

	// Which fingerprints / faces / photos each user has. Only metadata: the biometric data itself
	// is not stored (TEMPLATE_HASH just notices when a template is replaced).
	`CREATE TABLE IF NOT EXISTS zk_biometric_templates (
		IDNo BIGINT NOT NULL AUTO_INCREMENT,
		DEVICE_ID INT NOT NULL,
		PIN VARCHAR(32) NOT NULL,
		TEMPLATE_KIND VARCHAR(16) NOT NULL COMMENT 'FP, FACE, BIODATA, USERPIC, BIOPHOTO',
		BIO_TYPE SMALLINT NOT NULL DEFAULT 0 COMMENT '1 fingerprint, 2 face, 8 palm, 9 visible-light face',
		TEMPLATE_NO INT NOT NULL DEFAULT 0 COMMENT 'Finger number (FID 0-9) for fingerprints',
		TEMPLATE_INDEX INT NOT NULL DEFAULT 0,
		TEMPLATE_SIZE INT NULL DEFAULT NULL,
		VALID TINYINT NULL DEFAULT NULL,
		TEMPLATE_HASH CHAR(40) NULL DEFAULT NULL COMMENT 'SHA-1 of the payload; the payload itself is not stored',
		ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		EDITED_DT DATETIME NULL DEFAULT NULL COMMENT 'Last time the template itself changed',
		SYNCED_DT DATETIME NULL DEFAULT NULL COMMENT 'Last time the device reported this template',
		PRIMARY KEY (IDNo),
		UNIQUE KEY uq_zk_biometric_templates (DEVICE_ID, PIN, TEMPLATE_KIND, BIO_TYPE, TEMPLATE_NO, TEMPLATE_INDEX)
	) ${TABLE_OPTIONS} COMMENT='ZKTeco MB160: which biometrics each device user has (no biometric data)'`,

	// Server -> device queue. IDNo is sent to the device as C:<IDNo>:<COMMAND>.
	`CREATE TABLE IF NOT EXISTS zk_device_commands (
		IDNo INT NOT NULL AUTO_INCREMENT,
		DEVICE_ID INT NOT NULL,
		LABEL VARCHAR(120) NULL DEFAULT NULL,
		COMMAND MEDIUMTEXT NOT NULL COMMENT 'Can contain the device password: never returned by the API',
		STATUS VARCHAR(10) NOT NULL DEFAULT 'pending' COMMENT 'pending, sent, done, failed, expired, cancelled',
		RETURN_CODE INT NULL DEFAULT NULL,
		RESULT MEDIUMTEXT NULL DEFAULT NULL,
		EMPLOYEE_ID INT NULL DEFAULT NULL COMMENT 'Add again: the employee being put back on the device',
		PROFILE_JSON TEXT NULL DEFAULT NULL COMMENT 'Add employee: profile fields to apply once the device confirms',
		ENCODED_BY INT NULL DEFAULT NULL,
		ENCODED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		SENT_DT DATETIME NULL DEFAULT NULL,
		COMPLETED_DT DATETIME NULL DEFAULT NULL,
		PRIMARY KEY (IDNo),
		KEY idx_zk_device_commands_queue (DEVICE_ID, STATUS, IDNo),
		KEY idx_zk_device_commands_employee (EMPLOYEE_ID)
	) ${TABLE_OPTIONS} COMMENT='ZKTeco MB160: commands queued for the device (finished ones pruned after ZK_COMMAND_LOG_DAYS)'`,

	// Every device request/response (debugging, replay tests). Biometric payloads are blanked.
	`CREATE TABLE IF NOT EXISTS zk_raw_requests (
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
		KEY idx_zk_raw_requests_serial (SERIAL_NO, IDNo),
		KEY idx_zk_raw_requests_created (CREATED_DT)
	) ${TABLE_OPTIONS} COMMENT='ZKTeco MB160: raw device traffic, pruned after ZK_RAW_LOG_DAYS'`,
];

// The person on the device = their employee row. These columns hold what the MB160 has for them.
// A person removed from the device keeps their row (ZK_ON_DEVICE = 0) so past punches keep their
// name; "Add again" puts the same row back. ZK_ACTIVE_PIN is ZK_PIN while on the device, so the
// unique key allows one person per User ID per device. Added in order (ZK_ACTIVE_PIN needs
// ZK_ON_DEVICE and ZK_PIN first).
const EMPLOYEE_ZK_COLUMNS = [
	['ZK_DEVICE_ID', "INT NULL DEFAULT NULL COMMENT 'ZKTeco: zk_devices.IDNo this person is (or was) on'"],
	['ZK_PIN', "VARCHAR(32) NULL DEFAULT NULL COMMENT 'ZKTeco: User ID on the device (kept after removal)'"],
	['ZK_ON_DEVICE', "TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'ZKTeco: 1 = on the device now'"],
	['ZK_ACTIVE_PIN', "VARCHAR(32) GENERATED ALWAYS AS (IF(ZK_ON_DEVICE = 1, ZK_PIN, NULL)) STORED COMMENT 'ZKTeco: ZK_PIN while on the device'"],
	['ZK_NAME', "VARCHAR(100) NULL DEFAULT NULL COMMENT 'ZKTeco: name on the device (follows the profile name)'"],
	['ZK_PRIVILEGE', "SMALLINT NULL DEFAULT NULL COMMENT 'ZKTeco: 0 user, 14 admin (older firmware: 2 enroller, 6 admin)'"],
	['ZK_PASSWORD', "VARCHAR(32) NULL DEFAULT NULL COMMENT 'ZKTeco: device password; never returned by the API'"],
	['ZK_CARD_NO', "VARCHAR(32) NULL DEFAULT NULL COMMENT 'ZKTeco: card number; never returned by the API'"],
	['ZK_GROUP_NO', "VARCHAR(8) NULL DEFAULT NULL COMMENT 'ZKTeco: device access group'"],
	['ZK_USER_TZ', "VARCHAR(32) NULL DEFAULT NULL COMMENT 'ZKTeco: device time zones'"],
	['ZK_VERIFY_MODE', "VARCHAR(8) NULL DEFAULT NULL COMMENT 'ZKTeco: device verify mode'"],
	['ZK_SOURCE', "VARCHAR(8) NULL DEFAULT NULL COMMENT 'ZKTeco: device = created on the MB160, server = added from this app'"],
	['ZK_ADDED_DT', "DATETIME NULL DEFAULT NULL COMMENT 'ZKTeco: when they were put on the device (device time)'"],
	['ZK_EDITED_DT', "DATETIME NULL DEFAULT NULL COMMENT 'ZKTeco: last real change of the device fields, or removal'"],
	['ZK_REMOVED_BY', "INT NULL DEFAULT NULL COMMENT 'ZKTeco: user who removed them in the app (NULL = removed on the device)'"],
	['ZK_SYNCED_DT', "DATETIME NULL DEFAULT NULL COMMENT 'ZKTeco: last time the device reported them'"],
];
const EMPLOYEE_ZK_INDEXES = [
	['uq_employee_zk_active_pin', 'ADD UNIQUE KEY uq_employee_zk_active_pin (ZK_DEVICE_ID, ZK_ACTIVE_PIN)'],
	['idx_employee_zk_pin', 'ADD KEY idx_employee_zk_pin (ZK_DEVICE_ID, ZK_PIN)'],
];

/**
 * Takes a person off the device (removed in the app, on the device, or missing from a full sync).
 * What the device erased is erased here too (password, card); their templates are deleted by the
 * caller. Append WHERE ...; the first parameter is ZK_REMOVED_BY (null = removed on the device).
 */
const REMOVE_FROM_DEVICE_SQL = `UPDATE employee
	SET ZK_ON_DEVICE = 0, ZK_PASSWORD = NULL, ZK_CARD_NO = NULL, ZK_EDITED_DT = NOW(), ZK_REMOVED_BY = ?`;

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

/** Display name of a user_info row (alias `u`): first + last name, else username. */
const userNameSql = (u) =>
	`COALESCE(NULLIF(TRIM(CONCAT_WS(' ', NULLIF(${u}.FIRSTNAME, ''), NULLIF(${u}.LASTNAME, ''))), ''), ${u}.USERNAME)`;

/** Punch `a`'s status after corrections. */
const effectiveStatus = (a) => `COALESCE(${a}.PUNCH_STATUS_NEW, ${a}.PUNCH_STATUS)`;

/** Device punch: corrected; manual punch: changed after it was added. */
const isEditedSql = (a) =>
	`IF(${a}.SOURCE = 'manual', ${a}.EDITED_DT IS NOT NULL, ${a}.PUNCH_DT_NEW IS NOT NULL OR ${a}.PUNCH_STATUS_NEW IS NOT NULL)`;

/** "DATA DELETE USERINFO" for one user; built in one place so pending deletes can be matched exactly. */
const userDeleteCommand = (pin) => `DATA DELETE USERINFO PIN=${pin}`;

// Adds and edits are both DATA UPDATE USERINFO; edits are told apart by their LABEL.
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
 * otherwise an array of branch IDs.
 */
const branchClause = (column, branchIds) => {
	if (branchIds == null) return { sql: '', params: [] };
	if (branchIds.length === 0) return { sql: ' AND 1 = 0', params: [] };
	return {
		sql: ` AND ${column} IN (${branchIds.map(() => '?').join(',')})`,
		params: branchIds,
	};
};

const placeholders = (list) => list.map(() => '?').join(',');

class ZktecoModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (ZktecoModel._schemaReady) return;
		if (ZktecoModel._schemaPromise) return ZktecoModel._schemaPromise;

		ZktecoModel._schemaPromise = (async () => {
			// The ZK_ columns go on employee, so it has to exist first.
			await EmployeeModel.ensureSchema();
			for (const ddl of TABLES) {
				await zkPool.query(ddl);
			}
			const [cols] = await zkPool.query(
				`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee'`
			);
			const existing = new Set(cols.map((c) => c.COLUMN_NAME));
			for (const [name, definition] of EMPLOYEE_ZK_COLUMNS) {
				if (!existing.has(name)) {
					await zkPool.query(`ALTER TABLE employee ADD COLUMN ${name} ${definition}`);
					console.log(`[Schema] employee.${name} created`);
				}
			}
			for (const [name, ddl] of EMPLOYEE_ZK_INDEXES) {
				const [rows] = await zkPool.query(
					`SELECT 1 FROM information_schema.STATISTICS
					 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee' AND INDEX_NAME = ? LIMIT 1`,
					[name]
				);
				if (rows.length === 0) {
					await zkPool.query(`ALTER TABLE employee ${ddl}`);
					console.log(`[Schema] employee.${name} created`);
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
		const scope = branchClause('d.BRANCH_ID', branchIds);
		const [rows] = await zkPool.query(
			`SELECT
				d.IDNo, d.SERIAL_NO, d.BRANCH_ID, b.BRANCH_NAME, d.DEVICE_NAME, d.IP_ADDRESS, d.FIRMWARE, d.PUSH_VERSION,
				d.USER_COUNT, d.FP_COUNT, d.FACE_COUNT, d.ATT_COUNT,
				d.LAST_HANDSHAKE_DT, d.LAST_SEEN_DT, d.ACTIVE,
				(d.LAST_SEEN_DT IS NOT NULL AND d.LAST_SEEN_DT >= NOW() - INTERVAL ${ONLINE_THRESHOLD_SECONDS} SECOND) AS IS_ONLINE,
				(SELECT COUNT(*) FROM zk_attendance_logs a WHERE a.DEVICE_ID = d.IDNo) AS STORED_PUNCHES,
				(SELECT COUNT(*) FROM employee e WHERE e.ZK_DEVICE_ID = d.IDNo AND e.ZK_ON_DEVICE = 1) AS STORED_USERS
			 FROM zk_devices d
			 LEFT JOIN branches b ON b.IDNo = d.BRANCH_ID
			 WHERE 1 = 1${scope.sql}
			 ORDER BY d.SERIAL_NO`,
			scope.params
		);
		return rows;
	}

	/**
	 * Punches newest first, at most `limit` (default 5000). Dates are device-local YYYY-MM-DD (inclusive).
	 * PUNCH_DT / PUNCH_STATUS include corrections (originals in ORIGINAL_*); soft-deleted punches are
	 * left out unless include_deleted. PERSON_ID is the employee the punch belongs to; CURRENT_PIN is
	 * set when they are now on the device under another User ID.
	 */
	static async getAttendanceLogs(branchIds, filters = {}) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('a.BRANCH_ID', branchIds);
		let sql = `
			SELECT
				a.SOURCE, a.IDNo, COALESCE(a.DEVICE_ID, e.ZK_DEVICE_ID) AS DEVICE_ID, a.BRANCH_ID, b.BRANCH_NAME,
				COALESCE(a.PIN, e.ZK_PIN) AS PIN,
				a.EFFECTIVE_DT AS PUNCH_DT, ${effectiveStatus('a')} AS PUNCH_STATUS,
				a.PUNCH_DT AS ORIGINAL_PUNCH_DT, a.PUNCH_STATUS AS ORIGINAL_PUNCH_STATUS,
				a.VERIFY_TYPE, a.WORK_CODE, a.ENCODED_DT AS RECEIVED_DT,
				a.EMPLOYEE_ID AS PERSON_ID, e.ZK_NAME AS NAME, e.ZK_ON_DEVICE AS USER_ACTIVE,
				IF(a.PIN IS NOT NULL AND e.ZK_PIN <> a.PIN, e.ZK_PIN, NULL) AS CURRENT_PIN,
				${isEditedSql('a')} AS IS_EDITED,
				a.IS_DELETED, a.REASON AS CORRECTION_REASON,
				${userNameSql('cu')} AS CORRECTED_BY_NAME,
				IF(a.EDITED_DT IS NOT NULL OR a.SOURCE = 'manual', COALESCE(a.EDITED_DT, a.ENCODED_DT), NULL) AS CORRECTED_DT,
				${userNameSql('au')} AS ADDED_BY_NAME,
				d.SERIAL_NO, d.DEVICE_NAME
			FROM zk_attendance_logs a
			LEFT JOIN employee e ON e.IDNo = a.EMPLOYEE_ID
			LEFT JOIN zk_devices d ON d.IDNo = COALESCE(a.DEVICE_ID, e.ZK_DEVICE_ID)
			LEFT JOIN branches b ON b.IDNo = a.BRANCH_ID
			LEFT JOIN user_info cu ON cu.IDNo = COALESCE(a.EDITED_BY, a.ENCODED_BY)
			LEFT JOIN user_info au ON au.IDNo = a.ENCODED_BY
			WHERE 1 = 1${scope.sql}`;
		const params = [...scope.params];

		if (!filters.include_deleted) sql += ' AND a.IS_DELETED = 0';
		if (filters.start_date) {
			sql += ' AND a.EFFECTIVE_DT >= ?';
			params.push(`${filters.start_date} 00:00:00`);
		}
		if (filters.end_date) {
			sql += ' AND a.EFFECTIVE_DT < DATE_ADD(?, INTERVAL 1 DAY)';
			params.push(filters.end_date);
		}
		if (filters.device_id) {
			sql += ' AND COALESCE(a.DEVICE_ID, e.ZK_DEVICE_ID) = ?';
			params.push(filters.device_id);
		}

		const safeLimit = Math.min(Math.max(1, Number(filters.limit) || 5000), 20000);
		// One extra row tells the caller the range had more punches than the limit.
		sql += ` ORDER BY a.EFFECTIVE_DT DESC, a.IDNo DESC LIMIT ${safeLimit + 1}`;

		const [rows] = await zkPool.query(sql, params);
		return { rows: rows.slice(0, safeLimit), truncated: rows.length > safeLimit, limit: safeLimit };
	}

	/**
	 * Every counted punch (corrections applied, deleted ones left out) with time >= startDt and
	 * < endDt, oldest first, for computing attendance. EMPLOYEE_ID is null when that User ID isn't
	 * on the device.
	 */
	static async getPunchesForAttendance(branchIds, startDt, endDt) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('a.BRANCH_ID', branchIds);
		const [rows] = await zkPool.query(
			`SELECT a.SOURCE, a.IDNo, COALESCE(a.DEVICE_ID, e.ZK_DEVICE_ID) AS DEVICE_ID, a.BRANCH_ID,
				COALESCE(a.PIN, e.ZK_PIN) AS PIN,
				a.EFFECTIVE_DT AS PUNCH_DT, ${effectiveStatus('a')} AS PUNCH_STATUS,
				a.PUNCH_DT AS ORIGINAL_PUNCH_DT, a.PUNCH_STATUS AS ORIGINAL_PUNCH_STATUS,
				${isEditedSql('a')} AS IS_EDITED, a.REASON, a.VERIFY_TYPE,
				a.EMPLOYEE_ID, e.ZK_NAME AS NAME
			 FROM zk_attendance_logs a
			 LEFT JOIN employee e ON e.IDNo = a.EMPLOYEE_ID
			 WHERE a.IS_DELETED = 0 AND a.EFFECTIVE_DT >= ? AND a.EFFECTIVE_DT < ?${scope.sql}
			 ORDER BY a.EFFECTIVE_DT, a.SOURCE, a.IDNo`,
			[startDt, endDt, ...scope.params]
		);
		return rows;
	}

	// ---- People (employee rows linked to a device) ----

	/**
	 * Everyone who is or was on a device in scope (by the device's branch), with what attendance
	 * needs. Profiles (employee.ACTIVE = 0) merged into another one are left out.
	 */
	static async getPeople(branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('d.BRANCH_ID', branchIds);
		const [rows] = await zkPool.query(
			`SELECT e.IDNo, e.ZK_DEVICE_ID, e.ZK_PIN, e.ZK_NAME, e.ZK_ON_DEVICE, d.BRANCH_ID AS DEVICE_BRANCH_ID
			 FROM employee e
			 JOIN zk_devices d ON d.IDNo = e.ZK_DEVICE_ID
			 WHERE e.ACTIVE = 1${scope.sql}
			 ORDER BY e.IDNo`,
			scope.params
		);
		return rows;
	}

	/** One employee's device link with the device's branch, or null when they were never on one. */
	static async getEmployeeOnDevice(employeeId) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT e.IDNo, e.ACTIVE, e.ZK_DEVICE_ID, e.ZK_PIN, e.ZK_NAME, e.ZK_ON_DEVICE, d.BRANCH_ID AS DEVICE_BRANCH_ID
			 FROM employee e JOIN zk_devices d ON d.IDNo = e.ZK_DEVICE_ID
			 WHERE e.IDNo = ?`,
			[employeeId]
		);
		return rows[0] || null;
	}

	/** People removed from a device in scope whose profile is still active (for "Returning employee?"). */
	static async getFormerEmployees(branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('d.BRANCH_ID', branchIds);
		const [rows] = await zkPool.query(
			`SELECT e.IDNo, e.FIRSTNAME, e.LASTNAME, e.DEPARTMENT, e.ZK_NAME,
				DATE_FORMAT(e.DATE_STARTED, '%Y-%m-%d') AS DATE_STARTED, DATE_FORMAT(e.DATE_SEPARATED, '%Y-%m-%d') AS DATE_SEPARATED
			 FROM employee e
			 JOIN zk_devices d ON d.IDNo = e.ZK_DEVICE_ID
			 WHERE e.ACTIVE = 1 AND e.ZK_ON_DEVICE = 0${scope.sql}
			 ORDER BY e.FIRSTNAME, e.LASTNAME`,
			scope.params
		);
		return rows;
	}

	/**
	 * Someone added back directly on the device got a new employee row (`currentId`). This moves
	 * their device link and punches onto their old profile (`formerId`) and deactivates the new one.
	 */
	static async mergeIntoFormerEmployee(currentId, formerId, userId) {
		await ZktecoModel.ensureSchema();
		const conn = await zkPool.getConnection();
		try {
			await conn.beginTransaction();
			const [rows] = await conn.query(
				`SELECT IDNo, ACTIVE, ZK_DEVICE_ID, ZK_PIN, ZK_ON_DEVICE, ZK_NAME, ZK_PRIVILEGE, ZK_PASSWORD, ZK_CARD_NO,
					ZK_GROUP_NO, ZK_USER_TZ, ZK_VERIFY_MODE, ZK_SOURCE, ZK_ADDED_DT, ZK_EDITED_DT, ZK_SYNCED_DT
				 FROM employee WHERE IDNo IN (?, ?) FOR UPDATE`,
				[currentId, formerId]
			);
			const current = rows.find((r) => Number(r.IDNo) === Number(currentId));
			const former = rows.find((r) => Number(r.IDNo) === Number(formerId));
			if (!current || !Number(current.ZK_ON_DEVICE)) throw new Error('This user is no longer on the device');
			if (!former || !Number(former.ACTIVE) || Number(former.ZK_ON_DEVICE)) throw new Error('That profile is not a former employee');

			// The new row lets go of the User ID first (one person per User ID), then the old profile takes it.
			await conn.query(
				`UPDATE employee SET ACTIVE = 0, ZK_ON_DEVICE = 0, ZK_DEVICE_ID = NULL, ZK_PIN = NULL, ZK_NAME = NULL,
					ZK_PRIVILEGE = NULL, ZK_PASSWORD = NULL, ZK_CARD_NO = NULL, ZK_GROUP_NO = NULL, ZK_USER_TZ = NULL,
					ZK_VERIFY_MODE = NULL, ZK_SOURCE = NULL, ZK_ADDED_DT = NULL, ZK_EDITED_DT = NULL, ZK_SYNCED_DT = NULL,
					EDITED_BY = ?, EDITED_DT = NOW()
				 WHERE IDNo = ?`,
				[userId, current.IDNo]
			);
			await conn.query(
				`UPDATE employee SET ZK_DEVICE_ID = ?, ZK_PIN = ?, ZK_ON_DEVICE = 1, ZK_NAME = ?, ZK_PRIVILEGE = ?,
					ZK_PASSWORD = ?, ZK_CARD_NO = ?, ZK_GROUP_NO = ?, ZK_USER_TZ = ?, ZK_VERIFY_MODE = ?, ZK_SOURCE = ?,
					ZK_ADDED_DT = ?, ZK_EDITED_DT = ?, ZK_REMOVED_BY = NULL, ZK_SYNCED_DT = ?, EDITED_BY = ?, EDITED_DT = NOW()
				 WHERE IDNo = ?`,
				[
					current.ZK_DEVICE_ID,
					current.ZK_PIN,
					current.ZK_NAME,
					current.ZK_PRIVILEGE,
					current.ZK_PASSWORD,
					current.ZK_CARD_NO,
					current.ZK_GROUP_NO,
					current.ZK_USER_TZ,
					current.ZK_VERIFY_MODE,
					current.ZK_SOURCE,
					current.ZK_ADDED_DT,
					current.ZK_EDITED_DT,
					current.ZK_SYNCED_DT,
					userId,
					former.IDNo,
				]
			);
			await conn.query('UPDATE zk_attendance_logs SET EMPLOYEE_ID = ? WHERE EMPLOYEE_ID = ?', [former.IDNo, current.IDNo]);
			await conn.query('UPDATE zk_device_commands SET EMPLOYEE_ID = ? WHERE EMPLOYEE_ID = ?', [former.IDNo, current.IDNo]);
			await conn.commit();
			return { deviceId: Number(current.ZK_DEVICE_ID) };
		} catch (error) {
			await conn.rollback().catch(() => {});
			throw error;
		} finally {
			conn.release();
		}
	}

	// ---- Punches: manual punches and corrections ----

	/**
	 * True when this person already has a counted punch at exactly `punchDt` (any punch other than
	 * `excludeId`, at its corrected time).
	 */
	static async punchExistsAt(employeeId, punchDt, excludeId = null) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT 1 FROM zk_attendance_logs
			 WHERE EMPLOYEE_ID = ? AND EFFECTIVE_DT = ? AND IS_DELETED = 0 AND IDNo <> ?
			 LIMIT 1`,
			[employeeId, punchDt, excludeId ?? 0]
		);
		return rows.length > 0;
	}

	static async insertManualPunch({ employeeId, branchId, punchDt, status, reason }, userId) {
		await ZktecoModel.ensureSchema();
		const [result] = await zkPool.query(
			`INSERT INTO zk_attendance_logs (SOURCE, EMPLOYEE_ID, BRANCH_ID, PUNCH_DT, PUNCH_STATUS, REASON, ENCODED_BY)
			 VALUES ('manual', ?, ?, ?, ?, ?, ?)`,
			[employeeId, branchId, punchDt, status, reason, userId]
		);
		return result.insertId;
	}

	/** One punch (device or manual) in the caller's branch scope. */
	static async getAttendanceLog(id, branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('a.BRANCH_ID', branchIds);
		const [rows] = await zkPool.query(
			`SELECT a.IDNo, a.SOURCE, a.EMPLOYEE_ID, a.BRANCH_ID, COALESCE(a.DEVICE_ID, e.ZK_DEVICE_ID) AS DEVICE_ID,
				a.PUNCH_DT, a.PUNCH_STATUS, a.PUNCH_DT_NEW, a.PUNCH_STATUS_NEW, a.EFFECTIVE_DT, a.IS_DELETED, a.REASON
			 FROM zk_attendance_logs a
			 LEFT JOIN employee e ON e.IDNo = a.EMPLOYEE_ID
			 WHERE a.IDNo = ?${scope.sql}`,
			[id, ...scope.params]
		);
		return rows[0] || null;
	}

	/**
	 * Corrects a device punch. PUNCH_DT_NEW / PUNCH_STATUS_NEW are null when equal to the device's
	 * values, so "back to the original" clears the edit instead of storing it.
	 */
	static async correctDevicePunch(id, { punchDtNew, punchStatusNew, reason }, userId) {
		await ZktecoModel.ensureSchema();
		await zkPool.query(
			`UPDATE zk_attendance_logs
			 SET PUNCH_DT_NEW = ?, PUNCH_STATUS_NEW = ?, REASON = ?, EDITED_BY = ?, EDITED_DT = NOW()
			 WHERE IDNo = ? AND SOURCE = 'device'`,
			[punchDtNew, punchStatusNew, reason, userId, id]
		);
	}

	/** A manual punch is app data, so an edit simply changes it. */
	static async updateManualPunch(id, { punchDt, status, reason }, userId) {
		await ZktecoModel.ensureSchema();
		await zkPool.query(
			`UPDATE zk_attendance_logs
			 SET PUNCH_DT = ?, PUNCH_STATUS = ?, REASON = ?, EDITED_BY = ?, EDITED_DT = NOW()
			 WHERE IDNo = ? AND SOURCE = 'manual'`,
			[punchDt, status, reason, userId, id]
		);
	}

	/** Soft delete / restore. Edits are kept, so a restored punch comes back as it was. */
	static async setPunchDeleted(id, deleted, reason, userId) {
		await ZktecoModel.ensureSchema();
		await zkPool.query(
			`UPDATE zk_attendance_logs
			 SET IS_DELETED = ?, REASON = COALESCE(?, REASON), EDITED_BY = ?, EDITED_DT = NOW()
			 WHERE IDNo = ?`,
			[deleted ? 1 : 0, reason, userId, id]
		);
	}

	// ---- Employees page (people on the device) ----

	/**
	 * Everyone on each device, with biometric counts and last punch. Never returns passwords, card
	 * numbers or templates. People removed from the device only with include_deleted. IDNo and
	 * EMPLOYEE_ID are both the employee row.
	 */
	static async getDeviceUsers(branchIds, filters = {}) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('d.BRANCH_ID', branchIds);
		let sql = `
			SELECT
				e.IDNo, e.IDNo AS EMPLOYEE_ID, e.ZK_DEVICE_ID AS DEVICE_ID, e.ZK_PIN AS PIN, e.ZK_NAME AS NAME,
				e.ZK_PRIVILEGE AS PRIVILEGE, e.ZK_SOURCE AS SOURCE, e.ZK_ON_DEVICE AS ACTIVE,
				e.ZK_ADDED_DT AS ENCODED_DT, e.ZK_EDITED_DT AS EDITED_DT, ${userNameSql('ru')} AS EDITED_BY_NAME,
				(e.ZK_PASSWORD IS NOT NULL AND e.ZK_PASSWORD <> '') AS HAS_PASSWORD,
				(e.ZK_CARD_NO IS NOT NULL AND e.ZK_CARD_NO <> '' AND e.ZK_CARD_NO <> '0') AS HAS_CARD,
				d.SERIAL_NO, d.DEVICE_NAME, d.BRANCH_ID, b.BRANCH_NAME,
				COALESCE(bt.FP_COUNT, 0) AS FP_COUNT,
				COALESCE(bt.HAS_FACE, 0) AS HAS_FACE,
				COALESCE(bt.PALM_COUNT, 0) AS PALM_COUNT,
				bt.FP_FINGERS,
				COALESCE(bt.HAS_PHOTO, 0) AS HAS_PHOTO,
				(SELECT MAX(a.EFFECTIVE_DT) FROM zk_attendance_logs a WHERE a.EMPLOYEE_ID = e.IDNo AND a.IS_DELETED = 0) AS LAST_PUNCH_DT
			FROM employee e
			JOIN zk_devices d ON d.IDNo = e.ZK_DEVICE_ID
			LEFT JOIN branches b ON b.IDNo = d.BRANCH_ID
			LEFT JOIN user_info ru ON ru.IDNo = e.ZK_REMOVED_BY
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
				FROM zk_biometric_templates
				GROUP BY DEVICE_ID, PIN
			) bt ON e.ZK_ON_DEVICE = 1 AND bt.DEVICE_ID = e.ZK_DEVICE_ID AND bt.PIN = e.ZK_PIN
			WHERE e.ACTIVE = 1${scope.sql}`;
		const params = [...scope.params];

		if (!filters.include_deleted) sql += ' AND e.ZK_ON_DEVICE = 1';
		if (filters.device_id) {
			sql += ' AND e.ZK_DEVICE_ID = ?';
			params.push(filters.device_id);
		}

		sql += ' ORDER BY d.SERIAL_NO, e.ZK_ON_DEVICE DESC, CAST(e.ZK_PIN AS UNSIGNED), e.ZK_PIN';
		const [rows] = await zkPool.query(sql, params);
		return rows;
	}

	static async getDeviceById(deviceId) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query('SELECT IDNo, SERIAL_NO, BRANCH_ID, ACTIVE FROM zk_devices WHERE IDNo = ?', [deviceId]);
		return rows[0] || null;
	}

	/**
	 * Why removed employee `employeeId` can't be added again on `deviceId` (null when it can): they
	 * must have been removed from that device, and not be on it again or in a pending add.
	 */
	static async readdBlocker(deviceId, employeeId) {
		await ZktecoModel.ensureSchema();
		const [[row]] = await zkPool.query(
			`SELECT e.ACTIVE, e.ZK_DEVICE_ID, e.ZK_ON_DEVICE,
				EXISTS(SELECT 1 FROM zk_device_commands c
					WHERE c.EMPLOYEE_ID = e.IDNo AND c.STATUS IN ('pending', 'sent')) AS PENDING
			 FROM employee e WHERE e.IDNo = ?`,
			[employeeId]
		);
		if (!row || !Number(row.ACTIVE) || Number(row.ZK_DEVICE_ID) !== Number(deviceId)) {
			return 'That removed user was not found on this device';
		}
		if (Number(row.ZK_ON_DEVICE) || Number(row.PENDING)) return 'This user has already been added again';
		return null;
	}

	/** True when the PIN is on the device or an add for it is still waiting to be delivered. */
	static async isPinTaken(deviceId, pin) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT 1 FROM employee WHERE ZK_DEVICE_ID = ? AND ZK_ACTIVE_PIN = ?
			 UNION ALL
			 SELECT 1 FROM zk_device_commands
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
			`SELECT IDNo FROM zk_device_commands
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
			`SELECT 1 FROM zk_biometric_templates
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
		const scope = branchClause('d.BRANCH_ID', branchIds);
		const [rows] = await zkPool.query(
			`SELECT c.IDNo, c.DEVICE_ID, c.COMMAND, c.STATUS, c.RETURN_CODE, c.ENCODED_DT, c.SENT_DT, c.COMPLETED_DT,
				(c.STATUS = 'sent' AND c.SENT_DT < NOW() - INTERVAL ${ENROLL_PROMPT_MAX_SECONDS} SECOND) AS PROMPT_STALE,
				d.BRANCH_ID
			 FROM zk_device_commands c
			 JOIN zk_devices d ON d.IDNo = c.DEVICE_ID
			 WHERE c.IDNo = ? AND (c.COMMAND LIKE 'ENROLL\\_FP %' OR c.COMMAND LIKE 'DATA DELETE FINGERTMP %')${scope.sql}`,
			[commandId, ...scope.params]
		);
		const row = rows[0];
		if (!row) return null;

		const command = String(row.COMMAND);
		const kind = command.startsWith('ENROLL_FP ') ? 'enroll' : 'remove';
		const fields = commandFields(command, kind === 'enroll' ? 'ENROLL_FP ' : 'DATA DELETE FINGERTMP ');
		const pin = fields.PIN ?? null;
		const finger = fields.FID != null ? Number(fields.FID) : null;
		const base = {
			IDNo: row.IDNo,
			DEVICE_ID: row.DEVICE_ID,
			KIND: kind,
			PIN: pin,
			FINGER: finger,
			RETURN_CODE: row.RETURN_CODE,
			ENCODED_DT: row.ENCODED_DT,
			SENT_DT: row.SENT_DT,
			COMPLETED_DT: row.COMPLETED_DT,
		};

		if (kind === 'remove') {
			const removeState = { pending: 'waiting', sent: 'waiting', done: 'removed', cancelled: 'cancelled' };
			return { ...base, STATE: removeState[row.STATUS] || 'failed', FP_RECEIVED: false };
		}

		// The template upload belongs to this enrollment only if it landed between the prompt
		// and shortly after the device's answer (a later enrollment of the same finger doesn't count).
		let received = false;
		if (row.SENT_DT) {
			const [tpl] = await zkPool.query(
				`SELECT 1 FROM zk_biometric_templates
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

		return { ...base, STATE: state, FP_RECEIVED: received };
	}

	/** Withdraws a command the device hasn't picked up yet. Returns false once it was sent. */
	static async cancelPendingCommand(commandId) {
		await ZktecoModel.ensureSchema();
		const [result] = await zkPool.query(
			`UPDATE zk_device_commands SET STATUS = 'cancelled', COMPLETED_DT = NOW(), PROFILE_JSON = NULL
			 WHERE IDNo = ? AND STATUS = 'pending'`,
			[commandId]
		);
		return result.affectedRows > 0;
	}

	/**
	 * User adds, edits and removals from the app that haven't landed yet (waiting/sent) or failed
	 * in the last day. KIND: 'add' | 'edit' | 'delete'. Raw COMMAND is not returned: it contains
	 * the device password. A removal names only the PIN, so NAME comes from the person being removed.
	 */
	static async getPendingUserCommands(branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('d.BRANCH_ID', branchIds);
		const [rows] = await zkPool.query(
			`SELECT c.IDNo, c.DEVICE_ID, c.LABEL, c.COMMAND, c.STATUS, c.RETURN_CODE, c.ENCODED_BY, c.ENCODED_DT, c.SENT_DT, c.COMPLETED_DT,
				d.SERIAL_NO, d.DEVICE_NAME, d.BRANCH_ID, b.BRANCH_NAME,
				(SELECT e.ZK_NAME FROM employee e
				 WHERE e.ZK_DEVICE_ID = c.DEVICE_ID AND e.ZK_ACTIVE_PIN = SUBSTRING(c.COMMAND, ${'DATA DELETE USERINFO PIN='.length + 1})
				) AS REMOVED_NAME
			 FROM zk_device_commands c
			 JOIN zk_devices d ON d.IDNo = c.DEVICE_ID
			 LEFT JOIN branches b ON b.IDNo = d.BRANCH_ID
			 WHERE (c.COMMAND LIKE 'DATA UPDATE USERINFO %' OR c.COMMAND LIKE 'DATA DELETE USERINFO %')
			   AND (c.STATUS IN ('pending', 'sent') OR (c.STATUS = 'failed' AND c.COMPLETED_DT >= NOW() - INTERVAL 1 DAY))${scope.sql}
			 ORDER BY c.IDNo DESC
			 LIMIT 100`,
			scope.params
		);
		return rows.map(({ COMMAND, LABEL, REMOVED_NAME, ...row }) => {
			const kind = userCommandKind(COMMAND, LABEL);
			const fields = commandFields(COMMAND, kind === 'delete' ? 'DATA DELETE USERINFO ' : 'DATA UPDATE USERINFO ');
			return { ...row, KIND: kind, PIN: fields.PIN ?? null, NAME: kind === 'delete' ? REMOVED_NAME : fields.Name ?? null };
		});
	}

	/** One queued user add/edit/removal (for cancelling), in the caller's branch scope. */
	static async getUserCommand(commandId, branchIds) {
		await ZktecoModel.ensureSchema();
		const scope = branchClause('d.BRANCH_ID', branchIds);
		const [rows] = await zkPool.query(
			`SELECT c.IDNo, c.DEVICE_ID, c.LABEL, c.COMMAND, c.STATUS
			 FROM zk_device_commands c
			 JOIN zk_devices d ON d.IDNo = c.DEVICE_ID
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
	 * The person holding this PIN on the device, with their full device record including PASSWORD
	 * and CARD_NO, for building an edit command (the device needs the whole record).
	 * Internal only: never return it from the API.
	 */
	static async getDeviceUserForEdit(deviceId, pin) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT IDNo, ZK_PIN AS PIN, ZK_NAME AS NAME, ZK_PRIVILEGE AS PRIVILEGE, ZK_PASSWORD AS PASSWORD,
				ZK_CARD_NO AS CARD_NO, ZK_GROUP_NO AS GROUP_NO, ZK_USER_TZ AS USER_TZ, ZK_VERIFY_MODE AS VERIFY_MODE
			 FROM employee WHERE ZK_DEVICE_ID = ? AND ZK_ACTIVE_PIN = ?`,
			[deviceId, pin]
		);
		return rows[0] || null;
	}

	/** An edit or removal of this PIN still waiting for the device, or null. */
	static async getPendingUserChange(deviceId, pin) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT IDNo FROM zk_device_commands
			 WHERE DEVICE_ID = ? AND STATUS IN ('pending', 'sent') AND (COMMAND = ? OR COMMAND LIKE ?)
			 LIMIT 1`,
			[deviceId, userDeleteCommand(pin), `DATA UPDATE USERINFO PIN=${pin}\t%`]
		);
		return rows[0] || null;
	}

	/** The newest pending rename/removal of this PIN (deviceNameSync), newest first. */
	static async getPendingUserCommandsFor(deviceId, pin) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT COMMAND FROM zk_device_commands
			 WHERE DEVICE_ID = ? AND STATUS IN ('pending', 'sent') AND (COMMAND = ? OR COMMAND LIKE ?)
			 ORDER BY IDNo DESC`,
			[deviceId, userDeleteCommand(pin), `DATA UPDATE USERINFO PIN=${pin}\t%`]
		);
		return rows;
	}

	/** The person currently holding this PIN on the device. */
	static async getActiveDeviceUser(deviceId, pin) {
		await ZktecoModel.ensureSchema();
		const [rows] = await zkPool.query(
			`SELECT IDNo, ZK_DEVICE_ID AS DEVICE_ID, ZK_PIN AS PIN, ZK_NAME AS NAME, ZK_PRIVILEGE AS PRIVILEGE
			 FROM employee WHERE ZK_DEVICE_ID = ? AND ZK_ACTIVE_PIN = ?`,
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
			`SELECT COUNT(*) AS n FROM employee e
			 WHERE e.ZK_DEVICE_ID = ? AND e.ZK_ON_DEVICE = 1 AND e.ZK_PIN <> ? AND e.ZK_PRIVILEGE IN (${placeholders(ADMIN_PRIVILEGES)})
			   AND NOT EXISTS (
				SELECT 1 FROM zk_device_commands c
				WHERE c.DEVICE_ID = e.ZK_DEVICE_ID AND c.STATUS IN ('pending', 'sent')
				  AND c.COMMAND = CONCAT('DATA DELETE USERINFO PIN=', e.ZK_PIN)
			   )`,
			[deviceId, pin, ...ADMIN_PRIVILEGES]
		);
		return Number(row.n);
	}

	static userDeleteCommand(pin) {
		return userDeleteCommand(pin);
	}

	/** Device-local "now" (the pool runs in the device timezone), for rejecting future punch times. */
	static async deviceNow() {
		const [[row]] = await zkPool.query('SELECT NOW() AS now');
		return row.now;
	}
}

ZktecoModel.REMOVE_FROM_DEVICE_SQL = REMOVE_FROM_DEVICE_SQL;

module.exports = ZktecoModel;
