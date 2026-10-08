import type { ApiBranchSalesItem, ApiDailySalesItem, ApiMenuReportRow } from '../services/analyticsService';

export type SalesAnalyticsProfitDriver = {
  row: ApiMenuReportRow;
  profit: number;
  branchId: number | null;
  branchName: string;
};

export type SalesAnalyticsCachePayload = {
  dailySalesCurrent: ApiDailySalesItem[];
  dailySalesPrevious: ApiDailySalesItem[];
  branchSalesData: ApiBranchSalesItem[];
  profitDriversData: SalesAnalyticsProfitDriver[];
  reconAdjustCurrent: { byDate: Record<string, number>; total: number };
  reconAdjustPreviousTotal: number;
};

const SESSION_STORAGE_KEY = 'resto_sales_analytics_cache_v1';
const LOCAL_STORAGE_KEY = 'resto_sales_analytics_cache_v1_local';
const LOCAL_CACHE_TTL_MS = 30 * 1000;
const STALE_LOCAL_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 10;

const EMPTY_PAYLOAD: SalesAnalyticsCachePayload = {
  dailySalesCurrent: [],
  dailySalesPrevious: [],
  branchSalesData: [],
  profitDriversData: [],
  reconAdjustCurrent: { byDate: {}, total: 0 },
  reconAdjustPreviousTotal: 0,
};

type CacheStore = Record<string, { at: number; data: SalesAnalyticsCachePayload }>;

function readCacheStore(storage: Storage, storageKey: string): CacheStore | null {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    return JSON.parse(raw) as CacheStore;
  } catch {
    return null;
  }
}

function pruneCacheStore(store: CacheStore): CacheStore {
  const keys = Object.entries(store)
    .sort(([, a], [, b]) => b.at - a.at)
    .map(([k]) => k);
  for (const k of keys.slice(MAX_ENTRIES)) {
    delete store[k];
  }
  return store;
}

function writeCacheStore(storage: Storage, storageKey: string, store: CacheStore): void {
  storage.setItem(storageKey, JSON.stringify(pruneCacheStore(store)));
}

function payloadFromEntry(entry: SalesAnalyticsCachePayload): SalesAnalyticsCachePayload {
  return {
    ...EMPTY_PAYLOAD,
    ...entry,
    reconAdjustCurrent: entry.reconAdjustCurrent ?? { byDate: {}, total: 0 },
  };
}

export function buildSalesAnalyticsCacheKey(params: {
  start: string;
  end: string;
  branchId: string | null;
}): string {
  return `sa:${params.start}|${params.end}|${params.branchId ?? 'all'}`;
}

export function hasSalesAnalyticsCacheData(
  cached: SalesAnalyticsCachePayload | null,
): cached is SalesAnalyticsCachePayload {
  if (!cached) return false;
  const hasDaily = cached.dailySalesCurrent.some(
    (d) => Number(d.total_sales ?? d.net_sales ?? 0) > 0,
  );
  const hasBranch = cached.branchSalesData.some((b) => Number(b.total_sales ?? 0) > 0);
  return hasDaily || hasBranch || cached.profitDriversData.length > 0;
}

export function hasSalesAnalyticsCoreData(cached: SalesAnalyticsCachePayload): boolean {
  const hasDaily = cached.dailySalesCurrent.some(
    (d) => Number(d.total_sales ?? d.net_sales ?? 0) > 0,
  );
  const hasBranch = cached.branchSalesData.some((b) => Number(b.total_sales ?? 0) > 0);
  return hasDaily || hasBranch;
}

export function readSalesAnalyticsCache(key: string): SalesAnalyticsCachePayload | null {
  const now = Date.now();

  try {
    const sessionStore = readCacheStore(sessionStorage, SESSION_STORAGE_KEY);
    const sessionEntry = sessionStore?.[key];
    if (sessionEntry?.data) {
      return payloadFromEntry(sessionEntry.data);
    }
  } catch {
    // sessionStorage unavailable — fall through to localStorage
  }

  try {
    const localStore = readCacheStore(localStorage, LOCAL_STORAGE_KEY);
    const localEntry = localStore?.[key];
    if (!localEntry?.data) return null;
    if (now - localEntry.at > LOCAL_CACHE_TTL_MS) return null;
    return payloadFromEntry(localEntry.data);
  } catch {
    return null;
  }
}

export function readSalesAnalyticsCacheIncludingStale(
  key: string,
): SalesAnalyticsCachePayload | null {
  const now = Date.now();

  try {
    const sessionStore = readCacheStore(sessionStorage, SESSION_STORAGE_KEY);
    const sessionEntry = sessionStore?.[key];
    if (sessionEntry?.data) {
      return payloadFromEntry(sessionEntry.data);
    }
  } catch {
    // sessionStorage unavailable — fall through to localStorage
  }

  try {
    const localStore = readCacheStore(localStorage, LOCAL_STORAGE_KEY);
    const localEntry = localStore?.[key];
    if (!localEntry?.data) return null;
    if (now - localEntry.at > STALE_LOCAL_CACHE_TTL_MS) return null;
    return payloadFromEntry(localEntry.data);
  } catch {
    return null;
  }
}

export function writeSalesAnalyticsCache(key: string, data: SalesAnalyticsCachePayload): void {
  if (!hasSalesAnalyticsCacheData(data)) return;

  const entry = { at: Date.now(), data };

  try {
    const store = readCacheStore(sessionStorage, SESSION_STORAGE_KEY) ?? {};
    store[key] = entry;
    writeCacheStore(sessionStorage, SESSION_STORAGE_KEY, store);
  } catch {
    // sessionStorage full or unavailable — ignore
  }

  try {
    const store = readCacheStore(localStorage, LOCAL_STORAGE_KEY) ?? {};
    store[key] = entry;
    writeCacheStore(localStorage, LOCAL_STORAGE_KEY, store);
  } catch {
    // localStorage quota — ignore
  }
}

export function patchSalesAnalyticsCache(
  key: string,
  patch: Partial<SalesAnalyticsCachePayload>,
): void {
  const existing = readSalesAnalyticsCacheIncludingStale(key) ?? readSalesAnalyticsCache(key);
  const base = existing ?? EMPTY_PAYLOAD;
  writeSalesAnalyticsCache(key, {
    ...base,
    ...patch,
    dailySalesCurrent:
      patch.dailySalesCurrent && patch.dailySalesCurrent.length > 0
        ? patch.dailySalesCurrent
        : base.dailySalesCurrent,
    dailySalesPrevious:
      patch.dailySalesPrevious && patch.dailySalesPrevious.length > 0
        ? patch.dailySalesPrevious
        : base.dailySalesPrevious,
    branchSalesData:
      patch.branchSalesData && patch.branchSalesData.length > 0
        ? patch.branchSalesData
        : base.branchSalesData,
    profitDriversData:
      patch.profitDriversData && patch.profitDriversData.length > 0
        ? patch.profitDriversData
        : base.profitDriversData,
    reconAdjustCurrent: patch.reconAdjustCurrent ?? base.reconAdjustCurrent,
    reconAdjustPreviousTotal:
      patch.reconAdjustPreviousTotal != null
        ? patch.reconAdjustPreviousTotal
        : base.reconAdjustPreviousTotal,
  });
}
