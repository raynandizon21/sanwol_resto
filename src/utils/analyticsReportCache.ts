import { getManilaMonthToDateRange } from './manilaDateTime';

type CacheStore = Record<string, { at: number; data: unknown }>;

const SESSION_KEYS: Record<string, string> = {
  menu: 'resto_menu_report_cache_v1',
  category: 'resto_category_report_cache_v1',
  payment: 'resto_payment_report_cache_v1',
  receipt: 'resto_receipt_report_cache_v1',
};

const LOCAL_KEYS: Record<string, string> = {
  menu: 'resto_menu_report_cache_v1_local',
  category: 'resto_category_report_cache_v1_local',
  payment: 'resto_payment_report_cache_v1_local',
  receipt: 'resto_receipt_report_cache_v1_local',
};

const LOCAL_CACHE_TTL_MS = 30 * 1000;
const STALE_LOCAL_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 10;

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

function readEntry<T>(
  report: keyof typeof SESSION_KEYS,
  key: string,
  maxAgeMs: number | null,
): T | null {
  const now = Date.now();

  try {
    const sessionStore = readCacheStore(sessionStorage, SESSION_KEYS[report]);
    const sessionEntry = sessionStore?.[key];
    if (sessionEntry?.data != null) {
      return sessionEntry.data as T;
    }
  } catch {
    // fall through
  }

  if (maxAgeMs == null) return null;

  try {
    const localStore = readCacheStore(localStorage, LOCAL_KEYS[report]);
    const localEntry = localStore?.[key];
    if (localEntry?.data == null) return null;
    if (now - localEntry.at > maxAgeMs) return null;
    return localEntry.data as T;
  } catch {
    return null;
  }
}

export function buildAnalyticsReportCacheKey(
  prefix: string,
  params: {
    start: string;
    end: string;
    branchId: string | null;
    extra?: string;
  },
): string {
  const branch = params.branchId ?? 'all';
  const extra = params.extra ? `|${params.extra}` : '';
  return `${prefix}:${params.start}|${params.end}|${branch}${extra}`;
}

export function readAnalyticsReportCache<T>(report: keyof typeof SESSION_KEYS, key: string): T | null {
  return readEntry<T>(report, key, LOCAL_CACHE_TTL_MS);
}

export function readAnalyticsReportCacheIncludingStale<T>(
  report: keyof typeof SESSION_KEYS,
  key: string,
): T | null {
  return readEntry<T>(report, key, STALE_LOCAL_CACHE_TTL_MS);
}

export function writeAnalyticsReportCache<T>(
  report: keyof typeof SESSION_KEYS,
  key: string,
  data: T,
): void {
  const entry = { at: Date.now(), data };

  try {
    const store = readCacheStore(sessionStorage, SESSION_KEYS[report]) ?? {};
    store[key] = entry;
    writeCacheStore(sessionStorage, SESSION_KEYS[report], store);
  } catch {
    // ignore
  }

  try {
    const store = readCacheStore(localStorage, LOCAL_KEYS[report]) ?? {};
    store[key] = entry;
    writeCacheStore(localStorage, LOCAL_KEYS[report], store);
  } catch {
    // ignore
  }
}

export function hasNonEmptyRows<T extends { totalSales?: number; netAmount?: number; total?: number }>(
  rows: T[] | null | undefined,
  valueKey: 'totalSales' | 'netAmount' | 'total' = 'totalSales',
): boolean {
  if (!rows?.length) return false;
  return rows.some((r) => Number(r[valueKey] ?? 0) !== 0 || rows.length > 1);
}

export function getCurrentMonthRange(): { start: string; end: string } {
  return getManilaMonthToDateRange();
}
