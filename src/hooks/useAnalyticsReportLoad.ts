import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  buildAnalyticsReportCacheKey,
  readAnalyticsReportCacheIncludingStale,
  writeAnalyticsReportCache,
} from '../utils/analyticsReportCache';
import { waitForAnalyticsReportPrefetch } from '../utils/prefetchAnalyticsReports';

type ReportCacheId = 'menu' | 'category' | 'payment' | 'receipt';

type HydrateOptions = { background?: boolean };

type UseAnalyticsReportLoadOptions<T> = {
  report: ReportCacheId;
  dateRange: { start: string; end: string };
  branchId: string | null;
  cacheExtra?: string;
  hasCacheData: (cached: T | null) => boolean;
  fetchData: () => Promise<T>;
  onHydrate: (cached: T, options?: HydrateOptions) => void;
  onClear: () => void;
};

export function useAnalyticsReportLoad<T>({
  report,
  dateRange,
  branchId,
  cacheExtra,
  hasCacheData,
  fetchData,
  onHydrate,
  onClear,
}: UseAnalyticsReportLoadOptions<T>) {
  const cacheKey = useMemo(
    () =>
      buildAnalyticsReportCacheKey(report, {
        start: dateRange.start,
        end: dateRange.end,
        branchId,
        extra: cacheExtra,
      }),
    [report, dateRange.start, dateRange.end, branchId, cacheExtra],
  );

  const initialCached = useMemo(() => {
    if (!dateRange.start || !dateRange.end) return null;
    const cached = readAnalyticsReportCacheIncludingStale<T>(report, cacheKey);
    return hasCacheData(cached) ? cached : null;
  }, [report, cacheKey, dateRange.start, dateRange.end, hasCacheData]);

  const [loading, setLoading] = useState(() => !initialCached);
  const reqIdRef = useRef(0);
  const loadedCacheKeyRef = useRef<string | null>(null);

  const onHydrateRef = useRef(onHydrate);
  const onClearRef = useRef(onClear);
  const fetchDataRef = useRef(fetchData);
  const hasCacheDataRef = useRef(hasCacheData);
  onHydrateRef.current = onHydrate;
  onClearRef.current = onClear;
  fetchDataRef.current = fetchData;
  hasCacheDataRef.current = hasCacheData;

  const load = useCallback(
    async (background: boolean) => {
      if (!dateRange.start || !dateRange.end) return;
      const reqId = ++reqIdRef.current;
      if (!background) setLoading(true);
      try {
        const data = await fetchDataRef.current();
        if (reqId !== reqIdRef.current) return;
        onHydrateRef.current(data, { background });
        if (hasCacheDataRef.current(data)) {
          writeAnalyticsReportCache(report, cacheKey, data);
        }
      } catch (err) {
        if (reqId !== reqIdRef.current) return;
        console.error(`Failed to load ${report} report`, err);
        const stale = readAnalyticsReportCacheIncludingStale<T>(report, cacheKey);
        if (!background && !hasCacheDataRef.current(stale)) {
          onClearRef.current();
        }
      } finally {
        if (!background && reqId === reqIdRef.current) setLoading(false);
      }
    },
    [report, cacheKey, dateRange.start, dateRange.end],
  );

  const loadRef = useRef(load);
  loadRef.current = load;

  useLayoutEffect(() => {
    if (!initialCached) return;
    onHydrateRef.current(initialCached);
  }, [cacheKey, initialCached]);

  useEffect(() => {
    if (!dateRange.start || !dateRange.end) {
      loadedCacheKeyRef.current = null;
      setLoading(false);
      onClearRef.current();
      return;
    }

    const cacheKeyChanged = loadedCacheKeyRef.current !== cacheKey;
    loadedCacheKeyRef.current = cacheKey;

    let cancelled = false;

    const run = async () => {
      const cached = readAnalyticsReportCacheIncludingStale<T>(report, cacheKey);
      if (hasCacheDataRef.current(cached)) {
        onHydrateRef.current(cached as T);
        setLoading(false);
        void loadRef.current(true);
        return;
      }

      if (report === 'menu' || report === 'category') {
        await waitForAnalyticsReportPrefetch(report, cacheKey);
        if (cancelled) return;

        const afterPrefetch = readAnalyticsReportCacheIncludingStale<T>(report, cacheKey);
        if (hasCacheDataRef.current(afterPrefetch)) {
          onHydrateRef.current(afterPrefetch as T);
          setLoading(false);
          void loadRef.current(true);
          return;
        }
      }

      if (cacheKeyChanged && !hasCacheDataRef.current(readAnalyticsReportCacheIncludingStale<T>(report, cacheKey))) {
        onClearRef.current();
      }
      void loadRef.current(false);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [report, cacheKey, dateRange.start, dateRange.end]);

  const reload = useCallback(() => {
    void load(false);
  }, [load]);

  return { loading, reload, cacheKey, initialCached };
}
