const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env.local'), override: true });
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
const mysql = require('mysql2/promise');

// ZKTeco (MB160 attendance device) data lives in its own database so it can move
// to another server independently. Each ZK_DB_* value falls back to the main DB_*.
// See docs/zkteco-mb160.md.
const config = {
	host: process.env.ZK_DB_HOST || process.env.DB_HOST,
	port: process.env.ZK_DB_PORT || process.env.DB_PORT,
	user: process.env.ZK_DB_USER || process.env.DB_USER,
	password: process.env.ZK_DB_PASSWORD || process.env.DB_PASSWORD,
	database: process.env.ZK_DB_NAME || 'zkteco',
};

// Device punch times are device-local wall-clock times. Keep DATETIMEs as plain
// strings so they never shift through JS Date / server timezone conversion.
const tzOffsetHours = Number(process.env.ZK_TZ_OFFSET_HOURS || 8);
const sign = tzOffsetHours < 0 ? '-' : '+';
const abs = Math.abs(tzOffsetHours);
const sessionTimeZone = `${sign}${String(Math.floor(abs)).padStart(2, '0')}:${String(Math.round((abs % 1) * 60)).padStart(2, '0')}`;

const pool = mysql.createPool({
	...config,
	dateStrings: true,
	waitForConnections: true,
	connectionLimit: Number(process.env.ZK_DB_CONNECTION_LIMIT || 10),
	queueLimit: 0,
});

// NOW()/CURRENT_TIMESTAMP in the device timezone, so LAST_SEEN_DT etc. compare with punch times.
pool.on('connection', (conn) => {
	conn.query(`SET time_zone = '${sessionTimeZone}'`);
});

/** Creates the database when the MySQL user is allowed to (local/dev). Cloud users may need it created by hand. */
async function ensureDatabase() {
	const { database, ...serverConfig } = config;
	const conn = await mysql.createConnection(serverConfig);
	try {
		await conn.query(
			`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
		);
	} finally {
		await conn.end();
	}
}

module.exports = pool;
module.exports.ensureDatabase = ensureDatabase;
module.exports.tzOffsetHours = tzOffsetHours;
module.exports.databaseName = config.database;
