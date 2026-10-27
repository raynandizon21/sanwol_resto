// ============================================
// PRINTER SETTINGS MODEL
// ============================================
// The cashier tablet's printer setup per branch (printers, print routing,
// auto-print), kept on the server as a backup: a reinstalled / replaced
// tablet gets it back. The tablet's own copy is the one in use; this is
// overwritten whenever the cashier changes it.
// ============================================

const pool = require('../config/db');

class PrinterSettingsModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (PrinterSettingsModel._schemaReady) return;
		if (PrinterSettingsModel._schemaPromise) return PrinterSettingsModel._schemaPromise;

		PrinterSettingsModel._schemaPromise = (async () => {
			await pool.execute(`
				CREATE TABLE IF NOT EXISTS branch_printer_settings (
					BRANCH_ID INT NOT NULL,
					SETTINGS LONGTEXT NOT NULL,
					UPDATED_BY INT NULL,
					UPDATED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
					PRIMARY KEY (BRANCH_ID)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
			`);
			PrinterSettingsModel._schemaReady = true;
			PrinterSettingsModel._schemaPromise = null;
		})().catch((error) => {
			PrinterSettingsModel._schemaPromise = null;
			PrinterSettingsModel._schemaReady = false;
			throw error;
		});

		return PrinterSettingsModel._schemaPromise;
	}

	/** { settings, updated_dt } or null when the branch has none saved. */
	static async get(branchId) {
		await PrinterSettingsModel.ensureSchema();
		const [rows] = await pool.execute(
			'SELECT SETTINGS, UPDATED_DT FROM branch_printer_settings WHERE BRANCH_ID = ? LIMIT 1',
			[branchId]
		);
		if (!rows[0]) return null;
		let settings = null;
		try {
			settings = JSON.parse(rows[0].SETTINGS);
		} catch (_) {
			return null;
		}
		return { settings, updated_dt: rows[0].UPDATED_DT };
	}

	static async save(branchId, settings, userId) {
		await PrinterSettingsModel.ensureSchema();
		await pool.execute(
			`INSERT INTO branch_printer_settings (BRANCH_ID, SETTINGS, UPDATED_BY)
			 VALUES (?, ?, ?)
			 ON DUPLICATE KEY UPDATE SETTINGS = VALUES(SETTINGS), UPDATED_BY = VALUES(UPDATED_BY)`,
			[branchId, JSON.stringify(settings), userId || null]
		);
	}
}

module.exports = PrinterSettingsModel;
