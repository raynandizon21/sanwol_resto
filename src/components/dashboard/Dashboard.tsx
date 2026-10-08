import React from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { type Branch } from '../partials/Header';
import { SkeletonStatCards, SkeletonChart, SkeletonTable } from '../ui/Skeleton';
import {
  ClipboardList,
  Package,
  TrendingUp,
  UtensilsCrossed,
  MessageSquare,
  Star,
  Calendar,
  ChevronDown,
  DollarSign,
} from 'lucide-react';
import {
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Sector,
  BarChart,
  Bar,
  Rectangle,
  Area,
  ComposedChart,
  XAxis,
  YAxis,
} from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Modal } from '../ui/Modal';
import { ORDER_STATUS, type OrderRecord } from '../../services/orderService';
import { getMenus, resolveImageUrl, type MenuRecord } from '../../services/menuService';
import {
  fetchTopSellingApi,
  fetchBranchDashboardBundleApi,
  type ApiTopSellingItem,
} from '../../services/analyticsService';
import { fetchCashReconciliationAggregates } from '../../services/cashReconciliationService';
import {
  buildBranchDashboardCacheKey,
  clearKnownEmptyBranch,
  hasBranchDashboardCacheData,
  isBranchDashboardCacheFresh,
  isBranchDashboardPayloadEmpty,
  isBranchDashboardPayloadIncomplete,
  isKnownEmptyBranch,
  markKnownEmptyBranch,
  readBranchDashboardCacheIncludingStale,
  writeBranchDashboardCache,
  type BranchDashboardCachePayload,
} from '../../utils/branchDashboardCache';
import { waitForBranchDashboardPrefetch } from '../../utils/prefetchBranchDashboard';
import { getManilaMonthToDateRange } from '../../utils/manilaDateTime';
import { showsMoneyCents } from '../../utils/branchFeatures';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Measures container and renders chart with explicit width/height to avoid Recharts -1 warning */
function ChartContainer({
  className = '',
  minHeight = 200,
  render,
}: {
  className?: string;
  minHeight?: number;
  render: (size: { width: number; height: number }) => React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  React.useEffect(() => {
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
    <div ref={ref} className={className} style={{ minHeight }}>
      {size.width > 0 && size.height > 0 ? render(size) : null}
    </div>
  );
}

const toYYYYMMDD = (d: Date): string =>
  d.getFullYear() +
  '-' +
  String(d.getMonth() + 1).padStart(2, '0') +
  '-' +
  String(d.getDate()).padStart(2, '0');

const WEEKDAY_ABBR_TO_JS_DAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const weekdayAbbrFromJsDay = (jsDay: number): string =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][jsDay] ?? '';

const weekendStyleForDay = (jsDay: number): { fill: string } | null => {
  if (jsDay === 6) return { fill: '#ef4444' }; // Sat (red)
  if (jsDay === 0) return { fill: '#22c55e' }; // Sun (green)
  return null;
};

const normalizeTickLabel = (value: unknown): string => String(value ?? '').trim();

const parseIsoDate = (iso: string): Date | null => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const getCurrentMonthRange = () => getManilaMonthToDateRange();

const formatCurrency = (value: number, withCents = false) => {
  const n = Number.isFinite(value) ? value : 0;
  if (withCents) {
    const cents = Math.round(n * 100) / 100;
    return `₱${cents.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return `₱${Math.trunc(n).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
};

const formatDateLabel = (dateStr: string) => {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
};

const TOP_CATEGORY_COLORS = ['#0f172a', '#2563eb', '#f97316', '#16a34a', '#7c3aed', '#e11d48'];

const DEFAULT_TRENDING_IMAGE =
  'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?q=80&w=800&auto=format&fit=crop';

type TrendingMenuRow = {
  key: string;
  name: string;
  category: string;
  totalQty: number;
  netSales: number;
  image: string;
};

type DashboardStats = {
  totalOrders: number;
  totalSales: number;
  totalExpenses: number;
  totalProfit: number;
};

type RevenuePoint = {
  name: string;
  date?: string; // ISO yyyy-mm-dd for tooltip/weekend styling
  income: number;
  expense: number;
};

const EMPTY_BRANCH_DASHBOARD = {
  stats: {
    totalOrders: 0,
    totalSales: 0,
    totalExpenses: 0,
    totalProfit: 0,
  },
  revenueData: [] as RevenuePoint[],
  ordersOverview: [] as { name: string; orders: number; date?: string }[],
};

type DashboardProps = {
  selectedBranch: Branch | null;
  dateRange: {
    start: string;
    end: string;
  };
};

const PieTooltip = ({ active, payload, total, withCents = false }: any) => {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  const name = p?.name ?? p?.payload?.name ?? '';
  const value = Number(p?.value ?? 0);
  const safeTotal = Number(total ?? 0);
  const percent = safeTotal > 0 ? value / safeTotal : 0;
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-md">
      <div className="text-sm font-bold text-slate-900 mb-0.5">{name}</div>
      <div className="text-xs text-slate-600">
        {formatCurrency(value, withCents)} • {(percent * 100).toFixed(1)}%
      </div>
    </div>
  );
};

const renderActiveCategorySlice = (props: any) => {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill, payload } = props;
  return (
    <g style={{ cursor: 'pointer' }}>
      <text x={cx} y={cy} dy={4} textAnchor="middle" className="fill-slate-700 text-xs font-semibold">
        {payload?.name}
      </text>
      <Sector
        cx={cx}
        cy={cy}
        innerRadius={innerRadius}
        outerRadius={outerRadius + 6}
        startAngle={startAngle}
        endAngle={endAngle}
        fill={fill}
      />
    </g>
  );
};

const parseDateSafe = (value: string) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isBetweenInclusive = (value: Date, start: Date, end: Date) => {
  const t = value.getTime();
  return t >= start.getTime() && t <= end.getTime();
};

const statusBadgeClass = (status: number) =>
  status === ORDER_STATUS.SETTLED
    ? 'bg-green-100 text-green-600'
    : status === ORDER_STATUS.CANCELLED
      ? 'bg-red-100 text-red-600'
      : status === ORDER_STATUS.CONFIRMED
        ? 'bg-blue-100 text-blue-600'
        : 'bg-orange-100 text-orange-600';

const orderTypeLabel = (t: any, orderType: string | null | undefined) => {
  if (!orderType) return '—';
  const normalized = orderType.trim().toUpperCase().replace(/\s+/g, '_');
  if (normalized === 'DINE_IN') return t('orders.dine_in');
  if (normalized === 'TAKE_OUT') return t('orders.take_out');
  if (normalized === 'DELIVERY') return t('orders.delivery');
  return orderType;
};

const StatCard = ({
  icon: Icon,
  label,
  value,
  trend,
  trendType,
}: {
  icon: any;
  label: string;
  value: string;
  trend: string;
  trendType: 'up' | 'down';
}) => (
  <div className="bg-white p-5 rounded-2xl shadow-sm flex items-center gap-4 flex-1 min-w-[200px]">
    <div className="w-12 h-12 rounded-xl bg-brand-primary flex items-center justify-center text-white">
      <Icon size={24} />
    </div>
    <div>
      <p className="text-brand-muted text-sm font-medium mb-1">{label}</p>
      <div className="flex items-baseline gap-2">
        <h3 className="text-2xl font-bold">{value}</h3>
      </div>
    </div>
  </div>
);

const TrendingMenuItem = ({
  menu,
  netSalesLabel = 'Net sales',
  withCents = false,
}: {
  menu: TrendingMenuRow;
  netSalesLabel?: string;
  withCents?: boolean;
  key?: React.Key;
}) => (
  <div className="group cursor-pointer">
    <div className="relative mb-3 overflow-hidden rounded-2xl">
      <img
        src={menu.image || DEFAULT_TRENDING_IMAGE}
        alt={menu.name}
        className="w-full aspect-[4/3] object-cover group-hover:scale-105 transition-transform duration-500"
        referrerPolicy="no-referrer"
      />
      <div className="absolute top-3 right-3 bg-white/90 backdrop-blur-sm px-2 py-1 rounded-lg flex items-center gap-1 shadow-sm">
        <Star size={10} className="text-yellow-500 fill-yellow-500" />
        <span className="text-[10px] font-bold">{formatCurrency(menu.netSales, withCents)}</span>
      </div>
    </div>
    <div className="flex items-start justify-between">
      <div>
        <h5 className="text-base font-bold group-hover:text-brand-primary transition-colors">
          {menu.name}
        </h5>
        <p className="text-xs text-brand-muted font-medium mb-2">{menu.category}</p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-brand-muted">
            <Star size={12} />
            <span className="text-xs font-bold">{netSalesLabel}</span>
          </div>
          <div className="flex items-center gap-1.5 text-brand-muted">
            <ClipboardList size={12} />
            <span className="text-xs font-bold">{menu.totalQty.toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
);

const RevenueClickableDot = ({
  cx,
  cy,
  payload,
  color,
  metric,
  onNavigate,
}: any) => {
  if (typeof cx !== 'number' || typeof cy !== 'number') return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill={color}
      stroke="none"
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        onNavigate(metric, payload?.date);
      }}
    />
  );
};

