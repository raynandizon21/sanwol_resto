// ============================================
// ADMS SERVICE (ZKTeco PUSH protocol)
// ============================================
// File: services/admsService.js
// Description: Handles requests from ZKTeco devices (MB160). Ported from
// zkteco_test/src/Adms.php; keep the two in step when the protocol handling changes.
//
// The device is the HTTP client:
//   GET  /iclock/cdata?SN=..&options=all   handshake, server replies with options
//   POST /iclock/cdata?SN=..&table=ATTLOG  punches (also OPERLOG, ATTPHOTO, options, ...)
//   GET  /iclock/getrequest?SN=..          poll for queued commands
//   POST /iclock/devicecmd?SN=..           results of executed commands
//   POST /iclock/querydata?SN=..           query results on newer (PUSH 3.x) firmware
//
// Rules that matter (see docs/zkteco-mb160.md):
// - Reply "OK: <lines>" only after the data is committed; on a DB error answer 500
//   so the device keeps the batch and resends it.
// - Punches are unique on (device, PIN, time), so resends never duplicate.
// ============================================

const crypto = require('crypto');
const zkPool = require('../config/zktecoDb');
const ZktecoModel = require('../models/zktecoModel');
const { emitZkChange } = require('./zktecoEvents');

// Record prefixes seen inside OPERLOG/USERINFO/BIODATA bodies, mapped to how we store them.
const RECORD_TYPES = {
	OPLOG: 'OPLOG',
	USER: 'USER',
	USERINFO: 'USER',
	FP: 'FP',
	FINGERTMP: 'FP',
	TEMPLATEV10: 'FP',
	FACE: 'FACE',
	BIODATA: 'BIODATA',
	USERPIC: 'USERPIC',
	BIOPHOTO: 'BIOPHOTO',
};

const STAMP_COLUMNS = {
	ATTLOG: 'ATTLOG_STAMP',
	OPERLOG: 'OPERLOG_STAMP',
	ATTPHOTO: 'ATTPHOTO_STAMP',
};

// Handshake options returned to the device on GET /iclock/cdata.
const HANDSHAKE = {
	ErrorDelay: 30, // seconds to wait before retrying after a failed request
	Delay: 10, // seconds between /iclock/getrequest polls
	TransTimes: '00:00;14:05', // scheduled full-upload times (Realtime=1 makes this mostly moot)
	TransInterval: 1, // minutes between batched uploads
	TransFlag: 'TransData AttLog\tOpLog\tAttPhoto\tEnrollUser\tChgUser\tEnrollFP\tChgFP\tFACE\tUserPic\tBioPhoto',
	Realtime: 1, // push each punch immediately
	Encrypt: 'None',
};

// OPLOG type for "user deleted on the device" (OBJ1 = PIN). Verified on the MB160
// (ZMM501-NF28VF-Ver3.0.2): each 103 event matched the device's user count dropping by one.
const OPLOG_USER_DELETED = 103;
// OPLOG type for "card removed from a user on the device" (OBJ1 = PIN). Verified on the MB160
// 2026-10-26: no USER line follows, and DATA QUERY USERINFO afterwards reported "Card=".
// (A card added on the device does send a USER line with Card=..., alongside OPLOG 8.)
const OPLOG_CARD_DELETED = 12;

// Soft delete of a user removed from the device (on the device, from the app, or missing from a
// full sync). The row stays (ACTIVE = 0) so past punches keep the name; a reused PIN gets a new
// row (unique key on ACTIVE_PIN). What the device erased is erased here too: password, card and
// the raw fields that hold them. Callers also delete that PIN's biometric templates. Append
// WHERE ...; the first parameter is EDITED_BY (the app user, or null for device-side changes).
const DEACTIVATE_USER_SQL = `UPDATE device_users
	SET ACTIVE = 0, PASSWORD = NULL, CARD_NO = NULL, FIELDS_JSON = NULL, EDITED_DT = NOW(), EDITED_BY = ?`;

// Queued the first time a device connects. A device that already uploaded to another
// server (e.g. zkteco_test, or before a DB move) ignores "Stamp=None" in the handshake
// and only sends new events, so its users and punch history must be requested.
// Both verified on the MB160: USERINFO returns every user with FP/FACE/USERPIC templates.
const INITIAL_SYNC_COMMANDS = [
	['Initial sync: users and biometrics', 'DATA QUERY USERINFO'],
	['Initial sync: punch history', 'DATA QUERY ATTLOG StartTime=2000-01-01 00:00:00\tEndTime=2099-12-31 23:59:59'],
];

// Privilege values for a user pushed from the app (see buildUserUpsertCommand).
const PRIVILEGE_USER = 0;
const PRIVILEGE_ADMIN = 14;

// Remote fingerprint enrollment (ENROLL_FP), verified on the MB160 (ZMM501-NF28VF-Ver3.0.2):
// the device shows its "place finger" prompt, uploads the FP template, then answers
// Return=0. Return=6 = nobody scanned within ~60 s; Return=4 = that finger is already
// enrolled for another user (the device refuses duplicates). Face cannot be started remotely on
// this firmware: ENROLL_FACE -> -1002 (unknown command), ENROLL_BIO TYPE=2 opens the
// fingerprint prompt instead. FID is the finger, 0-9 (see FINGER labels in the frontend).
const ENROLL_PICKUP_TIMEOUT_SECONDS = 120;
const ENROLL_RETRIES = 3;

