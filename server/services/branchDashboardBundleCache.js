const { LRUCache } = require('lru-cache');
const { buildBranchDashboardBundle } = require('./branchDashboardBundle');
const { getManilaMonthToDateRange } = require('../utils/manilaMonthRange');

const CACHE_TTL_MS = Number(process.env.BRANCH_DASHBOARD_CACHE_TTL_MS || 30000);
const CACHE_MAX = Number(process.env.BRANCH_DASHBOARD_CACHE_MAX || 48);
const WARM_ATTEMPTS = Number(process.env.BRANCH_DASHBOARD_WARM_ATTEMPTS || 5);
const WARM_RETRY_MS = Number(process.env.BRANCH_DASHBOARD_WARM_RETRY_MS || 3000);
const WARM_INITIAL_DELAY_MS = Number(process.env.BRANCH_DASHBOARD_WARM_DELAY_MS || 2500);

const bundleCache = new LRUCache({ max: CACHE_MAX, ttl: CACHE_TTL_MS });

function isBranchDashboardBundleIncomplete(bundle) {
	if (!bundle) return false;
	const stats = bundle.dashboardData?.stats;
	const totalSales = Number(stats?.totalSales) || 0;
	const hasRevenue = (bundle.dashboardData?.revenueData?.length ?? 0) > 0;
	if (totalSales <= 0 && !hasRevenue) return false;

	const totalOrders = Number(stats?.totalOrders) || 0;
	const totalExpenses = Number(stats?.totalExpenses) || 0;
	if (totalOrders <= 0) return true;
	if (totalExpenses <= 0 && totalSales > 0) return true;
	return false;
}

function hasBranchDashboardBundleData(bundle) {
	if (!bundle) return false;
	if (isBranchDashboardBundleIncomplete(bundle)) return false;
	const stats = bundle.dashboardData?.stats;
	const hasStats =
		!!stats &&
		(stats.totalOrders > 0 ||
			stats.totalSales > 0 ||
			stats.totalExpenses > 0 ||
			(bundle.dashboardData?.revenueData?.length ?? 0) > 0);
	return (
		hasStats ||
		(bundle.topCategories?.length ?? 0) > 0 ||
		(bundle.trendingMenusData?.length ?? 0) > 0 ||
		(bundle.recentOrders?.length ?? 0) > 0
	);
}

function buildBranchDashboardBundleCacheKey({ start_date, end_date, branchId }) {
	const bid = branchId != null && String(branchId).trim() !== '' ? String(branchId) : '';
	return `${bid}|${start_date}|${end_date}`;
}

function getCachedBranchDashboardBundle(key) {
	const hit = bundleCache.get(key);
	if (!hit) return null;
	if (!hasBranchDashboardBundleData(hit)) {
		bundleCache.delete(key);
		return null;
	}
	return hit;
}

function setCachedBranchDashboardBundle(key, bundle) {
	if (!hasBranchDashboardBundleData(bundle) || isBranchDashboardBundleIncomplete(bundle)) return;
	bundleCache.set(key, bundle);
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

let warmInFlight = null;

async function warmBranchDashboardBundleForId(branchId, opts = {}) {
	const { start_date, end_date } = getCurrentMonthRange();
	const key = buildBranchDashboardBundleCacheKey({ start_date, end_date, branchId });

	const existing = getCachedBranchDashboardBundle(key);
	if (existing) return existing;

	for (let attempt = 1; attempt <= WARM_ATTEMPTS; attempt++) {
		const bundle = await buildBranchDashboardBundle({
			branchId,
			start_date,
			end_date,
		});

		if (hasBranchDashboardBundleData(bundle) && !isBranchDashboardBundleIncomplete(bundle)) {
			setCachedBranchDashboardBundle(key, bundle);
			return bundle;
		}

		if (attempt < WARM_ATTEMPTS && !opts.skipRetry) {
			await delay(WARM_RETRY_MS);
		}
	}

	return null;
}

/**
 * Warm branch dashboard bundles for configured branch ids (current month).
 */
async function warmBranchDashboardBundles(opts = {}) {
	const enabled =
		String(process.env.BRANCH_DASHBOARD_WARM_ON_BOOT ?? 'false').toLowerCase() === 'true';
	if (!enabled && !opts.force) return;

	const branchIds = getWarmBranchIds();
	if (branchIds.length === 0) return;

	if (warmInFlight) return warmInFlight;

	warmInFlight = (async () => {
		try {
			if (WARM_INITIAL_DELAY_MS > 0) {
				await delay(WARM_INITIAL_DELAY_MS);
			}

			let warmed = 0;
			for (const branchId of branchIds) {
				const bundle = await warmBranchDashboardBundleForId(branchId, { skipRetry: false });
				if (bundle) warmed += 1;
			}

			if (warmed > 0) {
				console.log(`[BranchDashboardCache] Warmed ${warmed}/${branchIds.length} branch bundle(s)`);
			} else {
				console.warn('[BranchDashboardCache] Warm finished without branch data (PyServer may still be starting)');
			}
		} catch (err) {
			console.warn('[BranchDashboardCache] Warm failed:', err?.message || err);
		} finally {
			warmInFlight = null;
		}
	})();

	return warmInFlight;
}

module.exports = {
	buildBranchDashboardBundleCacheKey,
	getCachedBranchDashboardBundle,
	setCachedBranchDashboardBundle,
	hasBranchDashboardBundleData,
	isBranchDashboardBundleIncomplete,
	warmBranchDashboardBundles,
	getCurrentMonthRange,
};
