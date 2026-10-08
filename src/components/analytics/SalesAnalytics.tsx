import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { BarChart3, ChevronDown, ChevronLeft, ChevronRight, LayoutGrid, Store, TrendingUp, Loader2, AlertCircle } from 'lucide-react';
import { type Branch } from '../partials/Header';
import { Skeleton } from '../ui/Skeleton';
import { Modal } from '../ui/Modal';
import {
  fetchTopProfitDriversApi,
  fetchSalesDashboardBundleApi,
  fetchDailyPerBranchApi,
  isAnalyticsFetchTimeout,
  type ApiBranchSalesItem,
  type ApiMenuReportRow,
  type ApiDailySalesItem,
  type ApiDailyPerBranchItem,
} from '../../services/analyticsService';
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from 'recharts';
import { fetchCashReconciliationAggregates } from '../../services/cashReconciliationService';
import { CashReconciliationModal } from './CashReconciliationModal';
import { MenuItemAnalyticsModal, MenuItemAnalyticsPanel, type MenuItemAnalyticsTarget } from './MenuItemAnalyticsModal';
import { SalesDayDrillModal, type SalesDayDrillOpenArgs } from './SalesDayDrillModal';
import {
  buildSalesAnalyticsCacheKey,
  hasSalesAnalyticsCacheData,
  patchSalesAnalyticsCache,
  readSalesAnalyticsCacheIncludingStale,
  writeSalesAnalyticsCache,
  type SalesAnalyticsCachePayload,
} from '../../utils/salesAnalyticsCache';
import { waitForSalesAnalyticsPrefetch } from '../../utils/prefetchSalesAnalytics';
import { getManilaMonthToDateRange } from '../../utils/manilaDateTime';
import { isExcludedFromAllBranchesView } from '../../utils/branchLogo';
import { showsMoneyCents } from '../../utils/branchFeatures';

/** Measures container and renders chart with explicit width/height to avoid Recharts -1 warning */
function ChartContainer({
  className = '',
  minHeight = 200,
  style,
  render,
}: {
  className?: string;
  minHeight?: number;
  style?: React.CSSProperties;
  render: (size: { width: number; height: number }) => React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setSize({ width: w, height: h });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={className} style={{ minHeight, ...style }}>
      {size.width > 0 && size.height > 0 ? render(size) : null}
    </div>
  );
}

type SalesAnalyticsProps = {
  selectedBranch: Branch | null;
  dateRange: {
    start: string;
    end: string;
  };
};

type MetricKey = 'totalSales' | 'refund' | 'discount' | 'netSales' | 'grossProfit';
type ChartType = 'bar chart' | 'line graph';
type ViewMode = 'glance' | 'week';

type InlineDropdownProps<T extends string> = {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  formatOption?: (value: T) => string;
};

// API data types
// API types now imported from analyticsService

function getToken() {
  return localStorage.getItem('token') || '';
}

function authHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getToken()}`,
  };
}

function InlineDropdown<T extends string>({ value, options, onChange, formatOption }: InlineDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 border-b border-gray-200 px-2 py-1 text-sm text-brand-muted hover:text-brand-text transition-colors"
      >
        <span>{formatOption ? formatOption(value) : value}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 min-w-[130px] overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg z-20">
          {options.map((option) => (
            <button
              type="button"
              key={option}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
              className={`w-full px-3 py-2 text-left text-sm transition-colors ${option === value ? 'bg-brand-primary text-white' : 'text-brand-text hover:bg-gray-50'
                }`}
            >
              {formatOption ? formatOption(option) : option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const parseDateSafe = (value: string) => {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const parsed = new Date(`${s.slice(0, 10)}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(s.includes('T') ? s : `${s}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toSaleDateKey = (value: string) => {
  const s = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = parseDateSafe(s);
  if (!parsed) return s.slice(0, 10);
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const formatDateLabel = (date: Date) =>
  date.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });

/** Match Admin Dashboard Total Profit — Sat red, Sun green. */
const weekendStyleForDay = (jsDay: number): { fill: string } | null => {
  if (jsDay === 6) return { fill: '#ef4444' };
  if (jsDay === 0) return { fill: '#22c55e' };
  return null;
};

const makeWeekendXAxisTick = (
  saleDateByLabel: Map<string, string>,
  options: { dy: number; textAnchor: 'middle' | 'end'; angle: number },
) => {
  const Tick = (props: { x?: string | number; y?: string | number; payload?: { value?: string } }) => {
    const x = Number(props.x) || 0;
    const y = Number(props.y) || 0;
    const label = String(props.payload?.value ?? '');
    const parsed = parseDateSafe(saleDateByLabel.get(label) || '');
    const weekend = parsed ? weekendStyleForDay(parsed.getDay()) : null;
    const fill = weekend?.fill ?? '#64748b';
    return (
      <g transform={`translate(${x},${y})`}>
        <text
          x={0}
          y={0}
          dy={options.dy}
          textAnchor={options.textAnchor}
          fill={fill}
          fontSize={11}
          fontWeight={weekend ? 800 : 500}
          transform={options.angle ? `rotate(${options.angle})` : undefined}
        >
          {label}
        </text>
      </g>
    );
  };
  return Tick;
};

const getCurrentMonthRange = () => getManilaMonthToDateRange();

const normalizeDailySalesItem = (item: ApiDailySalesItem) => {
  const totalSales = Number(item.total_sales || 0);
  const discount = Number((item as any).discount ?? 0);
  const apiRefund = Number((item as any).refund ?? 0);
  const apiNetSales = Number((item as any).net_sales ?? 0);
  const hasApiNetSales = Number.isFinite(apiNetSales) && (item as any).net_sales != null;

  const refund = Math.max(0, apiRefund);
  const netSales = hasApiNetSales ? Math.max(0, apiNetSales) : Math.max(0, totalSales - refund - discount);
  // Daily sum of LINE_COST (same as product_cost used for gross profit)
  const rawCost = (item as any).product_cost ?? (item as any).productCost;
  const productCost = Math.max(0, Number(rawCost ?? 0));
  const productUnitPrice = productCost;
  const apiGross = Number((item as any).gross_profit);
  const hasApiGross = Number.isFinite(apiGross) && (item as any).gross_profit != null;
  // Gross margin = (total_sales - refund - discount) - product_cost = net_sales - product_cost
  const grossProfit = hasApiGross ? Math.max(0, apiGross) : Math.max(0, netSales - productCost);

  return {
    totalSales,
    refund,
    discount: Math.max(0, discount),
    netSales,
    productCost,
    productUnitPrice,
    grossProfit,
  };
};

const formatSalesMoney = (value: number, withCents = false) => {
  const n = Number(value || 0);
  if (withCents) {
    const cents = Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
    return `₱${cents.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return `₱${Math.trunc(Number.isFinite(n) ? n : 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
};
const CHART_THEME_COLOR = 'rgb(139, 92, 246)';

const BRANCH_BAR_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

const colorWithAlpha = (color: string, alpha: number) => {
  const a = Math.min(1, Math.max(0, alpha));
  const c = (color || '').trim();
  if (!c) return c;

  // #RRGGBB
  if (c.startsWith('#') && c.length === 7) {
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return c;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  // #RGB
  if (c.startsWith('#') && c.length === 4) {
    const r = parseInt(c[1] + c[1], 16);
    const g = parseInt(c[2] + c[2], 16);
    const b = parseInt(c[3] + c[3], 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return c;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  // rgb(r,g,b)
  const rgb = c.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`;

  // rgba(r,g,b,x)
  const rgba = c.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/i);
  if (rgba) return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${a})`;

  return c;
};



export const SalesAnalytics: React.FC<SalesAnalyticsProps> = ({ selectedBranch, dateRange }) => {
  const { t } = useTranslation();
  const isAllBranch = !selectedBranch || String(selectedBranch.id) === 'all';
  /** Cents/decimals only for a cents branch (see branchFeatures.ts), never All Branches. */
  const showMoneyCents = !isAllBranch && showsMoneyCents(selectedBranch?.id);
  const money = useCallback((value: number) => formatSalesMoney(value, showMoneyCents), [showMoneyCents]);
  const moneyTooltip = useCallback((value: number) => formatSalesMoney(value, showMoneyCents), [showMoneyCents]);

  const initialSalesLoad = useMemo(() => {
    const fallback = getCurrentMonthRange();
    const start = dateRange.start || fallback.start;
    const end = dateRange.end || fallback.end;
    if (!start || !end) {
      return { cached: null as SalesAnalyticsCachePayload | null, needsSkeleton: false };
    }
    const key = buildSalesAnalyticsCacheKey({
      start,
      end,
      branchId: isAllBranch ? null : String(selectedBranch?.id ?? ''),
    });
    const cached = readSalesAnalyticsCacheIncludingStale(key);
    const hasCache = hasSalesAnalyticsCacheData(cached);
    return {
      cached: hasCache ? cached : null,
      needsSkeleton: !hasCache,
    };
  }, [selectedBranch?.id, dateRange.start, dateRange.end, isAllBranch]);

  const [activeMetric, setActiveMetric] = useState<MetricKey>('totalSales');
  const [chartType, setChartType] = useState<ChartType>('bar chart');
  const [viewMode, setViewMode] = useState<ViewMode>('glance');
  const [tablePage, setTablePage] = useState(0);
  const profitDriversRef = useRef<HTMLDivElement | null>(null);
  const dashboardReqIdRef = useRef(0);
  const profitDriversReqIdRef = useRef(0);
  const loadedCacheKeyRef = useRef<string | null>(null);

  // API data state for the two new cards
  const [branchSalesData, setBranchSalesData] = useState<ApiBranchSalesItem[]>(
    () => initialSalesLoad.cached?.branchSalesData ?? [],
  );
  const [branchSalesLoading, setBranchSalesLoading] = useState(
    () => initialSalesLoad.needsSkeleton && !(initialSalesLoad.cached?.branchSalesData.length),
  );
  const [branchSalesError, setBranchSalesError] = useState<string | null>(null);

  const [profitDriversData, setProfitDriversData] = useState<
    Array<{ row: ApiMenuReportRow; profit: number; branchId: number | null; branchName: string }>
  >(() => initialSalesLoad.cached?.profitDriversData ?? []);
  const [profitDriversLoading, setProfitDriversLoading] = useState(
    () => initialSalesLoad.needsSkeleton && !(initialSalesLoad.cached?.profitDriversData.length),
  );
  const [profitDriversError, setProfitDriversError] = useState<string | null>(null);
  const [profitDriversBranchId, setProfitDriversBranchId] = useState<number | null>(null);
  /** All-branches race chart selection — filters Total sales KPI + daily chart. Empty = all. */
  const [chartBranchIds, setChartBranchIds] = useState<number[]>([]);
  const [profitDriversModalOpen, setProfitDriversModalOpen] = useState(false);
  const [itemAnalyticsTarget, setItemAnalyticsTarget] = useState<MenuItemAnalyticsTarget | null>(null);
  const [itemAnalyticsOpen, setItemAnalyticsOpen] = useState(false);
  const [dayDrillOpen, setDayDrillOpen] = useState(false);
  const [dayDrillInitial, setDayDrillInitial] = useState<SalesDayDrillOpenArgs | null>(null);

  const [dailySalesCurrent, setDailySalesCurrent] = useState<ApiDailySalesItem[]>(
    () => initialSalesLoad.cached?.dailySalesCurrent ?? [],
  );
  const [dailySalesPrevious, setDailySalesPrevious] = useState<ApiDailySalesItem[]>(
    () => initialSalesLoad.cached?.dailySalesPrevious ?? [],
  );
  const [dailySalesLoading, setDailySalesLoading] = useState(
    () => initialSalesLoad.needsSkeleton && !(initialSalesLoad.cached?.dailySalesCurrent.length),
  );
  const [dailySalesError, setDailySalesError] = useState<string | null>(null);

  const [dailyPerBranch, setDailyPerBranch] = useState<ApiDailyPerBranchItem[]>([]);

  const [cashReconciliationOpen, setCashReconciliationOpen] = useState(false);
  const [reconAdjustCurrent, setReconAdjustCurrent] = useState<{
    byDate: Record<string, number>;
    total: number;
  }>(() => initialSalesLoad.cached?.reconAdjustCurrent ?? { byDate: {}, total: 0 });
  const [reconAdjustPreviousTotal, setReconAdjustPreviousTotal] = useState(
    () => initialSalesLoad.cached?.reconAdjustPreviousTotal ?? 0,
  );

  const allBranchesTrendData = useMemo(() => {
    const byDate = reconAdjustCurrent.byDate;
    const saleDatesWithPosRow = new Set<string>();

    const rows: Array<{
      label: string;
      tableDate: string;
      saleDate: string;
      totalSales: number;
      refund: number;
      discount: number;
      netSales: number;
      productCost: number;
      productUnitPrice: number;
      grossProfit: number;
    }> = [];

    for (const item of dailySalesCurrent) {
      const saleDate = toSaleDateKey(item.sale_date);
      saleDatesWithPosRow.add(saleDate);
      const parsed = parseDateSafe(saleDate);
      const label = parsed ? formatDateLabel(parsed) : item.sale_date;
      const tableDate = parsed
        ? parsed.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
        : item.sale_date;
      const recon = Number(byDate[saleDate] ?? 0);
      const normalized = normalizeDailySalesItem(item);
      rows.push({
        label,
        tableDate,
        saleDate,
        totalSales: normalized.totalSales + recon,
        refund: normalized.refund,
        discount: normalized.discount,
        netSales: normalized.netSales + recon,
        productCost: normalized.productCost,
        productUnitPrice: normalized.productUnitPrice,
        grossProfit: normalized.grossProfit + recon,
      });
    }

    // Cash recon on dates with no POS daily row — still part of period net / gross (was missing before).
    for (const [dateKey, raw] of Object.entries(byDate)) {
      const recon = Number(raw) || 0;
      if (recon <= 0 || saleDatesWithPosRow.has(dateKey)) continue;
      const parsed = parseDateSafe(dateKey);
      const label = parsed ? formatDateLabel(parsed) : dateKey;
      const tableDate = parsed
        ? parsed.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
        : dateKey;
      rows.push({
        label,
        tableDate,
        saleDate: dateKey,
        totalSales: recon,
        refund: 0,
        discount: 0,
        netSales: recon,
        productCost: 0,
        productUnitPrice: 0,
        grossProfit: recon,
      });
    }

    rows.sort((a, b) => a.saleDate.localeCompare(b.saleDate));
    return rows;
  }, [dailySalesCurrent, reconAdjustCurrent.byDate]);

  /** Daily series for KPI cards + Total sales chart (filtered by race-graph branch selection). */
  const trendData = useMemo(() => {
    if (!isAllBranch || chartBranchIds.length === 0 || dailyPerBranch.length === 0) {
      return allBranchesTrendData;
    }
    const idSet = new Set(chartBranchIds);
    const agg = new Map<
      string,
      { totalSales: number; refund: number; discount: number; netSales: number }
    >();
    for (const row of dailyPerBranch) {
      if (!idSet.has(Number(row.branch_id))) continue;
      const key = toSaleDateKey(String(row.sale_date));
      const prev = agg.get(key) || { totalSales: 0, refund: 0, discount: 0, netSales: 0 };
      prev.totalSales += Number(row.total_sales) || 0;
      prev.refund += Number(row.refund) || 0;
      prev.discount += Number(row.discount) || 0;
      prev.netSales += Number(row.net_sales) || 0;
      agg.set(key, prev);
    }
    return allBranchesTrendData.map((base) => {
      const hit = agg.get(base.saleDate);
      if (!hit) {
        return {
          ...base,
          totalSales: 0,
          refund: 0,
          discount: 0,
          netSales: 0,
          productCost: 0,
          productUnitPrice: 0,
          grossProfit: 0,
        };
      }
      return {
        ...base,
        totalSales: hit.totalSales,
        refund: hit.refund,
        discount: hit.discount,
        netSales: hit.netSales,
        productCost: 0,
        productUnitPrice: 0,
        grossProfit: hit.netSales,
      };
    });
  }, [isAllBranch, chartBranchIds, dailyPerBranch, allBranchesTrendData]);

  const previousTrendData = useMemo(() => {
    if (dailySalesPrevious.length === 0) return [];
    return dailySalesPrevious.map((item) => normalizeDailySalesItem(item));
  }, [dailySalesPrevious]);

  useEffect(() => { setTablePage(0); }, [dateRange.start, dateRange.end, selectedBranch?.id, activeMetric]);

  const previousRange = useMemo(() => {
    const start = parseDateSafe(dateRange.start);
    const end = parseDateSafe(dateRange.end);
    if (!start || !end || start > end) {
      return { previousStart: null as string | null, previousEnd: null as string | null };
    }
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
    const prevEnd = new Date(start);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - (days - 1));
    const toIso = (d: Date) => d.toISOString().slice(0, 10);
    return { previousStart: toIso(prevStart), previousEnd: toIso(prevEnd) };
  }, [dateRange.start, dateRange.end]);

  const getProfitValue = useCallback((row: ApiMenuReportRow) => {
    const rawProfit = Number((row as any).totalRevenue ?? 0);
    if (Number.isFinite(rawProfit) && rawProfit !== 0) return rawProfit;
    const revenue = Number((row as any).netSales ?? (row as any).totalSales ?? 0);
    const cost = Number((row as any).unitCost ?? 0);
    const derived = revenue - cost;
    return Number.isFinite(derived) ? derived : 0;
  }, []);

  useEffect(() => {
    if (!isAllBranch) {
      setProfitDriversBranchId(null);
      setChartBranchIds([]);
    }
  }, [isAllBranch]);

  useEffect(() => {
    setChartBranchIds([]);
  }, [dateRange.start, dateRange.end]);

  const profitDriversEffectiveBranchId = useMemo(() => {
    if (profitDriversBranchId != null) return String(profitDriversBranchId);
    if (!isAllBranch && selectedBranch?.id) return String(selectedBranch.id);
    return null;
  }, [profitDriversBranchId, isAllBranch, selectedBranch?.id]);

  useEffect(() => {
    setProfitDriversModalOpen(false);
  }, [profitDriversEffectiveBranchId, dateRange.start, dateRange.end]);

  const profitDriversBranchLabel = useMemo(() => {
    if (profitDriversBranchId != null) {
      const match = branchSalesData.find((b) => b.branch_id === profitDriversBranchId);
      return match?.branch_name || `${t('sales_analytics.branch')} #${profitDriversBranchId}`;
    }
    if (!isAllBranch && selectedBranch) return selectedBranch.name;
    return t('sales_analytics.all_branches');
  }, [profitDriversBranchId, branchSalesData, isAllBranch, selectedBranch, t]);

  const cacheKey = useMemo(
    () =>
      buildSalesAnalyticsCacheKey({
        start: dateRange.start,
        end: dateRange.end,
        branchId: isAllBranch ? null : String(selectedBranch?.id ?? ''),
      }),
    [dateRange.start, dateRange.end, isAllBranch, selectedBranch?.id]
  );

  const hydrateFromCache = useCallback((cached: SalesAnalyticsCachePayload) => {
    setDailySalesCurrent(cached.dailySalesCurrent);
    setDailySalesPrevious(cached.dailySalesPrevious);
    setBranchSalesData(cached.branchSalesData);
    setProfitDriversData(cached.profitDriversData);
    setReconAdjustCurrent(cached.reconAdjustCurrent);
    setReconAdjustPreviousTotal(cached.reconAdjustPreviousTotal);
    setDailySalesError(null);
    setBranchSalesError(null);
    setProfitDriversError(null);
    setDailySalesLoading(false);
    setBranchSalesLoading(false);
    setProfitDriversLoading(false);
  }, []);

  const applySalesBundle = useCallback(
    (bundle: SalesAnalyticsCachePayload, options: { background?: boolean } = {}) => {
      const { background = false } = options;
      const hasCore =
        bundle.dailySalesCurrent.some((d) => Number(d.total_sales ?? d.net_sales ?? 0) > 0) ||
        bundle.branchSalesData.some((b) => Number(b.total_sales ?? 0) > 0);

      const mergeArray = <T,>(next: T[], prev: T[]) => (next.length > 0 ? next : prev);

      if (background) {
        if (hasCore) {
          setDailySalesCurrent((prev) => mergeArray(bundle.dailySalesCurrent, prev));
          setDailySalesPrevious((prev) => mergeArray(bundle.dailySalesPrevious, prev));
          setBranchSalesData((prev) => mergeArray(bundle.branchSalesData, prev));
        }
        setProfitDriversData((prev) => mergeArray(bundle.profitDriversData, prev));
        if (bundle.reconAdjustCurrent.total > 0 || Object.keys(bundle.reconAdjustCurrent.byDate).length > 0) {
          setReconAdjustCurrent(bundle.reconAdjustCurrent);
        }
        if (bundle.reconAdjustPreviousTotal > 0) {
          setReconAdjustPreviousTotal(bundle.reconAdjustPreviousTotal);
        }
      } else {
        setDailySalesCurrent((prev) =>
          hasCore ? bundle.dailySalesCurrent : mergeArray(bundle.dailySalesCurrent, prev),
        );
        setDailySalesPrevious((prev) => mergeArray(bundle.dailySalesPrevious, prev));
        setBranchSalesData((prev) => mergeArray(bundle.branchSalesData, prev));
        setProfitDriversData((prev) => mergeArray(bundle.profitDriversData, prev));
        if (bundle.reconAdjustCurrent.total > 0 || Object.keys(bundle.reconAdjustCurrent.byDate).length > 0) {
          setReconAdjustCurrent(bundle.reconAdjustCurrent);
        } else if (!hasCore) {
          setReconAdjustCurrent((prev) => prev);
        }
        setReconAdjustPreviousTotal((prev) =>
          bundle.reconAdjustPreviousTotal > 0 ? bundle.reconAdjustPreviousTotal : prev,
        );
      }

      if (hasSalesAnalyticsCacheData(bundle)) {
        writeSalesAnalyticsCache(cacheKey, bundle);
      } else if (hasCore) {
        patchSalesAnalyticsCache(cacheKey, bundle);
      }
    },
    [cacheKey],
  );

  const loadProfitDriversOnly = useCallback(
    async (background: boolean) => {
      if (!dateRange.start || !dateRange.end) return;
      const reqId = ++profitDriversReqIdRef.current;
      if (!background) setProfitDriversLoading(true);
      setProfitDriversError(null);
      try {
        const profitParams = new URLSearchParams();
        profitParams.set('start_date', dateRange.start);
        profitParams.set('end_date', dateRange.end);
        if (profitDriversEffectiveBranchId) profitParams.set('branch_id', profitDriversEffectiveBranchId);

        const profitRows = await fetchTopProfitDriversApi(profitParams);
        const driversBranchName =
          profitDriversBranchId != null
            ? (branchSalesData.find((b) => b.branch_id === profitDriversBranchId)?.branch_name ||
                `${t('sales_analytics.branch')} #${profitDriversBranchId}`)
            : !isAllBranch && selectedBranch
              ? selectedBranch.name
              : t('sales_analytics.all_branches');

        const combined = profitRows
          .map((row) => ({
            row,
            profit: getProfitValue(row),
            branchId:
              (row as ApiMenuReportRow & { branch_id?: number | null }).branch_id ??
              (profitDriversEffectiveBranchId ? Number(profitDriversEffectiveBranchId) : null),
            branchName:
              profitDriversEffectiveBranchId && !isAllBranch
                ? driversBranchName
                : String(row.branch || driversBranchName),
          }))
          .filter((x) => x.profit > 0)
          .sort((a, b) => b.profit - a.profit)
          .slice(0, 20);

        if (reqId !== profitDriversReqIdRef.current) return;

        setProfitDriversData((prev) => (combined.length > 0 ? combined : prev));

        if (combined.length > 0) {
          patchSalesAnalyticsCache(cacheKey, { profitDriversData: combined });
        }
      } catch (err) {
        if (reqId !== profitDriversReqIdRef.current) return;
        if (background && isAnalyticsFetchTimeout(err)) return;
        if (!isAnalyticsFetchTimeout(err)) console.error(err);
        if (!background) {
          setProfitDriversError(t('sales_analytics.network_error'));
        }
      } finally {
        if (!background && reqId === profitDriversReqIdRef.current) setProfitDriversLoading(false);
      }
    },
    [
      cacheKey,
      dateRange.start,
      dateRange.end,
      getProfitValue,
      isAllBranch,
      profitDriversBranchId,
      profitDriversEffectiveBranchId,
      branchSalesData,
      selectedBranch,
      t,
    ]
  );

  const loadDashboardData = useCallback(
    async (background: boolean) => {
      const reqId = ++dashboardReqIdRef.current;
      const hasRange = dateRange.start && dateRange.end;
      if (!hasRange) {
        setDailySalesCurrent([]);
        setDailySalesPrevious([]);
        return;
      }

      if (!background) {
        setDailySalesLoading(true);
        setBranchSalesLoading(true);
        setProfitDriversLoading(true);
      }
      setDailySalesError(null);
      setBranchSalesError(null);
      setProfitDriversError(null);

      const branchOpt =
        !isAllBranch && selectedBranch?.id && String(selectedBranch.id) !== 'all'
          ? String(selectedBranch.id)
          : undefined;

      try {
        const bundle = await fetchSalesDashboardBundleApi({
          start: dateRange.start,
          end: dateRange.end,
          branchId: branchOpt ?? null,
          profitBranchId: profitDriversEffectiveBranchId,
        });
        if (reqId !== dashboardReqIdRef.current) return;

        applySalesBundle(
          {
            dailySalesCurrent: bundle.dailySalesCurrent,
            dailySalesPrevious: bundle.dailySalesPrevious,
            branchSalesData: bundle.branchSalesData,
            profitDriversData: bundle.profitDriversData,
            reconAdjustCurrent: bundle.reconAdjustCurrent,
            reconAdjustPreviousTotal: bundle.reconAdjustPreviousTotal,
          },
          { background },
        );
      } catch (err) {
        if (reqId !== dashboardReqIdRef.current) return;
        if (background && isAnalyticsFetchTimeout(err)) return;
        if (!isAnalyticsFetchTimeout(err)) console.error(err);
        const msg = t('sales_analytics.network_error');
        if (!background) {
          setDailySalesError(msg);
          setBranchSalesError(msg);
          setProfitDriversError(msg);
        }
      } finally {
        if (!background && reqId === dashboardReqIdRef.current) {
          setDailySalesLoading(false);
          setBranchSalesLoading(false);
          setProfitDriversLoading(false);
        }
      }
    },
    [
      applySalesBundle,
      cacheKey,
      dateRange.start,
      dateRange.end,
      isAllBranch,
      profitDriversEffectiveBranchId,
      selectedBranch,
      t,
    ]
  );

  const fetchDailySales = useCallback(() => loadDashboardData(false), [loadDashboardData]);
  const fetchBranchSales = useCallback(() => loadDashboardData(false), [loadDashboardData]);
  const fetchProfitDrivers = useCallback(() => loadProfitDriversOnly(false), [loadProfitDriversOnly]);

  const handleSelectDriversBranch = useCallback((branchId: number) => {
    setChartBranchIds((prev) => {
      const next = prev.includes(branchId)
        ? prev.filter((id) => id !== branchId)
        : [...prev, branchId];
      setProfitDriversBranchId(next.length === 0 ? null : next[next.length - 1]);
      return next;
    });
  }, []);

  /** Same flow as Admin Dashboard Overall Performance Trend → Sales by branch → Top menus. */
  const handleTrendDayClick = useCallback(
    (data: unknown) => {
      const payload = ((data as { payload?: Record<string, unknown> } | null)?.payload ??
        data) as {
        saleDate?: string;
        label?: string;
        totalSales?: number;
        refund?: number;
        discount?: number;
        netSales?: number;
        grossProfit?: number;
      } | null;
      if (!payload?.saleDate) return;
      const metricValue = Number(payload[activeMetric] ?? payload.totalSales) || 0;
      if (metricValue <= 0 && !(Number(payload.totalSales) > 0)) return;
      setDayDrillInitial({
        saleDate: String(payload.saleDate).slice(0, 10),
        label: String(payload.label || ''),
        chartTotal: metricValue > 0 ? metricValue : Number(payload.totalSales) || 0,
      });
      setDayDrillOpen(true);
    },
    [activeMetric],
  );

  const openItemAnalytics = useCallback(
    (item: { row: ApiMenuReportRow; profit: number; branchId: number | null; branchName: string }) => {
      const next: MenuItemAnalyticsTarget = {
        goods: String(item.row.goods || '').trim(),
        branchId: item.branchId,
        branchName: item.branchName,
        amount: item.profit,
        qty: Number((item.row as any).salesQty) || 0,
      };
      setItemAnalyticsTarget(next);
      // All-branches: keep popup. Single-branch: inline panel only.
      if (isAllBranch) setItemAnalyticsOpen(true);
    },
    [isAllBranch],
  );

  const loadDashboardDataRef = useRef(loadDashboardData);
  loadDashboardDataRef.current = loadDashboardData;

  useEffect(() => {
    if (!cacheKey || !dateRange.start || !dateRange.end) return;

    const cacheKeyChanged = loadedCacheKeyRef.current !== cacheKey;
    loadedCacheKeyRef.current = cacheKey;

    let cancelled = false;

    const run = async () => {
      const cached = readSalesAnalyticsCacheIncludingStale(cacheKey);
      if (hasSalesAnalyticsCacheData(cached)) {
        hydrateFromCache(cached);
        void loadDashboardDataRef.current(true);
        return;
      }

      await waitForSalesAnalyticsPrefetch(cacheKey);
      if (cancelled) return;

      const afterPrefetch = readSalesAnalyticsCacheIncludingStale(cacheKey);
      if (hasSalesAnalyticsCacheData(afterPrefetch)) {
        hydrateFromCache(afterPrefetch);
        void loadDashboardDataRef.current(true);
        return;
      }

      if (cacheKeyChanged) {
        setDailySalesCurrent([]);
        setDailySalesPrevious([]);
        setBranchSalesData([]);
        setProfitDriversData([]);
        setReconAdjustCurrent({ byDate: {}, total: 0 });
        setReconAdjustPreviousTotal(0);
      }
      void loadDashboardDataRef.current(false);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, dateRange.start, dateRange.end, hydrateFromCache]);

  const profitDriversFilterMounted = useRef(false);
  useEffect(() => {
    if (!profitDriversFilterMounted.current) {
      profitDriversFilterMounted.current = true;
      return;
    }
    void loadProfitDriversOnly(dailySalesCurrent.length > 0);
  }, [profitDriversEffectiveBranchId, loadProfitDriversOnly, dailySalesCurrent.length]);

  // Day × branch series for all-branches detail table
  useEffect(() => {
    if (!dateRange.start || !dateRange.end || !isAllBranch) {
      setDailyPerBranch([]);
      return;
    }
    let cancelled = false;
    void fetchDailyPerBranchApi({
      start: dateRange.start,
      end: dateRange.end,
      branchId: null,
    })
      .then((rows) => {
        if (cancelled) return;
        setDailyPerBranch(
          rows.filter((r) => !isExcludedFromAllBranchesView(r.branch_name)),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        if (!isAnalyticsFetchTimeout(err)) console.error(err);
        setDailyPerBranch([]);
      });

    return () => {
      cancelled = true;
    };
  }, [dateRange.start, dateRange.end, isAllBranch]);

  const loadReconAggregates = useCallback(async () => {
    const hasRange = dateRange.start && dateRange.end;
    if (!hasRange) {
      setReconAdjustCurrent({ byDate: {}, total: 0 });
      setReconAdjustPreviousTotal(0);
      return;
    }
    const branchOpt =
      !isAllBranch && selectedBranch?.id && String(selectedBranch.id) !== 'all'
        ? String(selectedBranch.id)
        : undefined;
    try {
      const { previousStart, previousEnd } = previousRange;
      const [cur, prev] = await Promise.all([
        fetchCashReconciliationAggregates({
          start: dateRange.start,
          end: dateRange.end,
          branchId: branchOpt,
        }),
        previousStart && previousEnd
          ? fetchCashReconciliationAggregates({
              start: previousStart,
              end: previousEnd,
              branchId: branchOpt,
            })
          : Promise.resolve({ total: 0, byDate: {} as Record<string, number> }),
      ]);
      const reconCurrent = {
        byDate: cur.byDate || {},
        total: Number(cur.total) || 0,
      };
      const reconPrevTotal = Number(prev.total) || 0;
      setReconAdjustCurrent(reconCurrent);
      setReconAdjustPreviousTotal(reconPrevTotal);
      patchSalesAnalyticsCache(cacheKey, {
        reconAdjustCurrent: reconCurrent,
        reconAdjustPreviousTotal: reconPrevTotal,
      });
    } catch (e) {
      console.error('[SalesAnalytics] cash reconciliation aggregates', e);
      if (!readSalesAnalyticsCacheIncludingStale(cacheKey)) {
        setReconAdjustCurrent({ byDate: {}, total: 0 });
        setReconAdjustPreviousTotal(0);
      }
    }
  }, [
    cacheKey,
    dateRange.start,
    dateRange.end,
    isAllBranch,
    selectedBranch?.id,
    previousRange.previousStart,
    previousRange.previousEnd,
  ]);

  // UI rule:
  // - All branches: Top 7 (unchanged comparison card).
  // - Single branch: Top 10, no in-card scroll.
  const topProfitDriversLimit = isAllBranch ? 7 : 10;
  const topProfitDrivers = useMemo(
    () => profitDriversData.slice(0, topProfitDriversLimit),
    [profitDriversData, topProfitDriversLimit]
  );
  const modalProfitDrivers = useMemo(() => profitDriversData.slice(0, 20), [profitDriversData]);

  // Single-branch: auto-show analytics for the #1 Top Revenue item.
  useEffect(() => {
    if (isAllBranch) return;
    if (topProfitDrivers.length === 0) {
      setItemAnalyticsTarget(null);
      return;
    }
    const first = topProfitDrivers[0];
    setItemAnalyticsTarget((prev) => {
      if (
        prev &&
        topProfitDrivers.some(
          (x) =>
            String(x.row.goods || '').trim() === prev.goods &&
            x.branchId === prev.branchId,
        )
      ) {
        return prev;
      }
      return {
        goods: String(first.row.goods || '').trim(),
        branchId: first.branchId,
        branchName: first.branchName,
        amount: first.profit,
        qty: Number((first.row as any).salesQty) || 0,
      };
    });
  }, [isAllBranch, topProfitDrivers]);

  const chartPointCount = trendData.length;
  const responsiveBarSize = useMemo(() => {
    if (chartPointCount <= 2) return 200;
    if (chartPointCount <= 4) return 140;
    if (chartPointCount <= 7) return 88;
    if (chartPointCount <= 14) return 52;
    if (chartPointCount <= 31) return 32;
    if (chartPointCount <= 62) return 20;
    return 12;
  }, [chartPointCount]);
  const responsiveBarCategoryGap = useMemo(() => {
    if (chartPointCount <= 2) return '0%';
    if (chartPointCount <= 4) return '2%';
    if (chartPointCount <= 7) return '3%';
    if (chartPointCount <= 14) return '4%';
    return '6%';
  }, [chartPointCount]);
  const responsiveXAxisInterval = useMemo(() => {
    // Show every date label (no 1,3,5,7 skip) for typical month ranges.
    if (chartPointCount <= 62) return 0;
    if (chartPointCount <= 90) return 1;
    return 3;
  }, [chartPointCount]);
  const useSlantedXAxisLabels = chartPointCount > 20;
  const responsiveXAxisAngle: 0 | -35 = useSlantedXAxisLabels ? -35 : 0;
  const responsiveXAxisTextAnchor: 'middle' | 'end' = useSlantedXAxisLabels ? 'end' : 'middle';
  const responsiveXAxisHeight = useSlantedXAxisLabels ? 72 : 48;
  const responsiveXAxisTickMargin = useSlantedXAxisLabels ? 12 : 8;

  const saleDateByChartLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of trendData) {
      map.set(row.label, row.saleDate);
    }
    return map;
  }, [trendData]);

  const salesChartXAxisTick = useMemo(
    () =>
      makeWeekendXAxisTick(saleDateByChartLabel, {
        dy: responsiveXAxisTickMargin,
        textAnchor: responsiveXAxisTextAnchor,
        angle: responsiveXAxisAngle,
      }),
    [saleDateByChartLabel, responsiveXAxisTickMargin, responsiveXAxisTextAnchor, responsiveXAxisAngle],
  );

  const salesTableRows = useMemo(() => {
    // All Branches: one row per branch × day (detailed). Single branch: aggregated daily trend.
    if (isAllBranch && dailyPerBranch.length > 0) {
      return [...dailyPerBranch]
        .sort((a, b) => {
          const byDate = String(b.sale_date).localeCompare(String(a.sale_date));
          if (byDate !== 0) return byDate;
          return String(a.branch_name).localeCompare(String(b.branch_name));
        })
        .map((row) => {
          const parsed = parseDateSafe(String(row.sale_date).slice(0, 10));
          const date = parsed
            ? parsed.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
            : String(row.sale_date).slice(0, 10);
          return {
            date,
            branchName: row.branch_name,
            totalSales: Number(row.total_sales) || 0,
            refund: Number(row.refund) || 0,
            discount: Number(row.discount) || 0,
            netSales: Number(row.net_sales) || 0,
            productUnitPrice: 0,
            grossProfit: Number(row.net_sales) || 0,
          };
        });
    }
    return [...trendData]
      .slice()
      .reverse()
      .map((row) => ({
        date: row.tableDate,
        branchName: null as string | null,
        totalSales: row.totalSales,
        refund: row.refund,
        discount: row.discount,
        netSales: row.netSales,
        productUnitPrice: row.productUnitPrice,
        grossProfit: row.grossProfit,
      }));
  }, [trendData, isAllBranch, dailyPerBranch]);

  const TABLE_PAGE_SIZE = 10;
  const totalTablePages = Math.max(1, Math.ceil(salesTableRows.length / TABLE_PAGE_SIZE));
  const safeTablePage = Math.min(tablePage, totalTablePages - 1);
  const pagedTableRows = salesTableRows.slice(
    safeTablePage * TABLE_PAGE_SIZE,
    safeTablePage * TABLE_PAGE_SIZE + TABLE_PAGE_SIZE
  );

  const baseSales = useMemo(
    () => trendData.reduce((sum, row) => sum + row.totalSales, 0),
    [trendData]
  );

  const baseSalesPrevious = useMemo(
    () =>
      dailySalesPrevious.reduce((sum, item) => {
        return sum + (Number(item.total_sales) || 0);
      }, 0),
    [dailySalesPrevious]
  );

