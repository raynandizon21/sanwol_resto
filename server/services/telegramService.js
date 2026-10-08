const https = require('https');
const crypto = require('crypto');
const TelegramSettingsModel = require('../models/telegramSettingsModel');
const CashReconciliationModel = require('../models/cashReconciliationModel');
const pool = require('../config/db');
const { resolveNetSalesFromRow, sumNetSalesFromDailyRows } = require('../utils/analyticsSales');
const { buildAdminDashboardBundle } = require('./adminDashboardBundle');
const { buildBranchDashboardBundle } = require('./branchDashboardBundle');
const PYSERVER_BASE_URL = process.env.PYSERVER_BASE_URL || 'http://localhost:2100';
// Public HTTPS URL of the mobile branch-comparison board (set BRANCH_COMPARE_PUBLIC_URL).
// Reply-keyboard Web App requires HTTPS; when it's unset or not https the compare button is hidden.
const BRANCH_COMPARE_PUBLIC_URL = (() => {
	const url = String(process.env.BRANCH_COMPARE_PUBLIC_URL || '')
		.trim()
		.replace(/\/$/, '');
	return url.startsWith('https://') ? url : null;
})();
/** 3Core developer/testing branch — left out of Telegram reports, same as All Branches totals. */
const TEST_BRANCH_NAME_PATTERN = /3core/i;
const BRANCH_CALLBACK_PREFIX = 'report_branch_';
const TOTAL_LABEL = '합계 Total';
const COMPARE_LABEL = '업장별 비교';
const TELEGRAM_MINIAPP_SECRET = String(process.env.TELEGRAM_MINIAPP_SECRET || '').trim();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