// The device answers an enrollment either just before or just after uploading the new
// template (both seen). Wait this long before deciding the template is missing.
const TEMPLATE_GRACE_MS = 15000;
// Query results arrive as separate uploads around the Return; reconcile only after they settle.
const RECONCILE_DELAY_MS = 20000;
// A DATA UPDATE/DELETE the device took but never answered (e.g. it rebooted) is re-sent
// once after this long, then marked failed. Both are safe to repeat.
const UNANSWERED_RESEND_MINUTES = 5;
const RESENT_MARKER = 'No answer; re-sent';

const COMMANDS_PER_POLL = 10;
const RAW_BODY_MAX = 262144; // bytes of each body kept in raw_requests (XAMPP max_allowed_packet is 1M)
const ATTLOG_INSERT_CHUNK = 500;

const config = {
	allowedSerials: String(process.env.ZK_ALLOWED_SERIALS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean),
	defaultBranchId: Number(process.env.ZK_DEFAULT_BRANCH_ID) || null,
	rawLogDays: Number(process.env.ZK_RAW_LOG_DAYS || 14),
	// Hours between automatic full user/biometric syncs (keeps the app a mirror of the device:
	// fingerprints or users removed at the device disappear here too). 0 = off.
	resyncHours: Number(process.env.ZK_RESYNC_HOURS || 12),
	tzOffsetHours: zkPool.tzOffsetHours,
};

// ---- Parsing helpers (same rules as zkteco_test/src/helpers.php) ----

const splitLines = (body) => body.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');

/** "Key=Value\tKey2=Value2" -> ordered object, keeping the original keys. */
function parseKv(text, sep = '\t') {
	const out = {};
	for (const pair of text.split(sep)) {
		const pos = pair.indexOf('=');
		if (pos === -1) continue;
		out[pair.slice(0, pos).trim()] = pair.slice(pos + 1);
	}
	return out;
}

/** Case-insensitive lookup over several candidate keys; empty values count as missing. */
function kvGet(kv, ...keys) {
	const lower = {};
	for (const [k, v] of Object.entries(kv)) lower[k.toLowerCase()] = v;
	for (const key of keys) {
		const v = lower[key.toLowerCase()];
		if (v !== undefined && v !== '') return v;
	}
	return null;
}

/** Trimmed value, or null when empty ("0" is kept). */
const strOrNull = (s) => {
	const t = String(s ?? '').trim();
	return t === '' ? null : t;
};

const intOrNull = (s) => {
	const t = String(s ?? '').trim();
	return /^[-+]?\d+(\.\d+)?$/.test(t) ? parseInt(t, 10) : null;
};

/** "YYYY-MM-DD HH:MM:SS" (or the "T" variant) as wall-clock text; null when unparseable. */
function normalizeDatetime(s) {
	const m = String(s ?? '')
		.trim()
		.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
	if (!m) return null;
	const [, y, mo, d, h, mi, se = '0'] = m;
	if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +se > 59) return null;
	const p = (v) => String(v).padStart(2, '0');
	return `${y}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:${p(se)}`;
}

/** Device text may arrive in a legacy codepage depending on the device language. */
function decodeBody(buf) {
	if (!buf || buf.length === 0) return '';
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(buf);
	} catch {
		return new TextDecoder('windows-1252').decode(buf);
	}
}

const truncate = (s, max) => (s.length > max ? s.slice(0, max) : s);

/** Strips characters that would break the tab/newline-delimited command format. */
const cmdValue = (s) => String(s ?? '').replace(/[\t\r\n]/g, ' ').trim();

/** {Key: value} -> "Key=value\tKey2=value2" (the device's record format). */
const buildKv = (kv) =>
	Object.entries(kv)
		.map(([k, v]) => `${k}=${v}`)
		.join('\t');

// ---- Device bookkeeping ----

/** Registers/updates the device and returns { IDNo, BRANCH_ID, ACTIVE }. */
async function touchDevice(sn, ip) {
	// INSERT IGNORE reports affectedRows 1 only when the row is really new. (Don't use
	// INSERT ... ON DUPLICATE KEY UPDATE for this: mysql2 sets CLIENT_FOUND_ROWS, so an
	// unchanged existing row also reports 1, and the sync would be queued on every request.)
	const [inserted] = await zkPool.execute(
		'INSERT IGNORE INTO devices (SERIAL_NO, BRANCH_ID, IP_ADDRESS, LAST_SEEN_DT) VALUES (?, ?, ?, NOW())',
		[sn, config.defaultBranchId, ip || null]
	);
	if (inserted.affectedRows === 0) {
		await zkPool.execute('UPDATE devices SET IP_ADDRESS = ?, LAST_SEEN_DT = NOW() WHERE SERIAL_NO = ?', [
			ip || null,
			sn,
		]);
	}
	const [rows] = await zkPool.execute('SELECT IDNo, BRANCH_ID, ACTIVE FROM devices WHERE SERIAL_NO = ?', [sn]);
	const device = rows[0];

	if (inserted.affectedRows === 1) {
		for (const [label, command] of INITIAL_SYNC_COMMANDS) {
			await queueCommand(device.IDNo, label, command, null);
		}
		console.log(`[ADMS] new device ${sn} registered; queued initial user + punch sync`);
	}
	return device;
}

/**
 * Adds a command to the device's queue; it is delivered on the next poll (every Delay = 10 s).
 * `readdOfId`: for "Add again", the removed device_users row the add brings back.
 * `profileJson`: for Add employee, the profile details to apply once the device confirms.
 */
