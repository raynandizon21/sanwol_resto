/**
 * Fix legacy tables where IDNo is NOT NULL but not AUTO_INCREMENT (common in old SQL dumps).
 * InnoDB requires an indexed column (usually PRIMARY KEY) for AUTO_INCREMENT to apply.
 */
async function ensureIdNoAutoIncrement(pool, tableName) {
	const verify = async () => {
		const [rows] = await pool.execute(
			`SELECT COLUMN_KEY, EXTRA FROM INFORMATION_SCHEMA.COLUMNS
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'IDNo'`,
			[tableName]
		);
		if (!rows.length) return false;
		return String(rows[0].EXTRA || '')
			.toLowerCase()
			.includes('auto_increment');
	};

	if (await verify()) return true;

	try {
		const [pkRows] = await pool.execute(
			`SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'PRIMARY KEY'`,
			[tableName]
		);
		if (pkRows.length === 0) {
			await pool.execute(`ALTER TABLE \`${tableName}\` ADD PRIMARY KEY (IDNo)`);
		}
	} catch (e) {
		console.warn(`[ensureIdNoAutoIncrement] ${tableName} ADD PRIMARY KEY (IDNo):`, e?.message);
	}

	try {
		await pool.execute(
			`ALTER TABLE \`${tableName}\` MODIFY COLUMN IDNo INT NOT NULL AUTO_INCREMENT`
		);
	} catch (e) {
		console.warn(`[ensureIdNoAutoIncrement] ${tableName} MODIFY IDNo AUTO_INCREMENT:`, e?.message);
	}

	if (await verify()) return true;

	try {
		const [show] = await pool.execute(`SHOW CREATE TABLE \`${tableName}\``);
		const row = show && show[0];
		const ddl = row ? row['Create Table'] || row.Statement : '';
		if (ddl) {
			console.error(`[ensureIdNoAutoIncrement] ${tableName}.IDNo still not AUTO_INCREMENT. Current DDL:\n${ddl}`);
		}
	} catch (_) {
		// ignore
	}

	return false;
}

module.exports = { ensureIdNoAutoIncrement };
