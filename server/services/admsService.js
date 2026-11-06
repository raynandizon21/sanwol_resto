// ============================================
// ADMS SERVICE (ZKTeco PUSH protocol)
// ============================================
// File: services/admsService.js
// Description: Handles requests from ZKTeco devices (MB160). Ported from
// zkteco_test/src/Adms.php; keep the two in step when the protocol handling changes. The storage
// differs since 2026-11-05: device users are `employee` rows (ZK_ columns), punches carry their
// EMPLOYEE_ID, operation logs and biometric payloads aren't stored (see docs/zkteco-mb160.md).
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
const EmployeeModel = require('../models/employeeModel');
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
// Other OPLOG events (menu access, enrollments...) are acknowledged but not stored; they stay in
// zk_raw_requests for ZK_RAW_LOG_DAYS.

// Takes a person off the device (on the device, from the app, or missing from a full sync). Their
// employee row stays, so past punches keep the name; "Add again" puts the same row back. Callers
// also delete that PIN's biometric templates. Append WHERE ...; first parameter = ZK_REMOVED_BY.
const REMOVE_SQL = ZktecoModel.REMOVE_FROM_DEVICE_SQL;

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
const RAW_BODY_MAX = 262144; // bytes of each body kept in zk_raw_requests (XAMPP max_allowed_packet is 1M)
const ATTLOG_INSERT_CHUNK = 500;

// Fields of a device record (USER / FP / FACE / BIODATA / USERPIC / BIOPHOTO line) that hold
// biometric data or a photo. Never stored: only a hash in zk_biometric_templates, and the value is
// blanked in zk_raw_requests.
const PAYLOAD_KEYS = ['tmp', 'content', 'template'];

const config = {
	allowedSerials: String(process.env.ZK_ALLOWED_SERIALS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean),
	defaultBranchId: Number(process.env.ZK_DEFAULT_BRANCH_ID) || null,
	rawLogDays: Number(process.env.ZK_RAW_LOG_DAYS || 14),
	// Days finished device commands are kept (the queue is only needed until they're answered).
	commandLogDays: Number(process.env.ZK_COMMAND_LOG_DAYS || 30),
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
		'INSERT IGNORE INTO zk_devices (SERIAL_NO, BRANCH_ID, IP_ADDRESS, LAST_SEEN_DT) VALUES (?, ?, ?, NOW())',
		[sn, config.defaultBranchId, ip || null]
	);
	if (inserted.affectedRows === 0) {
		await zkPool.execute('UPDATE zk_devices SET IP_ADDRESS = ?, LAST_SEEN_DT = NOW() WHERE SERIAL_NO = ?', [
			ip || null,
			sn,
		]);
	}
	const [rows] = await zkPool.execute('SELECT IDNo, BRANCH_ID, ACTIVE FROM zk_devices WHERE SERIAL_NO = ?', [sn]);
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
 * `employeeId`: for "Add again", the removed employee the add puts back on the device.
 * `profileJson`: for Add employee, the profile details to apply once the device confirms.
 */
