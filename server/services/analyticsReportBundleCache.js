const { LRUCache } = require('lru-cache');
const { buildMenuReportBundle } = require('./menuReportBundle');
const { fetchPyCachedOptional } = require('./analyticsPyFetch');
const { getManilaMonthToDateRange } = require('../utils/manilaMonthRange');

const CACHE_TTL_MS = Number(process.env.ANALYTICS_REPORT_CACHE_TTL_MS || 30000);
const CACHE_MAX = Number(process.env.ANALYTICS_REPORT_CACHE_MAX || 64);
const WARM_ATTEMPTS = Number(process.env.ANALYTICS_REPORT_WARM_ATTEMPTS || 5);
const WARM_RETRY_MS = Number(process.env.ANALYTICS_REPORT_WARM_RETRY_MS || 3000);
const WARM_INITIAL_DELAY_MS = Number(process.env.ANALYTICS_REPORT_WARM_DELAY_MS || 3000);
const MENU_REPORT_TIMEOUT_MS = Number(process.env.MENU_REPORT_TIMEOUT_MS || 25000);
const MENU_REPORT_RETRY_TIMEOUT_MS = Number(
	process.env.MENU_REPORT_RETRY_TIMEOUT_MS || MENU_REPORT_TIMEOUT_MS * 2,
);

const reportCache = new LRUCache({ max: CACHE_MAX, ttl: CACHE_TTL_MS });

function buildAnalyticsReportBundleCacheKey(report, { start_date, end_date, branchId }) {
	const bid = branchId != null && String(branchId).trim() !== '' ? String(branchId) : 'all';
	return `${report}|${bid}|${start_date}|${end_date}`;
}

function getCachedAnalyticsReportBundle(key) {
	const hit = reportCache.get(key);
	if (!hit) return null;
	if (key.startsWith('menu|')) {
		if (!hasMenuReportBundleData(hit)) {
			reportCache.delete(key);
			return null;
		}
	} else if (key.startsWith('category|')) {
		if (!hasCategoryReportData(hit)) {
			reportCache.delete(key);
			return null;
		}
	}
	return hit;
}

function setCachedAnalyticsReportBundle(key, payload, hasDataFn) {
	if (!hasDataFn(payload)) return;
	reportCache.set(key, payload);
}

function getCurrentMonthRange() {
	return getManilaMonthToDateRange();
}

function getWarmBranchIds() {
	const multiRaw = (process.env.CACHE_WARM_BRANCH_IDS || '').trim();
	if (multiRaw) {
		return multiRaw
			.split(',')
			.map((s) => s.trim())
			.filter((id) => id && /^\d+$/.test(id));
	}
	return [];
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasMenuReportBundleData(bundle) {
	return (bundle?.menuRows?.length ?? 0) > 0 || (bundle?.dailySalesCurrent?.length ?? 0) > 0;
}

function hasCategoryReportData(rows) {
	return Array.isArray(rows) && rows.length > 0;
}

async function fetchCategoryReportRows(start_date, end_date, branchId) {
	const params = { start_date, end_date };
	if (branchId) params.branch_id = String(branchId);

	let res = await fetchPyCachedOptional('/api/analytics/category-report', params, {
		timeoutMs: MENU_REPORT_TIMEOUT_MS,
	});
	let rows = res?.data?.data || [];
	if (rows.length > 0) return rows;

	res = await fetchPyCachedOptional('/api/analytics/category-report', params, {
		timeoutMs: MENU_REPORT_RETRY_TIMEOUT_MS,
		skipCacheRead: true,
	});
	return res?.data?.data || [];
}

async function getOrBuildMenuReportBundle({ start_date, end_date, branchId }) {
	const key = buildAnalyticsReportBundleCacheKey('menu', { start_date, end_date, branchId });
	const cached = getCachedAnalyticsReportBundle(key);
	if (cached) return cached;

	const bundle = await buildMenuReportBundle({ start_date, end_date, branchId });
	setCachedAnalyticsReportBundle(key, bundle, hasMenuReportBundleData);
	return bundle;
}

async function getOrBuildCategoryReportRows({ start_date, end_date, branchId }) {
	const key = buildAnalyticsReportBundleCacheKey('category', { start_date, end_date, branchId });
	const cached = getCachedAnalyticsReportBundle(key);
	if (cached) return cached;

	const rows = await fetchCategoryReportRows(start_date, end_date, branchId);
	setCachedAnalyticsReportBundle(key, rows, hasCategoryReportData);
	return rows;
}

let warmInFlight = null;

async function warmAnalyticsReports(opts = {}) {
	const enabled =
		String(process.env.ANALYTICS_REPORT_WARM_ON_BOOT ?? 'false').toLowerCase() === 'true';
	if (!enabled && !opts.force) return;

	if (warmInFlight) return warmInFlight;

	warmInFlight = (async () => {
		try {
			if (WARM_INITIAL_DELAY_MS > 0) {
				await delay(WARM_INITIAL_DELAY_MS);
			}

			const { start_date, end_date } = getCurrentMonthRange();
			let warmed = 0;

			for (let attempt = 1; attempt <= WARM_ATTEMPTS; attempt++) {
				const menuBundle = await getOrBuildMenuReportBundle({
					start_date,
					end_date,
					branchId: null,
				});
				if (hasMenuReportBundleData(menuBundle)) {
					warmed += 1;
					break;
				}
				if (attempt < WARM_ATTEMPTS) await delay(WARM_RETRY_MS);
			}

			for (let attempt = 1; attempt <= WARM_ATTEMPTS; attempt++) {
				const categoryRows = await getOrBuildCategoryReportRows({
					start_date,
					end_date,
					branchId: null,
				});
				if (hasCategoryReportData(categoryRows)) {
					warmed += 1;
					break;
				}
				if (attempt < WARM_ATTEMPTS) await delay(WARM_RETRY_MS);
			}

			for (const branchId of getWarmBranchIds()) {
				const menuBundle = await getOrBuildMenuReportBundle({
					start_date,
					end_date,
					branchId,
				});
				if (hasMenuReportBundleData(menuBundle)) warmed += 1;

				const categoryRows = await getOrBuildCategoryReportRows({
					start_date,
					end_date,
					branchId,
				});
				if (hasCategoryReportData(categoryRows)) warmed += 1;
			}

			if (warmed > 0) {
				console.log(`[AnalyticsReportCache] Warmed ${warmed} menu/category report cache entries`);
			} else {
				console.warn('[AnalyticsReportCache] Warm finished without report data (PyServer may still be starting)');
			}
		} catch (err) {
			console.warn('[AnalyticsReportCache] Warm failed:', err?.message || err);
		} finally {
			warmInFlight = null;
		}
	})();

	return warmInFlight;
}

module.exports = {
	buildAnalyticsReportBundleCacheKey,
	getCachedAnalyticsReportBundle,
	setCachedAnalyticsReportBundle,
	hasMenuReportBundleData,
	hasCategoryReportData,
	getOrBuildMenuReportBundle,
	getOrBuildCategoryReportRows,
	warmAnalyticsReports,
};
