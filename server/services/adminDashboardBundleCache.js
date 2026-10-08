const { LRUCache } = require('lru-cache');
const { buildAdminDashboardBundle } = require('./adminDashboardBundle');
const { getManilaMonthToDateRange } = require('../utils/manilaMonthRange');

const CACHE_TTL_MS = Number(process.env.ADMIN_DASHBOARD_CACHE_TTL_MS || 30000);
const CACHE_MAX = Number(process.env.ADMIN_DASHBOARD_CACHE_MAX || 32);
const WARM_ATTEMPTS = Number(process.env.ADMIN_DASHBOARD_WARM_ATTEMPTS || 5);
const WARM_RETRY_MS = Number(process.env.ADMIN_DASHBOARD_WARM_RETRY_MS || 3000);
const WARM_INITIAL_DELAY_MS = Number(process.env.ADMIN_DASHBOARD_WARM_DELAY_MS || 2000);

const bundleCache = new LRUCache({ max: CACHE_MAX, ttl: CACHE_TTL_MS });

function hasAdminDashboardBundleData(bundle) {
	if (!bundle) return false;
	const hasTrend =
		Array.isArray(bundle.trendData) &&
		bundle.trendData.some(
			(row) => (Number(row?.totalSales) || 0) > 0 || (Number(row?.totalExpenses) || 0) > 0,
		);
	return (
		(bundle.branchCardsData?.length ?? 0) > 0 ||
		(bundle.branchRevenueDistribution?.length ?? 0) > 0 ||
		(bundle.topProductsData?.length ?? 0) > 0 ||
		hasTrend
	);
}

function buildAdminDashboardBundleCacheKey({
	start_date,
	end_date,
	branchId,
	period,
	include_branch_charts,
	mode = 'full',
}) {
	const bid =
		branchId != null && String(branchId).trim() !== '' ? String(branchId) : 'all';
	const modeKey = String(mode || 'full').toLowerCase() === 'compare' || String(mode || '').toLowerCase() === 'slim'
		? 'compare'
		: 'full';
	return `${start_date}|${end_date}|${bid}|${period || 'monthly'}|${include_branch_charts ? '1' : '0'}|${modeKey}`;
}

function getCachedAdminDashboardBundle(key) {
	const hit = bundleCache.get(key);
	if (!hit) return null;
	if (!hasAdminDashboardBundleData(hit)) {
		bundleCache.delete(key);
		return null;
	}
	return hit;
}

function setCachedAdminDashboardBundle(key, bundle) {
	if (!hasAdminDashboardBundleData(bundle)) return;
	bundleCache.set(key, bundle);
}

function getCurrentMonthRange() {
	return getManilaMonthToDateRange();
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let warmInFlight = null;

/**
 * Pre-build the default admin dashboard bundle after server boot (current month, all branches).
 * Retries when PyServer is still starting — never caches an empty payload.
 */
async function warmAdminDashboardBundle(opts = {}) {
	const enabled =
		String(process.env.ADMIN_DASHBOARD_WARM_ON_BOOT ?? 'true').toLowerCase() !== 'false';
	if (!enabled && !opts.force) return null;

	const { start_date, end_date } = getCurrentMonthRange();
	const key = buildAdminDashboardBundleCacheKey({
		start_date,
		end_date,
		branchId: null,
		period: 'monthly',
		include_branch_charts: false,
	});

	const existing = getCachedAdminDashboardBundle(key);
	if (existing) return existing;

	if (warmInFlight) return warmInFlight;

	warmInFlight = (async () => {
		try {
			if (WARM_INITIAL_DELAY_MS > 0) {
				await delay(WARM_INITIAL_DELAY_MS);
			}

			for (let attempt = 1; attempt <= WARM_ATTEMPTS; attempt++) {
				const bundle = await buildAdminDashboardBundle({
					start_date,
					end_date,
					branchId: null,
					period: 'monthly',
					include_branch_charts: false,
				});

				if (hasAdminDashboardBundleData(bundle)) {
					setCachedAdminDashboardBundle(key, bundle);
					console.log('[AdminDashboardCache] Warmed default bundle');
					return bundle;
				}

				if (attempt < WARM_ATTEMPTS) {
					await delay(WARM_RETRY_MS);
				}
			}

			console.warn('[AdminDashboardCache] Warm finished without branch data (PyServer may still be starting)');
			return null;
		} catch (err) {
			console.warn('[AdminDashboardCache] Warm failed:', err?.message || err);
			return null;
		} finally {
			warmInFlight = null;
		}
	})();

	return warmInFlight;
}

module.exports = {
	buildAdminDashboardBundleCacheKey,
	getCachedAdminDashboardBundle,
	setCachedAdminDashboardBundle,
	hasAdminDashboardBundleData,
	warmAdminDashboardBundle,
	getCurrentMonthRange,
};
