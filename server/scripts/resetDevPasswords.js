// Local dev helper: reset passwords for a few accounts to a known value.
// Usage:  node scripts/resetDevPasswords.js [newPassword]
// Default password: Resto@123
//
// Run from the server/ folder so it picks up ../.env

const path = require('path');
const argon2 = require('argon2');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env.local'), override: true });
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

const NEW_PASSWORD = process.argv[2] || 'Resto@123';
const USERNAMES = ['admin', 'waiter001', 'cashier', 'kitchen'];

(async () => {
	const conn = await mysql.createConnection({
		host: process.env.DB_HOST,
		user: process.env.DB_USER,
		password: process.env.DB_PASSWORD,
		database: process.env.DB_NAME,
		port: process.env.DB_PORT,
	});

	for (const username of USERNAMES) {
		const hash = await argon2.hash(NEW_PASSWORD);
		const [res] = await conn.execute(
			"UPDATE user_info SET PASSWORD = ?, SALT = '' WHERE USERNAME = ?",
			[hash, username]
		);
		console.log(`${username}: ${res.affectedRows ? 'updated' : 'NOT FOUND'}`);
	}

	await conn.end();
	console.log(`\nDone. New password for [${USERNAMES.join(', ')}]: ${NEW_PASSWORD}`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
