const { fetchPyCachedOptional } = require('./analyticsPyFetch');

const BUNDLE_PYSERVER_TIMEOUT_MS = Number(process.env.BUNDLE_PYSERVER_TIMEOUT_MS || 8000);
const MENU_REPORT_TIMEOUT_MS = Number(process.env.MENU_REPORT_TIMEOUT_MS || 25000);
const MENU_REPORT_RETRY_TIMEOUT_MS = Number(
  process.env.MENU_REPORT_RETRY_TIMEOUT_MS || MENU_REPORT_TIMEOUT_MS * 2,
);

async function fetchMenuReportRows(params) {
	let res = await fetchPyCachedOptional('/api/analytics/menu-report', params, {
		timeoutMs: MENU_REPORT_TIMEOUT_MS,
	});
	let rows = res?.data?.data || [];
	if (rows.length > 0) return rows;

	res = await fetchPyCachedOptional('/api/analytics/menu-report', params, {
		timeoutMs: MENU_REPORT_RETRY_TIMEOUT_MS,
		skipCacheRead: true,
	});
	rows = res?.data?.data || [];
	return rows;
}

async function buildMenuReportBundle({ start_date, end_date, branchId = null }) {
	const params = { start_date, end_date };
	if (branchId != null && String(branchId).trim() !== '') {
		params.branch_id = String(branchId);
	}

	const [menuRows, dailyRes] = await Promise.all([
		fetchMenuReportRows(params),
		fetchPyCachedOptional('/api/analytics/daily-sales', params, {
			timeoutMs: BUNDLE_PYSERVER_TIMEOUT_MS,
		}),
	]);

	return {
		menuRows,
		dailySalesCurrent: dailyRes?.data?.data || [],
	};
}

module.exports = { buildMenuReportBundle };
