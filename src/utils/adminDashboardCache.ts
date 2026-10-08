import type { BranchPerformanceData } from '../components/dashboard/BranchPerformanceCard';

export type AdminDashboardTrendPeriod = 'weekly' | 'monthly' | 'yearly';

export type AdminDashboardTrendPoint = {
  name: string;
  totalSales: number;
  totalExpenses: number;
  date?: string;
};

export type BranchChartsCacheEntry = {
  trendMonthly: AdminDashboardTrendPoint[];
  topProducts: { name: string; sales: number }[];
};

export type AdminDashboardCachePayload = {
  summary?: {
    totalSales: number;
    totalExpenses: number;
    totalRevenue: number;
  };
  branchCardsData: BranchPerformanceData[];
  branchRevenueDistribution: { name: string; value: number }[];
  topProductsData: { name: string; sales: number }[];
  expenseCategoryByBranch: Record<number, Record<string, number>>;
  expenseRentByBranch?: Record<number, number>;
  expenseSalaryByBranch?: Record<number, number>;
  trendByPeriod: Partial<Record<AdminDashboardTrendPeriod, AdminDashboardTrendPoint[]>>;
  /** Per-branch monthly trend + top products for instant branch-card focus. */
  branchChartsById?: Record<string, BranchChartsCacheEntry>;
};

const SESSION_STORAGE_KEY = 'resto_admin_dashboard_cache_v1';
const LOCAL_STORAGE_KEY = 'resto_admin_dashboard_cache_v1_local';
/** Short TTL — financial KPIs must not diverge across users for hours. */
const LOCAL_CACHE_TTL_MS = 30 * 1000;
/** Instant paint only; always revalidate on mount (see AdminDashboard). */
const STALE_LOCAL_CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Almost never skip refresh — live MTD sales change continuously.
 * Tiny window only avoids duplicate fetch right after prefetch write.
 */
export const ADMIN_DASHBOARD_BG_REFRESH_TTL_MS = 10 * 1000;
const MAX_ENTRIES = 10;

const EMPTY_PAYLOAD: AdminDashboardCachePayload = {
  branchCardsData: [],
  branchRevenueDistribution: [],
  topProductsData: [],
  expenseCategoryByBranch: {},
  trendByPeriod: {},
};

type CacheStore = Record<string, { at: number; data: AdminDashboardCachePayload }>;

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

export function buildAdminDashboardCacheKey(params: {
  start: string;
  end: string;
  branchId: string | null;
}): string {
  return `ad:${params.start}|${params.end}|${params.branchId ?? 'all'}`;
}

export function hasAdminDashboardCacheData(
  cached: AdminDashboardCachePayload | null,
): cached is AdminDashboardCachePayload {
  if (!cached) return false;
  const hasTrend = Object.values(cached.trendByPeriod ?? {}).some((rows) => (rows?.length ?? 0) > 0);
  return (
    cached.branchCardsData.length > 0 ||
    cached.branchRevenueDistribution.length > 0 ||
    cached.topProductsData.length > 0 ||
    hasTrend
  );
}

function payloadFromEntry(entry: AdminDashboardCachePayload): AdminDashboardCachePayload {
  return {
    ...EMPTY_PAYLOAD,
    ...entry,
    trendByPeriod: entry.trendByPeriod ?? {},
  };
}

export function readAdminDashboardCache(key: string): AdminDashboardCachePayload | null {
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

/** Fresh session cache, or local cache up to STALE_LOCAL_CACHE_TTL_MS (stale-while-revalidate). */
export function readAdminDashboardCacheIncludingStale(
  key: string,
): AdminDashboardCachePayload | null {
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

/** Age of cached entry in ms, or null if missing. Checks session then local. */
export function getAdminDashboardCacheAgeMs(key: string): number | null {
  const now = Date.now();
  try {
    const sessionStore = readCacheStore(sessionStorage, SESSION_STORAGE_KEY);
    const sessionEntry = sessionStore?.[key];
    if (sessionEntry?.data && typeof sessionEntry.at === 'number') {
      return Math.max(0, now - sessionEntry.at);
    }
  } catch {
    // ignore
  }
  try {
    const localStore = readCacheStore(localStorage, LOCAL_STORAGE_KEY);
    const localEntry = localStore?.[key];
    if (localEntry?.data && typeof localEntry.at === 'number') {
      return Math.max(0, now - localEntry.at);
    }
  } catch {
    // ignore
  }
  return null;
}

/** True when cache is young enough to skip a background network refresh. */
export function isAdminDashboardCacheFresh(
  key: string,
  maxAgeMs: number = ADMIN_DASHBOARD_BG_REFRESH_TTL_MS,
): boolean {
  const age = getAdminDashboardCacheAgeMs(key);
  return age != null && age < maxAgeMs;
}

export function writeAdminDashboardCache(key: string, data: AdminDashboardCachePayload): void {
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

/** Merge partial updates without dropping other cached sections (e.g. trend vs branch cards). */
export function patchAdminDashboardCache(
  key: string,
  patch: Partial<Omit<AdminDashboardCachePayload, 'trendByPeriod'>> & {
    trendByPeriod?: Partial<Record<AdminDashboardTrendPeriod, AdminDashboardTrendPoint[]>>;
  },
): void {
  const existing = readAdminDashboardCacheIncludingStale(key) ?? readAdminDashboardCache(key);
  const base = existing ?? EMPTY_PAYLOAD;
  writeAdminDashboardCache(key, {
    ...base,
    ...patch,
    branchCardsData:
      patch.branchCardsData && patch.branchCardsData.length > 0
        ? patch.branchCardsData
        : base.branchCardsData,
    branchRevenueDistribution:
      patch.branchRevenueDistribution && patch.branchRevenueDistribution.length > 0
        ? patch.branchRevenueDistribution
        : base.branchRevenueDistribution,
    topProductsData:
      patch.topProductsData && patch.topProductsData.length > 0
        ? patch.topProductsData
        : base.topProductsData,
    expenseCategoryByBranch:
      patch.expenseCategoryByBranch && Object.keys(patch.expenseCategoryByBranch).length > 0
        ? patch.expenseCategoryByBranch
        : base.expenseCategoryByBranch,
    expenseRentByBranch:
      patch.expenseRentByBranch && Object.keys(patch.expenseRentByBranch).length > 0
        ? patch.expenseRentByBranch
        : base.expenseRentByBranch,
    expenseSalaryByBranch:
      patch.expenseSalaryByBranch && Object.keys(patch.expenseSalaryByBranch).length > 0
        ? patch.expenseSalaryByBranch
        : base.expenseSalaryByBranch,
    trendByPeriod: {
      ...base.trendByPeriod,
      ...(patch.trendByPeriod ?? {}),
    },
    branchChartsById: patch.branchChartsById
      ? { ...base.branchChartsById, ...patch.branchChartsById }
      : base.branchChartsById,
  });
}
