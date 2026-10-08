import {
  buildAnalyticsReportCacheKey,
  getCurrentMonthRange,
  readAnalyticsReportCacheIncludingStale,
  writeAnalyticsReportCache,
} from './analyticsReportCache';
import {
  fetchCategoryReportApi,
  fetchMenuReportBundleApi,
} from '../services/analyticsService';
import type { ApiCategoryReportRow, ApiDailySalesItem, ApiMenuReportRow } from '../services/analyticsService';

type ReportId = 'menu' | 'category';

const inFlight = new Map<string, Promise<void>>();

function buildDefaultKey(report: ReportId, branchId: string | null, start?: string, end?: string) {
  const range = getCurrentMonthRange();
  return buildAnalyticsReportCacheKey(report, {
    start: start || range.start,
    end: end || range.end,
    branchId,
  });
}

export function waitForAnalyticsReportPrefetch(report: ReportId, cacheKey: string): Promise<void> {
  const flightKey = `${report}:${cacheKey}`;
  if (readAnalyticsReportCacheIncludingStale(report, cacheKey)) {
    return Promise.resolve();
  }
  return inFlight.get(flightKey) ?? Promise.resolve();
}

type MenuReportCachePayload = {
  rows: Array<{
    id: string;
    goods: string;
    branch: string;
    salesQty: number;
    totalSales: number;
    netSales: number;
  }>;
  dailySalesCurrent: ApiDailySalesItem[];
};

function hasMenuPrefetchData(cached: MenuReportCachePayload | null): boolean {
  return !!cached && (cached.rows.length > 0 || cached.dailySalesCurrent.length > 0);
}

function mapMenuRows(apiRows: ApiMenuReportRow[], branchName: string): MenuReportCachePayload['rows'] {
  return apiRows.map((row) => ({
    id: String(row.id),
    goods: row.goods,
    branch: row.branch || branchName,
    salesQty: row.salesQty,
    totalSales: row.totalSales,
    netSales: row.netSales,
  }));
}

export function prefetchMenuReportBundle(params?: {
  branchId?: string | null;
  start?: string;
  end?: string;
  branchName?: string;
}): void {
  const range = getCurrentMonthRange();
  const start = params?.start || range.start;
  const end = params?.end || range.end;
  const branchId =
    params?.branchId != null && String(params.branchId).trim() !== '' && params.branchId !== 'all'
      ? String(params.branchId)
      : null;
  const cacheKey = buildDefaultKey('menu', branchId, start, end);
  const flightKey = `menu:${cacheKey}`;

  const existing = readAnalyticsReportCacheIncludingStale<MenuReportCachePayload>('menu', cacheKey);
  if (hasMenuPrefetchData(existing)) return;
  if (inFlight.has(flightKey)) return;

  const promise = (async () => {
    try {
      const bundle = await fetchMenuReportBundleApi({
        start,
        end,
        branchId,
      });
      const payload: MenuReportCachePayload = {
        rows: mapMenuRows(bundle.menuRows, params?.branchName || 'All Branches'),
        dailySalesCurrent: bundle.dailySalesCurrent,
      };
      if (!hasMenuPrefetchData(payload)) return;
      if (hasMenuPrefetchData(readAnalyticsReportCacheIncludingStale('menu', cacheKey))) return;
      writeAnalyticsReportCache('menu', cacheKey, payload);
    } catch (error) {
      console.warn('[prefetchMenuReportBundle] failed:', error);
    } finally {
      inFlight.delete(flightKey);
    }
  })();

  inFlight.set(flightKey, promise);
}

type CategoryReportCachePayload = {
  rows: Array<{
    id: string;
    category: string;
    branch: string;
    salesQty: number;
    totalSales: number;
  }>;
};

function hasCategoryPrefetchData(cached: CategoryReportCachePayload | null): boolean {
  return !!cached && cached.rows.length > 0;
}

export function prefetchCategoryReportBundle(params?: {
  branchId?: string | null;
  start?: string;
  end?: string;
  branchName?: string;
}): void {
  const range = getCurrentMonthRange();
  const start = params?.start || range.start;
  const end = params?.end || range.end;
  const branchId =
    params?.branchId != null && String(params.branchId).trim() !== '' && params.branchId !== 'all'
      ? String(params.branchId)
      : null;
  const cacheKey = buildDefaultKey('category', branchId, start, end);
  const flightKey = `category:${cacheKey}`;

  const existing = readAnalyticsReportCacheIncludingStale<CategoryReportCachePayload>('category', cacheKey);
  if (hasCategoryPrefetchData(existing)) return;
  if (inFlight.has(flightKey)) return;

  const promise = (async () => {
    try {
      const qs = new URLSearchParams();
      qs.set('start_date', start);
      qs.set('end_date', end);
      if (branchId) qs.set('branch_id', branchId);

      const apiRows: ApiCategoryReportRow[] = await fetchCategoryReportApi(qs);
      const payload: CategoryReportCachePayload = {
        rows: apiRows.map((row) => ({
          id: String(row.id),
          category: row.category,
          branch: row.branch || params?.branchName || 'All Branches',
          salesQty: row.salesQty,
          totalSales: row.totalSales,
        })),
      };
      if (!hasCategoryPrefetchData(payload)) return;
      if (hasCategoryPrefetchData(readAnalyticsReportCacheIncludingStale('category', cacheKey))) return;
      writeAnalyticsReportCache('category', cacheKey, payload);
    } catch (error) {
      console.warn('[prefetchCategoryReportBundle] failed:', error);
    } finally {
      inFlight.delete(flightKey);
    }
  })();

  inFlight.set(flightKey, promise);
}

export function prefetchMenuAndCategoryReports(params?: {
  branchId?: string | null;
  branchName?: string;
}): void {
  prefetchMenuReportBundle(params);
  prefetchCategoryReportBundle(params);
}