const metricConfig = {
  totalSales: { positiveIsGood: true },
  refund: { positiveIsGood: false },
  discount: { positiveIsGood: true },
  netSales: { positiveIsGood: true },
  grossProfit: { positiveIsGood: true },
} as const;
  const topStatItems = useMemo(() => {
    const makeItem = (key: MetricKey, label: string) => {
      const cfg = metricConfig[key];
      // Aggregate totals from normalized series (current vs previous period)
      const aggregateMetric = (
        items: Array<{ totalSales: number; refund: number; discount: number; netSales: number; grossProfit: number }>,
        metricKey: MetricKey
      ) => {
        return items.reduce((sum, row) => {
          switch (metricKey) {
            case 'totalSales':
              return sum + row.totalSales;
            case 'refund':
              return sum + row.refund;
            case 'discount':
              return sum + row.discount;
            case 'netSales':
              return sum + row.netSales;
            case 'grossProfit':
              return sum + row.grossProfit;
            default:
              return sum;
          }
        }, 0);
      };

      const current = aggregateMetric(trendData, key);
      // Branch race filter has no prior-period per-branch series — skip misleading deltas.
      const branchFiltered = isAllBranch && chartBranchIds.length > 0;
      let previous = branchFiltered ? 0 : aggregateMetric(previousTrendData, key);
      if (!branchFiltered && (key === 'totalSales' || key === 'netSales' || key === 'grossProfit')) {
        previous += reconAdjustPreviousTotal;
      }
      const diff = current - previous;
      const hasPrev = previous > 0;
      const percent = hasPrev ? (diff / previous) * 100 : 0;
      const isIncrease = diff >= 0;
      const positive = cfg.positiveIsGood ? isIncrease : !isIncrease;
      const sign = diff >= 0 ? '+' : '-';
      const absDiff = Math.abs(diff);
      const absPercent = Math.abs(percent);
      const delta = branchFiltered ? '—' : `${sign}${money(absDiff)} (${absPercent.toFixed(2)}%)`;

      return {
        key,
        label,
        value: money(current),
        delta,
        positive,
      } as const;
    };

    return [
      makeItem('totalSales', t('sales_analytics.total_sales')),
      makeItem('refund', t('sales_analytics.refund')),
      makeItem('discount', t('sales_analytics.discount')),
      makeItem('netSales', t('sales_analytics.net_sales')),
      makeItem('grossProfit', t('sales_analytics.gross_profit')),
    ];
  }, [trendData, previousTrendData, metricConfig, t, reconAdjustPreviousTotal, money, isAllBranch, chartBranchIds]);
  /** POS / daily-sales net only (no cash reconciliation) — for modal breakdown */
  const reportNetSalesTotal = useMemo(
    () =>
      dailySalesCurrent.reduce((sum, item) => sum + normalizeDailySalesItem(item).netSales, 0),
    [dailySalesCurrent]
  );
  const reportNetSalesDisplay = money(reportNetSalesTotal);
  const cashReconPeriodDisplay = money(reconAdjustCurrent.total);
  const totalNetSalesModalDisplay = money(reportNetSalesTotal + reconAdjustCurrent.total);

  const cashReconciliationBranchId = useMemo(() => {
    if (!selectedBranch || String(selectedBranch.id) === 'all') return null;
    const n = Number(selectedBranch.id);
    return Number.isFinite(n) ? n : null;
  }, [selectedBranch]);
  const activeMetricLabel = topStatItems.find((item) => item.key === activeMetric)?.label || t('sales_analytics.total_sales');
  const MoneyTooltip: React.FC<{
    active?: boolean;
    payload?: { value: number }[];
    label?: string;
  }> = ({ active, payload, label }) => {
    if (!active || !payload || payload.length === 0) return null;
    const rawValue = Number(payload[0]?.value ?? 0);
    return (
      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 shadow-[0_4px_14px_rgba(15,23,42,0.16)]">
        {label && (
          <div className="mb-0.5 text-[11px] font-medium text-slate-500">
            {label}
          </div>
        )}
        <div className="text-sm font-semibold text-slate-900">
          {moneyTooltip(rawValue)}
        </div>
      </div>
    );
  };
  const tooltipProps = {
    cursor: false as const,
    content: <MoneyTooltip />,
  };

  const visibleBranchSalesData = useMemo(
    () => branchSalesData.filter((b) => !isExcludedFromAllBranchesView(b.branch_name)),
    [branchSalesData],
  );

  const dayDrillLockedBranch = useMemo(() => {
    // Header single-branch selection
    if (!isAllBranch && selectedBranch?.id && String(selectedBranch.id) !== 'all') {
      const id = Number(selectedBranch.id);
      if (Number.isFinite(id) && id > 0) {
        return { id, name: selectedBranch.name || `Branch ${id}` };
      }
    }
    // Race-graph filter: one branch selected → skip "Sales by branch", open Top menus
    if (isAllBranch && chartBranchIds.length === 1) {
      const id = chartBranchIds[0];
      const match = visibleBranchSalesData.find((b) => b.branch_id === id);
      return { id, name: match?.branch_name || `Branch ${id}` };
    }
    return null;
  }, [isAllBranch, selectedBranch, chartBranchIds, visibleBranchSalesData]);

  // Branch chart data for horizontal bar
  const branchChartData = useMemo(() => {
    return visibleBranchSalesData.map((b) => ({
      name: b.branch_name,
      sales: b.total_sales,
      branchId: b.branch_id,
    }));
  }, [visibleBranchSalesData]);

  const chartBranchIdSet = useMemo(() => new Set(chartBranchIds), [chartBranchIds]);
  const branchRaceChartHeight = Math.max(160, visibleBranchSalesData.length * 34 + 36);

  const branchColorById = useMemo(() => {
    const map = new Map<number, string>();
    visibleBranchSalesData.forEach((b, i) => {
      map.set(b.branch_id, BRANCH_BAR_COLORS[i % BRANCH_BAR_COLORS.length]);
    });
    return map;
  }, [visibleBranchSalesData]);

  const selectedChartBranches = useMemo(
    () =>
      chartBranchIds.map((id) => {
        const match = visibleBranchSalesData.find((b) => b.branch_id === id);
        return {
          id,
          name: match?.branch_name || `Branch ${id}`,
          color: branchColorById.get(id) || CHART_THEME_COLOR,
        };
      }),
    [chartBranchIds, visibleBranchSalesData, branchColorById],
  );

  const removeChartBranchFilter = useCallback((branchId: number) => {
    setChartBranchIds((prev) => {
      const next = prev.filter((id) => id !== branchId);
      setProfitDriversBranchId(next.length === 0 ? null : next[next.length - 1]);
      return next;
    });
  }, []);

  const branchXAxisTicks = useMemo(() => {
    const million = 1_000_000;
    const max = Math.max(0, ...branchChartData.map((d) => Number(d.sales) || 0));
    if (max <= 0) return [0];

    const maxM = Math.max(1, Math.ceil(max / million));
    const ticks: number[] = [0];

    // Prefer readable "odd million" ticks: 1M, 3M, 5M ... then ensure max is included.
    for (let m = 1; m <= maxM; m += 2) ticks.push(m * million);

    const maxTick = maxM * million;
    if (ticks[ticks.length - 1] !== maxTick) ticks.push(maxTick);
    return ticks;
  }, [branchChartData]);

  const formatBranchAxisTick = useCallback((v: number) => {
    const million = 1_000_000;
    const n = Number(v) || 0;
    if (n === 0) return '₱0';
    return `₱${Math.round(n / million)}M`;
  }, []);

  const showBranchColumn = isAllBranch && salesTableRows.some((r) => r.branchName);

  // --- Export Functions (CSV + PDF) ---
  const handleExportCsv = useCallback(() => {
    const headers = [
      t('sales_analytics.date'),
      ...(showBranchColumn ? [t('sales_analytics.branch')] : []),
      t('sales_analytics.total_sales'),
      t('sales_analytics.refund'),
      t('sales_analytics.discount'),
      t('sales_analytics.net_sales'),
      t('sales_analytics.product_unit_price'),
      t('sales_analytics.gross_profit'),
    ];

    const escapeCell = (value: string) => {
      const needsQuotes = /[",\n]/.test(value);
      const safe = value.replace(/"/g, '""');
      return needsQuotes ? `"${safe}"` : safe;
    };

    const rows = salesTableRows.map((row) => [
      row.date,
      ...(showBranchColumn ? [row.branchName || ''] : []),
      row.totalSales.toString(),
      row.refund.toString(),
      row.discount.toString(),
      row.netSales.toString(),
      row.productUnitPrice.toString(),
      row.grossProfit.toString(),
    ]);

    const csv = [
      headers.map(escapeCell).join(','),
      ...rows.map((r) => r.map(escapeCell).join(',')),
    ].join('\n');

    const branchNameStr = selectedBranch ? selectedBranch.name : 'All_Branches';
    const cleanBranchName = branchNameStr.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `sales_report_${cleanBranchName}_${dateRange.start}_to_${dateRange.end}.csv`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [salesTableRows, selectedBranch, dateRange, t, showBranchColumn]);

  const handleExportPdf = useCallback(async () => {
    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
    const doc = new jsPDF('l', 'pt', 'a4');

    const headers = [
      t('sales_analytics.date'),
      ...(showBranchColumn ? [t('sales_analytics.branch')] : []),
      t('sales_analytics.total_sales'),
      t('sales_analytics.refund'),
      t('sales_analytics.discount'),
      t('sales_analytics.net_sales'),
      t('sales_analytics.product_unit_price'),
      t('sales_analytics.gross_profit'),
    ];

    const body = salesTableRows.map((row) => [
      row.date,
      ...(showBranchColumn ? [row.branchName || ''] : []),
      money(row.totalSales),
      money(row.refund),
      money(row.discount),
      money(row.netSales),
      money(row.productUnitPrice),
      money(row.grossProfit),
    ]);

    autoTable(doc, {
      head: [headers],
      body,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [139, 92, 246] },
      margin: { top: 40 },
    });

    const branchNameStr = selectedBranch ? selectedBranch.name : 'All_Branches';
    const cleanBranchName = branchNameStr.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `sales_report_${cleanBranchName}_${dateRange.start}_to_${dateRange.end}.pdf`;

    doc.save(filename);
  }, [salesTableRows, selectedBranch, dateRange, t, money, showBranchColumn]);

  const isPageLoading = dailySalesLoading && dailySalesCurrent.length === 0;

  return (
    <div className="pt-6 space-y-8">
      <AnimatePresence mode="wait">
        {isPageLoading ? (
          <motion.div
            key="skeleton"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="space-y-8"
          >
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="grid grid-cols-1 md:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="p-5">
                    <Skeleton className="h-4 w-20 mb-2 rounded-lg" />
                    <Skeleton className="h-10 w-28 mb-2 rounded-lg" />
                    <Skeleton className="h-3 w-24 rounded-lg" />
                  </div>
                ))}
              </div>
              <div className="p-6 border-t border-gray-200">
                <div className="flex items-center justify-between mb-5">
                  <Skeleton className="h-5 w-40 rounded-lg" />
                  <div className="flex gap-2">
                    <Skeleton className="h-8 w-24 rounded-lg" />
                    <Skeleton className="h-8 w-20 rounded-lg" />
                  </div>
                </div>
                <Skeleton className="h-72 w-full rounded-2xl" />
              </div>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden p-5">
                <Skeleton className="h-5 w-48 mb-4 rounded-lg" />
                <Skeleton className="h-48 w-full rounded-xl mb-4" />
                <Skeleton className="h-32 w-full rounded-xl" />
              </div>
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden p-5">
                <Skeleton className="h-8 w-56 mb-4 rounded-lg" />
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-xl mb-3" />
                ))}
              </div>
            </div>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden p-5">
              <div className="flex justify-between mb-4">
                <Skeleton className="h-9 w-28 rounded-lg" />
                <Skeleton className="h-9 w-9 rounded-lg" />
              </div>
              <Skeleton className="h-10 w-full rounded-lg mb-2" />
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg mb-1" />
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="content"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="space-y-8"
          >
      {dailySalesError ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-red-700">
            <AlertCircle size={18} />
            <span>{dailySalesError}</span>
          </div>
          <button
            type="button"
            onClick={() => void fetchDailySales()}
            className="text-xs font-semibold text-red-700 hover:underline shrink-0"
          >
            {t('sales_analytics.retry')}
          </button>
        </div>
      ) : null}

      {/* ── Stat Cards ─────────────────────────────── */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-5">
          {topStatItems.map((item) => (
            <button
              type="button"
              key={item.label}
              onClick={() => {
                setActiveMetric(item.key);
                if (item.key === 'netSales') setCashReconciliationOpen(true);
              }}
              className="p-5 text-left transition-colors hover:bg-gray-50 border-b-2 border-b-transparent"
              style={activeMetric === item.key ? { borderBottomColor: CHART_THEME_COLOR } : undefined}
            >
              <p className="text-brand-muted text-sm font-medium mb-1">{item.label}</p>
              <h3 className="text-4xl/none md:text-[2rem] font-bold text-brand-text mb-2">{item.value}</h3>
              <p className={`text-xs font-medium ${item.positive ? 'text-green-600' : 'text-red-600'}`}>{item.delta}</p>
            </button>
          ))}
        </div>
        <div className="p-6 border-t border-gray-200">
          <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <BarChart3 size={18} className="text-brand-muted shrink-0" />
              <h4 className="text-lg font-normal text-brand-text shrink-0">{activeMetricLabel}</h4>
              {selectedChartBranches.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => removeChartBranchFilter(b.id)}
                  className="inline-flex items-center gap-1.5 max-w-[180px] px-2 py-1 rounded-full text-[11px] font-semibold border hover:opacity-90"
                  style={{
                    backgroundColor: colorWithAlpha(b.color, 0.12),
                    borderColor: colorWithAlpha(b.color, 0.35),
                    color: b.color,
                  }}
                  title={`Remove ${b.name}`}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: b.color }}
                  />
                  <span className="truncate">{b.name}</span>
                  <span className="opacity-70 shrink-0">×</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <InlineDropdown value={chartType} options={['line graph', 'bar chart'] as const} formatOption={(v) => t(`sales_analytics.${v.replace(' ', '_')}`)} onChange={(v) => setChartType(v)} />
              <InlineDropdown value={viewMode} options={['glance', 'week'] as const} formatOption={(v) => t(`sales_analytics.${v}`)} onChange={(v) => setViewMode(v)} />
            </div>
          </div>
          <ChartContainer
            className="w-full min-w-0 h-72 min-h-[288px]"
            minHeight={288}
            render={({ width, height }) =>
              chartType === 'bar chart' ? (
                <BarChart width={width} height={height} data={trendData} barCategoryGap={responsiveBarCategoryGap} barGap={0}>
                  <CartesianGrid stroke="#e5e7eb" vertical={false} />
                  <XAxis dataKey="label" tick={salesChartXAxisTick} interval={responsiveXAxisInterval} angle={responsiveXAxisAngle} textAnchor={responsiveXAxisTextAnchor} height={responsiveXAxisHeight} tickMargin={responsiveXAxisTickMargin} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 12 }} tickFormatter={(v) => `₱${Math.round(v / 1000)}k`} axisLine={false} tickLine={false} />
                  <Tooltip {...tooltipProps} />
                  <Bar
                    dataKey={activeMetric}
                    fill={CHART_THEME_COLOR}
                    barSize={responsiveBarSize}
                    cursor="pointer"
                    onClick={handleTrendDayClick}
                  />
                </BarChart>
              ) : (
                <AreaChart width={width} height={height} data={trendData}>
                  <CartesianGrid stroke="#e5e7eb" vertical={false} />
                  <XAxis dataKey="label" tick={salesChartXAxisTick} interval={responsiveXAxisInterval} angle={responsiveXAxisAngle} textAnchor={responsiveXAxisTextAnchor} height={responsiveXAxisHeight} tickMargin={responsiveXAxisTickMargin} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 12 }} tickFormatter={(v) => `₱${Math.round(v / 1000)}k`} axisLine={false} tickLine={false} />
                  <Tooltip {...tooltipProps} />
                  <Area
                    type="linear"
                    dataKey={activeMetric}
                    stroke={CHART_THEME_COLOR}
                    strokeWidth={2}
                    fill={CHART_THEME_COLOR}
                    fillOpacity={0.2}
                    dot={{ r: 3, cursor: 'pointer' }}
                    activeDot={{ r: 5, cursor: 'pointer', onClick: handleTrendDayClick }}
                    style={{ cursor: 'pointer' }}
                    onClick={handleTrendDayClick}
                  />
                </AreaChart>
              )
            }
          />
        </div>
      </div>

      {/* ══ Branch sales (all) / Top Revenue + Item Analytics (single) ══════════════════════ */}
      <div
        className={`grid grid-cols-1 gap-6 items-stretch ${
          isAllBranch
            ? 'xl:grid-cols-2'
            : 'xl:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.4fr)]'
        }`}
      >
        {/* Card 1: Total Sales per Branch — all-branches comparison only */}
        {isAllBranch ? (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden flex flex-col h-full">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0 gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Store size={18} className="text-brand-muted shrink-0" />
              <h4 className="text-base font-semibold text-brand-text truncate">
                {t('sales_analytics.total_sales_per_branch')}
              </h4>
            </div>
            {chartBranchIds.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setChartBranchIds([]);
                  setProfitDriversBranchId(null);
                }}
                className="text-[11px] font-semibold text-violet-600 hover:underline shrink-0"
              >
                {t('sales_analytics.all_branches')}
              </button>
            ) : (
              <span className="text-[10px] text-brand-muted shrink-0 hidden sm:inline">
                tap branch → Total sales
              </span>
            )}
          </div>
          <div className="flex-1 flex flex-col min-h-0 px-5 py-3">
            {branchSalesLoading && visibleBranchSalesData.length === 0 ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 size={24} className="animate-spin text-violet-500" />
              </div>
            ) : branchSalesError ? (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <AlertCircle size={32} className="text-red-400 mb-2" />
                <p className="text-sm text-red-500 font-medium">{branchSalesError}</p>
                <button onClick={fetchBranchSales} className="mt-2 text-xs text-violet-600 font-bold hover:underline cursor-pointer">{t('sales_analytics.retry')}</button>
              </div>
            ) : visibleBranchSalesData.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <Store size={36} className="text-gray-300 mb-2" />
                <p className="text-sm text-brand-muted font-medium">{t('sales_analytics.no_branch_sales_data')}</p>
              </div>
            ) : (
              <>
                <div className="mb-2 flex flex-col min-w-0" style={{ height: branchRaceChartHeight }}>
                  <ChartContainer
                    className="w-full min-w-0 h-full"
                    minHeight={branchRaceChartHeight}
                    render={({ width, height }) => (
                      <BarChart
                        width={width}
                        height={height}
                        data={branchChartData}
                        layout="vertical"
                        margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                        barCategoryGap={4}
                      >
                        <CartesianGrid stroke="#e5e7eb" horizontal={false} />
                        <XAxis
                          type="number"
                          tick={{ fill: '#64748b', fontSize: 11 }}
                          ticks={branchXAxisTicks}
                          tickFormatter={(v) => formatBranchAxisTick(Number(v))}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          type="category"
                          dataKey="name"
                          width={120}
                          interval={0}
                          tick={{ fill: '#334155', fontSize: 11, fontWeight: 500 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip cursor={false} content={<MoneyTooltip />} />
                        <Bar
                          dataKey="sales"
                          barSize={26}
                          radius={[0, 6, 6, 0]}
                          cursor="pointer"
                          onClick={(data: any) => {
                            const id = Number(data?.branchId ?? data?.payload?.branchId);
                            if (!Number.isFinite(id)) return;
                            handleSelectDriversBranch(id);
                          }}
                        >
                          {branchChartData.map((entry, index) => {
                            const selected =
                              chartBranchIdSet.size === 0 || chartBranchIdSet.has(entry.branchId);
                            return (
                              <Cell
                                key={entry.branchId}
                                fill={BRANCH_BAR_COLORS[index % BRANCH_BAR_COLORS.length]}
                                fillOpacity={selected ? 1 : 0.28}
                                stroke={
                                  chartBranchIdSet.has(entry.branchId)
                                    ? BRANCH_BAR_COLORS[index % BRANCH_BAR_COLORS.length]
                                    : undefined
                                }
                                strokeWidth={chartBranchIdSet.has(entry.branchId) ? 1.5 : 0}
                              />
                            );
                          })}
                        </Bar>
                      </BarChart>
                    )}
                  />
                </div>
                <div className="shrink-0 overflow-x-auto rounded-xl border border-gray-100">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs font-medium text-brand-muted border-b border-gray-100 bg-gray-50">
                        <th className="px-3 py-2">{t('sales_analytics.branch')}</th>
                        <th className="px-3 py-2 text-right">{t('sales_analytics.total_sales')}</th>
                        <th className="px-3 py-2 text-right">{t('sales_analytics.orders')}</th>
                        <th className="px-3 py-2 text-right">{t('sales_analytics.avg_order')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleBranchSalesData.map((b, i) => (
                        <tr
                          key={b.branch_id}
                          onClick={() => handleSelectDriversBranch(b.branch_id)}
                          className={`border-b border-gray-50 last:border-b-0 cursor-pointer hover:bg-violet-50/40 ${
                            chartBranchIdSet.has(b.branch_id)
                              ? 'bg-violet-50/70'
                              : i % 2 === 0
                                ? ''
                                : 'bg-gray-50/40'
                          }`}
                        >
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: BRANCH_BAR_COLORS[i % BRANCH_BAR_COLORS.length] }} />
                              <span className="font-medium text-brand-text truncate max-w-[120px]">{b.branch_name}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right font-semibold text-brand-text">{money(b.total_sales)}</td>
                          <td className="px-3 py-2.5 text-right text-brand-muted">{b.order_count.toLocaleString()}</td>
                          <td className="px-3 py-2.5 text-right text-brand-muted">{money(b.avg_order_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
        ) : null}

        {/* Card 2: Top Revenue Items */}
        <div
          ref={profitDriversRef}
          className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden flex flex-col h-full min-h-0"
        >
          <div
            className={`flex items-center justify-between border-b border-gray-100 ${
              isAllBranch ? 'px-4 py-2.5' : 'px-4 py-3'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-violet-100 text-violet-600 shrink-0">
                <TrendingUp size={15} />
              </span>
              <div className="flex flex-col min-w-0">
                <h4 className="font-semibold text-slate-900 text-sm">
                  {t('sales_analytics.top_revenue_items')}
                </h4>
                <p className="text-[11px] font-medium text-slate-500 truncate">
                  {profitDriversBranchLabel}
                  {!isAllBranch ? ` · ${t('sales_analytics.item_analytics_click_hint')}` : ''}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {profitDriversData.length > topProfitDriversLimit ? (
                <button
                  type="button"
                  onClick={() => setProfitDriversModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-white text-slate-700 border border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                >
                  {t('sales_analytics.view_more')}
                </button>
              ) : null}
              {profitDriversBranchId != null && isAllBranch ? (
                <button
                  type="button"
                  onClick={() => {
                    setProfitDriversBranchId(null);
                    setChartBranchIds([]);
                  }}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] font-semibold border"
                  title="Clear branch filter"
                  style={(() => {
                    const branchColor = branchColorById.get(profitDriversBranchId) || CHART_THEME_COLOR;
                    return {
                      backgroundColor: colorWithAlpha(branchColor, 0.12),
                      borderColor: colorWithAlpha(branchColor, 0.35),
                      color: branchColor,
                    };
                  })()}
                >
                  <span>{profitDriversBranchLabel}</span>
                  <span className="opacity-80">×</span>
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
            {profitDriversLoading && profitDriversData.length === 0 ? (
              <div className="flex h-full items-center justify-center py-16">
                <Loader2 size={24} className="animate-spin text-violet-500" />
              </div>
            ) : profitDriversError ? (
              <div className="flex h-full flex-col items-center justify-center py-12 text-center">
                <AlertCircle size={32} className="text-red-400 mb-2" />
                <p className="text-sm text-red-500 font-medium">{profitDriversError}</p>
                <button onClick={fetchProfitDrivers} className="mt-2 text-xs text-violet-600 font-bold hover:underline cursor-pointer">{t('sales_analytics.retry')}</button>
              </div>
            ) : profitDriversData.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center py-12 text-center">
                <TrendingUp size={36} className="text-gray-300 mb-2" />
                <p className="text-sm text-brand-muted font-medium">{t('sales_analytics.no_data_available')}</p>
              </div>
            ) : (
              <div className="h-full flex flex-col gap-1">
                {topProfitDrivers.map((item, idx) => {
                  const isSelected =
                    !isAllBranch &&
                    itemAnalyticsTarget != null &&
                    String(item.row.goods || '').trim() === itemAnalyticsTarget.goods &&
                    item.branchId === itemAnalyticsTarget.branchId;
                  return (
                  <button
                    type="button"
                    key={`${item.row.id}-${item.branchId ?? 'all'}-${idx}`}
                    onClick={() => openItemAnalytics(item)}
                    className={`w-full text-left flex items-center justify-between rounded-lg border transition-all cursor-pointer flex-1 min-h-0 px-2.5 py-1.5 ${
                      isSelected
                        ? 'border-violet-300 bg-violet-50 shadow-sm'
                        : 'border-violet-50 bg-gradient-to-r from-slate-50 via-white to-violet-50/40 hover:shadow-sm hover:border-violet-200 hover:bg-violet-50/30'
                    }`}
                  >
                    <div className={`flex items-center min-w-0 flex-1 ${isAllBranch ? 'gap-2' : 'gap-2'}`}>
                      <div
                        className={`rounded-md flex items-center justify-center font-bold shrink-0 bg-violet-100 text-violet-700 ${
                          isAllBranch ? 'w-6 h-6 text-[11px]' : 'w-5 h-5 text-[10px]'
                        }`}
                      >
                        {idx + 1}
                      </div>
                      <div className="min-w-0">
                        <p
                          className={`font-semibold text-slate-900 truncate ${
                            isAllBranch ? 'text-[13px] leading-tight' : 'text-[13px] leading-tight'
                          }`}
                        >
                          {item.row.goods}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                          {profitDriversEffectiveBranchId ? null : (
                            <span
                              className="inline-flex items-center text-[10px] px-1.5 py-px rounded-full font-semibold border"
                              style={(() => {
                                const branchColor =
                                  (item.branchId != null ? branchColorById.get(item.branchId) : undefined) ||
                                  CHART_THEME_COLOR;
                                return {
                                  backgroundColor: colorWithAlpha(branchColor, 0.12),
                                  borderColor: colorWithAlpha(branchColor, 0.35),
                                  color: branchColor,
                                };
                              })()}
                            >
                              {item.branchName}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      <div className="text-right">
                        {isAllBranch ? (
                          <>
                            <span className="text-[13px] font-semibold text-slate-900 leading-tight">{money(item.profit)}</span>
                            <div className="text-[10px] text-slate-500 font-medium leading-tight">
                              {(Number((item.row as any).salesQty) || 0).toLocaleString()} {t('sales_analytics.sold')}
                            </div>
                          </>
                        ) : (
                          <div className="leading-tight">
                            <span className="text-[13px] font-semibold text-slate-900">{money(item.profit)}</span>
                            <div className="text-[10px] text-slate-500 font-medium">
                              {(Number((item.row as any).salesQty) || 0).toLocaleString()} {t('sales_analytics.sold')}
                            </div>
                          </div>
                        )}
                      </div>
                      <ChevronRight size={14} className="text-slate-300 shrink-0" />
                    </div>
                  </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Single-branch: item analytics panel (red-box area) */}
        {!isAllBranch ? (
          <MenuItemAnalyticsPanel
            target={itemAnalyticsTarget}
            dateRange={dateRange}
            active={!isAllBranch}
            className="h-full"
          />
        ) : null}
      </div>

      <Modal
        isOpen={profitDriversModalOpen}
        onClose={() => setProfitDriversModalOpen(false)}
        title={`${t('sales_analytics.top_revenue_items')} · ${profitDriversBranchLabel}`}
        maxWidth="3xl"
        bodyClassName="px-5 py-5"
      >
        {modalProfitDrivers.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-500">
            {t('sales_analytics.no_data_available')}
          </div>
        ) : (
          <div className="space-y-2">
            {modalProfitDrivers.map((item, idx) => (
              <button
                type="button"
                key={`modal-${item.row.id}-${item.branchId ?? 'all'}-${idx}`}
                onClick={() => {
                  openItemAnalytics(item);
                  if (!isAllBranch) setProfitDriversModalOpen(false);
                }}
                className="w-full text-left flex items-center justify-between p-3 rounded-xl border border-violet-50 bg-gradient-to-r from-slate-50 via-white to-violet-50/40 hover:border-violet-200 hover:bg-violet-50/40 cursor-pointer transition-all"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 bg-violet-100 text-violet-700">
                    {idx + 1}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">{item.row.goods}</p>
                    <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                      {profitDriversEffectiveBranchId ? null : (
                        <span
                          className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full font-semibold border"
                          style={(() => {
                            const branchColor =
                              (item.branchId != null ? branchColorById.get(item.branchId) : undefined) ||
                              CHART_THEME_COLOR;
                            return {
                              backgroundColor: colorWithAlpha(branchColor, 0.12),
                              borderColor: colorWithAlpha(branchColor, 0.35),
                              color: branchColor,
                            };
                          })()}
                        >
                          {item.branchName}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <div className="text-right">
                    <span className="text-sm font-semibold text-slate-900">{money(item.profit)}</span>
                    <div className="text-[11px] text-slate-500 font-medium mt-0.5">
                      {(Number((item.row as any).salesQty) || 0).toLocaleString()} {t('sales_analytics.sold')}
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-slate-300" />
                </div>
              </button>
            ))}
          </div>
        )}
      </Modal>

      <MenuItemAnalyticsModal
        isOpen={isAllBranch && itemAnalyticsOpen}
        onClose={() => {
          setItemAnalyticsOpen(false);
        }}
        target={itemAnalyticsTarget}
        dateRange={dateRange}
      />

      <SalesDayDrillModal
        open={dayDrillOpen}
        onClose={() => {
          setDayDrillOpen(false);
          setDayDrillInitial(null);
        }}
        initial={dayDrillInitial}
        boundRange={dateRange}
        lockedBranch={dayDrillLockedBranch}
        dailyPerBranch={dailyPerBranch}
        filterBranchIds={chartBranchIds}
        formatMoney={money}
      />

      {/* ── Sales Table ────────────────────────────── */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportCsv}
              className="flex items-center justify-center h-9 w-9 rounded-lg bg-green-50 hover:bg-green-100 transition-colors cursor-pointer"
            >
              <img src="/csv.png" alt="CSV export" className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={handleExportPdf}
              className="flex items-center justify-center h-9 w-9 rounded-lg bg-red-50 hover:bg-red-100 transition-colors cursor-pointer"
            >
              <img src="/pdf.png" alt="PDF export" className="h-6 w-6" />
            </button>
          </div>
          <button type="button" className="text-brand-muted hover:text-brand-text transition-colors">
            <LayoutGrid size={18} />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className={`w-full ${showBranchColumn ? 'min-w-[1040px]' : 'min-w-[920px]'}`}>
            <thead>
              <tr className="text-left text-xs font-medium text-brand-muted border-b border-gray-100">
                <th className="px-5 py-3">{t('sales_analytics.date')}</th>
                {showBranchColumn ? (
                  <th className="px-5 py-3">{t('sales_analytics.branch')}</th>
                ) : null}
                <th className="px-5 py-3">{t('sales_analytics.total_sales')}</th>
                <th className="px-5 py-3">{t('sales_analytics.refund')}</th>
                <th className="px-5 py-3">{t('sales_analytics.discount')}</th>
                <th className="px-5 py-3">{t('sales_analytics.net_sales')}</th>
                <th className="px-5 py-3">{t('sales_analytics.product_unit_price')}</th>
                <th className="px-5 py-3">{t('sales_analytics.gross_profit')}</th>
              </tr>
            </thead>
            <tbody>
              {pagedTableRows.map((row, idx) => (
                <tr key={`${row.date}-${row.branchName ?? 'all'}-${idx}`} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-5 py-3.5 text-sm text-brand-text">{row.date}</td>
                  {showBranchColumn ? (
                    <td className="px-5 py-3.5 text-sm font-medium text-brand-text">{row.branchName}</td>
                  ) : null}
                  <td className="px-5 py-3.5 text-sm text-brand-text">{money(row.totalSales)}</td>
                  <td className="px-5 py-3.5 text-sm text-brand-text">{money(row.refund)}</td>
                  <td className="px-5 py-3.5 text-sm text-brand-text">{money(row.discount)}</td>
                  <td className="px-5 py-3.5 text-sm text-brand-text">{money(row.netSales)}</td>
                  <td className="px-5 py-3.5 text-sm text-brand-text">{money(row.productUnitPrice)}</td>
                  <td className="px-5 py-3.5 text-sm text-brand-text">{money(row.grossProfit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setTablePage((prev) => Math.max(0, prev - 1))} disabled={safeTablePage === 0} className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-200 text-brand-muted disabled:opacity-40">
              <ChevronLeft size={16} />
            </button>
            <button type="button" onClick={() => setTablePage((prev) => Math.min(totalTablePages - 1, prev + 1))} disabled={safeTablePage >= totalTablePages - 1} className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-200 text-brand-muted disabled:opacity-40">
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="text-sm text-brand-muted">
            {t('sales_analytics.page')} <span className="font-semibold text-brand-text">{safeTablePage + 1}</span> / {totalTablePages}
          </div>
          <div className="text-sm text-brand-muted">
            {t('sales_analytics.page_line_count')} <span className="font-semibold text-brand-text">{TABLE_PAGE_SIZE}</span>
          </div>
        </div>
      </div>

          </motion.div>
        )}
      </AnimatePresence>

      <CashReconciliationModal
        open={cashReconciliationOpen}
        onClose={() => {
          setCashReconciliationOpen(false);
          void loadReconAggregates();
        }}
        onDataChanged={() => void loadReconAggregates()}
        branchId={cashReconciliationBranchId}
        branchName={selectedBranch?.name ?? '—'}
        dateRange={dateRange}
        reportNetSalesDisplay={reportNetSalesDisplay}
        cashReconPeriodDisplay={cashReconPeriodDisplay}
        totalNetSalesDisplay={totalNetSalesModalDisplay}
      />
    </div>
  );
};
