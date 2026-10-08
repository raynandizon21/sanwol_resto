const { LRUCache } = require('lru-cache');
const { buildSalesDashboardBundle } = require('./salesDashboardBundle');
const { getManilaMonthToDateRange } = require('../utils/manilaMonthRange');

const CACHE_TTL_MS = Number(process.env.SALES_DASHBOARD_CACHE_TTL_MS || 30000);
const CACHE_MAX = Number(process.env.SALES_DASHBOARD_CACHE_MAX || 48);
const WARM_ATTEMPTS = Number(process.env.SALES_DASHBOARD_WARM_ATTEMPTS || 5);
const WARM_RETRY_MS = Number(process.env.SALES_DASHBOARD_WARM_RETRY_MS || 3000);
const WARM_INITIAL_DELAY_MS = Number(process.env.SALES_DASHBOARD_WARM_DELAY_MS || 2500);

const bundleCache = new LRUCache({ max: CACHE_MAX, ttl: CACHE_TTL_MS });

function hasSalesDashboardBundleData(bundle) {
	if (!bundle) return false;
	const hasDaily = (bundle.dailySalesCurrent || []).some(
		(d) => Number(d?.total_sales ?? d?.net_sales ?? 0) > 0,
	);
	const hasBranch = (bundle.branchSalesData || []).some((b) => Number(b?.total_sales ?? 0) > 0);
	return hasDaily || hasBranch || (bundle.profitDriversData?.length ?? 0) > 0;
}

function buildSalesDashboardBundleCacheKey({
	start_date,
	end_date,
	branchId,
	profitBranchId,
}) {
	const bid = branchId != null && String(branchId).trim() !== '' ? String(branchId) : 'all';
	const profit =
		profitBranchId != null && String(profitBranchId).trim() !== ''
			? String(profitBranchId)
			: 'none';
	return `${bid}|${start_date}|${end_date}|${profit}`;
}

function getCachedSalesDashboardBundle(key) {
	const hit = bundleCache.get(key);
	if (!hit) return null;
	if (!hasSalesDashboardBundleData(hit)) {
		bundleCache.delete(key);
		return null;
	}
	return hit;
}

function setCachedSalesDashboardBundle(key, bundle) {
	if (!hasSalesDashboardBundleData(bundle)) return;
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

async function warmSalesDashboardBundleForScope({ start_date, end_date, branchId, profitBranchId }) {
	const key = buildSalesDashboardBundleCacheKey({
		start_date,
		end_date,
		branchId,
		profitBranchId,
	});

	const existing = getCachedSalesDashboardBundle(key);
	if (existing) return existing;

	for (let attempt = 1; attempt <= WARM_ATTEMPTS; attempt++) {
		const bundle = await buildSalesDashboardBundle({
			start_date,
			end_date,
			branchId,
			profitBranchId,
			branchNameFallback: branchId ? `Branch #${branchId}` : 'All Branches',
		});

		if (hasSalesDashboardBundleData(bundle)) {
			setCachedSalesDashboardBundle(key, bundle);
			return bundle;
		}

		if (attempt < WARM_ATTEMPTS) {
			await delay(WARM_RETRY_MS);
		}
	}

	return null;
}

async function warmSalesDashboardBundles(opts = {}) {
	const enabled =
		String(process.env.SALES_DASHBOARD_WARM_ON_BOOT ?? 'false').toLowerCase() === 'true';
	if (!enabled && !opts.force) return;

	if (warmInFlight) return warmInFlight;

	warmInFlight = (async () => {
		try {
			if (WARM_INITIAL_DELAY_MS > 0) {
				await delay(WARM_INITIAL_DELAY_MS);
			}

			const { start_date, end_date } = getCurrentMonthRange();
			let warmed = 0;

			const allBundle = await warmSalesDashboardBundleForScope({
				start_date,
				end_date,
				branchId: null,
				profitBranchId: null,
			});
			if (allBundle) warmed += 1;

			for (const branchId of getWarmBranchIds()) {
				const bundle = await warmSalesDashboardBundleForScope({
					start_date,
					end_date,
					branchId,
					profitBranchId: branchId,
				});
				if (bundle) warmed += 1;
			}

			if (warmed > 0) {
				console.log(`[SalesDashboardCache] Warmed ${warmed} sales analytics bundle(s)`);
			} else {
				console.warn('[SalesDashboardCache] Warm finished without sales data (PyServer may still be starting)');
			}
		} catch (err) {
			console.warn('[SalesDashboardCache] Warm failed:', err?.message || err);
		} finally {
			warmInFlight = null;
		}
	})();

	return warmInFlight;
}

module.exports = {
	buildSalesDashboardBundleCacheKey,
	getCachedSalesDashboardBundle,
	setCachedSalesDashboardBundle,
	hasSalesDashboardBundleData,
	warmSalesDashboardBundles,
	getCurrentMonthRange,
};