async function queueCommand(deviceId, label, command, encodedBy, { employeeId = null, profileJson = null } = {}) {
	const [result] = await zkPool.execute(
		'INSERT INTO zk_device_commands (DEVICE_ID, LABEL, COMMAND, EMPLOYEE_ID, PROFILE_JSON, ENCODED_BY) VALUES (?, ?, ?, ?, ?, ?)',
		[deviceId, truncate(label, 120), command, employeeId, profileJson, encodedBy ?? null]
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
		`UPDATE zk_devices SET LAST_HANDSHAKE_DT = NOW(),
			PUSH_VERSION = COALESCE(?, PUSH_VERSION), LANGUAGE = COALESCE(?, LANGUAGE)
		 WHERE IDNo = ?`,
		[strOrNull(q.pushver), strOrNull(q.language), device.IDNo]
	);
	const [[dev]] = await zkPool.execute(
		'SELECT ATTLOG_STAMP, OPERLOG_STAMP, ATTPHOTO_STAMP FROM zk_devices WHERE IDNo = ?',
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
		else if (table === 'ATTPHOTO') n = 1; // binary JPEG; kept in zk_raw_requests only
		else if (table === 'OPTIONS') n = await saveOptions(conn, device, lines);
		else n = await saveRecords(conn, device, table, lines, changes);

		if (stamp !== null && STAMP_COLUMNS[table]) {
			await conn.execute(`UPDATE zk_devices SET ${STAMP_COLUMNS[table]} = ? WHERE IDNo = ?`, [
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

/**
 * Whose punch this is: the employee who had `pin` on the device at `time`. A User ID can be
 * reused after someone is removed, so it's the person put on the device most recently at or
 * before the punch; punches older than everyone (history uploaded on first connect) go to the
 * earliest. `candidates` are that PIN's employees (on the device or removed), oldest first.
 */
function punchOwner(candidates, time) {
	if (!candidates || candidates.length === 0) return null;
	let owner = null;
	for (const c of candidates) {
		if (c.ZK_ADDED_DT != null && c.ZK_ADDED_DT <= time) owner = c;
	}
	return Number((owner || candidates[0]).IDNo);
}

// ATTLOG line: PIN \t Time \t Status \t Verify \t WorkCode \t Reserved...
async function saveAttLogs(conn, device, lines, changes) {
	const parsed = [];
	for (const line of lines) {
		const f = line.split('\t');
		const pin = truncate(f[0].trim(), 32);
		const time = normalizeDatetime(f[1]);
		if (pin === '' || time === null) continue;
		parsed.push({ pin, time, f, line });
	}
	// Each punch is tied to its employee when it arrives (EMPLOYEE_ID); a User ID nobody has yet
	// stays NULL until that user shows up (saveUser).
	const pins = [...new Set(parsed.map((p) => p.pin))];
	const byPin = new Map();
	if (pins.length) {
		const [people] = await conn.query(
			`SELECT IDNo, ZK_PIN, ZK_ADDED_DT FROM employee
			 WHERE ZK_DEVICE_ID = ? AND ZK_PIN IN (?)
			 ORDER BY ZK_ADDED_DT, IDNo`,
			[device.IDNo, pins]
		);
		for (const p of people) {
			if (!byPin.has(p.ZK_PIN)) byPin.set(p.ZK_PIN, []);
			byPin.get(p.ZK_PIN).push(p);
		}
	}
	const rows = parsed.map(({ pin, time, f, line }) => [
		'device',
		punchOwner(byPin.get(pin), time),
		device.BRANCH_ID,
		device.IDNo,
		pin,
		time,
		intOrNull(f[2]),
		intOrNull(f[3]),
		strOrNull(f[4]),
		truncate(line, 500),
	]);
	for (let i = 0; i < rows.length; i += ATTLOG_INSERT_CHUNK) {
		const chunk = rows.slice(i, i + ATTLOG_INSERT_CHUNK);
		const [result] = await conn.query(
			`INSERT IGNORE INTO zk_attendance_logs
				(SOURCE, EMPLOYEE_ID, BRANCH_ID, DEVICE_ID, PIN, PUNCH_DT, PUNCH_STATUS, VERIFY_TYPE, WORK_CODE, RAW_LINE)
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
			if (await saveOpLog(conn, device, rest)) changes.add('users');
		} else if (type === 'USER') {
			await saveUser(conn, device, parseKv(rest), 'device');
			changes.add('users');
		} else if (type) {
			await saveTemplate(conn, device, type, parseKv(rest));
			changes.add('users');
		}
		// unknown record types stay visible in zk_raw_requests
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
// Acts on the two events the device sends instead of a USER line; returns true when that changed
// someone. Resent or replayed events are harmless: only rows last written before the event are
// touched (a history re-upload can replay an old delete for a User ID enrolled again later).
async function saveOpLog(conn, device, rest) {
	const f = rest.split('\t');
	const opType = intOrNull(f[0]);
	const opDt = normalizeDatetime(f[2]);
	const pin = strOrNull(f[3]);
	if (pin === null || opDt === null) return false;

	if (opType === OPLOG_USER_DELETED) {
		const [users] = await conn.execute(
			`${REMOVE_SQL} WHERE ZK_DEVICE_ID = ? AND ZK_PIN = ? AND ZK_ON_DEVICE = 1 AND COALESCE(ZK_EDITED_DT, ZK_ADDED_DT) <= ?`,
			[null, device.IDNo, pin, opDt]
		);
		const [templates] = await conn.execute(
			'DELETE FROM zk_biometric_templates WHERE DEVICE_ID = ? AND PIN = ? AND COALESCE(EDITED_DT, ENCODED_DT) <= ?',
			[device.IDNo, pin, opDt]
		);
		return users.affectedRows > 0 || templates.affectedRows > 0;
	}
	if (opType === OPLOG_CARD_DELETED) {
		const [cleared] = await conn.execute(
			`UPDATE employee SET ZK_CARD_NO = NULL, ZK_EDITED_DT = NOW()
			 WHERE ZK_DEVICE_ID = ? AND ZK_PIN = ? AND ZK_ON_DEVICE = 1 AND ZK_CARD_NO IS NOT NULL
			   AND COALESCE(ZK_EDITED_DT, ZK_ADDED_DT) <= ?`,
			[device.IDNo, pin, opDt]
		);
		return cleared.affectedRows > 0;
	}
	return false;
}

/** { fields, userId } from a command's PROFILE_JSON, or null when missing or unreadable. */
function readProfileJson(json) {
	if (!json) return null;
	try {
		const data = JSON.parse(json);
		if (!data || typeof data.fields !== 'object' || data.fields === null) return null;
		const fields = Object.fromEntries(
			Object.entries(data.fields).filter(([key]) => EmployeeModel.PROFILE_EDITABLE.includes(key))
		);
		return { fields, userId: data.userId ?? null };
	} catch {
		return null;
	}
}

/**
 * A USER record (reported by the device, or confirmed after the app sent it). The person holding
 * the PIN is updated; otherwise the PIN gets a person: `employeeId` for "Add again", else a new
 * employee row (profile from Add employee's `profile`, or named as on the device). A reused PIN
 * is a new person; someone removed is only put back through "Add again".
 * ZK_SOURCE keeps where they were first put on the device. ZK_EDITED_DT moves only when a field
 * really changes; ZK_SYNCED_DT on every report. Returns the employee's IDNo.
 */
async function saveUser(conn, device, kv, source, { employeeId = null, profile = null, encodedBy = null } = {}) {
	const pin = kvGet(kv, 'PIN');
	if (pin === null) return null;
	const v = {
		name: kvGet(kv, 'Name'),
		privilege: intOrNull(kvGet(kv, 'Pri', 'privilege')),
		password: kvGet(kv, 'Passwd', 'password'),
		card: kvGet(kv, 'Card', 'cardno'),
		group: kvGet(kv, 'Grp', 'group'),
		tz: kvGet(kv, 'TZ'),
		verify: kvGet(kv, 'Verify'),
	};
	const deviceValues = [v.name, v.privilege, v.password, v.card, v.group, v.tz, v.verify];

	const [[holder]] = await conn.execute('SELECT IDNo FROM employee WHERE ZK_DEVICE_ID = ? AND ZK_ACTIVE_PIN = ? FOR UPDATE', [
		device.IDNo,
		pin,
	]);
	if (holder) {
		// Assignments run left to right, so ZK_EDITED_DT compares the old values first.
		await conn.execute(
			`UPDATE employee SET
				ZK_EDITED_DT = IF(ZK_NAME <=> ? AND ZK_PRIVILEGE <=> ? AND ZK_PASSWORD <=> ? AND ZK_CARD_NO <=> ? AND ZK_GROUP_NO <=> ?,
					ZK_EDITED_DT, NOW()),
				ZK_NAME = ?, ZK_PRIVILEGE = ?, ZK_PASSWORD = ?, ZK_CARD_NO = ?, ZK_GROUP_NO = ?, ZK_USER_TZ = ?, ZK_VERIFY_MODE = ?,
				ZK_SYNCED_DT = NOW()
			 WHERE IDNo = ?`,
			[v.name, v.privilege, v.password, v.card, v.group, ...deviceValues, holder.IDNo]
		);
		await linkTemplates(conn, device, pin, holder.IDNo);
		return Number(holder.IDNo);
	}

	const fields = profile?.fields || {};
	const profileBy = profile?.userId ?? encodedBy ?? null;
	let id = null;
	if (employeeId) {
		// Add again: the same person (profile, past punches) is back on the device. ZK_EDITED_DT is
		// cleared so an old OPLOG delete replayed later can't take them off again.
		const [result] = await conn.execute(
			`UPDATE employee SET ZK_DEVICE_ID = ?, ZK_PIN = ?, ZK_ON_DEVICE = 1,
				ZK_NAME = ?, ZK_PRIVILEGE = ?, ZK_PASSWORD = ?, ZK_CARD_NO = ?, ZK_GROUP_NO = ?, ZK_USER_TZ = ?, ZK_VERIFY_MODE = ?,
				ZK_SOURCE = ?, ZK_ADDED_DT = NOW(), ZK_EDITED_DT = NULL, ZK_REMOVED_BY = NULL, ZK_SYNCED_DT = NOW()
			 WHERE IDNo = ? AND ACTIVE = 1 AND ZK_ON_DEVICE = 0`,
			[device.IDNo, pin, ...deviceValues, source, employeeId]
		);
		if (result.affectedRows) {
			id = Number(employeeId);
			const entries = Object.entries(fields);
			if (entries.length) {
				await conn.execute(
					`UPDATE employee SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, EDITED_BY = ?, EDITED_DT = NOW() WHERE IDNo = ?`,
					[...entries.map(([, value]) => value), profileBy, id]
				);
			}
		}
	}
	if (!id) {
		const data = new Map(Object.entries(fields));
		if (!String(data.get('FIRSTNAME') ?? '').trim()) data.set('FIRSTNAME', String(v.name || '').trim() || `User ${pin}`);
		const columns = [...data.keys()];
		const [result] = await conn.execute(
			`INSERT INTO employee (BRANCH_ID, ${columns.join(', ')}, STATUS, ACTIVE, ENCODED_BY, ENCODED_DT,
				ZK_DEVICE_ID, ZK_PIN, ZK_ON_DEVICE, ZK_NAME, ZK_PRIVILEGE, ZK_PASSWORD, ZK_CARD_NO, ZK_GROUP_NO, ZK_USER_TZ,
				ZK_VERIFY_MODE, ZK_SOURCE, ZK_ADDED_DT, ZK_SYNCED_DT)
			 VALUES (?, ${columns.map(() => '?').join(', ')}, 1, 1, ?, NOW(), ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
			[device.BRANCH_ID ?? null, ...data.values(), profileBy, device.IDNo, pin, ...deviceValues, source]
		);
		id = Number(result.insertId);
	}
	// Punches of this User ID that arrived before them (history uploads, or a punch sent before
	// the USER line) become theirs.
	await conn.execute('UPDATE zk_attendance_logs SET EMPLOYEE_ID = ? WHERE DEVICE_ID = ? AND PIN = ? AND EMPLOYEE_ID IS NULL', [
		id,
		device.IDNo,
		pin,
	]);
	await linkTemplates(conn, device, pin, id);
	return id;
}

/**
 * Makes `employeeId` the owner of every template of this User ID (zk_biometric_templates.EMPLOYEE_ID).
 * Templates are deleted whenever someone is taken off the device, so whatever is left under the
 * PIN belongs to whoever has it now; this covers templates sent before their USER line.
 */
async function linkTemplates(conn, device, pin, employeeId) {
	await conn.execute(
		'UPDATE zk_biometric_templates SET EMPLOYEE_ID = ? WHERE DEVICE_ID = ? AND PIN = ? AND NOT (EMPLOYEE_ID <=> ?)',
		[employeeId, device.IDNo, pin, employeeId]
	);
}

/**
 * Only which biometrics a user has is kept; the payload is reduced to a hash. EMPLOYEE_ID is the
 * person who has the User ID on the device; if nobody has it yet, saveUser fills it in later.
 */
async function saveTemplate(conn, device, kind, kv) {
	const pin = kvGet(kv, 'PIN');
	if (pin === null) return;

	const payloadKey = Object.keys(kv).find((k) => PAYLOAD_KEYS.includes(k.toLowerCase())) ?? null;
	const payload = payloadKey !== null ? kv[payloadKey] : null;
	const hash = payload ? crypto.createHash('sha1').update(payload).digest('hex') : null;

	let bioType = 0;
	if (kind === 'FP') bioType = 1;
	else if (kind === 'FACE') bioType = 2;
	else if (kind === 'BIODATA' || kind === 'BIOPHOTO') bioType = intOrNull(kvGet(kv, 'Type')) ?? 0;

	await conn.execute(
		`INSERT INTO zk_biometric_templates
			(EMPLOYEE_ID, DEVICE_ID, PIN, TEMPLATE_KIND, BIO_TYPE, TEMPLATE_NO, TEMPLATE_INDEX, TEMPLATE_SIZE, VALID, TEMPLATE_HASH, SYNCED_DT)
		 VALUES ((SELECT e.IDNo FROM employee e WHERE e.ZK_DEVICE_ID = ? AND e.ZK_ACTIVE_PIN = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
		 ON DUPLICATE KEY UPDATE
			EDITED_DT = IF(TEMPLATE_HASH <=> VALUES(TEMPLATE_HASH) AND VALID <=> VALUES(VALID), EDITED_DT, NOW()),
			TEMPLATE_SIZE = VALUES(TEMPLATE_SIZE), VALID = VALUES(VALID), TEMPLATE_HASH = VALUES(TEMPLATE_HASH),
			EMPLOYEE_ID = COALESCE(VALUES(EMPLOYEE_ID), EMPLOYEE_ID),
			SYNCED_DT = NOW()`,
		[
			device.IDNo,
			pin,
			device.IDNo,
			pin,
			kind,
			bioType,
			intOrNull(kvGet(kv, 'FID', 'No', 'fingerid')) ?? 0,
			intOrNull(kvGet(kv, 'Index')) ?? 0,
			intOrNull(kvGet(kv, 'Size')),
			intOrNull(kvGet(kv, 'Valid')),
			hash,
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
	const [[row]] = await conn.execute('SELECT OPTIONS_JSON FROM zk_devices WHERE IDNo = ?', [device.IDNo]);
	let current = {};
	try {
		current = JSON.parse(row?.OPTIONS_JSON || '{}') || {};
	} catch {
		current = {};
	}
	const merged = { ...current, ...incoming };
	const deviceName = strOrNull(kvGet(merged, '~DeviceName', 'DeviceName'));

	await conn.execute(
		'UPDATE zk_devices SET OPTIONS_JSON = ?, DEVICE_NAME = COALESCE(DEVICE_NAME, ?) WHERE IDNo = ?',
		[JSON.stringify(merged), deviceName ? truncate(deviceName, 64) : null, device.IDNo]
	);
	return lines.length;
}

async function getRequest(device, q) {
	if (q.INFO) await saveInfo(device, String(q.INFO));

	// An enrollment nobody picked up in time must not pop up on the device later
	// (e.g. hours after it comes back online), so it expires instead.
	await zkPool.execute(
		`UPDATE zk_device_commands SET STATUS = 'expired', COMPLETED_DT = NOW()
		 WHERE DEVICE_ID = ? AND STATUS = 'pending' AND COMMAND LIKE 'ENROLL\\_%'
		   AND ENCODED_DT < NOW() - INTERVAL ${ENROLL_PICKUP_TIMEOUT_SECONDS} SECOND`,
		[device.IDNo]
	);

	// DATA UPDATE/DELETE taken but never answered: re-send once, then give up. (Order matters:
	// give up on already re-sent ones first, so a command isn't re-sent twice in one poll.)
	const unanswered = `DEVICE_ID = ? AND STATUS = 'sent' AND (COMMAND LIKE 'DATA UPDATE %' OR COMMAND LIKE 'DATA DELETE %')
		AND SENT_DT < NOW() - INTERVAL ${UNANSWERED_RESEND_MINUTES} MINUTE`;
	await zkPool.execute(
		`UPDATE zk_device_commands SET STATUS = 'failed', COMPLETED_DT = NOW(), PROFILE_JSON = NULL WHERE ${unanswered} AND RESULT = ?`,
		[device.IDNo, RESENT_MARKER]
	);
	await zkPool.execute(
		`UPDATE zk_device_commands SET STATUS = 'pending', RESULT = ? WHERE ${unanswered} AND RESULT IS NULL`,
		[RESENT_MARKER, device.IDNo]
	);

	if (config.resyncHours > 0) {
		const [recent] = await zkPool.execute(
			`SELECT 1 FROM zk_device_commands
			 WHERE DEVICE_ID = ? AND COMMAND = 'DATA QUERY USERINFO' AND ENCODED_DT >= NOW() - INTERVAL ? HOUR
			 LIMIT 1`,
			[device.IDNo, config.resyncHours]
		);
		if (recent.length === 0) {
			await queueCommand(device.IDNo, 'Scheduled sync: users and biometrics', 'DATA QUERY USERINFO', null);
		}
	}

	const [cmds] = await zkPool.query(
		`SELECT IDNo, COMMAND FROM zk_device_commands
		 WHERE DEVICE_ID = ? AND STATUS = 'pending' ORDER BY IDNo LIMIT ${COMMANDS_PER_POLL}`,
		[device.IDNo]
	);
	if (cmds.length === 0) return [200, 'OK'];

	let out = '';
	for (const c of cmds) {
		await zkPool.execute(`UPDATE zk_device_commands SET STATUS = 'sent', SENT_DT = NOW() WHERE IDNo = ?`, [c.IDNo]);
		out += `C:${c.IDNo}:${c.COMMAND}\n`;
	}
	return [200, out];
}

// INFO=FirmwareVer,UserCount,FPCount,AttCount,IP,FPAlgVer,FaceAlgVer,FaceTmpNeeded,FaceCount,FuncFlags
async function saveInfo(device, info) {
	const p = info.split(',');
	await zkPool.execute(
		`UPDATE zk_devices SET FIRMWARE = ?, USER_COUNT = ?, FP_COUNT = ?, ATT_COUNT = ?, FACE_COUNT = ?
		 WHERE IDNo = ?`,
		[
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
			'SELECT COMMAND, ENCODED_BY, EMPLOYEE_ID, PROFILE_JSON FROM zk_device_commands WHERE IDNo = ? AND DEVICE_ID = ?',
			[r.id, device.IDNo]
		);
		if (!cmd) continue;
		const command = String(cmd.COMMAND);
		// Enrollment answers 0 only when a finger was actually enrolled; positive codes
		// such as 6 (nobody scanned in time) are failures too.
		const ok = command.startsWith('ENROLL_') ? r.ret === 0 : r.ret >= 0;
		// A failed add drops its profile details; a successful one turns them into the person's
		// profile (applyCommandResult), so they're kept until then.
		await zkPool.execute(
			`UPDATE zk_device_commands SET STATUS = ?, RETURN_CODE = ?, RESULT = ?, COMPLETED_DT = NOW()${ok ? '' : ', PROFILE_JSON = NULL'}
			 WHERE IDNo = ? AND DEVICE_ID = ?`,
			[ok ? 'done' : 'failed', r.ret, r.payload.length ? r.payload.join('\n') : null, r.id, device.IDNo]
		);
		const extra = { commandId: r.id, employeeId: cmd.EMPLOYEE_ID, profileJson: cmd.PROFILE_JSON };
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
		`SELECT 1 FROM zk_biometric_templates t
		 JOIN zk_device_commands c ON c.IDNo = ?
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
	const [[cmd]] = await zkPool.execute('SELECT SENT_DT FROM zk_device_commands WHERE IDNo = ?', [commandId]);
	if (!cmd?.SENT_DT) return;

	const params = pin ? [device.IDNo, cmd.SENT_DT, pin] : [device.IDNo, cmd.SENT_DT];
	const [users] = await zkPool.execute(
		`${REMOVE_SQL} WHERE ZK_DEVICE_ID = ? AND ZK_ON_DEVICE = 1 AND (ZK_SYNCED_DT IS NULL OR ZK_SYNCED_DT < ?)${pin ? ' AND ZK_PIN = ?' : ''}`,
		[null, ...params]
	);
	const [templates] = await zkPool.execute(
		`DELETE FROM zk_biometric_templates WHERE DEVICE_ID = ? AND (SYNCED_DT IS NULL OR SYNCED_DT < ?)${pin ? ' AND PIN = ?' : ''}`,
		params
	);
	if (users.affectedRows || templates.affectedRows) {
		console.log(
			`[ADMS] sync: took ${users.affectedRows} user(s) off and removed ${templates.affectedRows} template(s) no longer on device ${device.IDNo}`
		);
		emitZkChange('users', device);
	}
}

// Mirrors successful server-initiated changes into our tables (the device does not echo them back).
// Returns true when device users changed. `encodedBy` is the app user who queued the command;
// `employeeId` the removed employee an "Add again" puts back; `profileJson` the Add employee
// details, written to the profile (and cleared off the command `commandId`) in the same transaction.
async function applyCommandResult(device, command, payload, encodedBy = null, { commandId = null, employeeId = null, profileJson = null } = {}) {
	if (command.startsWith('DATA UPDATE USERINFO ')) {
		const kv = parseKv(command.slice(21));
		await inTransaction(async (conn) => {
			await saveUser(conn, device, kv, 'server', { employeeId, profile: readProfileJson(profileJson), encodedBy });
			if (profileJson && commandId) {
				await conn.execute('UPDATE zk_device_commands SET PROFILE_JSON = NULL WHERE IDNo = ?', [commandId]);
			}
		});
		return true;
	}
	if (command.startsWith('DATA DELETE USERINFO ')) {
		const pin = kvGet(parseKv(command.slice(21)), 'PIN');
		await zkPool.execute(`${REMOVE_SQL} WHERE ZK_DEVICE_ID = ? AND ZK_PIN = ? AND ZK_ON_DEVICE = 1`, [
			encodedBy ?? null,
			device.IDNo,
			pin,
		]);
		await zkPool.execute('DELETE FROM zk_biometric_templates WHERE DEVICE_ID = ? AND PIN = ?', [device.IDNo, pin]);
		return true;
	}
	if (command.startsWith('DATA DELETE FINGERTMP ')) {
		const kv = parseKv(command.slice('DATA DELETE FINGERTMP '.length));
		await zkPool.execute(
			`DELETE FROM zk_biometric_templates
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
		const [known] = await zkPool.execute('SELECT 1 FROM zk_devices WHERE SERIAL_NO = ? LIMIT 1', [sn]);
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

const PAYLOAD_IN_BODY = new RegExp(`(^|[\\t\\r\\n ])(${PAYLOAD_KEYS.join('|')})=([^\\t\\r\\n]*)`, 'gi');

/**
 * The body with biometric templates and photos blanked (USER/FP/FACE/BIODATA/USERPIC lines), so
 * the log never holds biometric data. latin1 keeps every other byte as it was.
 */
function redactBody(buf) {
	const text = buf.toString('latin1');
	if (!/(?:tmp|content|template)=/i.test(text)) return buf;
	return Buffer.from(
		text.replace(PAYLOAD_IN_BODY, (_, lead, key, value) => `${lead}${key}=[${value.length} chars not stored]`),
		'latin1'
	);
}

async function logRequest({ sn, method, path, qs, remoteIp, headers, rawBody, response, status, durationMs }) {
	if (config.rawLogDays <= 0) return;
	// Refused requests (unknown device, blocked IP, bad request) keep only the body's length, so
	// anyone on the internet can't fill the log with large bodies.
	const bodyLength = rawBody.length;
	const kept = status >= 400 && status < 500 ? Buffer.alloc(0) : redactBody(rawBody).subarray(0, RAW_BODY_MAX);
	await zkPool.execute(
		`INSERT INTO zk_raw_requests
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

/** Deletes old raw requests (ZK_RAW_LOG_DAYS) and finished commands (ZK_COMMAND_LOG_DAYS). */
async function pruneLogs() {
	await ZktecoModel.ensureSchema();
	if (config.rawLogDays > 0) {
		await zkPool.execute('DELETE FROM zk_raw_requests WHERE CREATED_DT < NOW() - INTERVAL ? DAY', [config.rawLogDays]);
	}
	if (config.commandLogDays > 0) {
		await zkPool.execute(
			`DELETE FROM zk_device_commands
			 WHERE STATUS NOT IN ('pending', 'sent') AND COALESCE(COMPLETED_DT, ENCODED_DT) < NOW() - INTERVAL ? DAY`,
			[config.commandLogDays]
		);
	}
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
	pruneLogs,
	decodeBody,
};
