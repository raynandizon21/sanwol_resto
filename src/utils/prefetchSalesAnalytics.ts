import { fetchSalesDashboardBundleApi } from '../services/analyticsService';
import {
  buildSalesAnalyticsCacheKey,
  hasSalesAnalyticsCacheData,
  readSalesAnalyticsCacheIncludingStale,
  writeSalesAnalyticsCache,
} from './salesAnalyticsCache';
import { getManilaMonthToDateRange } from './manilaDateTime';

const getCurrentMonthRange = (): { start: string; end: string } => getManilaMonthToDateRange();

let inFlightKey: string | null = null;
let inFlightPromise: Promise<void> | null = null;

export function buildDefaultSalesAnalyticsCacheKey(branchId: string | null): string {
  const range = getCurrentMonthRange();
  return buildSalesAnalyticsCacheKey({
    start: range.start,
    end: range.end,
    branchId,
  });
}

export function waitForSalesAnalyticsPrefetch(cacheKey: string): Promise<void> {
  if (hasSalesAnalyticsCacheData(readSalesAnalyticsCacheIncludingStale(cacheKey))) {
    return Promise.resolve();
  }
  if (inFlightKey === cacheKey && inFlightPromise) {
    return inFlightPromise;
  }
  return Promise.resolve();
}

/** Warms sales analytics client cache before SalesAnalytics mounts. */
export function prefetchSalesAnalyticsBundle(params?: {
  branchId?: string | null;
  start?: string;
  end?: string;
}): void {
  const current = getCurrentMonthRange();
  const start = params?.start || current.start;
  const end = params?.end || current.end;
  const branchId =
    params?.branchId != null && String(params.branchId).trim() !== '' && params.branchId !== 'all'
      ? String(params.branchId)
      : null;
  const key = buildSalesAnalyticsCacheKey({ start, end, branchId });

  if (hasSalesAnalyticsCacheData(readSalesAnalyticsCacheIncludingStale(key))) return;
  if (inFlightKey === key && inFlightPromise) return;

  inFlightKey = key;
  inFlightPromise = (async () => {
    try {
      const bundle = await fetchSalesDashboardBundleApi({
        start,
        end,
        branchId,
        profitBranchId: branchId,
      });

      if (hasSalesAnalyticsCacheData(readSalesAnalyticsCacheIncludingStale(key))) return;

      writeSalesAnalyticsCache(key, {
        dailySalesCurrent: bundle.dailySalesCurrent,
        dailySalesPrevious: bundle.dailySalesPrevious,
        branchSalesData: bundle.branchSalesData,
        profitDriversData: bundle.profitDriversData,
        reconAdjustCurrent: bundle.reconAdjustCurrent,
        reconAdjustPreviousTotal: bundle.reconAdjustPreviousTotal,
      });
    } catch (error) {
      console.warn('[prefetchSalesAnalyticsBundle] failed:', error);
    } finally {
      if (inFlightKey === key) {
        inFlightKey = null;
        inFlightPromise = null;
      }
    }
  })();
}

export function resolveSalesAnalyticsBranchId(
  permissions: number | undefined | null,
  branchId: string | null | undefined,
): string | null {
  if (Number(permissions) === 1) return null;
  const id = String(branchId ?? '').trim();
  if (!id || id === 'all') return null;
  return id;
}
