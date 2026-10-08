import { fetchBranchDashboardBundleApi } from '../services/analyticsService';
import type { OrderRecord } from '../services/orderService';
import {
  buildBranchDashboardCacheKey,
  clearKnownEmptyBranch,
  hasBranchDashboardCacheData,
  isBranchDashboardPayloadEmpty,
  isBranchDashboardPayloadIncomplete,
  readBranchDashboardCacheIncludingStale,
  writeBranchDashboardCache,
} from './branchDashboardCache';
import { getManilaMonthToDateRange } from './manilaDateTime';

const getCurrentMonthRange = (): { start: string; end: string } => getManilaMonthToDateRange();

let inFlightKey: string | null = null;
let inFlightPromise: Promise<void> | null = null;

export function buildDefaultBranchDashboardCacheKey(branchId: string): string {
  const range = getCurrentMonthRange();
  return buildBranchDashboardCacheKey({
    branchId,
    start: range.start,
    end: range.end,
  });
}

/** Await in-flight prefetch so Dashboard does not duplicate the bundle request. */
export function waitForBranchDashboardPrefetch(cacheKey: string): Promise<void> {
  if (hasBranchDashboardCacheData(readBranchDashboardCacheIncludingStale(cacheKey))) {
    return Promise.resolve();
  }
  if (inFlightKey === cacheKey && inFlightPromise) {
    return inFlightPromise;
  }
  return Promise.resolve();
}

/** Warms branch dashboard client cache before Dashboard mounts. */
export function prefetchBranchDashboardBundle(params: {
  branchId: string;
  start?: string;
  end?: string;
}): void {
  const branchId = String(params.branchId || '').trim();
  if (!branchId || branchId === 'all') return;

  const current = getCurrentMonthRange();
  const start = params.start || current.start;
  const end = params.end || current.end;
  const key = buildBranchDashboardCacheKey({ branchId, start, end });

  if (hasBranchDashboardCacheData(readBranchDashboardCacheIncludingStale(key))) return;
  if (inFlightKey === key && inFlightPromise) return;

  inFlightKey = key;
  inFlightPromise = (async () => {
    try {
      const bundle = await fetchBranchDashboardBundleApi({ branchId, start, end });

      if (hasBranchDashboardCacheData(readBranchDashboardCacheIncludingStale(key))) return;

      const payload = {
        dashboardData: bundle.dashboardData,
        topCategories: bundle.topCategories,
        trendingMenusData: bundle.trendingMenusData,
        recentOrders: bundle.recentOrders as OrderRecord[],
        recentOrderItemsMeta: bundle.recentOrderItemsMeta,
      };

      if (isBranchDashboardPayloadEmpty(payload)) return;
      if (isBranchDashboardPayloadIncomplete(payload)) return;

      clearKnownEmptyBranch(key);
      writeBranchDashboardCache(key, payload);
    } catch (error) {
      console.warn('[prefetchBranchDashboardBundle] failed:', error);
    } finally {
      if (inFlightKey === key) {
        inFlightKey = null;
        inFlightPromise = null;
      }
    }
  })();
}

export function shouldPrefetchBranchDashboard(
  permissions: number | undefined | null,
  branchId: string | null | undefined,
): boolean {
  if (Number(permissions) === 1) return false;
  const id = String(branchId ?? '').trim();
  return id.length > 0 && id !== 'all';
}
