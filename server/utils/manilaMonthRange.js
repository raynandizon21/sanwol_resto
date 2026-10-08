/**
 * Month-to-date in Asia/Manila — same calendar day as frontend getManilaMonthToDateRange.
 * Avoids warm-cache keys drifting when process TZ ≠ Asia/Manila.
 */

const MANILA_TZ = 'Asia/Manila';

function getManilaTodayYmd(now = new Date()) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: MANILA_TZ,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(now);
	const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
	return `${get('year')}-${get('month')}-${get('day')}`;
}

function getManilaMonthToDateRange(now = new Date()) {
	const end_date = getManilaTodayYmd(now);
	const [y, m] = end_date.split('-');
	return {
		start_date: `${y}-${m}-01`,
		end_date,
	};
}

module.exports = { getManilaTodayYmd, getManilaMonthToDateRange };