const VerticalCarousel = ({
  items,
  netSalesLabel = 'Net sales',
  withCents = false,
}: {
  items: any[];
  netSalesLabel?: string;
  withCents?: boolean;
}) => {
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % items.length);
    }, 4000);
    return () => clearInterval(timer);
  }, [items.length]);

  return (
    <div className="relative h-full overflow-hidden">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={index}
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -100, opacity: 0 }}
          transition={{
            type: "spring",
            stiffness: 300,
            damping: 30,
            opacity: { duration: 0.2 },
          }}
          className="space-y-6"
        >
          {[...items, ...items, ...items]
            .slice(index, index + 3)
            .map((menu, i) => (
              <TrendingMenuItem
                key={`${menu.name}-${index}-${i}`}
                menu={menu}
                netSalesLabel={netSalesLabel}
                withCents={withCents}
              />
            ))}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};

export const Dashboard: React.FC<DashboardProps> = ({ selectedBranch, dateRange }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const dashboardReqSeq = React.useRef(0);
  const loadedCacheKeyRef = React.useRef<string | null>(null);
  const showMoneyCents = showsMoneyCents(selectedBranch?.id);
  const money = React.useCallback(
    (value: number) => formatCurrency(value, showMoneyCents),
    [showMoneyCents],
  );

  const initialBranchLoad = React.useMemo(() => {
    if (!selectedBranch) {
      return { cached: null as BranchDashboardCachePayload | null, knownEmpty: false, needsSkeleton: false };
    }
    const fallback = getCurrentMonthRange();
    const key = buildBranchDashboardCacheKey({
      branchId: String(selectedBranch.id),
      start: dateRange.start || fallback.start,
      end: dateRange.end || fallback.end,
    });
    const cached = readBranchDashboardCacheIncludingStale(key);
    const hasCache = hasBranchDashboardCacheData(cached);
    const knownEmpty = isKnownEmptyBranch(key);
    return {
      cached: hasCache ? cached : null,
      knownEmpty,
      needsSkeleton: !hasCache && !knownEmpty,
    };
  }, [selectedBranch?.id, dateRange.start, dateRange.end]);

  const [dashboardData, setDashboardData] = React.useState<{
    stats: DashboardStats;
    revenueData: RevenuePoint[];
    ordersOverview: { name: string; orders: number }[];
  } | null>(() => initialBranchLoad.cached?.dashboardData ?? EMPTY_BRANCH_DASHBOARD);
  const [pageLoading, setPageLoading] = React.useState(() => initialBranchLoad.needsSkeleton);
  const [topCategories, setTopCategories] = React.useState<
    { name: string; value: number; color: string }[]
  >(() => initialBranchLoad.cached?.topCategories ?? []);
  const [loadingTopCategories, setLoadingTopCategories] = React.useState(
    () => !(initialBranchLoad.cached?.topCategories.length),
  );
  const [activeCategoryIndex, setActiveCategoryIndex] = React.useState<number | null>(null);
  const [recentOrders, setRecentOrders] = React.useState<OrderRecord[]>(
    () => initialBranchLoad.cached?.recentOrders ?? [],
  );
  const [loadingRecentOrders, setLoadingRecentOrders] = React.useState(
    () => !(initialBranchLoad.cached?.recentOrders.length),
  );
  const [recentOrderItemsMeta, setRecentOrderItemsMeta] = React.useState<
    Record<string, { lineCount: number; totalQty: number }>
  >(() => initialBranchLoad.cached?.recentOrderItemsMeta ?? {});
  const [trendingMenusData, setTrendingMenusData] = React.useState<TrendingMenuRow[]>(
    () => initialBranchLoad.cached?.trendingMenusData ?? [],
  );
  const [loadingTrendingMenus, setLoadingTrendingMenus] = React.useState(
    () => !(initialBranchLoad.cached?.trendingMenusData.length),
  );
  const [menuImageByName, setMenuImageByName] = React.useState<Record<string, string>>({});
  const [isIncomeTopModalOpen, setIsIncomeTopModalOpen] = React.useState(false);
  const [incomeTopDate, setIncomeTopDate] = React.useState<string>('');
  const [incomeTopLoading, setIncomeTopLoading] = React.useState(false);
  const [incomeTopRows, setIncomeTopRows] = React.useState<ApiTopSellingItem[]>([]);
  /** Cash reconciliation amount for the opened calendar day (same scope as chart / Sales Analytics) */
  const [incomeTopReconDay, setIncomeTopReconDay] = React.useState(0);
  const incomeTopGrandTotal = React.useMemo(
    () => incomeTopRows.reduce((sum, row) => sum + Number(row.total_revenue || 0), 0),
    [incomeTopRows],
  );
  const incomeTopModalTotal = React.useMemo(
    () => incomeTopGrandTotal + incomeTopReconDay,
    [incomeTopGrandTotal, incomeTopReconDay],
  );

  const cacheKey = React.useMemo(() => {
    if (!selectedBranch) return '';
    const fallback = getCurrentMonthRange();
    return buildBranchDashboardCacheKey({
      branchId: String(selectedBranch.id),
      start: dateRange.start || fallback.start,
      end: dateRange.end || fallback.end,
    });
  }, [selectedBranch?.id, dateRange.start, dateRange.end]);

  const hydrateFromCache = React.useCallback((cached: BranchDashboardCachePayload) => {
    if (cached.dashboardData) {
      setDashboardData(cached.dashboardData);
    }
    if (cached.topCategories.length) {
      setTopCategories(cached.topCategories);
      setLoadingTopCategories(false);
    }
    if (cached.trendingMenusData.length) {
      setTrendingMenusData(cached.trendingMenusData);
      setLoadingTrendingMenus(false);
    }
    if (cached.recentOrders.length) {
      setRecentOrders(cached.recentOrders);
      setRecentOrderItemsMeta(cached.recentOrderItemsMeta);
      setLoadingRecentOrders(false);
    }
  }, []);

  const navigateToBreakdown = React.useCallback(
    (metric: 'income' | 'expense', pointDate?: string) => {
      const nextParams = new URLSearchParams(location.search);
      nextParams.set('breakdown', '1');
      nextParams.set('metric', metric);
      if (pointDate) nextParams.set('focus_date', pointDate);
      navigate(`/expenses?${nextParams.toString()}`);
    },
    [location.search, navigate],
  );

  const handleRevenuePointAction = React.useCallback(
    async (metric: 'income' | 'expense', pointDate?: string) => {
      if (metric === 'expense') {
        navigateToBreakdown('expense', pointDate);
        return;
      }

      const fallback = getCurrentMonthRange();
      const pickedDate = pointDate || dateRange.end || fallback.end;
      const params = new URLSearchParams();
      params.set('start_date', pickedDate);
      params.set('end_date', pickedDate);
      params.set('limit', '10');
      if (selectedBranch && String(selectedBranch.id) !== 'all') {
        params.set('branch_id', String(selectedBranch.id));
      }

      setIncomeTopDate(pickedDate);
      setIsIncomeTopModalOpen(true);
      setIncomeTopLoading(true);
      setIncomeTopReconDay(0);
      const ymd = pickedDate.slice(0, 10);
      try {
        const [rows, recon] = await Promise.all([
          fetchTopSellingApi(params),
          selectedBranch && String(selectedBranch.id) !== 'all'
            ? fetchCashReconciliationAggregates({
                start: ymd,
                end: ymd,
                branchId: String(selectedBranch.id),
              }).catch(() => ({ total: 0, byDate: {} as Record<string, number> }))
            : Promise.resolve({ total: 0, byDate: {} as Record<string, number> }),
        ]);
        setIncomeTopRows(Array.isArray(rows) ? rows.slice(0, 10) : []);
        const fromMap = Number(recon.byDate?.[ymd] ?? 0);
        const dayAmt = fromMap || Number(recon.total ?? 0);
        setIncomeTopReconDay(Number.isFinite(dayAmt) ? Math.max(0, dayAmt) : 0);
      } catch (error) {
        console.error('Failed to load income top menus:', error);
        setIncomeTopRows([]);
        setIncomeTopReconDay(0);
      } finally {
        setIncomeTopLoading(false);
      }
    },
    [dateRange.end, navigateToBreakdown, selectedBranch],
  );

  const RevenueXAxisTick = React.useMemo(() => {
    const Tick = (props: any) => {
      const { x, y, payload } = props ?? {};
      const iso = normalizeTickLabel(payload?.value);
      const d = iso ? parseIsoDate(iso) : null;
      const jsDay = d ? d.getDay() : null;
      const weekend = jsDay == null ? null : weekendStyleForDay(jsDay);
      const fill = weekend?.fill ?? '#64748b';
      const label = d ? String(d.getDate()) : iso;
      return (
        <g transform={`translate(${x},${y})`}>
          <text x={0} y={0} dy={16} textAnchor="middle" fill={fill} fontSize={12} fontWeight={weekend ? 800 : 500}>
            {label}
          </text>
        </g>
      );
    };
    return Tick;
  }, []);

  const OrdersXAxisTick = React.useMemo(() => {
    const Tick = (props: any) => {
      const { x, y, payload } = props ?? {};
      const label = normalizeTickLabel(payload?.value);
      const iso = payload?.payload?.date as string | undefined;
      const d = iso ? parseIsoDate(iso) : null;
      const jsDay = d ? d.getDay() : WEEKDAY_ABBR_TO_JS_DAY[label.slice(0, 3)] ?? null;
      const weekend = jsDay == null ? null : weekendStyleForDay(jsDay);
      const fill = weekend?.fill ?? '#64748b';
      // Weekly requirement: dot marker for all days, dot uses same color as label.
      return (
        <g transform={`translate(${x},${y})`}>
          <text x={0} y={0} dy={16} textAnchor="middle" fill={fill} fontSize={12} fontWeight={weekend ? 800 : 600}>
            {`● ${label}`}
          </text>
        </g>
      );
    };
    return Tick;
  }, []);

  const RevenueTooltipContent = React.useMemo(() => {
    const Content = (props: any) => {
      const { active, payload } = props ?? {};
      if (!active || !payload?.length) return null;
      const point = payload?.[0]?.payload as RevenuePoint | undefined;
      const d = point?.date ? parseIsoDate(point.date) : null;
      const labelText = d ? `${d.getDate()} - ${weekdayAbbrFromJsDay(d.getDay())}` : normalizeTickLabel(point?.name);
      const weekend = d ? weekendStyleForDay(d.getDay()) : null;
      const labelStyle: React.CSSProperties = weekend ? { color: weekend.fill, fontWeight: 800 } : { fontWeight: 800 };

      const rawForKey = (dataKey: string): number => {
        if (!point) return 0;
        if (dataKey === 'income' || dataKey === 'incomePlot') return Number(point.income || 0);
        if (dataKey === 'expense' || dataKey === 'expensePlot') return Number(point.expense || 0);
        return 0;
      };
      const rowLabel = (dataKey: string) =>
        dataKey === 'income' || dataKey === 'incomePlot' ? t('dashboard.income') : t('dashboard.expense');
      const sorted = [...payload].sort((a, b) => rawForKey(String(b?.dataKey)) - rawForKey(String(a?.dataKey)));

      return (
        <div
          style={{
            background: '#fff',
            borderRadius: 12,
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            padding: '10px 12px',
          }}
        >
          <div style={{ marginBottom: 8, fontSize: 12, ...labelStyle }}>{labelText}</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {sorted.map((it: any, idx: number) => (
              <div
                key={`${it?.dataKey}-${idx}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  width: '100%',
                  textAlign: 'left',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 9999, background: it?.color || '#64748b', display: 'inline-block' }} />
                <span style={{ fontSize: 12, color: '#475569', minWidth: 70 }}>{rowLabel(String(it?.dataKey))}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>
                  {money(rawForKey(String(it?.dataKey)))}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    };
    return Content;
  }, [money, t]);

  const revenueChartData = React.useMemo(() => {
    const base = dashboardData?.revenueData ?? [];
    const plot = (v: number) => Math.sqrt(Math.max(0, Number(v) || 0));
    return base.map((p) => ({
      ...p,
      incomePlot: plot(p.income),
      expensePlot: plot(p.expense),
    }));
  }, [dashboardData?.revenueData]);

  const OrdersTooltipContent = React.useMemo(() => {
    const Content = (props: any) => {
      const { active, payload } = props ?? {};
      if (!active || !payload?.length) return null;
      const point = payload?.[0]?.payload as { name?: string; date?: string; orders?: number } | undefined;
      const d = point?.date ? parseIsoDate(point.date) : null;
      const labelText = d ? `${d.getDate()} - ${weekdayAbbrFromJsDay(d.getDay())}` : normalizeTickLabel(point?.name);
      const weekend = d ? weekendStyleForDay(d.getDay()) : null;
      const labelStyle: React.CSSProperties = weekend ? { color: weekend.fill, fontWeight: 800 } : { fontWeight: 800 };
      const value = Number(payload?.[0]?.value ?? 0);
      return (
        <div
          style={{
            background: '#fff',
            borderRadius: 12,
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            padding: '10px 12px',
          }}
        >
          <div style={{ marginBottom: 8, fontSize: 12, ...labelStyle }}>{labelText}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: 9999, background: '#4f46e5', display: 'inline-block' }} />
            <span style={{ fontSize: 12, color: '#475569', minWidth: 86 }}>{t('dashboard.total_orders')}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>{value}</span>
          </div>
        </div>
      );
    };
    return Content;
  }, [t]);

  const hasDashboardPayloadStats = React.useCallback((payload: BranchDashboardCachePayload) => {
    const stats = payload.dashboardData?.stats;
    return (
      !!stats &&
      (stats.totalOrders > 0 ||
        stats.totalSales > 0 ||
        stats.totalExpenses > 0 ||
        (payload.dashboardData?.revenueData?.length ?? 0) > 0)
    );
  }, []);

  const applyBundle = React.useCallback(
    (bundle: BranchDashboardCachePayload, options: { background?: boolean } = {}) => {
      const { background = false } = options;
      const payload: BranchDashboardCachePayload = {
        ...bundle,
        dashboardData: bundle.dashboardData ?? EMPTY_BRANCH_DASHBOARD,
      };
      const hasStats = hasDashboardPayloadStats(payload);
      const incomplete = isBranchDashboardPayloadIncomplete(payload);

      const mergeDashboardData = (
        prev: NonNullable<typeof dashboardData>,
        incoming: NonNullable<typeof payload.dashboardData>,
      ) => ({
        ...incoming,
        stats: {
          totalOrders:
            incoming.stats.totalOrders > 0 ? incoming.stats.totalOrders : prev.stats.totalOrders,
          totalSales:
            incoming.stats.totalSales > 0 ? incoming.stats.totalSales : prev.stats.totalSales,
          totalExpenses:
            incoming.stats.totalExpenses > 0
              ? incoming.stats.totalExpenses
              : prev.stats.totalExpenses,
          totalProfit:
            incoming.stats.totalProfit > 0 ? incoming.stats.totalProfit : prev.stats.totalProfit,
        },
        ordersOverview:
          incoming.ordersOverview.length > 0 ? incoming.ordersOverview : prev.ordersOverview,
        revenueData: incoming.revenueData.length > 0 ? incoming.revenueData : prev.revenueData,
      });

      if (background) {
        if (hasStats && payload.dashboardData && !incomplete) {
          setDashboardData(payload.dashboardData);
        } else if (incomplete && payload.dashboardData) {
          setDashboardData((prev) =>
            prev ? mergeDashboardData(prev, payload.dashboardData!) : payload.dashboardData!,
          );
        }
        setTopCategories((prev) => (payload.topCategories.length > 0 ? payload.topCategories : prev));
        setTrendingMenusData((prev) =>
          payload.trendingMenusData.length > 0 ? payload.trendingMenusData : prev,
        );
        setRecentOrders((prev) => (payload.recentOrders.length > 0 ? payload.recentOrders : prev));
        setRecentOrderItemsMeta((prev) =>
          Object.keys(payload.recentOrderItemsMeta).length > 0
            ? payload.recentOrderItemsMeta
            : prev,
        );
      } else {
        setDashboardData((prev) => {
          if (!hasStats || !payload.dashboardData) {
            return prev ?? EMPTY_BRANCH_DASHBOARD;
          }
          if (incomplete && prev) {
            return mergeDashboardData(prev, payload.dashboardData);
          }
          return payload.dashboardData;
        });
        setTopCategories((prev) => (payload.topCategories.length > 0 ? payload.topCategories : prev));
        setTrendingMenusData((prev) =>
          payload.trendingMenusData.length > 0 ? payload.trendingMenusData : prev,
        );
        setRecentOrders((prev) => (payload.recentOrders.length > 0 ? payload.recentOrders : prev));
        setRecentOrderItemsMeta((prev) =>
          Object.keys(payload.recentOrderItemsMeta).length > 0
            ? payload.recentOrderItemsMeta
            : prev,
        );
      }

      if (payload.topCategories.length > 0) setLoadingTopCategories(false);
      if (payload.trendingMenusData.length > 0) setLoadingTrendingMenus(false);
      if (payload.recentOrders.length > 0) setLoadingRecentOrders(false);

      if (isBranchDashboardPayloadEmpty(payload)) {
        if (!background) {
          markKnownEmptyBranch(cacheKey);
        }
      } else if (!isBranchDashboardPayloadIncomplete(payload)) {
        clearKnownEmptyBranch(cacheKey);
        writeBranchDashboardCache(cacheKey, payload);
      }
    },
    [cacheKey, hasDashboardPayloadStats],
  );

  const loadDashboardBundle = React.useCallback(
    async (background: boolean) => {
      if (!selectedBranch || !cacheKey) return;
      const reqId = ++dashboardReqSeq.current;
      if (!background) {
        setLoadingTopCategories(true);
        setLoadingTrendingMenus(true);
        setLoadingRecentOrders(true);
      }
      try {
        const fallback = getCurrentMonthRange();
        const start = dateRange.start || fallback.start;
        const end = dateRange.end || fallback.end;

        const bundle = await fetchBranchDashboardBundleApi({
          branchId: String(selectedBranch.id),
          start,
          end,
        });
        if (reqId !== dashboardReqSeq.current) return;

        const payload = {
          ...bundle,
          recentOrders: bundle.recentOrders as OrderRecord[],
        };

        if (isBranchDashboardPayloadIncomplete(payload) && !background) {
          await new Promise((r) => setTimeout(r, 400));
          if (reqId !== dashboardReqSeq.current) return;
          const retryBundle = await fetchBranchDashboardBundleApi({
            branchId: String(selectedBranch.id),
            start,
            end,
          });
          if (reqId !== dashboardReqSeq.current) return;
          applyBundle(
            {
              ...retryBundle,
              recentOrders: retryBundle.recentOrders as OrderRecord[],
            },
            { background: false },
          );
          return;
        }

        applyBundle(payload, { background });
      } catch (error) {
        if (reqId !== dashboardReqSeq.current) return;
        console.error('Failed to load branch dashboard bundle:', error);
        if (!background) {
          setDashboardData((prev) => prev ?? EMPTY_BRANCH_DASHBOARD);
        }
      } finally {
        if (reqId !== dashboardReqSeq.current) return;
        setLoadingTopCategories(false);
        setLoadingTrendingMenus(false);
        setLoadingRecentOrders(false);
      }
    },
    [applyBundle, cacheKey, dateRange.end, dateRange.start, selectedBranch?.id],
  );

  React.useEffect(() => {
    if (!selectedBranch || !cacheKey) {
      loadedCacheKeyRef.current = null;
      setPageLoading(false);
      setDashboardData(EMPTY_BRANCH_DASHBOARD);
      setTopCategories([]);
      setTrendingMenusData([]);
      setRecentOrders([]);
      setRecentOrderItemsMeta({});
      return;
    }

    const cacheKeyChanged = loadedCacheKeyRef.current !== cacheKey;
    loadedCacheKeyRef.current = cacheKey;

    let cancelled = false;

    const run = async () => {
      const cached = readBranchDashboardCacheIncludingStale(cacheKey);
      if (hasBranchDashboardCacheData(cached)) {
        hydrateFromCache(cached);
        setPageLoading(false);
        void loadDashboardBundle(true);
        return;
      }

      await waitForBranchDashboardPrefetch(cacheKey);
      if (cancelled) return;

      const afterPrefetch = readBranchDashboardCacheIncludingStale(cacheKey);
      if (hasBranchDashboardCacheData(afterPrefetch)) {
        hydrateFromCache(afterPrefetch);
        setPageLoading(false);
        void loadDashboardBundle(true);
        return;
      }

      if (isKnownEmptyBranch(cacheKey)) {
        if (cacheKeyChanged) {
          setDashboardData(EMPTY_BRANCH_DASHBOARD);
          setTopCategories([]);
          setTrendingMenusData([]);
          setRecentOrders([]);
          setRecentOrderItemsMeta({});
        }
        setPageLoading(false);
        void loadDashboardBundle(true);
        return;
      }

      setPageLoading(true);
      void loadDashboardBundle(false).finally(() => {
        if (!cancelled) setPageLoading(false);
      });
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, dateRange.end, dateRange.start, hydrateFromCache, loadDashboardBundle, selectedBranch?.id]);

  React.useEffect(() => {
    if (!selectedBranch || pageLoading || trendingMenusData.length === 0) return;

    let cancelled = false;
    const loadMenuImages = async () => {
      try {
        const branchId = String(selectedBranch.id);
        const menus: MenuRecord[] = await getMenus(branchId);
        if (cancelled) return;
        const map: Record<string, string> = {};
        (Array.isArray(menus) ? menus : []).forEach((m) => {
          const key = (m.name || '').trim().toLowerCase();
          const resolved = resolveImageUrl(m.imageUrl);
          if (key && resolved) map[key] = resolved;
        });
        setMenuImageByName(map);
      } catch {
        if (!cancelled) setMenuImageByName({});
      }
    };

    const timer = window.setTimeout(() => {
      void loadMenuImages();
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedBranch?.id, pageLoading, trendingMenusData.length]);

  React.useEffect(() => {
    if (Object.keys(menuImageByName).length === 0) return;
    setTrendingMenusData((prev) => {
      if (!prev.length) return prev;
      return prev.map((row) => ({
        ...row,
        image: menuImageByName[row.name.trim().toLowerCase()] || row.image,
      }));
    });
  }, [menuImageByName]);

  const orderTypes = [
    {
      label: t('dashboard.dine_in'),
      value: 900,
      percentage: 45,
      icon: UtensilsCrossed,
      color: 'bg-orange-100 text-orange-600',
    },
    {
      label: t('dashboard.takeaway'),
      value: 600,
      percentage: 30,
      icon: Package,
      color: 'bg-slate-200 text-slate-700',
    },
    {
      label: t('dashboard.online'),
      value: 500,
      percentage: 25,
      icon: MessageSquare,
      color: 'bg-orange-50 text-orange-700',
    },
  ];

  return (
    <AnimatePresence mode="wait">
      {pageLoading ? (
        <motion.div
          key="skeleton"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="flex gap-8 pt-6"
        >
          <div className="flex-1 space-y-8">
            <SkeletonStatCards count={4} />
            <div className="grid grid-cols-3 gap-6">
              <SkeletonChart className="col-span-2" />
              <SkeletonChart />
            </div>
            <div className="grid grid-cols-3 gap-6">
              <SkeletonChart className="col-span-2" />
              <SkeletonChart />
            </div>
            <SkeletonTable columns={7} rows={5} showToolbar={false} />
          </div>
          <div className="w-80 space-y-8">
            <SkeletonChart />
          </div>
        </motion.div>
      ) : (
      <motion.div
        key="content"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="flex gap-8 pt-6"
      >
          <div className="flex-1 space-y-8">
            <div className="flex gap-6">
              <StatCard
                icon={ClipboardList}
                label={t('dashboard.total_orders')}
                value={dashboardData
                  ? dashboardData.stats.totalOrders.toLocaleString()
                  : '0'}
                trend=""
                trendType="up"
              />
              <StatCard
                icon={DollarSign}
                label="Total Sales"
                value={
                  dashboardData
                    ? money(dashboardData.stats.totalSales)
                    : money(0)
                }
                trend=""
                trendType="up"
              />
              <StatCard
                icon={Package}
                label="Total Expenses"
                value={
                  dashboardData
                    ? money(dashboardData.stats.totalExpenses)
                    : money(0)
                }
                trend=""
                trendType="down"
              />
              <StatCard
                icon={TrendingUp}
                label="Total Profit"
                value={
                  dashboardData
                    ? money(dashboardData.stats.totalProfit)
                    : money(0)
                }
                trend=""
                trendType="up"
              />
            </div>

            <div className="grid grid-cols-3 gap-6">
              <div className="col-span-2 bg-white p-6 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h4 className="text-base text-brand-muted font-medium">{t('dashboard.total_revenue')}</h4>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-brand-primary" />
                      <span className="text-sm font-medium">{t('dashboard.income')}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-brand-text" />
                      <span className="text-sm font-medium">{t('dashboard.expense')}</span>
                    </div>
                  </div>
                </div>
                <div className="h-64 w-full">
                  {dashboardData.revenueData.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-sm text-brand-muted border border-dashed border-slate-200 rounded-2xl">
                      No data
                    </div>
                  ) : (
                  <ChartContainer
                    className="w-full h-full min-h-[256px]"
                    minHeight={256}
                    render={({ width, height }) => (
                      <ComposedChart width={width} height={height} data={revenueChartData} margin={{ top: 8, right: 6, bottom: 6, left: 6 }}>
                      <defs>
                        <linearGradient id="incomeGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="#4f46e5" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="expenseGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#0f172a" stopOpacity={0.18} />
                          <stop offset="100%" stopColor="#0f172a" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis
                        dataKey="date"
                        axisLine={false}
                        tickLine={false}
                        tick={RevenueXAxisTick}
                        dy={10}
                        interval={0}
                        minTickGap={0}
                        tickMargin={6}
                      />
                      <YAxis
                        hide
                        axisLine={false}
                        tickLine={false}
                        width={0}
                      />
                      <Tooltip
                        content={RevenueTooltipContent}
                        offset={20}
                        position={{ y: 24 }}
                        wrapperStyle={{ zIndex: 20, pointerEvents: 'none' }}
                      />
                      <Area
                        type="monotone"
                        dataKey="incomePlot"
                        name={t('dashboard.income')}
                        fill="url(#incomeGradient)"
                        stroke="#4f46e5"
                        strokeWidth={2}
                        dot={(props) => (
                          <RevenueClickableDot
                            {...props}
                            color="#4f46e5"
                            metric="income"
                            onNavigate={handleRevenuePointAction}
                          />
                        )}
                        activeDot={(props) => (
                          <RevenueClickableDot
                            {...props}
                            color="#4f46e5"
                            metric="income"
                            onNavigate={handleRevenuePointAction}
                          />
                        )}
                      />
                      <Area
                        type="monotone"
                        dataKey="expensePlot"
                        name={t('dashboard.expense')}
                        fill="url(#expenseGradient)"
                        stroke="#0f172a"
                        strokeWidth={2}
                        dot={(props) => (
                          <RevenueClickableDot
                            {...props}
                            color="#0f172a"
                            metric="expense"
                            onNavigate={handleRevenuePointAction}
                          />
                        )}
                        activeDot={(props) => (
                          <RevenueClickableDot
                            {...props}
                            color="#0f172a"
                            metric="expense"
                            onNavigate={handleRevenuePointAction}
                          />
                        )}
                      />
                      </ComposedChart>
                    )}
                  />
                  )}
                </div>
              </div>

              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between mb-6">
                  <h4 className="text-base font-bold">{t('dashboard.top_categories')}</h4>
                </div>
                <div className="h-48 w-full relative">
                  {loadingTopCategories && topCategories.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-sm text-brand-muted border border-dashed border-slate-200 rounded-2xl">
                      {t('common.loading')}
                    </div>
                  ) : topCategories.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-sm text-brand-muted border border-dashed border-slate-200 rounded-2xl">
                      No data
                    </div>
                  ) : (
                    <ChartContainer
                      className="w-full h-full min-h-[192px]"
                      minHeight={192}
                      render={({ width, height }) => (
                        <PieChart width={width} height={height}>
                        <Tooltip
                          content={({ active, payload }) => (
                            <PieTooltip
                              active={active}
                              payload={payload}
                              total={topCategories.reduce((s, it) => s + Number(it.value || 0), 0)}
                              withCents={showMoneyCents}
                            />
                          )}
                          contentStyle={{
                            borderRadius: '12px',
                            border: 'none',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                          }}
                        />
                      {/*
                        Recharts Pie supports activeIndex/activeShape at runtime,
                        but some type versions omit these props. Cast for TS.
                      */}
                      {(Pie as any)(
                        {
                          data: topCategories,
                          cx: '50%',
                          cy: '50%',
                          innerRadius: 60,
                          outerRadius: 80,
                          paddingAngle: 5,
                          dataKey: 'value',
                          activeIndex: activeCategoryIndex ?? undefined,
                          activeShape: renderActiveCategorySlice,
                          onMouseLeave: () => setActiveCategoryIndex(null),
                          children: topCategories.map((entry, index) => (
                            <Cell
                              key={`cell-${index}`}
                              fill={entry.color}
                              style={{ cursor: 'pointer', transition: 'opacity 150ms ease' }}
                              onMouseEnter={() => setActiveCategoryIndex(index)}
                            />
                          )),
                        },
                        null
                      )}
                        </PieChart>
                      )}
                    />
                  )}
                </div>
                <div className="grid grid-cols-2 gap-y-3 mt-4">
                  {topCategories.map((item) => (
                    <div key={item.name} className="flex items-center gap-2">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="text-xs font-medium text-brand-muted">{item.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-6">
              <div className="col-span-2 bg-white p-6 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between mb-8">
                  <h4 className="text-base font-bold">{t('dashboard.orders_overview')}</h4>
                </div>
                <div className="h-64 w-full">
                  {dashboardData.ordersOverview.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-sm text-brand-muted border border-dashed border-slate-200 rounded-2xl">
                      No data
                    </div>
                  ) : (
                  <ChartContainer
                    className="w-full h-full min-h-[256px]"
                    minHeight={256}
                    render={({ width, height }) => (
                    <BarChart width={width} height={height} data={dashboardData.ordersOverview}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis
                        dataKey="name"
                        axisLine={false}
                        tickLine={false}
                        tick={OrdersXAxisTick}
                        dy={10}
                      />
                      <YAxis
                        axisLine={false}
                        tickLine={false}
                        tick={{ fontSize: 12, fill: '#64748b' }}
                      />
                      <Tooltip cursor={{ fill: '#4f46e5', opacity: 0.1 }} content={OrdersTooltipContent} />
                      <Bar
                        dataKey="orders"
                        name={t('dashboard.total_orders')}
                        fill="#c7d2fe"
                        radius={[6, 6, 0, 0]}
                        activeBar={<Rectangle fill="#4f46e5" />}
                      />
                    </BarChart>
                    )}
                  />
                  )}
                </div>
              </div>

              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between mb-8">
                  <h4 className="text-base font-bold">{t('dashboard.order_types')}</h4>
                </div>
                <div className="space-y-6">
                  {orderTypes.map((type) => (
                    <div key={type.label} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div
                          className={cn(
                            'w-10 h-10 rounded-xl flex items-center justify-center',
                            type.color,
                          )}
                        >
                          <type.icon size={18} />
                        </div>
                        <div>
                          <p className="text-sm font-bold">{type.label}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-2xl shadow-sm">
              <div className="flex items-center justify-between mb-8">
                <h4 className="text-base font-bold">{t('dashboard.recent_orders')}</h4>
                <button
                  type="button"
                  onClick={() => navigate(`/orders${location.search || ''}`)}
                  className="text-xs font-bold bg-brand-bg px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  {t('dashboard.see_all_orders')}
                </button>
              </div>
              {loadingRecentOrders && recentOrders.length === 0 ? (
                <div className="flex items-center justify-center border border-dashed border-slate-200 rounded-2xl py-12 text-sm font-medium text-brand-muted">
                  {t('common.loading')}
                </div>
              ) : recentOrders.length === 0 ? (
                <div className="flex items-center justify-center border border-dashed border-slate-200 rounded-2xl py-12 text-sm font-medium text-brand-muted">
                  No data
                </div>
              ) : (
                <div className="border border-slate-100 rounded-2xl overflow-hidden">
                  <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100 grid grid-cols-[minmax(0,1fr)_110px_120px_140px_110px] items-center gap-3">
                    <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Order #</div>
                    <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide text-center">Type</div>
                    <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide text-center">Order Items</div>
                    <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide text-right">Total Amount</div>
                    <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide text-right">Status</div>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {recentOrders.map((o) => {
                      const dt = parseDateSafe(o.ENCODED_DT);
                      const dateLabel = dt
                        ? dt.toLocaleString(undefined, {
                            month: 'short',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : o.ENCODED_DT;

                      const meta = recentOrderItemsMeta[String(o.IDNo)];
                      const totalQty = meta?.totalQty ?? 0;

                      return (
                        <div
                          key={o.IDNo}
                          className="px-4 py-3 grid grid-cols-[minmax(0,1fr)_110px_120px_140px_110px] items-center gap-3 hover:bg-slate-50 transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="text-sm font-extrabold text-slate-900 truncate">{o.ORDER_NO}</div>
                            </div>
                            <div className="text-xs text-brand-muted font-medium truncate">{dateLabel}</div>
                          </div>

                          <div className="flex items-center justify-center">
                            {o.ORDER_TYPE ? (
                              <span className="text-[10px] font-bold bg-gray-100 px-2 py-1 rounded-lg whitespace-nowrap">
                                {orderTypeLabel(t, o.ORDER_TYPE)}
                              </span>
                            ) : (
                              <span className="text-brand-muted text-sm">—</span>
                            )}
                          </div>

                          <div className="flex items-center justify-center">
                            <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-violet-50 text-violet-700 border border-violet-100">
                              {totalQty ? totalQty : '—'}
                            </span>
                          </div>

                          <div className="text-sm font-extrabold text-slate-900 whitespace-nowrap text-right">
                            {money(Number(o.GRAND_TOTAL || 0))}
                          </div>

                          <div className="flex items-center justify-end">
                            <span
                              className={cn(
                                'text-xs font-bold px-2 py-1 rounded-lg whitespace-nowrap',
                                statusBadgeClass(Number(o.STATUS))
                              )}
                            >
                              {Number(o.STATUS) === ORDER_STATUS.PENDING
                                ? t('orders.pending')
                                : Number(o.STATUS) === ORDER_STATUS.CONFIRMED
                                  ? t('orders.confirmed')
                                  : Number(o.STATUS) === ORDER_STATUS.SETTLED
                                    ? t('orders.settled')
                                    : Number(o.STATUS) === ORDER_STATUS.CANCELLED
                                      ? t('orders.cancelled')
                                      : t('orders.unknown')}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="w-80 space-y-8">
            <div className="bg-white p-6 rounded-2xl shadow-sm h-full flex flex-col">
              <div className="flex items-center justify-between mb-6">
                <h4 className="text-base font-bold">{t('dashboard.trending_menus')}</h4>
              </div>
              <div className="flex-1 overflow-hidden">
                {loadingTrendingMenus && trendingMenusData.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-brand-muted border border-dashed border-slate-200 rounded-2xl py-8">
                    <span className="animate-pulse">{t('common.loading')}</span>
                  </div>
                ) : trendingMenusData.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-brand-muted border border-dashed border-slate-200 rounded-2xl py-8">
                    No data
                  </div>
                ) : (
                  <VerticalCarousel
                    items={trendingMenusData}
                    netSalesLabel={t('sales_analytics.net_sales') || 'Net sales'}
                    withCents={showMoneyCents}
                  />
                )}
              </div>
            </div>
          </div>
        </motion.div>
      )}
      <Modal
        isOpen={isIncomeTopModalOpen}
        onClose={() => {
          setIsIncomeTopModalOpen(false);
          setIncomeTopReconDay(0);
        }}
        title={`Top 10 Best Order Menu${incomeTopDate ? ` • ${formatDateLabel(incomeTopDate)}` : ''}`}
        maxWidth="3xl"
      >
        {incomeTopLoading ? (
          <div className="py-10 text-center text-sm text-brand-muted">Loading...</div>
        ) : incomeTopRows.length === 0 && incomeTopReconDay <= 0 ? (
          <div className="py-10 text-center text-sm text-brand-muted">No data</div>
        ) : (
          <div className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="px-3 py-2 text-xs font-bold text-slate-500 uppercase">#</th>
                    <th className="px-3 py-2 text-xs font-bold text-slate-500 uppercase">Menu</th>
                    <th className="px-3 py-2 text-xs font-bold text-slate-500 uppercase text-right">Qty</th>
                    <th className="px-3 py-2 text-xs font-bold text-slate-500 uppercase text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {incomeTopRows.map((row, idx) => (
                    <tr key={`${row.IDNo}-${idx}`} className="border-b border-slate-100 last:border-b-0">
                      <td className="px-3 py-2 text-sm font-semibold text-slate-700">{idx + 1}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">{row.MENU_NAME || 'Unknown'}</td>
                      <td className="px-3 py-2 text-sm text-slate-700 text-right tabular-nums">
                        {Number(row.total_quantity || 0).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-sm font-bold text-slate-900 text-right tabular-nums">
                        {money(Number(row.total_revenue || 0))}
                      </td>
                    </tr>
                  ))}
                  {incomeTopReconDay > 0 ? (
                    <tr className="border-b border-teal-100 bg-teal-50/50">
                      <td className="px-3 py-2 text-sm text-teal-800">—</td>
                      <td className="px-3 py-2 text-sm font-semibold text-teal-900">
                        {t('cash_reconciliation.card_cash_reconciliation')}
                      </td>
                      <td className="px-3 py-2 text-sm text-teal-700 text-right tabular-nums">—</td>
                      <td className="px-3 py-2 text-sm font-bold text-teal-900 text-right tabular-nums">
                        {money(incomeTopReconDay)}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <span className="text-sm font-bold text-slate-600">
                {`Total Income${incomeTopDate ? ` • ${formatDateLabel(incomeTopDate)}` : ''}`}
              </span>
              <span className="text-lg font-black text-slate-900 tabular-nums">
                {money(incomeTopModalTotal)}
              </span>
            </div>
          </div>
        )}
      </Modal>
    </AnimatePresence>
  );
};

