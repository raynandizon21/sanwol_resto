const ApiResponse = require('../utils/apiResponse');
const TelegramService = require('../services/telegramService');

class TelegramController {
	static async getConfig(req, res) {
		try {
			const settings = await TelegramService.getSettings();
			return ApiResponse.success(
				res,
				{
					has_token: Boolean(settings?.botToken),
					token_preview: TelegramService.maskToken(settings?.botToken),
					chat_id: settings?.chatId || null,
					updated_at: settings?.updatedAt || null,
				},
				'Telegram config fetched'
			);
		} catch (error) {
			console.error('Error fetching Telegram config:', error);
			return ApiResponse.error(res, 'Failed to fetch Telegram config', 500, error.message);
		}
	}

	static async saveConfig(req, res) {
		try {
			const { bot_token, chat_id } = req.body || {};
			if (!bot_token || !String(bot_token).trim()) {
				return ApiResponse.badRequest(res, 'bot_token is required');
			}

			const saved = await TelegramService.saveSettings({
				botToken: bot_token,
				chatId: chat_id,
			});

			return ApiResponse.success(
				res,
				{
					has_token: true,
					token_preview: TelegramService.maskToken(saved?.BOT_TOKEN),
					chat_id: saved?.CHAT_ID || null,
				},
				'Telegram config saved'
			);
		} catch (error) {
			console.error('Error saving Telegram config:', error);
			return ApiResponse.error(res, 'Failed to save Telegram config', 500, error.message);
		}
	}

	static async sendTestMessage(req, res) {
		try {
			const { message, chat_id } = req.body || {};
			const sent = await TelegramService.sendMessage({
				message: message || 'Telegram integration test message from RestoAdmin.',
				chatId: chat_id || null,
			});
			return ApiResponse.success(
				res,
				{
					message_id: sent?.message_id || null,
					chat_id: sent?.chat?.id || null,
					date: sent?.date || null,
				},
				'Test message sent to Telegram'
			);
		} catch (error) {
			console.error('Error sending Telegram test message:', error);
			return ApiResponse.error(res, 'Failed to send Telegram test message', 500, error.message);
		}
	}

	static async sendReportMenu(req, res) {
		try {
			const { chat_id, message } = req.body || {};
			const sent = await TelegramService.sendInlineMenu({
				chatId: chat_id || null,
				message: message || 'Select the report you want to send:',
			});
			return ApiResponse.success(
				res,
				{
					message_id: sent?.message_id || null,
					chat_id: sent?.chat?.id || null,
				},
				'Telegram report menu sent'
			);
		} catch (error) {
			console.error('Error sending Telegram report menu:', error);
			return ApiResponse.error(res, 'Failed to send Telegram report menu', 500, error.message);
		}
	}
}

module.exports = TelegramController;