async function queueCommand(deviceId, label, command, encodedBy, { readdOfId = null, profileJson = null } = {}) {
	const [result] = await zkPool.execute(
		'INSERT INTO device_commands (DEVICE_ID, LABEL, COMMAND, READD_OF_ID, PROFILE_JSON, ENCODED_BY) VALUES (?, ?, ?, ?, ?, ?)',
		[deviceId, truncate(label, 120), command, readdOfId, profileJson, encodedBy ?? null]
	);
	return result.insertId;
}

/**
 * "DATA UPDATE USERINFO ..." for a user created in the app. Same fields zkteco_test used
 * (verified on the MB160). Values must already be validated; tabs/newlines are stripped here.
 * Card stays empty: cards are registered on the device by swiping them (no remote card
 * prompt on this firmware), and the device then reports the number in a USER line.
 */
function buildUserUpsertCommand({ pin, name, privilege, password }) {
	return `DATA UPDATE USERINFO ${buildKv({
		PIN: cmdValue(pin),
		Name: cmdValue(name),
		Pri: privilege === PRIVILEGE_ADMIN ? PRIVILEGE_ADMIN : PRIVILEGE_USER,
		Passwd: cmdValue(password),
		Card: '',
		Grp: 1,
		TZ: '0000000100000000',
		Verify: 0,
		ViceCard: '',
	})}`;
}

/**
 * "DATA UPDATE USERINFO ..." for editing an existing user. The device replaces the whole record,
 * so every field carries the user's current value (as last reported by the device) unless the
 * edit changes it; in particular Card and Passwd, which buildUserUpsertCommand leaves empty.
 * Fingerprints and faces are separate templates and aren't touched.
 */
function buildUserUpdateCommand({ pin, name, privilege, password, card, group, tz, verify }) {
	return `DATA UPDATE USERINFO ${buildKv({
		PIN: cmdValue(pin),
		Name: cmdValue(name),
		Pri: privilege === PRIVILEGE_ADMIN ? PRIVILEGE_ADMIN : PRIVILEGE_USER,
		Passwd: cmdValue(password),
		Card: cmdValue(card),
		Grp: cmdValue(group) || 1,
		TZ: cmdValue(tz) || '0000000100000000',
		Verify: cmdValue(verify) || 0,
		ViceCard: '',
	})}`;
}

/**
 * Opens the device's fingerprint-enrollment prompt for a user. The device refuses a finger
 * that is already enrolled for anyone, this user included (Return=4), so an enrolled finger
 * has to be removed first (buildFingerprintRemoveCommand).
 */
function buildFingerprintEnrollCommand({ pin, finger }) {
	return `ENROLL_FP ${buildKv({ PIN: cmdValue(pin), FID: finger, RETRY: ENROLL_RETRIES, OVERWRITE: 1 })}`;
}

/** Deletes one fingerprint from the device (verified on the MB160: Return=0). */
function buildFingerprintRemoveCommand({ pin, finger }) {
	return `DATA DELETE FINGERTMP ${buildKv({ PIN: cmdValue(pin), FID: finger })}`;
}

/** Runs fn after ms without blocking the device's request; errors are only logged. */
function later(ms, label, fn) {
	setTimeout(() => {
		fn().catch((err) => console.error(`[ADMS] ${label} failed:`, err.message || err));
	}, ms).unref();
}

async function handshake(device, sn, q) {
	await zkPool.execute(
		`UPDATE devices SET LAST_HANDSHAKE_DT = NOW(),
			PUSH_VERSION = COALESCE(?, PUSH_VERSION), LANGUAGE = COALESCE(?, LANGUAGE)
		 WHERE IDNo = ?`,
		[strOrNull(q.pushver), strOrNull(q.language), device.IDNo]
	);
	const [[dev]] = await zkPool.execute(
		'SELECT ATTLOG_STAMP, OPERLOG_STAMP, ATTPHOTO_STAMP FROM devices WHERE IDNo = ?',
		[device.IDNo]
	);

	// A stamp of None makes the device upload everything it has.
	const lines = [
		`GET OPTION FROM: ${sn}`,
		`ATTLOGStamp=${dev.ATTLOG_STAMP ?? 'None'}`,
		`OPERLOGStamp=${dev.OPERLOG_STAMP ?? 'None'}`,
		`ATTPHOTOStamp=${dev.ATTPHOTO_STAMP ?? 'None'}`,
	];
	for (const [key, value] of Object.entries(HANDSHAKE)) lines.push(`${key}=${value}`);
	lines.push(`TimeZone=${config.tzOffsetHours}`);
	lines.push('ServerVer=2.4.1');
	lines.push('PushProtVer=2.4.1');

	emitZkChange('device', device);
	return [200, `${lines.join('\n')}\n`];
}

/** Runs fn(conn) in a transaction; rethrows so the caller answers 500 and the device retries. */
async function inTransaction(fn) {
	const conn = await zkPool.getConnection();
	try {
		await conn.beginTransaction();
		const result = await fn(conn);
		await conn.commit();
		return result;
	} catch (err) {
		await conn.rollback().catch(() => {});
		throw err;
	} finally {
		conn.release();
	}
}

