const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env.local'), override: true });
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
const mysql = require('mysql2/promise');

// Pool for the ZKTeco (MB160) code: the zk_* tables and the ZK_* columns of `employee`, all in
// the main sanwol_resto DB (DB_*). It is separate from config/db.js only because device times
// need different session settings; see docs/zkteco-mb160.md.
//
// Device punch times are device-local wall-clock times. DATETIMEs stay plain strings
// (dateStrings) so they never shift through JS Date / the server timezone, and NOW() runs in the
// device timezone so LAST_SEEN_DT, ZK_ADDED_DT etc. compare with punch times. The main pool can't
// do this without changing how every other page reads dates.
const tzOffsetHours = Number(process.env.ZK_TZ_OFFSET_HOURS || 8);
const sign = tzOffsetHours < 0 ? '-' : '+';
const abs = Math.abs(tzOffsetHours);
const sessionTimeZone = `${sign}${String(Math.floor(abs)).padStart(2, '0')}:${String(Math.round((abs % 1) * 60)).padStart(2, '0')}`;

const pool = mysql.createPool({
	host: process.env.DB_HOST,
	port: process.env.DB_PORT,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	dateStrings: true,
	waitForConnections: true,
	connectionLimit: 10,
	queueLimit: 0,
});

pool.on('connection', (conn) => {
	conn.query(`SET time_zone = '${sessionTimeZone}'`);
});

module.exports = pool;
module.exports.tzOffsetHours = tzOffsetHours;
