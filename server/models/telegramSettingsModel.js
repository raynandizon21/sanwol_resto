const pool = require('../config/db');

class TelegramSettingsModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	static async ensureSchema() {
		if (TelegramSettingsModel._schemaReady) return;
		if (TelegramSettingsModel._schemaPromise) return TelegramSettingsModel._schemaPromise;

		TelegramSettingsModel._schemaPromise = (async () => {
			await pool.execute(`
				CREATE TABLE IF NOT EXISTS telegram_settings (
					ID TINYINT NOT NULL DEFAULT 1,
					BOT_TOKEN VARCHAR(255) NOT NULL,
					CHAT_ID VARCHAR(64) DEFAULT NULL,
					CREATED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
					UPDATED_DT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
					PRIMARY KEY (ID)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
			`);

			TelegramSettingsModel._schemaReady = true;
			TelegramSettingsModel._schemaPromise = null;
		})().catch((error) => {
			TelegramSettingsModel._schemaPromise = null;
			TelegramSettingsModel._schemaReady = false;
			throw error;
		});

		return TelegramSettingsModel._schemaPromise;
	}

	static async getSettings() {
		await TelegramSettingsModel.ensureSchema();
		const [rows] = await pool.execute(
			`SELECT ID, BOT_TOKEN, CHAT_ID, CREATED_DT, UPDATED_DT FROM telegram_settings WHERE ID = 1 LIMIT 1`
		);
		return rows[0] || null;
	}

	static async upsertSettings({ botToken, chatId = null }) {
		await TelegramSettingsModel.ensureSchema();
		await pool.execute(
			`INSERT INTO telegram_settings (ID, BOT_TOKEN, CHAT_ID)
			 VALUES (1, ?, ?)
			 ON DUPLICATE KEY UPDATE
			 	BOT_TOKEN = VALUES(BOT_TOKEN),
			 	CHAT_ID = VALUES(CHAT_ID)`,
			[botToken, chatId]
		);
		return TelegramSettingsModel.getSettings();
	}
}

module.exports = TelegramSettingsModel;