async function receiveData(device, q, body) {
	const table = String(q.table || '').toUpperCase();
	const stamp = q.Stamp ?? q.stamp ?? null;
	const lines = splitLines(body);
	const changes = new Set();

	const count = await inTransaction(async (conn) => {
		let n;
		if (table === 'ATTLOG') n = await saveAttLogs(conn, device, lines, changes);
		else if (table === 'ATTPHOTO') n = 1; // binary JPEG; kept in raw_requests only
		else if (table === 'OPTIONS') n = await saveOptions(conn, device, lines);
		else n = await saveRecords(conn, device, table, lines, changes);

		if (stamp !== null && STAMP_COLUMNS[table]) {
			await conn.execute(`UPDATE devices SET ${STAMP_COLUMNS[table]} = ? WHERE IDNo = ?`, [
				truncate(String(stamp), 32),
				device.IDNo,
			]);
		}
		return n;
	});

	// Only after commit, so open pages re-fetch data that is really there.
	for (const type of changes) emitZkChange(type, device);
	return [200, `OK: ${count}`];
}

// ATTLOG line: PIN \t Time \t Status \t Verify \t WorkCode \t Reserved...
async function saveAttLogs(conn, device, lines, changes) {
	const rows = [];
	for (const line of lines) {
		const f = line.split('\t');
		const pin = f[0].trim();
		const time = normalizeDatetime(f[1]);
		if (pin === '' || time === null) continue;
		rows.push([
			device.IDNo,
			device.BRANCH_ID,
			truncate(pin, 32),
			time,
			intOrNull(f[2]),
			intOrNull(f[3]),
			strOrNull(f[4]),
			truncate(line, 500),
		]);
	}
	for (let i = 0; i < rows.length; i += ATTLOG_INSERT_CHUNK) {
		const chunk = rows.slice(i, i + ATTLOG_INSERT_CHUNK);
		const [result] = await conn.query(
			`INSERT IGNORE INTO attendance_logs
				(DEVICE_ID, BRANCH_ID, PIN, PUNCH_DT, PUNCH_STATUS, VERIFY_TYPE, WORK_CODE, RAW_LINE)
			 VALUES ?`,
			[chunk]
		);
		// INSERT IGNORE: resent punches count 0, so only real new punches notify the pages.
		if (result.affectedRows > 0) changes.add('attendance');
	}
	// Acknowledge every line, including unparseable ones, so the device does not resend them forever.
	return lines.length;
}

async function saveRecords(conn, device, table, lines, changes) {
	for (const line of lines) {
		const [type, rest] = splitRecord(line, table);
		if (type === 'OPLOG') {
			if (await saveOpLog(conn, device, rest, line)) changes.add('users');
		} else if (type === 'USER') {
			await saveUser(conn, device, parseKv(rest), 'device');
			changes.add('users');
		} else if (type) {
			await saveTemplate(conn, device, type, parseKv(rest));
			changes.add('users');
		}
		// unknown record types stay visible in raw_requests
	}
	return lines.length;
}

// "USER PIN=1\tName=..." -> ['USER', 'PIN=1\tName=...']; un-prefixed lines take their type from the table name.
function splitRecord(line, table) {
	const m = line.match(/^([A-Za-z0-9_]+)[ \t]([\s\S]*)$/);
	if (m) {
		const type = RECORD_TYPES[m[1].toUpperCase()];
		if (type) return [type, m[2]];
	}
	return [RECORD_TYPES[table] ?? null, line];
}

