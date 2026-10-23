// ============================================
// MENU SCHEDULE
// ============================================
// File: utils/menuSchedule.js
// Description: "Available hours" of menu items and categories (e.g. breakfast
// 06:00-11:00). Times are the store's local time (GMT+8 unless
// STORE_UTC_OFFSET_MINUTES says otherwise), not the server's clock.
// ============================================

const STORE_UTC_OFFSET_MINUTES = Number.isFinite(Number(process.env.STORE_UTC_OFFSET_MINUTES))
	? Number(process.env.STORE_UTC_OFFSET_MINUTES)
	: 480;

/** Minutes since local midnight at the store (0-1439). */
function storeNowMinutes(date = new Date()) {
	const minutes = Math.floor(date.getTime() / 60000) + STORE_UTC_OFFSET_MINUTES;
	return ((minutes % 1440) + 1440) % 1440;
}

/** "06:30" / "06:30:00" -> 390; anything else -> null. */
function toMinutes(value) {
	if (value === null || value === undefined || value === '') return null;
	const m = /^(\d{1,2}):(\d{2})/.exec(String(value).trim());
	if (!m) return null;
	return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * True when now is inside [from, to). No window (either end missing, or both
 * the same) = always. A window past midnight (22:00-02:00) wraps around.
 */
function isWithinHours(from, to, now = storeNowMinutes()) {
	const f = toMinutes(from);
	const t = toMinutes(to);
	if (f === null || t === null || f === t) return true;
	return f < t ? now >= f && now < t : now >= f || now < t;
}

/**
 * Request value -> 'HH:MM:00' for a TIME column. undefined = not sent (keep
 * the stored value), '' / null = no window. Throws on a malformed time.
 */
function normalizeTimeInput(value) {
	if (value === undefined) return undefined;
	if (value === null || String(value).trim() === '') return null;
	const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value).trim());
	if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
		throw new Error('Invalid time. Use HH:MM (e.g. 06:00).');
	}
	return `${m[1].padStart(2, '0')}:${m[2]}:00`;
}

/** 'HH:MM:SS' from MySQL -> 'HH:MM' (null when empty). */
function formatTime(value) {
	const minutes = toMinutes(value);
	if (minutes === null) return null;
	return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

module.exports = {
	storeNowMinutes,
	isWithinHours,
	normalizeTimeInput,
	formatTime,
};