function requestJson(url, method = 'POST', payload = null) {
	return new Promise((resolve, reject) => {
		const request = https.request(
			url,
			{
				method,
				headers: {
					'Content-Type': 'application/json',
				},
			},
			(response) => {
				let rawBody = '';
				response.on('data', (chunk) => {
					rawBody += chunk;
				});
				response.on('end', () => {
					try {
						const parsed = rawBody ? JSON.parse(rawBody) : {};
						resolve({ statusCode: response.statusCode, body: parsed });
					} catch (err) {
						reject(new Error(`Invalid Telegram response: ${err.message}`));
					}
				});
			}
		);

		request.on('error', reject);
		if (payload != null) {
			request.write(JSON.stringify(payload));
		}
		request.end();
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class TelegramService {
	static _pollingActive = false;
	static _lastUpdateId = null;
	static _webhookClearedForToken = null;
	static _menuConfiguredForToken = null;

	static getBranchCompareUrl() {
		// Both are needed: an unsigned link would let anyone skip the Mini App login.
		if (!BRANCH_COMPARE_PUBLIC_URL || !TELEGRAM_MINIAPP_SECRET) return null;
		// Signed SSO params so Mini App can skip password login even when initData is empty.
		const ts = Math.floor(Date.now() / 1000);
		const payload = `branch-comparison:${ts}`;
		const sig = crypto.createHmac('sha256', TELEGRAM_MINIAPP_SECRET).update(payload).digest('hex');
		const q = new URLSearchParams({
			view: 'branch-comparison',
			tg_t: String(ts),
			tg_sig: sig,
		});
		return `${BRANCH_COMPARE_PUBLIC_URL}/?${q.toString()}`;
	}

	/** Active branches shown as report buttons (from the `branches` table, 3Core excluded). */
	static async getReportBranches() {
		const [rows] = await pool.execute(
			'SELECT IDNo, BRANCH_NAME FROM branches WHERE ACTIVE = 1 ORDER BY BRANCH_NAME'
		);
		return (rows || [])
			.map((r) => ({ id: Number(r.IDNo), name: String(r.BRANCH_NAME || '').trim() }))
			.filter((b) => b.name && !TEST_BRANCH_NAME_PATTERN.test(b.name));
	}

	static branchCallback(branchId) {
		return `${BRANCH_CALLBACK_PREFIX}${branchId}`;
	}

	/** Branch id from `report_branch_<id>` callback data, or null. */
	static parseBranchCallback(callbackData) {
		const m = String(callbackData || '').match(/^report_branch_(\d+)$/);
		return m ? Number(m[1]) : null;
	}

	/** Splits buttons into rows of two. */
	static chunkPairs(items) {
		const rows = [];
		for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
		return rows;
	}

	static aggregateGroupFromCards(branchCards, branchIds) {
		const idSet = new Set((branchIds || []).map(Number));
		const cards = (branchCards || []).filter((c) => idSet.has(Number(c.id)));
		const totalSales = cards.reduce((s, c) => s + (Number(c.totalSales) || 0), 0);
		const totalExpenses = cards.reduce((s, c) => s + (Number(c.totalExpenses) || 0), 0);
		return {
			totalSales,
			totalExpenses,
			netProfit: totalSales - totalExpenses,
		};
	}

	static sumGroupResults(groupResults) {
		return (groupResults || []).reduce(
			(acc, row) => {
				acc.totalSales += Number(row.monthlyRevenue) || 0;
				acc.totalExpenses += Number(row.monthlyExpense) || 0;
				acc.netProfit += Number(row.netProfit) || 0;
				return acc;
			},
			{ totalSales: 0, totalExpenses: 0, netProfit: 0 }
		);
	}

	static computeMonthOverMonthPct(currentSales, previousSales) {
		const cur = Number(currentSales) || 0;
		const prev = Number(previousSales) || 0;
		return prev > 0 ? ((cur - prev) / prev) * 100 : 0;
	}

	static async buildReportButtons() {
		const compareUrl = TelegramService.getBranchCompareUrl();
		const branches = await TelegramService.getReportBranches();
		const topRow = [{ text: TOTAL_LABEL, callback_data: 'report_total' }];
		// Direct URL open → mobile comparison board
		if (compareUrl) topRow.push({ text: COMPARE_LABEL, url: compareUrl });
		return [
			topRow,
			...TelegramService.chunkPairs(
				branches.map((b) => ({ text: b.name, callback_data: TelegramService.branchCallback(b.id) }))
			),
		];
	}

	static async buildPersistentReplyKeyboard() {
		const compareUrl = TelegramService.getBranchCompareUrl();
		const branches = await TelegramService.getReportBranches();
		// Web App button: one tap opens URL in Telegram browser — no chat message is sent.
		const topRow = [{ text: TOTAL_LABEL }];
		if (compareUrl) topRow.push({ text: COMPARE_LABEL, web_app: { url: compareUrl } });
		return {
			keyboard: [topRow, ...TelegramService.chunkPairs(branches.map((b) => ({ text: b.name })))],
			resize_keyboard: true,
			one_time_keyboard: false,
			is_persistent: true,
		};
	}

	/** Re-apply Web App keyboard; delete helper message so chat stays clean. */
	static async refreshReplyKeyboardSilent({ botToken, chatId }) {
		const sent = await TelegramService.callTelegramApi(botToken, 'sendMessage', {
			chat_id: String(chatId),
			text: '\u2060', // word-joiner — nearly invisible, required by Telegram
			reply_markup: await TelegramService.buildPersistentReplyKeyboard(),
		});
		const messageId = sent?.body?.result?.message_id;
		if (messageId != null) {
			await TelegramService.callTelegramApi(botToken, 'deleteMessage', {
				chat_id: String(chatId),
				message_id: messageId,
			}).catch(() => {});
		}
	}

	/** Reply-keyboard button text → callback data (total, compare, or a branch by name). */
	static async resolveReplyKeyboardText(text) {
		if (text === TOTAL_LABEL) return 'report_total';
		if (text === COMPARE_LABEL) return 'report_branch_compare';
		const branches = await TelegramService.getReportBranches();
		const branch = branches.find((b) => b.name === text);
		return branch ? TelegramService.branchCallback(branch.id) : null;
	}

	/** True for callbacks that produce a report: total, or an active non-test branch. */
	static async isReportCallback(callbackData) {
		if (callbackData === 'report_total') return true;
		const branchId = TelegramService.parseBranchCallback(callbackData);
		if (branchId == null) return false;
		const branches = await TelegramService.getReportBranches();
		return branches.some((b) => b.id === branchId);
	}

	static async getSettings() {
		const settings = await TelegramSettingsModel.getSettings();
		if (!settings) return null;
		return {
			botToken: settings.BOT_TOKEN,
			chatId: settings.CHAT_ID || null,
			updatedAt: settings.UPDATED_DT,
		};
	}

	static async saveSettings({ botToken, chatId = null }) {
		if (!botToken || typeof botToken !== 'string') {
			throw new Error('botToken is required');
		}
		const trimmedToken = botToken.trim();
		if (!trimmedToken) {
			throw new Error('botToken is required');
		}
		const normalizedChatId = chatId == null || String(chatId).trim() === '' ? null : String(chatId).trim();
		return TelegramSettingsModel.upsertSettings({
			botToken: trimmedToken,
			chatId: normalizedChatId,
		});
	}

	static async sendMessage({ message, chatId = null, parseMode = 'HTML', replyMarkup = null }) {
		if (!message || !String(message).trim()) {
			throw new Error('message is required');
		}

		const settings = await TelegramService.getSettings();
		if (!settings?.botToken) {
			throw new Error('Telegram bot token is not configured');
		}

		const targetChatId = chatId || settings.chatId;
		if (!targetChatId) {
			throw new Error('Telegram chat ID is not configured');
		}

		const payload = {
			chat_id: String(targetChatId),
			text: String(message),
			parse_mode: parseMode,
		};
		if (replyMarkup && typeof replyMarkup === 'object') {
			payload.reply_markup = replyMarkup;
		}

		const response = await TelegramService.callTelegramApi(settings.botToken, 'sendMessage', payload);
		if (response.statusCode < 200 || response.statusCode >= 300 || response.body?.ok !== true) {
			const reason = response.body?.description || `HTTP ${response.statusCode}`;
			throw new Error(`Telegram send failed: ${reason}`);
		}

		return response.body.result;
	}

	static async sendInlineMenu({ chatId = null, message = 'Piliin ang report na gusto mo:' }) {
		const settings = await TelegramService.getSettings();
		if (!settings?.botToken) {
			throw new Error('Telegram bot token is not configured');
		}

		const targetChatId = chatId || settings.chatId;
		if (!targetChatId) {
			throw new Error('Telegram chat ID is not configured');
		}

		const payload = {
			chat_id: String(targetChatId),
			text: String(message),
			reply_markup: {
				inline_keyboard: await TelegramService.buildReportButtons(),
			},
		};

		const response = await TelegramService.callTelegramApi(settings.botToken, 'sendMessage', payload);
		if (response.statusCode < 200 || response.statusCode >= 300 || response.body?.ok !== true) {
			const reason = response.body?.description || `HTTP ${response.statusCode}`;
			throw new Error(`Telegram menu send failed: ${reason}`);
		}

		return response.body.result;
	}

	static async sendPersistentMenu({ chatId = null, message = 'Select the report you want to view:' }) {
		const settings = await TelegramService.getSettings();
		if (!settings?.botToken) {
			throw new Error('Telegram bot token is not configured');
		}

		const targetChatId = chatId || settings.chatId;
		if (!targetChatId) {
			throw new Error('Telegram chat ID is not configured');
		}

		const payload = {
			chat_id: String(targetChatId),
			text: String(message),
			reply_markup: await TelegramService.buildPersistentReplyKeyboard(),
		};

		const response = await TelegramService.callTelegramApi(settings.botToken, 'sendMessage', payload);
		if (response.statusCode < 200 || response.statusCode >= 300 || response.body?.ok !== true) {
			const reason = response.body?.description || `HTTP ${response.statusCode}`;
			throw new Error(`Telegram persistent menu send failed: ${reason}`);
		}

		return response.body.result;
	}

	static async configureBotMenu(botToken) {
		await TelegramService.callTelegramApi(botToken, 'setMyCommands', {
			commands: [],
		});
		await TelegramService.callTelegramApi(botToken, 'setChatMenuButton', {
			menu_button: { type: 'default' },
		});
	}

	static async callTelegramApi(botToken, method, payload) {
		const endpoint = `https://api.telegram.org/bot${botToken}/${method}`;
		return requestJson(endpoint, 'POST', payload);
	}

	static async getTelegramUpdates(botToken, options = {}) {
		const params = new URLSearchParams();
		if (options.offset != null) params.set('offset', String(options.offset));
		if (options.timeout != null) params.set('timeout', String(options.timeout));

		const endpoint = `https://api.telegram.org/bot${botToken}/getUpdates?${params.toString()}`;
		return requestJson(endpoint, 'GET');
	}

	static normalizeText(value) {
		return String(value || '').trim().toLowerCase();
	}

	static async buildReportTitle(callbackData) {
		if (callbackData === 'report_total') return TOTAL_LABEL;
		const branchId = TelegramService.parseBranchCallback(callbackData);
		const branches = await TelegramService.getReportBranches();
		return branches.find((b) => b.id === branchId)?.name || 'Report';
	}

	static async calculateMetricsForRange(startDate, endDate, previousStartDate, previousEndDate, branchId = null) {
		const [monthlyRows, monthlyDailyExpenses, monthlyExpenseSummary, monthlyExpenseBreakdown, monthlyBranchSales, currentRecon] = await Promise.all([
			TelegramService.getDashboardDailySales(startDate, endDate, branchId),
			TelegramService.getDashboardDailyExpenses(startDate, endDate, branchId),
			TelegramService.getDashboardExpenseSummary(startDate, endDate, branchId),
			TelegramService.getDashboardExpenseBreakdown(startDate, endDate, branchId).catch(() => []),
			TelegramService.getDashboardBranchSales(startDate, endDate, branchId),
			CashReconciliationModel.aggregatesForRange(branchId, startDate, endDate),
		]);
		const [previousRows, previousBranchSales, previousRecon] = await Promise.all([
			TelegramService.getDashboardDailySales(previousStartDate, previousEndDate, branchId),
			TelegramService.getDashboardBranchSales(previousStartDate, previousEndDate, branchId),
			CashReconciliationModel.aggregatesForRange(branchId, previousStartDate, previousEndDate),
		]);

		const monthlyReconTotal = parseFloat(currentRecon?.total || 0) || 0;
		const previousReconTotal = parseFloat(previousRecon?.total || 0) || 0;

		const totalSalesFromDaily = sumNetSalesFromDailyRows(monthlyRows);
		const totalSalesFromBranch = monthlyBranchSales.reduce((sum, row) => sum + (parseFloat(row.total_sales) || 0), 0);
		const monthlyRevenue = (totalSalesFromDaily || totalSalesFromBranch) + monthlyReconTotal;

		const previousSalesFromDaily = sumNetSalesFromDailyRows(previousRows);
		const previousSalesFromBranch = previousBranchSales.reduce((sum, row) => sum + (parseFloat(row.total_sales) || 0), 0);
		const previousRevenue = (previousSalesFromDaily || previousSalesFromBranch) + previousReconTotal;

		const totalExpensesFromDaily = monthlyDailyExpenses.reduce(
			(sum, row) => sum + (parseFloat(row.total_expense) || 0),
			0
		);
		const totalExpensesFromBreakdown = (monthlyExpenseBreakdown || []).reduce(
			(sum, row) => sum + (parseFloat(row?.total_amount) || 0),
			0
		);
		const monthlyExpense = monthlyExpenseSummary || totalExpensesFromBreakdown || totalExpensesFromDaily;
		const netProfit = monthlyRevenue - monthlyExpense;
		const monthOverMonthPct = previousRevenue > 0 ? ((monthlyRevenue - previousRevenue) / previousRevenue) * 100 : 0;

		return {
			monthlyRevenue,
			previousRevenue,
			monthlyExpense,
			netProfit,
			monthOverMonthPct,
		};
	}

	static async buildTotalReportMessage() {
		const todayDate = new Date();
		const currentMonth = TelegramService.getDateRangeForMonth(todayDate);
		const previousMonth = TelegramService.getPreviousMonthRange(todayDate);

		const [currentBundle, previousBundle] = await Promise.all([
			buildAdminDashboardBundle({
				start_date: currentMonth.start,
				end_date: currentMonth.end,
				include_branch_charts: false,
			}),
			buildAdminDashboardBundle({
				start_date: previousMonth.start,
				end_date: previousMonth.end,
				include_branch_charts: false,
			}),
		]);

		// One line per branch card (the admin bundle already leaves out 3Core).
		const branchGroups = (currentBundle.branchCardsData || []).map((card) => ({
			label: card.name,
			branchIds: [card.id],
		}));
		const groupResults = branchGroups.map((group) => {
			const current = TelegramService.aggregateGroupFromCards(
				currentBundle.branchCardsData,
				group.branchIds
			);
			const previous = TelegramService.aggregateGroupFromCards(
				previousBundle.branchCardsData,
				group.branchIds
			);
			return {
				label: group.label,
				monthlyRevenue: current.totalSales,
				monthlyExpense: current.totalExpenses,
				netProfit: current.netProfit,
				monthOverMonthPct: TelegramService.computeMonthOverMonthPct(
					current.totalSales,
					previous.totalSales
				),
			};
		});

		// Grand total must equal the sum of the branch lines shown (same as AdminDashboard cards sum).
		const overall = TelegramService.sumGroupResults(groupResults);

		const prevOverallSales = branchGroups.reduce((sum, group) => {
			const previous = TelegramService.aggregateGroupFromCards(
				previousBundle.branchCardsData,
				group.branchIds
			);
			return sum + (Number(previous.totalSales) || 0);
		}, 0);
		const overallMoM = TelegramService.computeMonthOverMonthPct(
			overall.totalSales,
			prevOverallSales
		);

		const lines = [
			`<b>${TOTAL_LABEL}</b>`,
			'',
			`전체 매출: ${TelegramService.formatNumber(overall.totalSales)}      지출: ${TelegramService.formatNumber(overall.totalExpenses)}`,
			`순익: ${TelegramService.formatNumber(overall.netProfit)}      전월대비: ${TelegramService.formatMonthIndex(overallMoM)}`,
			'',
		];

		for (const group of groupResults) {
			lines.push(`<b>${group.label}</b>`);
			lines.push(
				`월 매출: ${TelegramService.formatNumber(group.monthlyRevenue)}      지출: ${TelegramService.formatNumber(group.monthlyExpense)}`
			);
			lines.push(
				`순익: ${TelegramService.formatNumber(group.netProfit)}      전월대비: ${TelegramService.formatMonthIndex(group.monthOverMonthPct)}`
			);
			lines.push('');
		}

		lines.push(`기간: ${TelegramService.formatYmdKorean(currentMonth.start)} ~ ${TelegramService.formatYmdKorean(currentMonth.end)}`);
		return lines.join('\n');
	}

	static getDateRangeForMonth(baseDate = new Date()) {
		const year = baseDate.getFullYear();
		const month = baseDate.getMonth();
		const start = new Date(year, month, 1);
		// Dashboard default behavior is month-to-date, not full month until last day.
		const end = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
		return {
			start: TelegramService.formatDateLocalYmd(start),
			end: TelegramService.formatDateLocalYmd(end),
		};
	}

	static getPreviousMonthRange(baseDate = new Date()) {
		const year = baseDate.getFullYear();
		const month = baseDate.getMonth();
		const start = new Date(year, month - 1, 1);
		const previousMonthLastDay = new Date(year, month, 0).getDate();
		const comparableDay = Math.min(baseDate.getDate(), previousMonthLastDay);
		const end = new Date(year, month - 1, comparableDay);
		return {
			start: TelegramService.formatDateLocalYmd(start),
			end: TelegramService.formatDateLocalYmd(end),
		};
	}

	static formatDateLocalYmd(dateObj) {
		const y = dateObj.getFullYear();
		const m = String(dateObj.getMonth() + 1).padStart(2, '0');
		const d = String(dateObj.getDate()).padStart(2, '0');
		return `${y}-${m}-${d}`;
	}

	static formatYmdKorean(value) {
		const d = TelegramService.parseDateToLocal(value);
		if (!d) return String(value || '');
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}년 ${m}월 ${day}일`;
	}

	static parseDateToLocal(value) {
		if (!value) return null;
		if (value instanceof Date) {
			return new Date(value.getFullYear(), value.getMonth(), value.getDate());
		}

		const ymdMatch = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
		if (ymdMatch) {
			const year = Number(ymdMatch[1]);
			const month = Number(ymdMatch[2]) - 1;
			const day = Number(ymdMatch[3]);
			return new Date(year, month, day);
		}

		const d = new Date(value);
		if (Number.isNaN(d.getTime())) return null;
		return new Date(d.getFullYear(), d.getMonth(), d.getDate());
	}

	static formatNumber(value) {
		const n = Number(value || 0);
		const safe = Number.isFinite(n) ? Math.trunc(n) : 0;
		return safe.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
	}

	static formatMonthIndex(percentChange) {
		const n = Number(percentChange);
		if (!Number.isFinite(n)) return '0.0%';
		if (Math.abs(n) < 1e-9) return '0.0%';
		const index = 100 + n;
		return `${index.toFixed(1)}%`;
	}

	static async getLatestEncodedDt(branchId = null) {
		let query = `
			SELECT MAX(ENCODED_DT) AS latest_encoded_dt
			FROM billing
			WHERE STATUS IN (1, 2)
		`;
		const params = [];
		if (branchId) {
			query += ` AND BRANCH_ID = ?`;
			params.push(branchId);
		}

		const [rows] = await pool.execute(query, params);
		return rows?.[0]?.latest_encoded_dt || null;
	}

	static formatLastUpdate(value) {
		if (!value) return 'N/A';
		const d = new Date(value);
		if (Number.isNaN(d.getTime())) return 'N/A';
		return d.toLocaleDateString('en-US', {
			month: 'long',
			day: 'numeric',
			year: 'numeric',
		});
	}

	static getCalendarWeekRangeForMonth(baseDate = new Date()) {
		const year = baseDate.getFullYear();
		const month = baseDate.getMonth();
		const monthStart = new Date(year, month, 1);
		const monthEnd = new Date(year, month + 1, 0);

		const monthStartMondayIndex = (monthStart.getDay() + 6) % 7;
		const calendarStart = new Date(monthStart);
		calendarStart.setDate(calendarStart.getDate() - monthStartMondayIndex);

		const monthEndMondayIndex = (monthEnd.getDay() + 6) % 7;
		const calendarEnd = new Date(monthEnd);
		calendarEnd.setDate(calendarEnd.getDate() + (6 - monthEndMondayIndex));

		const dayMs = 24 * 60 * 60 * 1000;
		const weekCount = Math.floor((calendarEnd - calendarStart) / dayMs / 7) + 1;
		return {
			start: TelegramService.formatDateLocalYmd(calendarStart),
			end: TelegramService.formatDateLocalYmd(calendarEnd),
			weekCount,
		};
	}

	static buildWeeklyBucketsFromRevenue(revenueData, calendarStartYmd, weekCount = 5) {
		const weekly = Array.from({ length: Math.max(1, weekCount) }, () => 0);
		const calendarStart = TelegramService.parseDateToLocal(calendarStartYmd);
		if (!calendarStart) return weekly;
		const dayMs = 24 * 60 * 60 * 1000;

		const getWeekIndex = (dateValue) => {
			const d = TelegramService.parseDateToLocal(dateValue);
			if (!d) return -1;
			const dayDiff = Math.floor((d - calendarStart) / dayMs);
			if (dayDiff < 0) return -1;
			const index = Math.floor(dayDiff / 7);
			if (index < 0 || index >= weekly.length) return -1;
			return index;
		};

		for (const point of revenueData || []) {
			if (!point?.date) continue;
			const weekIndex = getWeekIndex(point.date);
			if (weekIndex < 0) continue;
			weekly[weekIndex] += Number(point.income || 0) || 0;
		}
		return weekly;
	}

	static buildWeeklyBuckets(rows, reconByDate = {}, calendarStartYmd, weekCount = 5) {
		const weekly = Array.from({ length: Math.max(1, weekCount) }, () => 0);
		const calendarStart = TelegramService.parseDateToLocal(calendarStartYmd);
		if (!calendarStart) return weekly;
		const dayMs = 24 * 60 * 60 * 1000;

		const getWeekIndex = (dateValue) => {
			const d = TelegramService.parseDateToLocal(dateValue);
			if (!d) return -1;
			const dayDiff = Math.floor((d - calendarStart) / dayMs);
			if (dayDiff < 0) return -1;
			const index = Math.floor(dayDiff / 7);
			if (index < 0 || index >= weekly.length) return -1;
			return index;
		};

		for (const row of rows || []) {
			if (!row?.date) continue;
			const weekIndex = getWeekIndex(row.date);
			if (weekIndex < 0) continue;
			weekly[weekIndex] += resolveNetSalesFromRow(row);
		}

		for (const [ymd, reconAmount] of Object.entries(reconByDate || {})) {
			const weekIndex = getWeekIndex(ymd);
			if (weekIndex < 0) continue;
			weekly[weekIndex] += parseFloat(reconAmount || 0) || 0;
		}
		return weekly;
	}

	static async getDashboardDailySales(startDate, endDate, branchId = null) {
		const params = new URLSearchParams();
		params.set('start_date', startDate);
		params.set('end_date', endDate);
		if (branchId) params.set('branch_id', String(branchId));

		const response = await fetch(`${PYSERVER_BASE_URL}/api/analytics/daily-sales?${params.toString()}`);
		if (!response.ok) {
			throw new Error(`PyServer daily-sales failed: HTTP ${response.status}`);
		}

		const json = await response.json();
		if (!json?.success) {
			throw new Error(json?.message || 'PyServer daily-sales failed');
		}

		const rows = Array.isArray(json?.data?.data) ? json.data.data : [];
		return rows.map((row) => ({
			date: row.sale_date,
			total_sales: parseFloat(row.total_sales || 0) || 0,
			net_sales: parseFloat(row.net_sales ?? NaN),
			refund: parseFloat(row.refund || 0) || 0,
			discount: parseFloat(row.discount || 0) || 0,
		}));
	}

	static async getDashboardExpenseSummary(startDate, endDate, branchId = null) {
		const params = new URLSearchParams();
		params.set('start_date', startDate);
		params.set('end_date', endDate);
		if (branchId) params.set('branch_id', String(branchId));

		const response = await fetch(`${PYSERVER_BASE_URL}/api/analytics/expense-summary?${params.toString()}`);
		if (!response.ok) {
			throw new Error(`PyServer expense-summary failed: HTTP ${response.status}`);
		}

		const json = await response.json();
		if (!json?.success) {
			throw new Error(json?.message || 'PyServer expense-summary failed');
		}

		return parseFloat(json?.data?.total_expense || 0) || 0;
	}

	static async getDashboardDailyExpenses(startDate, endDate, branchId = null) {
		const params = new URLSearchParams();
		params.set('start_date', startDate);
		params.set('end_date', endDate);
		if (branchId) params.set('branch_id', String(branchId));

		const response = await fetch(`${PYSERVER_BASE_URL}/api/analytics/daily-expenses?${params.toString()}`);
		if (!response.ok) {
			throw new Error(`PyServer daily-expenses failed: HTTP ${response.status}`);
		}

		const json = await response.json();
		if (!json?.success) {
			throw new Error(json?.message || 'PyServer daily-expenses failed');
		}

		return Array.isArray(json?.data?.data) ? json.data.data : [];
	}

	static async getDashboardExpenseBreakdown(startDate, endDate, branchId = null) {
		const params = new URLSearchParams();
		params.set('start_date', startDate);
		params.set('end_date', endDate);
		if (branchId) params.set('branch_id', String(branchId));

		const response = await fetch(`${PYSERVER_BASE_URL}/api/analytics/expense-breakdown?${params.toString()}`);
		if (!response.ok) {
			throw new Error(`PyServer expense-breakdown failed: HTTP ${response.status}`);
		}

		const json = await response.json();
		if (!json?.success) {
			throw new Error(json?.message || 'PyServer expense-breakdown failed');
		}

		return Array.isArray(json?.data?.data) ? json.data.data : [];
	}

	static async getDashboardBranchSales(startDate, endDate, branchId = null) {
		const params = new URLSearchParams();
		params.set('start_date', startDate);
		params.set('end_date', endDate);
		if (branchId) params.set('branch_id', String(branchId));

		const response = await fetch(`${PYSERVER_BASE_URL}/api/analytics/branch-sales?${params.toString()}`);
		if (!response.ok) {
			throw new Error(`PyServer branch-sales failed: HTTP ${response.status}`);
		}

		const json = await response.json();
		if (!json?.success) {
			throw new Error(json?.message || 'PyServer branch-sales failed');
		}

		return Array.isArray(json?.data?.data) ? json.data.data : [];
	}

	static async buildReportMessage(callbackData) {
		if (callbackData === 'report_total') {
			return TelegramService.buildTotalReportMessage();
		}

		const todayDate = new Date();
		const branchId = TelegramService.parseBranchCallback(callbackData);
		const currentMonth = TelegramService.getDateRangeForMonth(todayDate);
		const previousMonth = TelegramService.getPreviousMonthRange(todayDate);
		const weeklyCalendarRange = TelegramService.getCalendarWeekRangeForMonth(todayDate);

		const [currentBundle, previousBundle, latestEncodedDt] = await Promise.all([
			buildBranchDashboardBundle({
				branchId,
				start_date: currentMonth.start,
				end_date: currentMonth.end,
			}),
			buildBranchDashboardBundle({
				branchId,
				start_date: previousMonth.start,
				end_date: previousMonth.end,
			}),
			TelegramService.getLatestEncodedDt(branchId),
		]);

		const stats = currentBundle.dashboardData?.stats || {};
		const prevStats = previousBundle.dashboardData?.stats || {};
		const monthOverMonthPct = TelegramService.computeMonthOverMonthPct(
			stats.totalSales,
			prevStats.totalSales
		);
		const weeklyBuckets = TelegramService.buildWeeklyBucketsFromRevenue(
			currentBundle.dashboardData?.revenueData || [],
			weeklyCalendarRange.start,
			weeklyCalendarRange.weekCount
		);
		const weeklyLines = [];
		for (let i = 0; i < weeklyBuckets.length; i += 2) {
			const left = `${i + 1}주: ${TelegramService.formatNumber(weeklyBuckets[i])}`;
			const rightIndex = i + 1;
			if (rightIndex < weeklyBuckets.length) {
				const right = `${rightIndex + 1}주: ${TelegramService.formatNumber(weeklyBuckets[rightIndex])}`;
				weeklyLines.push(`${left}      ${right}`);
			} else {
				weeklyLines.push(left);
			}
		}
		const title = await TelegramService.buildReportTitle(callbackData);

		return [
			`<b>${title}</b>`,
			'',
			`월매출: ${TelegramService.formatNumber(stats.totalSales)}      지출: ${TelegramService.formatNumber(stats.totalExpenses)}`,
			`순익: ${TelegramService.formatNumber(stats.totalProfit)}      전월대비: ${TelegramService.formatMonthIndex(monthOverMonthPct)}`,
			'',
			'주간 매출(Weekly)',
			...weeklyLines,
			'',
			`Last Update : ${TelegramService.formatLastUpdate(latestEncodedDt)}`,
		].join('\n');
	}

	static async handleIncomingUpdate(update) {
		const settings = await TelegramService.getSettings();
		if (!settings?.botToken) {
			throw new Error('Telegram bot token is not configured');
		}

		const callbackQuery = update?.callback_query;
		if (callbackQuery?.id && callbackQuery?.message?.chat?.id && callbackQuery?.data) {
			// Legacy callback — dismiss only; inline keyboard uses a direct URL button.
			if (callbackQuery.data === 'report_branch_compare') {
				await TelegramService.callTelegramApi(settings.botToken, 'answerCallbackQuery', {
					callback_query_id: callbackQuery.id,
					show_alert: false,
				});
				return { handled: true, type: 'callback_branch_compare' };
			}

			if (!(await TelegramService.isReportCallback(callbackQuery.data))) {
				await TelegramService.callTelegramApi(settings.botToken, 'answerCallbackQuery', {
					callback_query_id: callbackQuery.id,
					text: 'Not configured yet',
					show_alert: false,
				});
				return { handled: true, type: 'callback_query' };
			}

			const reportMessage = await TelegramService.buildReportMessage(callbackQuery.data);
			await TelegramService.callTelegramApi(settings.botToken, 'answerCallbackQuery', {
				callback_query_id: callbackQuery.id,
				text: 'Report ready',
				show_alert: false,
			});

			await TelegramService.callTelegramApi(settings.botToken, 'sendMessage', {
				chat_id: String(callbackQuery.message.chat.id),
				text: reportMessage,
				parse_mode: 'HTML',
				reply_markup: {
					inline_keyboard: await TelegramService.buildReportButtons(),
				},
			});
			return { handled: true, type: 'callback_query' };
		}

		const text = String(update?.message?.text || '').trim();
		const chatId = update?.message?.chat?.id;
		const normalizedText = text.toLowerCase();
		if (chatId && normalizedText === '/start') {
			await TelegramService.sendMessage({
				chatId: String(chatId),
				message: 'Welcome to Restaurant System',
				parseMode: 'HTML',
				replyMarkup: await TelegramService.buildPersistentReplyKeyboard(),
			});
			return { handled: true, type: 'start_message' };
		}

		const callbackData = chatId ? await TelegramService.resolveReplyKeyboardText(text) : null;
		if (callbackData) {
			// Old plain-text keyboard still cached: no bot reply — just install Web App keyboard.
			if (callbackData === 'report_branch_compare') {
				await TelegramService.refreshReplyKeyboardSilent({
					botToken: settings.botToken,
					chatId,
				});
				return { handled: true, type: 'reply_keyboard_branch_compare' };
			}

			if (!(await TelegramService.isReportCallback(callbackData))) {
				await TelegramService.sendMessage({
					chatId: String(chatId),
					message: 'Not configured yet',
					parseMode: 'HTML',
				});
				return { handled: true, type: 'reply_keyboard_unconfigured' };
			}

			const reportMessage = await TelegramService.buildReportMessage(callbackData);
			await TelegramService.callTelegramApi(settings.botToken, 'sendMessage', {
				chat_id: String(chatId),
				text: reportMessage,
				parse_mode: 'HTML',
				reply_markup: await TelegramService.buildPersistentReplyKeyboard(),
			});
			return { handled: true, type: 'reply_keyboard_report' };
		}

		return { handled: false, type: 'ignored' };
	}

	static isPollingActive() {
		return TelegramService._pollingActive;
	}

	static stopPolling() {
		TelegramService._pollingActive = false;
	}

	static async startPolling() {
		if (TelegramService._pollingActive) {
			return;
		}
		TelegramService._pollingActive = true;

		while (TelegramService._pollingActive) {
			try {
				const settings = await TelegramService.getSettings();
				if (!settings?.botToken) {
					await sleep(3000);
					continue;
				}

				if (TelegramService._webhookClearedForToken !== settings.botToken) {
					await TelegramService.callTelegramApi(settings.botToken, 'deleteWebhook', {
						drop_pending_updates: false,
					});
					TelegramService._webhookClearedForToken = settings.botToken;
				}

				if (TelegramService._menuConfiguredForToken !== settings.botToken) {
					await TelegramService.configureBotMenu(settings.botToken);
					TelegramService._menuConfiguredForToken = settings.botToken;
				}

				const updatesResponse = await TelegramService.getTelegramUpdates(settings.botToken, {
					offset: TelegramService._lastUpdateId != null ? TelegramService._lastUpdateId + 1 : undefined,
					timeout: 25,
				});

				if (updatesResponse.statusCode >= 200 && updatesResponse.statusCode < 300 && updatesResponse.body?.ok) {
					const updates = Array.isArray(updatesResponse.body.result) ? updatesResponse.body.result : [];
					for (const update of updates) {
						TelegramService._lastUpdateId = Number(update.update_id);
						try {
							await TelegramService.handleIncomingUpdate(update);
						} catch (handlerError) {
							console.error('[Telegram] Update handling failed:', handlerError?.message || handlerError);
						}
					}
				} else {
					const reason = updatesResponse.body?.description || `HTTP ${updatesResponse.statusCode}`;
					console.error('[Telegram] getUpdates failed:', reason);
					await sleep(2000);
				}
			} catch (error) {
				console.error('[Telegram] Polling loop error:', error?.message || error);
				await sleep(3000);
			}
		}
	}

	static maskToken(token) {
		if (!token) return null;
		if (token.length <= 8) return '********';
		return `${token.slice(0, 4)}...${token.slice(-4)}`;
	}
}

module.exports = TelegramService;