// OPLOG line: OpType \t Operator \t Time \t Obj1 \t Obj2 \t Obj3 \t Obj4
// Returns true when the event changed device users (OPLOG_USER_DELETED, OPLOG_CARD_DELETED).
async function saveOpLog(conn, device, rest, line) {
	const f = rest.split('\t');
	const obj = (v) => {
		const s = strOrNull(v);
		return s === null ? null : truncate(s, 64);
	};
	const opType = intOrNull(f[0]);
	const opDt = normalizeDatetime(f[2]);
	const [result] = await conn.execute(
		`INSERT IGNORE INTO operation_logs
			(DEVICE_ID, OP_TYPE, OPERATOR, OP_DT, OBJ1, OBJ2, OBJ3, OBJ4, RAW_LINE, LINE_HASH)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			device.IDNo,
			opType,
			obj(f[1]),
			opDt,
			obj(f[3]),
			obj(f[4]),
			obj(f[5]),
			obj(f[6]),
			truncate(line, 500),
			crypto.createHash('sha1').update(line).digest('hex'),
		]
	);

	// The device sends no USER line when a user is deleted on it, only this OPLOG event.
	const pin = strOrNull(f[3]);
	if (result.affectedRows && opType === OPLOG_USER_DELETED && pin !== null && opDt !== null) {
		// Only rows last written before the delete: a history re-upload can replay an old
		// delete for a PIN that was enrolled again later.
		await conn.execute(
			`${DEACTIVATE_USER_SQL} WHERE DEVICE_ID = ? AND PIN = ? AND ACTIVE = 1 AND COALESCE(EDITED_DT, ENCODED_DT) <= ?`,
			[null, device.IDNo, pin, opDt]
		);
		await conn.execute(
			'DELETE FROM biometric_templates WHERE DEVICE_ID = ? AND PIN = ? AND COALESCE(EDITED_DT, ENCODED_DT) <= ?',
			[device.IDNo, pin, opDt]
		);
		return true;
	}
	// Same for a card removed on the device: no USER line, only this event.
	if (result.affectedRows && opType === OPLOG_CARD_DELETED && pin !== null && opDt !== null) {
		const [cleared] = await conn.execute(
			`UPDATE device_users SET CARD_NO = NULL, EDITED_DT = NOW()
			 WHERE DEVICE_ID = ? AND PIN = ? AND ACTIVE = 1 AND CARD_NO IS NOT NULL AND COALESCE(EDITED_DT, ENCODED_DT) <= ?`,
			[device.IDNo, pin, opDt]
		);
		return cleared.affectedRows > 0;
	}
	return false;
}

async function saveUser(conn, device, kv, source) {
	const pin = kvGet(kv, 'PIN');
	if (pin === null) return;

	// The duplicate key is (DEVICE_ID, ACTIVE_PIN): this updates the active user with the PIN,
	// or inserts a new row when the PIN is free or only held by removed users (a reused PIN is a
	// new person; removed rows are never reactivated).
	// SOURCE is not updated on duplicates: it keeps where the user was first created
	// (an app-created user who later enrolls a fingerprint on the device stays "server").
	// EDITED_DT moves only when a field really changes (assignments run left to right, so it
	// is compared before the new values are written); SYNCED_DT on every report.
	await conn.execute(
		`INSERT INTO device_users
			(DEVICE_ID, PIN, NAME, PRIVILEGE, PASSWORD, CARD_NO, GROUP_NO, USER_TZ, VERIFY_MODE, FIELDS_JSON, SOURCE, SYNCED_DT)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
		 ON DUPLICATE KEY UPDATE
			EDITED_DT = IF(NAME <=> VALUES(NAME) AND PRIVILEGE <=> VALUES(PRIVILEGE) AND PASSWORD <=> VALUES(PASSWORD)
				AND CARD_NO <=> VALUES(CARD_NO) AND GROUP_NO <=> VALUES(GROUP_NO), EDITED_DT, NOW()),
			NAME = VALUES(NAME), PRIVILEGE = VALUES(PRIVILEGE), PASSWORD = VALUES(PASSWORD),
			CARD_NO = VALUES(CARD_NO), GROUP_NO = VALUES(GROUP_NO), USER_TZ = VALUES(USER_TZ),
			VERIFY_MODE = VALUES(VERIFY_MODE), FIELDS_JSON = VALUES(FIELDS_JSON),
			SYNCED_DT = NOW()`,
		[
			device.IDNo,
			pin,
			kvGet(kv, 'Name'),
			intOrNull(kvGet(kv, 'Pri', 'privilege')),
			kvGet(kv, 'Passwd', 'password'),
			kvGet(kv, 'Card', 'cardno'),
			kvGet(kv, 'Grp', 'group'),
			kvGet(kv, 'TZ'),
			kvGet(kv, 'Verify'),
			JSON.stringify(kv),
			source,
		]
	);
}

async function saveTemplate(conn, device, kind, kv) {
	const pin = kvGet(kv, 'PIN');
	if (pin === null) return;

	const templateKey = Object.keys(kv).find((k) => ['tmp', 'content', 'template'].includes(k.toLowerCase())) ?? null;
	const template = templateKey !== null ? kv[templateKey] : null;
	const fields = { ...kv };
	if (templateKey !== null) delete fields[templateKey];

	let bioType = 0;
	if (kind === 'FP') bioType = 1;
	else if (kind === 'FACE') bioType = 2;
	else if (kind === 'BIODATA' || kind === 'BIOPHOTO') bioType = intOrNull(kvGet(kv, 'Type')) ?? 0;

	await conn.execute(
		`INSERT INTO biometric_templates
			(DEVICE_ID, PIN, TEMPLATE_KIND, BIO_TYPE, TEMPLATE_NO, TEMPLATE_INDEX, TEMPLATE_SIZE, VALID, TEMPLATE_KEY, TEMPLATE, FIELDS_JSON, SYNCED_DT)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
		 ON DUPLICATE KEY UPDATE
			EDITED_DT = IF(TEMPLATE <=> VALUES(TEMPLATE) AND VALID <=> VALUES(VALID), EDITED_DT, NOW()),
			TEMPLATE_SIZE = VALUES(TEMPLATE_SIZE), VALID = VALUES(VALID),
			TEMPLATE_KEY = VALUES(TEMPLATE_KEY), TEMPLATE = VALUES(TEMPLATE), FIELDS_JSON = VALUES(FIELDS_JSON),
			SYNCED_DT = NOW()`,
		[
			device.IDNo,
			pin,
			kind,
			bioType,
			intOrNull(kvGet(kv, 'FID', 'No', 'fingerid')) ?? 0,
			intOrNull(kvGet(kv, 'Index')) ?? 0,
			intOrNull(kvGet(kv, 'Size')),
			intOrNull(kvGet(kv, 'Valid')),
			templateKey,
			template,
			JSON.stringify(fields),
		]
	);
}

// "~DeviceName=MB160,MAC=..,FWVersion=.." (comma- or newline-separated) merged into OPTIONS_JSON.
async function saveOptions(conn, device, lines) {
	const incoming = {};
	for (const line of lines) {
		const kv = parseKv(line, line.includes(',') ? ',' : '\t');
		for (const [k, v] of Object.entries(kv)) {
			if (!(k in incoming)) incoming[k] = v;
		}
	}
	const [[row]] = await conn.execute('SELECT OPTIONS_JSON FROM devices WHERE IDNo = ?', [device.IDNo]);
	let current = {};
	try {
		current = JSON.parse(row?.OPTIONS_JSON || '{}') || {};
	} catch {
		current = {};
	}
	const merged = { ...current, ...incoming };
	const deviceName = strOrNull(kvGet(merged, '~DeviceName', 'DeviceName'));

	await conn.execute(
		'UPDATE devices SET OPTIONS_JSON = ?, DEVICE_NAME = COALESCE(DEVICE_NAME, ?) WHERE IDNo = ?',
		[JSON.stringify(merged), deviceName ? truncate(deviceName, 64) : null, device.IDNo]
	);
	return lines.length;
}

async function getRequest(device, q) {
	if (q.INFO) await saveInfo(device, String(q.INFO));

	// An enrollment nobody picked up in time must not pop up on the device later
	// (e.g. hours after it comes back online), so it expires instead.
	await zkPool.execute(
		`UPDATE device_commands SET STATUS = 'expired', COMPLETED_DT = NOW()
		 WHERE DEVICE_ID = ? AND STATUS = 'pending' AND COMMAND LIKE 'ENROLL\\_%'
		   AND ENCODED_DT < NOW() - INTERVAL ${ENROLL_PICKUP_TIMEOUT_SECONDS} SECOND`,
		[device.IDNo]
	);

	// DATA UPDATE/DELETE taken but never answered: re-send once, then give up. (Order matters:
	// give up on already re-sent ones first, so a command isn't re-sent twice in one poll.)
	const unanswered = `DEVICE_ID = ? AND STATUS = 'sent' AND (COMMAND LIKE 'DATA UPDATE %' OR COMMAND LIKE 'DATA DELETE %')
		AND SENT_DT < NOW() - INTERVAL ${UNANSWERED_RESEND_MINUTES} MINUTE`;
	await zkPool.execute(
		`UPDATE device_commands SET STATUS = 'failed', COMPLETED_DT = NOW(), PROFILE_JSON = NULL WHERE ${unanswered} AND RESULT = ?`,
		[device.IDNo, RESENT_MARKER]
	);
	await zkPool.execute(
		`UPDATE device_commands SET STATUS = 'pending', RESULT = ? WHERE ${unanswered} AND RESULT IS NULL`,
		[RESENT_MARKER, device.IDNo]
	);

	if (config.resyncHours > 0) {
		const [recent] = await zkPool.execute(
			`SELECT 1 FROM device_commands
			 WHERE DEVICE_ID = ? AND COMMAND = 'DATA QUERY USERINFO' AND ENCODED_DT >= NOW() - INTERVAL ? HOUR
			 LIMIT 1`,
			[device.IDNo, config.resyncHours]
		);
		if (recent.length === 0) {
			await queueCommand(device.IDNo, 'Scheduled sync: users and biometrics', 'DATA QUERY USERINFO', null);
		}
	}

	const [cmds] = await zkPool.query(
		`SELECT IDNo, COMMAND FROM device_commands
		 WHERE DEVICE_ID = ? AND STATUS = 'pending' ORDER BY IDNo LIMIT ${COMMANDS_PER_POLL}`,
		[device.IDNo]
	);
	if (cmds.length === 0) return [200, 'OK'];

	let out = '';
	for (const c of cmds) {
		await zkPool.execute(`UPDATE device_commands SET STATUS = 'sent', SENT_DT = NOW() WHERE IDNo = ?`, [c.IDNo]);
		out += `C:${c.IDNo}:${c.COMMAND}\n`;
	}
	return [200, out];
}

// INFO=FirmwareVer,UserCount,FPCount,AttCount,IP,FPAlgVer,FaceAlgVer,FaceTmpNeeded,FaceCount,FuncFlags
async function saveInfo(device, info) {
	const p = info.split(',');
	await zkPool.execute(
		`UPDATE devices SET INFO_RAW = ?, FIRMWARE = ?, USER_COUNT = ?, FP_COUNT = ?, ATT_COUNT = ?, FACE_COUNT = ?
		 WHERE IDNo = ?`,
		[
			truncate(info, 255),
			strOrNull(p[0]),
			intOrNull(p[1]),
			intOrNull(p[2]),
			intOrNull(p[3]),
			intOrNull(p[8]),
			device.IDNo,
		]
	);
}

// Body: "ID=12&Return=0&CMD=DATA" per command; INFO results are followed by key=value lines.
async function deviceCmd(device, body) {
	const results = [];
	for (const line of splitLines(body)) {
		if (/^ID=/i.test(line)) {
			const r = {};
			for (const [k, v] of new URLSearchParams(line)) r[k.toLowerCase()] = v;
			results.push({ id: parseInt(r.id, 10) || 0, ret: parseInt(r.return, 10) || 0, payload: [] });
		} else if (results.length > 0) {
			results[results.length - 1].payload.push(line);
		}
	}

	for (const r of results) {
		const [[cmd]] = await zkPool.execute(
			'SELECT COMMAND, ENCODED_BY, READD_OF_ID, PROFILE_JSON FROM device_commands WHERE IDNo = ? AND DEVICE_ID = ?',
			[r.id, device.IDNo]
		);
		if (!cmd) continue;
		const command = String(cmd.COMMAND);
		// Enrollment answers 0 only when a finger was actually enrolled; positive codes
		// such as 6 (nobody scanned in time) are failures too.
		const ok = command.startsWith('ENROLL_') ? r.ret === 0 : r.ret >= 0;
		// A failed add drops its profile details; a successful one moves them to the new user
		// (applyCommandResult), so they're kept until then.
		await zkPool.execute(
			`UPDATE device_commands SET STATUS = ?, RETURN_CODE = ?, RESULT = ?, COMPLETED_DT = NOW()${ok ? '' : ', PROFILE_JSON = NULL'}
			 WHERE IDNo = ? AND DEVICE_ID = ?`,
			[ok ? 'done' : 'failed', r.ret, r.payload.length ? r.payload.join('\n') : null, r.id, device.IDNo]
		);
		const extra = { commandId: r.id, readdOfId: cmd.READD_OF_ID, profileJson: cmd.PROFILE_JSON };
		if (ok && (await applyCommandResult(device, command, r.payload, cmd.ENCODED_BY, extra))) {
			emitZkChange('users', device);
		}
		if (ok && command.startsWith('ENROLL_FP ')) {
			later(TEMPLATE_GRACE_MS, 'enrollment template check', () => ensureEnrolledTemplate(device, r.id, command));
		}
		if (ok && /^DATA QUERY USERINFO( |$)/.test(command)) {
			later(RECONCILE_DELAY_MS, 'user reconcile', () => reconcileAfterUserQuery(device, r.id, command));
		}
	}
	if (results.length) emitZkChange('commands', device);
	return [200, 'OK'];
}

// After ENROLL_FP succeeds the MB160 uploads the new fingerprint (FP line), just before or
// just after its answer. If it still hasn't arrived after TEMPLATE_GRACE_MS, ask the device
// for that user (DATA QUERY USERINFO PIN=x returns the user and its templates).
async function ensureEnrolledTemplate(device, commandId, command) {
	const kv = parseKv(command.slice('ENROLL_FP '.length));
	const [rows] = await zkPool.execute(
		`SELECT 1 FROM biometric_templates t
		 JOIN device_commands c ON c.IDNo = ?
		 WHERE t.DEVICE_ID = ? AND t.PIN = ? AND t.TEMPLATE_KIND = 'FP' AND t.TEMPLATE_NO = ?
		   AND COALESCE(t.EDITED_DT, t.ENCODED_DT) >= c.SENT_DT
		 LIMIT 1`,
		[commandId, device.IDNo, kvGet(kv, 'PIN'), intOrNull(kvGet(kv, 'FID')) ?? 0]
	);
	if (rows.length === 0) {
		const pin = cmdValue(kvGet(kv, 'PIN'));
		await queueCommand(device.IDNo, `Fetch templates after enrollment ${commandId}`, `DATA QUERY USERINFO PIN=${pin}`, null);
	}
}

/**
 * A successful DATA QUERY USERINFO (all users, or PIN=x) reports everything the device has.
 * Users/templates in that scope the device did not report since the query was sent no longer
 * exist on it (e.g. a fingerprint deleted at the device), so they are removed here too.
 */
async function reconcileAfterUserQuery(device, commandId, command) {
	const pin = kvGet(parseKv(command.slice('DATA QUERY USERINFO'.length).trim()), 'PIN');
	const [[cmd]] = await zkPool.execute('SELECT SENT_DT FROM device_commands WHERE IDNo = ?', [commandId]);
	if (!cmd?.SENT_DT) return;

	const scope = `DEVICE_ID = ? AND (SYNCED_DT IS NULL OR SYNCED_DT < ?)${pin ? ' AND PIN = ?' : ''}`;
	const params = pin ? [device.IDNo, cmd.SENT_DT, pin] : [device.IDNo, cmd.SENT_DT];
	const [users] = await zkPool.execute(`${DEACTIVATE_USER_SQL} WHERE ACTIVE = 1 AND ${scope}`, [null, ...params]);
	const [templates] = await zkPool.execute(`DELETE FROM biometric_templates WHERE ${scope}`, params);
	if (users.affectedRows || templates.affectedRows) {
		console.log(
			`[ADMS] sync: deactivated ${users.affectedRows} user(s) and removed ${templates.affectedRows} template(s) no longer on device ${device.IDNo}`
		);
		emitZkChange('users', device);
	}
}

// Mirrors successful server-initiated changes into our tables (the device does not echo them back).
// Returns true when device users changed. `encodedBy` is the app user who queued the command;
// `readdOfId` the removed row an "Add again" brings back; `profileJson` the Add employee details,
// moved onto the new user (and off the command `commandId`) in the same transaction.
async function applyCommandResult(device, command, payload, encodedBy = null, { commandId = null, readdOfId = null, profileJson = null } = {}) {
	if (command.startsWith('DATA UPDATE USERINFO ')) {
		const kv = parseKv(command.slice(21));
		await inTransaction(async (conn) => {
			await saveUser(conn, device, kv, 'server');
			if (profileJson) {
				await conn.execute('UPDATE device_users SET PENDING_PROFILE_JSON = ? WHERE DEVICE_ID = ? AND ACTIVE_PIN = ?', [
					profileJson,
					device.IDNo,
					kvGet(kv, 'PIN'),
				]);
				if (commandId) await conn.execute('UPDATE device_commands SET PROFILE_JSON = NULL WHERE IDNo = ?', [commandId]);
			}
			if (readdOfId) {
				// The removed row, and any earlier rows already pointing at it, now point at the new
				// row, so READDED_AS_ID always names the person's latest row (Show deleted hides them).
				await conn.execute(
					`UPDATE device_users p
					 JOIN device_users n ON n.DEVICE_ID = p.DEVICE_ID AND n.ACTIVE_PIN = ?
					 SET p.READDED_AS_ID = n.IDNo
					 WHERE p.DEVICE_ID = ? AND p.ACTIVE = 0 AND (p.IDNo = ? OR p.READDED_AS_ID = ?)`,
					[kvGet(kv, 'PIN'), device.IDNo, readdOfId, readdOfId]
				);
			}
		});
		return true;
	}
	if (command.startsWith('DATA DELETE USERINFO ')) {
		const pin = kvGet(parseKv(command.slice(21)), 'PIN');
		await zkPool.execute(`${DEACTIVATE_USER_SQL} WHERE DEVICE_ID = ? AND PIN = ? AND ACTIVE = 1`, [
			encodedBy ?? null,
			device.IDNo,
			pin,
		]);
		await zkPool.execute('DELETE FROM biometric_templates WHERE DEVICE_ID = ? AND PIN = ?', [device.IDNo, pin]);
		return true;
	}
	if (command.startsWith('DATA DELETE FINGERTMP ')) {
		const kv = parseKv(command.slice('DATA DELETE FINGERTMP '.length));
		await zkPool.execute(
			`DELETE FROM biometric_templates
			 WHERE DEVICE_ID = ? AND PIN = ? AND TEMPLATE_NO = ?
			   AND (TEMPLATE_KIND = 'FP' OR (TEMPLATE_KIND = 'BIODATA' AND BIO_TYPE = 1))`,
			[device.IDNo, kvGet(kv, 'PIN'), intOrNull(kvGet(kv, 'FID')) ?? 0]
		);
		return true;
	}
	if (command === 'INFO' && payload.length) {
		await saveOptions(zkPool, device, payload);
	}
	return false;
}

// PUSH 3.x firmware answers DATA QUERY here instead of /iclock/cdata.
async function queryData(device, q, body) {
	const table = String(q.tablename || q.table || '').toUpperCase();
	const lines = splitLines(body);
	const changes = new Set();
	const count = await inTransaction((conn) =>
		table === 'ATTLOG' || table === 'TRANSACTION'
			? saveAttLogs(conn, device, lines, changes)
			: saveRecords(conn, device, table, lines, changes)
	);
	for (const type of changes) emitZkChange(type, device);
	return [200, `OK: ${count}`];
}

/**
 * Entry point for /iclock/<endpoint>.
 * @returns {Promise<[number, string]>} HTTP status and plain-text body
 */
// One warning per unknown serial per process, so a device retrying every few seconds doesn't flood the log.
const warnedSerials = new Set();
function warnUnlisted(sn) {
	if (warnedSerials.has(sn) || warnedSerials.size > 100) return;
	warnedSerials.add(sn);
	console.warn(`[ADMS] refused unknown device ${sn}: add it to ZK_ALLOWED_SERIALS to register it`);
}

async function dispatch(method, endpoint, query, body, remoteIp) {
	const sn = String(query.SN ?? query.sn ?? '').trim();
	if (sn === '' || sn.length > 32) return [400, 'ERROR: missing SN'];
	if (config.allowedSerials.length && !config.allowedSerials.includes(sn)) {
		// Not "OK": an unknown device keeps its data and retries later.
		return [403, 'ERROR: unknown device'];
	}

	await ZktecoModel.ensureSchema();
	// The serial number is the only identity a device has (it can't log in), so a new device is
	// registered only when ZK_ALLOWED_SERIALS lists it. With the list empty, devices registered
	// before keep working but nobody can register a new one (e.g. a fake device that would land
	// in ZK_DEFAULT_BRANCH_ID and push made-up punches).
	if (!config.allowedSerials.length) {
		const [known] = await zkPool.execute('SELECT 1 FROM devices WHERE SERIAL_NO = ? LIMIT 1', [sn]);
		if (known.length === 0) {
			warnUnlisted(sn);
			return [403, 'ERROR: unknown device'];
		}
	}
	const device = await touchDevice(sn, remoteIp);
	if (!Number(device.ACTIVE)) return [403, 'ERROR: device disabled'];

	switch (endpoint) {
		case 'cdata':
			return method === 'POST' ? receiveData(device, query, body) : handshake(device, sn, query);
		case 'getrequest':
			return getRequest(device, query);
		case 'devicecmd':
			return deviceCmd(device, body);
		case 'querydata':
			return queryData(device, query, body);
		default:
			return [200, 'OK']; // ping, registry, push, etc.
	}
}

async function logRequest({ sn, method, path, qs, remoteIp, headers, rawBody, response, status, durationMs }) {
	if (config.rawLogDays <= 0) return;
	// Refused requests (unknown device, blocked IP, bad request) keep only the body's length, so
	// anyone on the internet can't fill the log with large bodies.
	const bodyLength = rawBody.length;
	const kept = status >= 400 && status < 500 ? Buffer.alloc(0) : rawBody.subarray(0, RAW_BODY_MAX);
	await zkPool.execute(
		`INSERT INTO raw_requests
			(SERIAL_NO, METHOD, PATH, QUERY_STRING, REMOTE_IP, HEADERS, BODY, BODY_LENGTH, RESPONSE, STATUS_CODE, DURATION_MS)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			sn ? truncate(sn, 32) : null,
			method,
			truncate(path, 255),
			qs,
			remoteIp || null,
			JSON.stringify(headers),
			kept,
			bodyLength,
			response,
			status,
			durationMs,
		]
	);
}

async function pruneRawRequests() {
	if (config.rawLogDays <= 0) return;
	await ZktecoModel.ensureSchema();
	await zkPool.execute('DELETE FROM raw_requests WHERE CREATED_DT < NOW() - INTERVAL ? DAY', [config.rawLogDays]);
}

module.exports = {
	dispatch,
	queueCommand,
	buildUserUpsertCommand,
	buildUserUpdateCommand,
	buildFingerprintEnrollCommand,
	buildFingerprintRemoveCommand,
	ENROLL_PICKUP_TIMEOUT_SECONDS,
	PRIVILEGE_USER,
	PRIVILEGE_ADMIN,
	logRequest,
	pruneRawRequests,
	decodeBody,
};
