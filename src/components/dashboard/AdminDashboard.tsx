import React, { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { type Branch } from '../partials/Header';
import { Skeleton } from '../ui/Skeleton';
import { BranchPerformanceCard, type BranchPerformanceData } from './BranchPerformanceCard';
import { DollarSign, TrendingUp, TrendingDown, Calendar, ChevronDown, ChevronRight, ChevronLeft, ArrowLeft, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell } from 'recharts';
import DatePicker from 'react-datepicker';
import {
  fetchAdminDashboardBundleApi,
  fetchTopSellingApi,
  fetchExpenseCategoryBreakdownApi,
  fetchPerformanceTrendApi,
  type ApiPerformanceTrendRow,
  type ApiExpenseCategoryRow,
  type ApiTopSellingItem,
} from '../../services/analyticsService';
import { fetchCashReconciliationAggregates } from '../../services/cashReconciliationService';
import { getExpenses, type ExpenseRecord } from '../../services/expenseService';
import { CashReconciliationModal } from '../analytics/CashReconciliationModal';
import { Modal } from '../ui/Modal';
import { isExcludedFromAllBranchesView, sortBranchesBySidebarOrder, resolveBranchLogoUrl } from '../../utils/branchLogo';
import { navigateToBranch } from '../../utils/branchNavigation';
import {
  buildAdminDashboardCacheKey,
  hasAdminDashboardCacheData,
  isAdminDashboardCacheFresh,
  patchAdminDashboardCache,
  readAdminDashboardCacheIncludingStale,
  type AdminDashboardCachePayload,
  type AdminDashboardTrendPoint,
} from '../../utils/adminDashboardCache';
import { waitForAdminDashboardPrefetch } from '../../utils/prefetchAdminDashboard';
import {
  formatDateToLocalYmd,
  formatYmdDisplay,
  getManilaMonthToDateRange,
  getManilaTodayYmd,
  parseYmdToLocalDate,
} from '../../utils/manilaDateTime';

const REVENUE_DISTRIBUTION_COLORS = [
  '#3b82f6',
  '#f97316',
  '#22c55e',
  '#ef4444',
  '#8b5cf6',
  '#a16207',
  '#ec4899',
  '#6b7280',
  '#84cc16',
  '#0f766e',
  '#14b8a6',
  '#f59e0b',
  '#4f46e5',
  '#be123c',
  '#64748b',
];
const TOP_PRODUCTS_BAR_PALETTES = [
  ['#4338ca', '#4f46e5', '#6366f1', '#7c83ff', '#5b6df6'], // default
  ['#1d4ed8', '#2563eb', '#3b82f6', '#2f6df0', '#1e56db'],
  ['#047857', '#059669', '#10b981', '#0f9f74', '#0b8a64'],
  ['#b45309', '#d97706', '#f59e0b', '#e78a12', '#c46e0a'],
  ['#b91c1c', '#dc2626', '#ef4444', '#d63d3d', '#c62828'],
  ['#6d28d9', '#7c3aed', '#8b5cf6', '#7a4de8', '#6f33de'],
];
import { motion, AnimatePresence } from 'framer-motion';

type AdminDashboardProps = {
  selectedBranch: Branch | null;
  dateRange: {
    start: string;
    end: string;
  };
  onDateRangeChange: (range: DateRange) => void;
};

type SummaryData = {
  totalRevenue: number;
  totalSales: number;
  totalExpenses: number;
};

/** Keep header totals equal to the sum of branch cards (matches Telegram grand total). */
function computeAllBranchesSummary(
  branchCards: BranchPerformanceData[],
  expenseCategoryByBranch: Record<number, Record<string, number>>,
): SummaryData {
  const totalSales = branchCards.reduce((s, b) => s + (Number(b.totalSales) || 0), 0);
  const totalExpenses = branchCards.reduce((s, b) => {
    const branchMap = expenseCategoryByBranch[b.id];
    const fromBreakdown = branchMap
      ? Object.values(branchMap).reduce((sum, v) => sum + (Number(v) || 0), 0)
      : 0;
    return s + Math.max(fromBreakdown, Number(b.totalExpenses) || 0);
  }, 0);
  return {
    totalSales,
    totalExpenses,
    totalRevenue: totalSales - totalExpenses,
  };
}

/** Mirrors computeAllBranchesSummary's per-branch expense logic for a single focused branch. */
function computeBranchSummary(
  branch: BranchPerformanceData,
  expenseCategoryByBranch: Record<number, Record<string, number>>,
): SummaryData {
  const branchMap = expenseCategoryByBranch[branch.id];
  const fromBreakdown = branchMap
    ? Object.values(branchMap).reduce((sum, v) => sum + (Number(v) || 0), 0)
    : 0;
  const totalSales = Number(branch.totalSales) || 0;
  const totalExpenses = Math.max(fromBreakdown, Number(branch.totalExpenses) || 0);
  return {
    totalSales,
    totalExpenses,
    totalRevenue: totalSales - totalExpenses,
  };
}

const SUMMARY_CACHE_PREFIX = 'admin_dashboard_summary_v3';
const LEGACY_SUMMARY_CACHE_PREFIX = 'admin_dashboard_summary_v1';

const SummaryCard = ({ title, value, icon: Icon, color }: { title: string, value: string, icon: React.ElementType, color: string }) => (
  <div className="relative w-full group cursor-default">
    <div className="relative flex items-center py-2">
      
      {/* Floating Icon Box */}
      <div 
        className={`z-10 w-20 h-20 absolute left-0 shadow-lg shadow-slate-200/50 rounded-2xl flex items-center justify-center ${color} text-white border-4 border-white transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3`}
      >
        <Icon size={28} strokeWidth={2.5} />
      </div>

      {/* Content Card */}
      <div 
        className="bg-white w-full ml-10 rounded-2xl shadow-sm border border-slate-100 py-6 pr-6 pl-14 relative min-h-[100px] flex flex-col justify-center transition-all duration-300 group-hover:shadow-lg group-hover:-translate-y-1"
      >
        <p className="text-xs text-slate-400 font-bold tracking-wider uppercase mb-1">{title}</p>
        <p className="text-2xl font-extrabold text-slate-800 tracking-tight">{value}</p>
      </div>
    </div>
  </div>
);

type MonthlyData = {
  name: string;
  totalSales: number;
  totalExpenses: number;
  date?: string; // ISO yyyy-mm-dd when available (used for weekly tooltip correctness)
};

type TrendPeriod = 'weekly' | 'monthly' | 'yearly';

type DateRange = {
  start: string;
  end: string;
};

type CompareBreakdownKind = 'same_period' | 'vs_last_month' | 'vs_average';

type ComparisonRow = {
  id: string;
  label: string;
  values: number[];
  bestMode: 'max' | 'min';
  format?:
    | 'currency'
    | 'percent'
    | 'diff_index'
    | 'diff_index_stack'
    | 'diff_percent'
    | 'currency_share'
    | 'expense_diff'
    | 'expense_share'
    | 'expense_rate'
    | 'currency_pct'
    | 'rank';
  /** Parallel previous-period values when format is `diff_index` / `diff_index_stack` / `diff_percent` / `expense_diff`.
   *  For `currency_share`, holds the share denominator (e.g. same-period sales).
   *  For `currency_pct`, holds the secondary % shown beside the amount. */
  compareBases?: number[];
  /** When true, increase = bad (red) / decrease = good (green). Used for expense rows. */
  invertSentiment?: boolean;
  /** For `diff_index` / `diff_index_stack`: show current (expenses) or previous baseline amount. Default previous. */
  amountSource?: 'current' | 'previous';
  /** Enables cell click popup with date ranges + values used in the formula. */
  breakdownKind?: CompareBreakdownKind;
  /** When true, never show the TOP badge for this row. */
  hideTop?: boolean;
  /** For `currency_pct`: which % breakdown popup to open on click. */
  pctBreakdown?: 'expense_share' | 'expense_rate';
};

type CompareBreakdownPopup = {
  key: string;
  top: number;
  left: number;
  branchName: string;
  metricLabel: string;
  rows: Array<{
    label: string;
    sub?: string;
    value: string;
    /** green = higher of current/previous, or positive result; red = lower / negative */
    tone?: 'up' | 'down' | 'neutral';
  }>;
  /** Multi-line formula / explanation. Plain prose lines read better than mono. */
  formulaSummary: string;
  /** When true, formula box is a plain-language note (not math). */
  formulaIsNote?: boolean;
};

type ComparisonSectionRow = {
  id: string;
  rowType: 'section';
  label: string;
};

type UnifiedComparisonRow = ComparisonRow | ComparisonSectionRow;

const isSectionRow = (row: UnifiedComparisonRow): row is ComparisonSectionRow =>
  (row as ComparisonSectionRow).rowType === 'section';

const localeForLanguage = (lng: string) => {
  const base = String(lng || 'en').split('-')[0];
  if (base === 'ja') return 'ja-JP';
  if (base === 'ko') return 'ko-KR';
  if (base === 'zh') return 'zh-CN';
  return 'en-US';
};

const formatDate = (dateStr: string, lng?: string) =>
  formatYmdDisplay(dateStr, lng ? localeForLanguage(lng) : undefined);

const toDate = (s: string): Date | null => (s ? parseYmdToLocalDate(s) : null);

const toYYYYMMDD = (d: Date): string => formatDateToLocalYmd(d);

const getFullMonthRange = (monthDate: Date): [Date, Date] => {
  const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
  const manilaToday = parseYmdToLocalDate(getManilaTodayYmd()) ?? new Date();
  const end = monthEnd.getTime() > manilaToday.getTime() ? manilaToday : monthEnd;
  return [start, end];
};

const DATE_PICKER_MONTHS_SHOWN = 3;

const parseLocalYmd = (s: string): Date | null => {
  const match = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
};

const addDaysLocal = (d: Date, days: number): Date => {
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  next.setDate(next.getDate() + days);
  return next;
};

/** Shift a local date by N months, clamping day to the target month's last day. */
const shiftMonthClamped = (d: Date, deltaMonths: number): Date => {
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + deltaMonths, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
};

/** Fixed lookback used by 전월동기 (3일 전 기준). */
const SAME_PERIOD_LOOKBACK_DAYS = 3;

/**
 * Current vs last month same period, ending `lookbackDays` before selected end.
 * Example: Jul 1–22 with lookback 3 → current Jul 1–19, previous Jun 1–19.
 */
const getSamePeriodWindows = (
  start: string,
  end: string,
  lookbackDays = SAME_PERIOD_LOOKBACK_DAYS,
): { current: DateRange; previous: DateRange } | null => {
  const s = parseLocalYmd(start);
  const e = parseLocalYmd(end);
  if (!s || !e || s > e) return null;

  let currentEnd = addDaysLocal(e, -lookbackDays);
  if (currentEnd < s) currentEnd = new Date(s.getFullYear(), s.getMonth(), s.getDate());

  const previousStart = shiftMonthClamped(s, -1);
  const previousEnd = shiftMonthClamped(currentEnd, -1);

  return {
    current: { start: toYYYYMMDD(s), end: toYYYYMMDD(currentEnd) },
    previous: { start: toYYYYMMDD(previousStart), end: toYYYYMMDD(previousEnd) },
  };
};

/**
 * 전월 대비: current = month-to-date (1st → selected end), previous = full prior calendar month.
 * Example: end Jul 24 → current Jul 1–24, previous Jun 1–30.
 */
const getMtdVsFullPreviousMonth = (
  end: string,
): { current: DateRange; previous: DateRange } | null => {
  const e = parseLocalYmd(end);
  if (!e) return null;
  const currentStart = new Date(e.getFullYear(), e.getMonth(), 1);
  const previousStart = new Date(e.getFullYear(), e.getMonth() - 1, 1);
  const previousEnd = new Date(e.getFullYear(), e.getMonth(), 0);
  return {
    current: { start: toYYYYMMDD(currentStart), end: toYYYYMMDD(e) },
    previous: { start: toYYYYMMDD(previousStart), end: toYYYYMMDD(previousEnd) },
  };
};

/** True when index % is unreliable (÷0 / missing baseline). */
const isUnreliableCompareBase = (previous: number): boolean => Math.abs(Number(previous) || 0) < 1;

/**
 * Below this previous-period expense, % growth is statistically misleading.
 * Show "New Expense" / "Significant Increase" / N/A instead.
 */
const EXPENSE_PCT_MIN_PREVIOUS = 50_000;
/** Share of company total that flags elevated share bar coloring. */
const EXPENSE_SHARE_REVIEW_PCT = 30;
/** Expense ÷ sales ratio that flags elevated rate bar coloring. */
const EXPENSE_RATE_REVIEW_PCT = 90;
const EXPENSE_RATE_ELEVATED_PCT = 70;

type ExpenseDiffKind = 'delta' | 'new' | 'significant' | 'na';

type ExpenseAnalyticsRow = {
  branchId: number;
  branchName: string;
  current: number;
  previous: number;
  diff: number;
  sharePct: number;
  rank: number;
  /** Meaningful MoM % when previous ≥ threshold; otherwise null. */
  pctChange: number | null;
  diffKind: ExpenseDiffKind;
};

const resolveExpenseDiffKind = (current: number, previous: number): ExpenseDiffKind => {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev < 1 && cur < 1) return 'na';
  if (prev < EXPENSE_PCT_MIN_PREVIOUS) {
    if (prev < 1 && cur > 0) return 'new';
    if (cur - prev > 0) return 'significant';
  }
  return 'delta';
};

/**
 * Trailing 3 full calendar months before `end`'s month (평균대비).
 * Example: end=Jul 22 → Apr 1–Jun 30. Average = sum / 3.
 */
const getPreviousThreeMonthsRange = (end: string): DateRange | null => {
  const e = parseLocalYmd(end);
  if (!e) return null;
  const start = new Date(e.getFullYear(), e.getMonth() - 3, 1);
  const endDate = new Date(e.getFullYear(), e.getMonth(), 0); // last day of previous month
  return { start: toYYYYMMDD(start), end: toYYYYMMDD(endDate) };
};

const TRAILING_AVG_MONTHS = 3;

const pctChange = (current: number, previous: number): number => {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  const diff = cur - prev;
  // Use |previous| so % sign matches improvement (important when prior profit is a loss).
  if (prev === 0) {
    if (cur === 0) return 0;
    return diff > 0 ? 100 : -100;
  }
  return (diff / Math.abs(prev)) * 100;
};

/** Korean 전월대비 index: 100 = flat, 102.7 = +2.7%, 97.4 = -2.6%. */
const monthIndexFromPct = (percentChange: number): number => 100 + (Number(percentChange) || 0);

const formatRangeLabel = (range: DateRange): string => {
  const s = parseLocalYmd(range.start);
  const e = parseLocalYmd(range.end);
  if (!s || !e) return `${range.start} – ${range.end}`;
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${fmt(s)} – ${fmt(e)}`;
};

type CompareMetricMaps = {
  sales: Record<number, number>;
  expenses: Record<number, number>;
  profit: Record<number, number>;
};

const EMPTY_COMPARE_METRICS: CompareMetricMaps = { sales: {}, expenses: {}, profit: {} };

const branchCardsToMetricMaps = (
  cards: Array<{ id: number; totalSales: number; totalExpenses?: number }>,
  expenseCategoryByBranch?: Record<number, Record<string, number>>,
): CompareMetricMaps => {
  const sales: Record<number, number> = {};
  const expenses: Record<number, number> = {};
  const profit: Record<number, number> = {};
  for (const card of cards) {
    const s = Number(card.totalSales) || 0;
    const branchMap = expenseCategoryByBranch?.[card.id];
    const fromBreakdown = branchMap
      ? Object.values(branchMap).reduce((sum, v) => sum + (Number(v) || 0), 0)
      : 0;
    const fromCard = Number(card.totalExpenses) || 0;
    // Prefer fuller total — category map alone can undercount (profit ≈ sales).
    const e = Math.max(fromBreakdown, fromCard);
    sales[card.id] = s;
    expenses[card.id] = e;
    profit[card.id] = s - e;
  }
  return { sales, expenses, profit };
};

const averageMetricMaps = (maps: CompareMetricMaps, divisor: number): CompareMetricMaps => {
  const avgOne = (src: Record<number, number>): Record<number, number> => {
    const out: Record<number, number> = {};
    for (const [id, total] of Object.entries(src)) {
      out[Number(id)] = (Number(total) || 0) / divisor;
    }
    return out;
  };
  return {
    sales: avgOne(maps.sales),
    expenses: avgOne(maps.expenses),
    profit: avgOne(maps.profit),
  };
};

/** DB terms: 월세, 상가 임대료 / Rent. */
const RENT_NAME_HINTS = ['rent', 'rental', 'lease', '월세', '임대'];
/**
 * "Labor, Benefits" / "급여 및 복지" subcategory hints.
 * Always → 급여 (even when filed under Operation).
 */
const LABOR_BENEFITS_NAME_HINTS = ['labor', 'benefits', '복지'];
/** Pure salary / payroll + C.A. + Essome DJ/PROMOTER. */
const SALARY_NAME_HINTS = [
  'salary',
  'salaries',
  'payroll',
  'wage',
  'wages',
  '급여',
  '인건',
  // Cash advance (가불 / C.A.) may be filed under the Salary main category.
  '가불',
  'c.a',
  'cash advance',
  'cashadvance',
  // Essome: DJ + PROMOTER under Labor/Tax/Others count as salary.
  'dj',
  'promoter',
];

const matchesExpenseNameHints = (namePart: string, hints: string[]): boolean => {
  const name = String(namePart || '').trim().toLowerCase();
  if (!name) return false;
  return hints.some((h) => name === h || name.includes(h));
};

const splitExpenseMapKey = (key: string): { mainPart: string; namePart: string; full: string } => {
  const full = String(key || '').trim().toLowerCase();
  const pipe = full.indexOf('|');
  return {
    full,
    mainPart: (pipe >= 0 ? full.slice(0, pipe) : full).trim(),
    namePart: (pipe >= 0 ? full.slice(pipe + 1) : full).trim(),
  };
};

/** True for "급여 및 복지 / Labor, Benefits" style subs (any main category). */
const isLaborBenefitsSub = (namePart: string): boolean => {
  const name = String(namePart || '').trim().toLowerCase();
  if (!name) return false;
  if (matchesExpenseNameHints(name, LABOR_BENEFITS_NAME_HINTS)) return true;
  // "급여 및 복지" without English — 복지 marks benefits compound.
  return name.includes('급여') && name.includes('복지');
};

/**
 * Pure salary main only (e.g. "급여 / Salary" → includes C.A.).
 * Essome "급여, 세금, 기타 / Labor, Tax, Others" mixes rent+salary+others — use subs only.
 */
const isPureSalaryMain = (mainPart: string): boolean => {
  const main = String(mainPart || '').trim().toLowerCase();
  if (!main) return false;
  if (
    main.includes(',') ||
    main.includes('세금') ||
    main.includes('tax') ||
    main.includes('기타') ||
    main.includes('others') ||
    /\bother\b/.test(main)
  ) {
    return false;
  }
  return matchesExpenseNameHints(main, SALARY_NAME_HINTS);
};

type MainExpenseBucket = 'food' | 'rent' | 'salary' | 'other';

/** Exclusive bucket so food never double-counts rent/labor/salary. */
const classifyMainExpenseKey = (key: string): MainExpenseBucket => {
  const { mainPart, namePart, full } = splitExpenseMapKey(key);

  // Labor/Benefits subcategory → 급여 (regardless of main category parent).
  if (isLaborBenefitsSub(namePart)) return 'salary';
  // Essome: "상가 임대료 / Rent" under Labor/Tax/Others compound main.
  if (matchesExpenseNameHints(namePart, RENT_NAME_HINTS)) return 'rent';

  // Sub: SALARY, DJ, PROMOTER, 가불 / C.A., etc. Pure salary main includes all its subs.
  if (matchesExpenseNameHints(namePart, SALARY_NAME_HINTS)) return 'salary';
  if (isPureSalaryMain(mainPart)) return 'salary';

  const isFoodMain =
    mainPart.includes('식자재') ||
    mainPart.includes('food') ||
    mainPart.includes('inventory') ||
    // Market / mart purchases are food COGS (e.g. "3. 마트 / Mart").
    mainPart.includes('마트') ||
    /\bmart\b/.test(mainPart);
  if (full.startsWith('inventory|') || isFoodMain) return 'food';

  return 'other';
};

const sumMainExpenseBuckets = (
  branchMap?: Record<string, number>,
): Record<MainExpenseBucket, number> => {
  const out: Record<MainExpenseBucket, number> = {
    food: 0,
    rent: 0,
    salary: 0,
    other: 0,
  };
  if (!branchMap) return out;
  for (const [key, amount] of Object.entries(branchMap)) {
    const bucket = classifyMainExpenseKey(key);
    out[bucket] += Number(amount) || 0;
  }
  return out;
};

/** Branch Comparison metric labels — always Korean, regardless of UI language. */
const COMPARE_METRIC_LABELS = {
  totalSales: '매출액',
  totalExpenses: '비용',
  totalProfit: '순이익',
  vsSamePeriod: '전월 동기 대비(3일전 기준)',
  vsLastMonth: '전월 대비',
  vsAverage: '평균 대비',
  foodSupplies: '식자재 및 주류',
  rent: '임대료',
  salary: '급여',
  others: '그밖에',
} as const;

/** Diverging bar chart: sales (positive) vs expenses (negative). */
const clampFiniteNonNegative = (n: unknown): number => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v;
};

const hasNonZeroTrendRows = (rows: MonthlyData[]): boolean =>
  rows.some(
    (d) => clampFiniteNonNegative(d.totalSales) > 0 || clampFiniteNonNegative(d.totalExpenses) > 0,
  );

/** Skip branch trend fetch only when the header range has no activity (weekly/monthly). */
const shouldSkipBranchTrendFetch = (
  period: TrendPeriod,
  branch: BranchPerformanceData | undefined,
  branchExpenses: number,
): boolean => {
  if (period === 'yearly') return false;
  if (!branch) return true;
  return (Number(branch.totalSales) || 0) === 0 && branchExpenses === 0;
};

/** Explicit chart dimensions — avoids Recharts 3 ResponsiveContainer sizing glitches. */
function TrendChartContainer({
  className = '',
  minHeight = 384,
  render,
}: {
  className?: string;
  minHeight?: number;
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
    <div ref={ref} className={className} style={{ minHeight }}>
      {size.width > 0 && size.height > 0 ? render(size) : null}
    </div>
  );
}

const niceStep = (max: number, targetSteps: number): number => {
  const m = Number(max);
  if (!(m > 0) || !Number.isFinite(m)) return 1;
  const rough = m / Math.max(1, targetSteps);
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const r = rough / pow10;
  const mult = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
  return mult * pow10;
};

const buildNiceMax = (maxAbs: number) => {
  // Keep a minimum scale so the axis doesn't collapse at tiny ranges.
  const minMax = 10_000;
  const effectiveMax = Math.max(Number.isFinite(maxAbs) ? maxAbs : 0, minMax);
  const step = niceStep(effectiveMax, 4);
  return Math.ceil(effectiveMax / step) * step;
};

/** Equal top/bottom panes — domain [-1, 1]. When expenses are significant,
 *  peak expense maps to middle tick (-⅔); axis max = peak × 1.5. */
type TrendYScale = {
  salesMax: number;
  expenseMax: number;
  /** Actual max expense — anchored at chart -⅔ (middle expense tick). */
  peakExpense: number;
  domain: [number, number];
};

const EXPENSE_PEAK_CHART = -2 / 3;

const buildTrendYScale = (salesValues: number[], expenseValues: number[]): TrendYScale => {
  const maxSales = Math.max(0, ...salesValues);
  const maxExpense = Math.max(0, ...expenseValues);
  const salesMax = buildNiceMax(maxSales);
  const expenseFloor = salesMax * 3;

  if (!(maxExpense > 0)) {
    return { salesMax, expenseMax: expenseFloor, peakExpense: 0, domain: [-1, 1] };
  }

  const useMiddlePeak = maxExpense > expenseFloor * (2 / 3);
  if (useMiddlePeak) {
    const peakExpense = maxExpense;
    const expenseMax = Math.max(expenseFloor, buildNiceMax(peakExpense * 1.5));
    return { salesMax, expenseMax, peakExpense, domain: [-1, 1] };
  }

  return { salesMax, expenseMax: expenseFloor, peakExpense: 0, domain: [-1, 1] };
};

const toTrendChartSales = (value: number, salesMax: number): number | null => {
  if (!(value > 0) || !(salesMax > 0)) return null;
  return Math.min(value / salesMax, 1);
};

const toTrendChartExpense = (value: number, scale: TrendYScale): number | null => {
  if (!(value > 0) || !(scale.expenseMax > 0)) return null;
  if (scale.peakExpense > 0) {
    const chartMag = Math.min((value / scale.peakExpense) * Math.abs(EXPENSE_PEAK_CHART), 1);
    return -chartMag;
  }
  return -Math.min(value / scale.expenseMax, 1);
};

/** Sales: 2 ticks (½ & max). Expenses: 3 ticks (⅓, ⅔ & max of expense pane). */
const buildTrendYTicks = (): number[] => [1, 0.5, 0, -1 / 3, -2 / 3, -1];

const formatTrendYAxisTick = (chartValue: number, scale: TrendYScale): string => {
  const v = Number(chartValue);
  if (!Number.isFinite(v) || v === 0) return '₱0k';

  let raw: number;
  if (v > 0) {
    raw = v * scale.salesMax;
  } else if (scale.peakExpense > 0 && Math.abs(v - EXPENSE_PEAK_CHART) < 0.001) {
    raw = scale.peakExpense;
  } else {
    raw = Math.abs(v) * scale.expenseMax;
  }

  if (raw >= 1_000_000) {
    const m = raw / 1_000_000;
    return Number.isInteger(m) ? `₱${m}M` : `₱${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (raw >= 1_000) return `₱${Math.round(raw / 1_000)}k`;
  return `₱${raw}`;
};

const WEEKDAY_ABBR_TO_JS_DAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const normalizeTickLabel = (value: unknown): string => String(value ?? '').trim();

const parseDateFromTickLabel = (label: string, fallbackYear: number): Date | null => {
  // Common case: ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    const d = new Date(`${label}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Day-of-month only (e.g. "1", "01", "31") will be handled by caller
  // because we need a reference month (from selected date range).

  // If label already includes a year (e.g. "Mar 1, 2026"), rely on Date.parse
  const direct = new Date(label);
  if (!Number.isNaN(direct.getTime())) return direct;

  // If label looks like "Mar 1" (no year), attach a fallback year.
  const withYear = new Date(`${label} ${fallbackYear}`);
  if (!Number.isNaN(withYear.getTime())) return withYear;

  return null;
};

const weekendStyleForDay = (jsDay: number): { fill: string; marker: string } | null => {
  if (jsDay === 6) return { fill: '#ef4444', marker: '●' }; // Sat (red)
  if (jsDay === 0) return { fill: '#22c55e', marker: '●' }; // Sun (green)
  return null;
};

const weekdayAbbrFromJsDay = (jsDay: number): string => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][jsDay] ?? '';

const MONTH_LABEL_TO_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

type TrendDrillMetric = 'sales' | 'expenses';
type TrendDrillExpenseGroup = {
  main: string;
  total: number;
  subs: Array<{ name: string; amount: number; count: number }>;
};

/** Resolve the calendar range represented by a clicked trend bar. */
const resolveTrendBarDateRange = (
  point: { name?: string; date?: string },
  period: TrendPeriod,
  anchor: Date,
  fallbackYear: number,
): { range: DateRange; label: string } | null => {
  if (period === 'weekly') {
    const iso = String(point.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    return { range: { start: iso, end: iso }, label: formatYmdDisplay(iso) };
  }

  if (period === 'monthly') {
    const label = normalizeTickLabel(point.name);
    let d: Date | null = null;
    if (/^\d{1,2}$/.test(label)) {
      const day = Number(label);
      if (day >= 1 && day <= 31) {
        d = new Date(anchor.getFullYear(), anchor.getMonth(), day, 12, 0, 0);
      }
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
      d = new Date(`${label}T12:00:00`);
    } else {
      d = parseDateFromTickLabel(label, fallbackYear);
    }
    if (!d || Number.isNaN(d.getTime())) return null;
    const ymd = toYYYYMMDD(d);
    return { range: { start: ymd, end: ymd }, label: formatYmdDisplay(ymd) };
  }

  // yearly → whole month
  const label = normalizeTickLabel(point.name);
  let year = fallbackYear;
  let monthIdx: number | null = null;
  const ym = label.match(/^(\d{4})-(\d{2})$/);
  if (ym) {
    year = Number(ym[1]);
    monthIdx = Number(ym[2]) - 1;
  } else {
    const key = label.toLowerCase().replace(/\./g, '').trim();
    monthIdx = MONTH_LABEL_TO_INDEX[key] ?? MONTH_LABEL_TO_INDEX[key.slice(0, 3)] ?? null;
  }
  if (monthIdx == null || monthIdx < 0 || monthIdx > 11) return null;
  const start = new Date(year, monthIdx, 1);
  const end = new Date(year, monthIdx + 1, 0);
  return {
    range: { start: toYYYYMMDD(start), end: toYYYYMMDD(end) },
    label: start.toLocaleString(undefined, { month: 'short', year: 'numeric' }),
  };
};

const groupExpenseBreakdownForBranch = (
  rows: ApiExpenseCategoryRow[],
  branchId: number,
): TrendDrillExpenseGroup[] => {
  const byMain = new Map<string, TrendDrillExpenseGroup>();
  for (const r of rows) {
    if (String(r.branch_id) !== String(branchId)) continue;
    const amount = Number(r.total_amount) || 0;
    if (amount <= 0) continue;
    const main = String(r.exp_cat || 'Uncategorized').trim() || 'Uncategorized';
    const sub = String(r.exp_name || 'Unknown').trim() || 'Unknown';
    let group = byMain.get(main);
    if (!group) {
      group = { main, total: 0, subs: [] };
      byMain.set(main, group);
    }
    group.total += amount;
    group.subs.push({
      name: sub,
      amount,
      count: Number(r.entry_count) || 0,
    });
  }
  return Array.from(byMain.values())
    .map((g) => ({
      ...g,
      subs: g.subs.slice().sort((a, b) => b.amount - a.amount),
    }))
    .sort((a, b) => b.total - a.total);
};

const formatTopProductName = (value: string): string => {
  const normalized = String(value ?? '')
    .replace(/[\u3131-\uD79D]+/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= 22) return normalized;
  return `${normalized.slice(0, 22).trimEnd()}...`;
};

const getTopProductsPalette = (branchId: number | null): string[] => {
  if (!branchId || !Number.isFinite(branchId)) return TOP_PRODUCTS_BAR_PALETTES[0];
  const paletteIndex = (Math.abs(branchId) % (TOP_PRODUCTS_BAR_PALETTES.length - 1)) + 1;
  return TOP_PRODUCTS_BAR_PALETTES[paletteIndex];
};

const getCurrentMonthRange = (): DateRange => getManilaMonthToDateRange();

const WEEKDAY_LABELS_MON_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

type BranchTopProduct = { name: string; sales: number };

type BranchDashboardPrefetchEntry = {
  trendByPeriod: Partial<Record<TrendPeriod, AdminDashboardTrendPoint[]>>;
  topProducts: BranchTopProduct[];
};

const buildBranchPrefetchKey = (branchId: number, start: string, end: string) =>
  `${branchId}:${start}:${end}`;

const mapTopSellingRows = (rows: unknown): BranchTopProduct[] =>
  Array.isArray(rows)
    ? rows.map((item: { MENU_NAME: string; total_quantity: number }) => ({
        name: item.MENU_NAME,
        sales: item.total_quantity,
      }))
    : [];

async function fetchBranchDashboardSnapshot({
  branchId,
  start,
  end,
  period,
}: {
  branchId: number;
  start: string;
  end: string;
  period: TrendPeriod;
}): Promise<{ trend: AdminDashboardTrendPoint[]; topProducts: BranchTopProduct[] }> {
  const [trend, topSelling] = await Promise.all([
    fetchBranchPerformanceTrend(branchId, start, end, period),
    fetchTopSellingApi(
      new URLSearchParams({
        start_date: start,
        end_date: end,
        branch_id: String(branchId),
        limit: '5',
      }),
    ),
  ]);

  return {
    trend,
    topProducts: mapTopSellingRows(topSelling),
  };
}

/** Add cash-recon adjustments onto performance-trend rows (all-branches path). */
const applyReconToPerformanceTrend = (
  rows: AdminDashboardTrendPoint[],
  period: TrendPeriod,
  byDate: Record<string, number>,
  start: string,
  end: string,
): AdminDashboardTrendPoint[] => {
  if (period === 'weekly') {
    return rows.map((row) => {
      if (!row.date) return row;
      const extra = Number(byDate[row.date] ?? 0);
      return extra
        ? { ...row, totalSales: Number(row.totalSales || 0) + extra }
        : row;
    });
  }

  if (period === 'monthly') {
    const reconByDom = new Map<number, number>();
    for (const [date, amt] of Object.entries(byDate)) {
      if (date < start || date > end) continue;
      const dom = new Date(`${date}T12:00:00`).getDate();
      reconByDom.set(dom, (reconByDom.get(dom) ?? 0) + (Number(amt) || 0));
    }
    return rows.map((row) => {
      const dom = Number(row.name);
      const extra = Number.isFinite(dom) ? (reconByDom.get(dom) ?? 0) : 0;
      return extra
        ? { ...row, totalSales: Number(row.totalSales || 0) + extra }
        : row;
    });
  }

  if (period === 'yearly') {
    const reconByMonth = Array(12).fill(0);
    for (const [date, amt] of Object.entries(byDate)) {
      if (date < start || date > end) continue;
      const monthIdx = new Date(`${date}T12:00:00`).getMonth();
      reconByMonth[monthIdx] += Number(amt) || 0;
    }
    return rows.map((row, idx) => {
      const extra = reconByMonth[idx] ?? 0;
      return extra
        ? { ...row, totalSales: Number(row.totalSales || 0) + extra }
        : row;
    });
  }

  return rows;
};

/** Recon fetch window — mirrors pyserver performance-trend date expansion. */
const getPerformanceTrendReconRange = (
  period: TrendPeriod,
  start: string,
  end: string,
): { start: string; end: string } => {
  if (period === 'yearly') {
    const ref = end || start;
    const y = new Date(`${ref}T12:00:00`).getFullYear();
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  if (period === 'weekly') {
    const windowEnd = new Date(`${end}T12:00:00`);
    const rangeStart = new Date(`${start}T12:00:00`);
    const windowStart = new Date(windowEnd);
    windowStart.setDate(windowStart.getDate() - 6);
    if (windowStart < rangeStart) windowStart.setTime(rangeStart.getTime());
    return { start: toYYYYMMDD(windowStart), end: toYYYYMMDD(windowEnd) };
  }
  return { start, end };
};

/** Yearly trend uses the full calendar year — not the header date filter. */
const getTrendApiDateRange = (
  period: TrendPeriod,
  start: string,
  end: string,
): { start: string; end: string } => getPerformanceTrendReconRange(period, start, end);

const applyWeeklyTodayLabel = (chartData: AdminDashboardTrendPoint[]): AdminDashboardTrendPoint[] => {
  if (chartData.length === 0 || !chartData.every((d) => d.date)) return chartData;
  const lastKey = chartData[chartData.length - 1].date!;
  const anchor = new Date(`${lastKey}T12:00:00`);
  const now = new Date();
  const isAnchorToday =
    anchor.getFullYear() === now.getFullYear() &&
    anchor.getMonth() === now.getMonth() &&
    anchor.getDate() === now.getDate();
  if (!isAnchorToday) return chartData;
  const copy = [...chartData];
  copy[copy.length - 1] = { ...copy[copy.length - 1], name: 'Today' };
  return copy;
};

/** Branch trend via performance-trend API (full-year yearly, same as all-branches). */
async function fetchBranchPerformanceTrend(
  branchId: number,
  start: string,
  end: string,
  period: TrendPeriod,
): Promise<AdminDashboardTrendPoint[]> {
  const apiRange = getTrendApiDateRange(period, start, end);
  const params = new URLSearchParams({
    period,
    start_date: apiRange.start,
    end_date: apiRange.end,
    branch_id: String(branchId),
  });

  const reconRange = getPerformanceTrendReconRange(period, start, end);
  const [rows, recon] = await Promise.all([
    fetchPerformanceTrendApi(params),
    fetchCashReconciliationAggregates({
      start: reconRange.start,
      end: reconRange.end,
      branchId: String(branchId),
    }).catch(() => ({ byDate: {} as Record<string, number>, total: 0 })),
  ]);

  let chartData: AdminDashboardTrendPoint[] = rows.map((r) => ({
    name: r.name,
    totalSales: Number(r.totalSales || 0),
    totalExpenses: Number(r.totalExpenses || 0),
    ...(r.sale_date ? { date: String(r.sale_date).slice(0, 10) } : {}),
  }));

  chartData = applyReconToPerformanceTrend(
    chartData,
    period,
    recon.byDate ?? {},
    reconRange.start,
    reconRange.end,
  );

  if (period === 'weekly') {
    chartData = applyWeeklyTodayLabel(chartData);
  }

  return chartData;
}

const INITIAL_ADMIN_CACHE = (() => {
  const range = getCurrentMonthRange();
  const key = buildAdminDashboardCacheKey({ start: range.start, end: range.end, branchId: null });
  const cached = readAdminDashboardCacheIncludingStale(key);
  return { key, cached: hasAdminDashboardCacheData(cached) ? cached : null };
})();

const buildSummaryCacheKey = (branchScope: string, start: string, end: string): string =>
  `${SUMMARY_CACHE_PREFIX}:${branchScope}:${start}:${end}`;

const readSummaryCache = (key: string): SummaryData | null => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SummaryData> | null;
    if (!parsed) return null;
    const totalSales = Number(parsed.totalSales);
    const totalExpenses = Number(parsed.totalExpenses);
    const totalRevenue = Number(parsed.totalRevenue);
    if (![totalSales, totalExpenses, totalRevenue].every(Number.isFinite)) return null;
    return { totalSales, totalExpenses, totalRevenue };
  } catch {
    return null;
  }
};

const formatModalMoney = (n: number) =>
  `₱${Math.trunc(Number.isFinite(n) ? n : 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;

/** Branch-list rank badges — same color as chart bars (sales purple / expenses orange). */
const trendDrillBranchRankClass = (metric: TrendDrillMetric): string =>
  metric === 'sales'
    ? 'bg-[rgb(139,92,246)] text-white'
    : 'bg-[rgb(245,158,11)] text-white';

/**
 * Local expand state — keeps accordion toggles from re-rendering the whole AdminDashboard
 * (Recharts + branch cards) on every category click.
 */
const TrendDrillExpenseAccordion = memo(function TrendDrillExpenseAccordion({
  groups,
  onSubClick,
}: {
  groups: TrendDrillExpenseGroup[];
  onSubClick: (sub: { main: string; name: string; amount: number }) => void;
}) {
  const [expandedMains, setExpandedMains] = useState<Set<string>>(() => new Set());

  return (
    <div className="space-y-2">
      {groups.map((group) => {
        const expanded = expandedMains.has(group.main);
        return (
          <div key={group.main} className="rounded-xl border border-slate-100 overflow-hidden">
            <button
              type="button"
              onClick={() => {
                setExpandedMains((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.main)) next.delete(group.main);
                  else next.add(group.main);
                  return next;
                });
              }}
              className="w-full flex items-center justify-between gap-3 px-3 py-2.5 bg-[rgb(245,158,11)] hover:opacity-90 cursor-pointer"
            >
              <div className="flex items-center gap-2 min-w-0">
                <ChevronRight
                  size={16}
                  className={`text-black shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
                />
                <span className="text-sm font-bold text-black truncate">{group.main}</span>
                <span className="text-[11px] text-black/70 shrink-0">{group.subs.length}</span>
              </div>
              <span className="text-sm font-bold tabular-nums text-black shrink-0">
                {formatModalMoney(group.total)}
              </span>
            </button>
            {expanded ? (
              <ul className="divide-y divide-slate-50 bg-white">
                {group.subs.map((sub) => (
                  <li key={`${group.main}-${sub.name}`}>
                    <button
                      type="button"
                      onClick={() =>
                        onSubClick({
                          main: group.main,
                          name: sub.name,
                          amount: sub.amount,
                        })
                      }
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 pl-9 hover:bg-amber-50/40 cursor-pointer text-left"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate">{sub.name}</p>
                        {sub.count > 0 ? (
                          <p className="text-[11px] text-slate-400">
                            {sub.count} entr{sub.count === 1 ? 'y' : 'ies'}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-sm font-bold tabular-nums text-slate-900">
                          {formatModalMoney(sub.amount)}
                        </span>
                        <ChevronRight size={16} className="text-slate-300" />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

const buildExpenseMaps = (rows: ApiExpenseCategoryRow[]) => {
  const expenseMap: Record<number, Record<string, number>> = {};
  const expenseByBranch: Record<number, number> = {};
  const makeKey = (cat: string, name: string) =>
    `${cat.trim().toLowerCase()}|${name.trim().toLowerCase()}`;

  for (const row of rows || []) {
    const bid = Number(row.branch_id);
    if (!Number.isFinite(bid)) continue;
    if (!expenseMap[bid]) expenseMap[bid] = {};
    const key = makeKey(row.exp_cat, row.exp_name);
    const amt = Number(row.total_amount || 0);
    expenseMap[bid][key] = (expenseMap[bid][key] || 0) + amt;
    expenseByBranch[bid] = (expenseByBranch[bid] || 0) + amt;
  }

  return { expenseMap, expenseByBranch };
};

const preferNonEmptyArray = <T,>(next: T[], prev: T[]): T[] =>
  next.length > 0 ? next : prev;

const preferNonEmptyRecord = <T,>(
  next: Record<number, T>,
  prev: Record<number, T>,
): Record<number, T> => (Object.keys(next).length > 0 ? next : prev);

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ selectedBranch, dateRange, onDateRangeChange }) => {
  const { t, i18n } = useTranslation();
  const analyticsReqIdRef = useRef(0);
  const trendReqIdRef = useRef(0);
  const isFirstTrendEffectRef = useRef(true);
  const prevTrendPeriodEffectBranchRef = useRef<number | null>(null);
  const prevTrendPeriodRef = useRef<TrendPeriod>('monthly');
  const prevFocusedBranchIdRef = useRef<number | null>(null);
  const activeBranchIdRef = useRef<number | null>(null);
  const topProductsReqIdRef = useRef(0);
  const branchPrefetchCacheRef = useRef<Map<string, BranchDashboardPrefetchEntry>>(new Map());
  const branchPrefetchInFlightRef = useRef<Set<string>>(new Set());
  const refreshBranchDashboardChartsRef = useRef<
    ((branchId: number, period: TrendPeriod) => Promise<void>) | null
  >(null);
  const allBranchesTopProductsRef = useRef<{ name: string; sales: number }[]>([]);
  const initialMonthRange = getCurrentMonthRange();
  const [branchCardsData, setBranchCardsData] = useState<BranchPerformanceData[]>(
    () => INITIAL_ADMIN_CACHE.cached?.branchCardsData ?? [],
  );
  const [summaryData, setSummaryData] = useState<SummaryData | null>(() => {
    if (INITIAL_ADMIN_CACHE.cached?.summary) return INITIAL_ADMIN_CACHE.cached.summary;
    return readSummaryCache(buildSummaryCacheKey('all', initialMonthRange.start, initialMonthRange.end));
  });
  const [monthlyData, setMonthlyData] = useState<MonthlyData[]>(() => {
    const trend = INITIAL_ADMIN_CACHE.cached?.trendByPeriod?.monthly;
    return trend?.length && hasNonZeroTrendRows(trend) ? trend : [];
  });
  const [trendPeriod, setTrendPeriod] = useState<TrendPeriod>('monthly');
  const trendPeriodRef = useRef<TrendPeriod>('monthly');

  useEffect(() => {
    trendPeriodRef.current = trendPeriod;
  }, [trendPeriod]);

  const [trendLoading, setTrendLoading] = useState(false);
  const [branchChartsLoading, setBranchChartsLoading] = useState(false);
  const [activeBranchId, setActiveBranchId] = useState<number | null>(null);

  useEffect(() => {
    activeBranchIdRef.current = activeBranchId;
  }, [activeBranchId]);
  const [compareBranchIds, setCompareBranchIds] = useState<number[]>([]);
  const [isComparePanelOpen, setIsComparePanelOpen] = useState(false);
  const [isComparePanelLoading, setIsComparePanelLoading] = useState(false);
  const [isCompareDateOpen, setIsCompareDateOpen] = useState(false);
  const [compareDateRange, setCompareDateRange] = useState<DateRange>(getCurrentMonthRange);

  // Analytics-based data for pie chart (revenue distribution) and top products
  const [branchRevenueDistribution, setBranchRevenueDistribution] = useState<{ name: string; value: number }[]>(
    () => INITIAL_ADMIN_CACHE.cached?.branchRevenueDistribution ?? [],
  );
  const [topProductsData, setTopProductsData] = useState<{ name: string; sales: number }[]>(
    () => INITIAL_ADMIN_CACHE.cached?.topProductsData ?? [],
  );
  const [topProductsLoading, setTopProductsLoading] = useState(false);
  const [analyticsLoading, setAnalyticsLoading] = useState(() => !INITIAL_ADMIN_CACHE.cached);
  const [expenseCategoryByBranch, setExpenseCategoryByBranch] = useState<
    Record<number, Record<string, number>>
  >(() => INITIAL_ADMIN_CACHE.cached?.expenseCategoryByBranch ?? {});
  const [expenseRentByBranch, setExpenseRentByBranch] = useState<Record<number, number>>(
    () => INITIAL_ADMIN_CACHE.cached?.expenseRentByBranch ?? {},
  );
  const [expenseSalaryByBranch, setExpenseSalaryByBranch] = useState<Record<number, number>>(
    () => INITIAL_ADMIN_CACHE.cached?.expenseSalaryByBranch ?? {},
  );

  const [cashReconModalOpen, setCashReconModalOpen] = useState(false);
  const [cashReconModalBranch, setCashReconModalBranch] = useState<BranchPerformanceData | null>(null);

  /** All-Branches trend bar drill-down: day/month → branch list → breakdown */
  const [trendDrillOpen, setTrendDrillOpen] = useState(false);
  const [trendDrillStep, setTrendDrillStep] = useState<'branches' | 'breakdown'>('branches');
  const [trendDrillMetric, setTrendDrillMetric] = useState<TrendDrillMetric>('sales');
  const [trendDrillRange, setTrendDrillRange] = useState<DateRange>({ start: '', end: '' });
  const [trendDrillLabel, setTrendDrillLabel] = useState('');
  const [trendDrillBranches, setTrendDrillBranches] = useState<
    Array<{ id: number; name: string; amount: number; residual?: boolean }>
  >([]);
  const [trendDrillBranchesLoading, setTrendDrillBranchesLoading] = useState(false);
  /** Clicked bar total — footer must match chart tooltip, not re-summed branch rows. */
  const [trendDrillChartTotal, setTrendDrillChartTotal] = useState<number | null>(null);
  const [trendDrillBranch, setTrendDrillBranch] = useState<{
    id: number;
    name: string;
    residual?: boolean;
  } | null>(null);
  const [trendDrillSalesRows, setTrendDrillSalesRows] = useState<ApiTopSellingItem[]>([]);
  const [trendDrillSalesRecon, setTrendDrillSalesRecon] = useState(0);
  const [trendDrillExpenseGroups, setTrendDrillExpenseGroups] = useState<TrendDrillExpenseGroup[]>([]);
  const [trendDrillBreakdownLoading, setTrendDrillBreakdownLoading] = useState(false);
  /** When false, hide "← Branches" (opened from a focused branch card). */
  const [trendDrillAllowBranchNav, setTrendDrillAllowBranchNav] = useState(true);
  const [trendDrillExpenseSub, setTrendDrillExpenseSub] = useState<{
    main: string;
    name: string;
    amount: number;
  } | null>(null);
  const [trendDrillExpenseItems, setTrendDrillExpenseItems] = useState<ExpenseRecord[]>([]);
  const [trendDrillExpenseItemsLoading, setTrendDrillExpenseItemsLoading] = useState(false);
  const [trendDrillCalendarOpen, setTrendDrillCalendarOpen] = useState(false);
  const trendDrillReqIdRef = useRef(0);
  /** Avoid re-fetching the same day/metric while drilling around. */
  const trendDrillBranchesCacheRef = useRef(
    new Map<string, Array<{ id: number; name: string; amount: number; residual?: boolean }>>(),
  );
  const trendDrillBreakdownCacheRef = useRef(
    new Map<
      string,
      {
        salesRows: ApiTopSellingItem[];
        salesRecon: number;
        expenseGroups: TrendDrillExpenseGroup[];
      }
    >(),
  );
  const trendDrillExpensesListCacheRef = useRef(new Map<string, ExpenseRecord[]>());
  const [analyticsReloadKey, setAnalyticsReloadKey] = useState(0);
  /** Period metric maps (sales/expenses/profit) for Branch Comparison rows */
  const [compareSamePeriodCurrent, setCompareSamePeriodCurrent] =
    useState<CompareMetricMaps>(EMPTY_COMPARE_METRICS);
  const [compareSamePeriodPrev, setCompareSamePeriodPrev] =
    useState<CompareMetricMaps>(EMPTY_COMPARE_METRICS);
  /** Same-period (3일 전) expense maps for Main Expenses ÷ sales %. */
  const [compareSamePeriodExpenseCategoryByBranch, setCompareSamePeriodExpenseCategoryByBranch] =
    useState<Record<number, Record<string, number>>>({});
  const [compareSamePeriodExpenseRentByBranch, setCompareSamePeriodExpenseRentByBranch] =
    useState<Record<number, number>>({});
  const [compareSamePeriodExpenseSalaryByBranch, setCompareSamePeriodExpenseSalaryByBranch] =
    useState<Record<number, number>>({});
  /** Month-to-date of selected end (전월 대비 current: 1st → present). */
  const [compareLastMonthCurrent, setCompareLastMonthCurrent] =
    useState<CompareMetricMaps>(EMPTY_COMPARE_METRICS);
  /** Full prior calendar month (전월 대비 previous side). */
  const [compareLastMonthPrev, setCompareLastMonthPrev] =
    useState<CompareMetricMaps>(EMPTY_COMPARE_METRICS);
  /** Per-branch average of previous 3 full months when current is July: (Apr+May+Jun)/3 */
  const [compareThreeMonthAvg, setCompareThreeMonthAvg] =
    useState<CompareMetricMaps>(EMPTY_COMPARE_METRICS);
  const [compareBreakdownPopup, setCompareBreakdownPopup] = useState<CompareBreakdownPopup | null>(
    null,
  );
  /** Branch id → logo path (from /branch) for comparison table headers. */
  const [branchLogoById, setBranchLogoById] = useState<Record<number, string | null>>({});
  const [failedBranchLogoIds, setFailedBranchLogoIds] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/branch', {
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (!res.ok) return;
        const json = await res.json();
        const rows = json.data ?? json;
        if (!Array.isArray(rows) || cancelled) return;
        const map: Record<number, string | null> = {};
        for (const b of rows) {
          const id = Number(b.IDNo);
          if (!Number.isFinite(id)) continue;
          map[id] = b.BRANCH_LOGO || null;
        }
        setBranchLogoById(map);
      } catch (err) {
        console.warn('[AdminDashboard] Failed to load branch logos:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleBranchRevenueDistribution = useMemo(
    () => branchRevenueDistribution.filter((entry) => !isExcludedFromAllBranchesView(entry.name)),
    [branchRevenueDistribution],
  );
  const totalRevenueDistribution = useMemo(
    () => visibleBranchRevenueDistribution.reduce((sum, item) => sum + Number(item.value || 0), 0),
    [visibleBranchRevenueDistribution],
  );
  const topProductsPalette = useMemo(() => getTopProductsPalette(activeBranchId), [activeBranchId]);
  const topProductsChartData = useMemo(
    () =>
      topProductsData.map((item, index) => ({
        ...item,
        rank: index + 1,
        cleanName: formatTopProductName(item.name),
        barColor: topProductsPalette[index % topProductsPalette.length],
      })),
    [topProductsData, topProductsPalette],
  );
  const topProductMaxSales = useMemo(
    () => Math.max(...topProductsChartData.map((item) => Number(item.sales) || 0), 1),
    [topProductsChartData],
  );
  const focusedBranchName = useMemo(() => {
    if (!activeBranchId) return null;
    return branchCardsData.find((b) => b.id === activeBranchId)?.name ?? null;
  }, [activeBranchId, branchCardsData]);
  const summaryCacheKey = useMemo(() => {
    const currentRange = getCurrentMonthRange();
    const start = compareDateRange.start || currentRange.start;
    const end = compareDateRange.end || currentRange.end;
    const branchScope = activeBranchId ? String(activeBranchId) : 'all';
    return buildSummaryCacheKey(branchScope, start, end);
  }, [activeBranchId, compareDateRange.start, compareDateRange.end]);

  const analyticsCacheKey = useMemo(() => {
    const currentRange = getCurrentMonthRange();
    const start = compareDateRange.start || currentRange.start;
    const end = compareDateRange.end || currentRange.end;
    return buildAdminDashboardCacheKey({
      start,
      end,
      branchId: null,
    });
  }, [compareDateRange.start, compareDateRange.end]);

  // Cleanup legacy cache keys from older summary logic versions.
  useEffect(() => {
    try {
      const keysToDelete: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(LEGACY_SUMMARY_CACHE_PREFIX)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach((key) => localStorage.removeItem(key));
    } catch {
      // Ignore storage access errors.
    }
  }, []);

  // Sync selectedBranch prop to internal state
  useEffect(() => {
    const next =
      selectedBranch && selectedBranch.id !== 'all' ? Number(selectedBranch.id) : null;
    setActiveBranchId((prev) => (prev === next ? prev : next));
  }, [selectedBranch?.id]);

  // Keep internal compareDateRange in sync with global dateRange from Header
  useEffect(() => {
    if (!(dateRange.start || dateRange.end)) return;
    const nextStart = dateRange.start;
    const nextEnd = dateRange.end;
    setCompareDateRange((prev) => {
      if (prev.start === nextStart && prev.end === nextEnd) return prev;
      return { start: nextStart, end: nextEnd };
    });
  }, [dateRange.start, dateRange.end]);

  // Header date change while comparison panel is open → show skeleton until reload finishes
  useEffect(() => {
    if (!isComparePanelOpen) return;
    if (!dateRange.start || !dateRange.end) return;
    setIsComparePanelLoading(true);
  }, [dateRange.start, dateRange.end, isComparePanelOpen]);

  const getDateRangeForAnalytics = useCallback(() => {
    const currentRange = getCurrentMonthRange();
    return {
      start: compareDateRange.start || currentRange.start,
      end: compareDateRange.end || currentRange.end,
    };
  }, [compareDateRange.end, compareDateRange.start]);

  const seedBranchPrefetchFromChartsById = useCallback(
    (
      chartsById: Record<
        string,
        { trendMonthly: AdminDashboardTrendPoint[]; topProducts: BranchTopProduct[] }
      >,
      start: string,
      end: string,
    ) => {
      for (const [branchIdStr, charts] of Object.entries(chartsById ?? {})) {
        const branchId = Number(branchIdStr);
        if (!Number.isFinite(branchId) || !charts) continue;
        const key = buildBranchPrefetchKey(branchId, start, end);
        branchPrefetchCacheRef.current.set(key, {
          trendByPeriod: { monthly: charts.trendMonthly ?? [] },
          topProducts: charts.topProducts ?? [],
        });
      }
    },
    [],
  );

  useEffect(() => {
    const { start, end } = getDateRangeForAnalytics();
    // Reset only when the date/branch key changes, then re-seed from durable cache.
    branchPrefetchInFlightRef.current.clear();
    const cached = readAdminDashboardCacheIncludingStale(analyticsCacheKey);
    if (cached?.branchChartsById) {
      seedBranchPrefetchFromChartsById(cached.branchChartsById, start, end);
    }
  }, [analyticsCacheKey, getDateRangeForAnalytics, seedBranchPrefetchFromChartsById]);

  const getBranchPrefetchEntry = useCallback(
    (branchId: number) => {
      const { start, end } = getDateRangeForAnalytics();
      const key = buildBranchPrefetchKey(branchId, start, end);
      return { key, entry: branchPrefetchCacheRef.current.get(key) };
    },
    [getDateRangeForAnalytics],
  );

  const writeBranchPrefetchEntry = useCallback(
    (
      branchId: number,
      patch: {
        trendPeriod?: TrendPeriod;
        trend?: AdminDashboardTrendPoint[];
        topProducts?: BranchTopProduct[];
      },
    ) => {
      const { start, end } = getDateRangeForAnalytics();
      const key = buildBranchPrefetchKey(branchId, start, end);
      const existing = branchPrefetchCacheRef.current.get(key) ?? {
        trendByPeriod: {},
        topProducts: [],
      };
      const next: BranchDashboardPrefetchEntry = {
        trendByPeriod: { ...existing.trendByPeriod },
        topProducts: patch.topProducts ?? existing.topProducts,
      };
      if (patch.trendPeriod !== undefined && patch.trend !== undefined) {
        next.trendByPeriod[patch.trendPeriod] = patch.trend;
      }
      branchPrefetchCacheRef.current.set(key, next);
    },
    [getDateRangeForAnalytics],
  );

  const applyBranchPrefetchToCharts = useCallback(
    (branchId: number, period: TrendPeriod): boolean => {
      const { entry } = getBranchPrefetchEntry(branchId);
      if (!entry) return false;

      const cachedTrend = entry.trendByPeriod[period];
      if (cachedTrend === undefined) return false;

      setMonthlyData((prev) => (prev === cachedTrend ? prev : cachedTrend));
      setTopProductsData((prev) => (prev === entry.topProducts ? prev : entry.topProducts));
      return true;
    },
    [getBranchPrefetchEntry],
  );

  const refreshBranchDashboardCharts = useCallback(
    async (branchId: number, period: TrendPeriod, options: { background?: boolean } = {}) => {
      const { background = false } = options;
      const reqId = ++trendReqIdRef.current;
      const topProductsReqId = ++topProductsReqIdRef.current;
      const { start, end } = getDateRangeForAnalytics();

      if (!background && activeBranchIdRef.current === branchId) {
        setBranchChartsLoading(true);
      }

      try {
        const snapshot = await fetchBranchDashboardSnapshot({
          branchId,
          start,
          end,
          period,
        });
        if (
          reqId !== trendReqIdRef.current ||
          topProductsReqId !== topProductsReqIdRef.current ||
          activeBranchIdRef.current !== branchId
        ) {
          return;
        }

        setMonthlyData(snapshot.trend);
        setTopProductsData(snapshot.topProducts);
        writeBranchPrefetchEntry(branchId, {
          trendPeriod: period,
          trend: snapshot.trend,
          topProducts: snapshot.topProducts,
        });
        if (period === 'monthly') {
          patchAdminDashboardCache(analyticsCacheKey, {
            branchChartsById: {
              [String(branchId)]: {
                trendMonthly: snapshot.trend,
                topProducts: snapshot.topProducts,
              },
            },
          });
        }
      } catch (error) {
        if (activeBranchIdRef.current !== branchId) return;
        console.warn('[AdminDashboard] Branch dashboard refresh failed:', error);
      } finally {
        if (activeBranchIdRef.current === branchId) {
          setBranchChartsLoading(false);
          setTrendLoading(false);
          setTopProductsLoading(false);
        }
      }
    },
    [analyticsCacheKey, getDateRangeForAnalytics, writeBranchPrefetchEntry],
  );

  refreshBranchDashboardChartsRef.current = refreshBranchDashboardCharts;

  const invalidateBranchPrefetch = useCallback(
    (branchId?: number | null) => {
      const { start, end } = getDateRangeForAnalytics();
      if (branchId != null) {
        branchPrefetchCacheRef.current.delete(buildBranchPrefetchKey(branchId, start, end));
        return;
      }
      branchPrefetchCacheRef.current.clear();
      branchPrefetchInFlightRef.current.clear();
    },
    [getDateRangeForAnalytics],
  );

  const prefetchBranchDashboardData = useCallback(
    async (branchId: number, period: TrendPeriod = trendPeriod) => {
      const { start, end } = getDateRangeForAnalytics();
      const cacheKey = buildBranchPrefetchKey(branchId, start, end);
      const inflightKey = `${cacheKey}:${period}`;
      if (branchPrefetchInFlightRef.current.has(inflightKey)) return;

      const existing = branchPrefetchCacheRef.current.get(cacheKey);
      if (existing?.trendByPeriod[period] !== undefined) return;

      const branch = branchCardsData.find((b) => b.id === branchId);
      const branchExpenses = branch
        ? (expenseCategoryByBranch[branch.id]
            ? Object.values(expenseCategoryByBranch[branch.id]).reduce(
                (s, v) => s + (Number(v) || 0),
                0,
              )
            : Number(branch.totalExpenses) || 0)
        : 0;
      if (shouldSkipBranchTrendFetch(period, branch, branchExpenses)) {
        writeBranchPrefetchEntry(branchId, {
          trendPeriod: period,
          trend: [],
          topProducts: [],
        });
        return;
      }

      branchPrefetchInFlightRef.current.add(inflightKey);
      try {
        const snapshot = await fetchBranchDashboardSnapshot({
          branchId,
          start,
          end,
          period,
        });
        writeBranchPrefetchEntry(branchId, {
          trendPeriod: period,
          trend: snapshot.trend,
          topProducts: snapshot.topProducts,
        });

        if (period === 'monthly') {
          patchAdminDashboardCache(analyticsCacheKey, {
            branchChartsById: {
              [String(branchId)]: {
                trendMonthly: snapshot.trend,
                topProducts: snapshot.topProducts,
              },
            },
          });
        }

        if (activeBranchIdRef.current === branchId && trendPeriod === period) {
          setMonthlyData(snapshot.trend);
          setTopProductsData(snapshot.topProducts);
        }
      } catch (error) {
        console.warn('[AdminDashboard] Branch prefetch failed:', error);
      } finally {
        branchPrefetchInFlightRef.current.delete(inflightKey);
      }
    },
    [analyticsCacheKey, branchCardsData, expenseCategoryByBranch, getDateRangeForAnalytics, trendPeriod, writeBranchPrefetchEntry],
  );

  // Hover-only branch chart warm — do not fan out N× Py calls after every admin load.
  // Prefetch cache is cleared/reseeded in the analyticsCacheKey effect above.

  const applyAdminBundlePayload = useCallback(
    (
      payload: {
        summary: SummaryData;
        branchCardsData: BranchPerformanceData[];
        branchRevenueDistribution: { name: string; value: number }[];
        topProductsData: { name: string; sales: number }[];
        expenseCategoryByBranch: Record<number, Record<string, number>>;
        expenseRentByBranch?: Record<number, number>;
        expenseSalaryByBranch?: Record<number, number>;
      },
      options: { background?: boolean } = {},
    ) => {
      const { background = false } = options;
      // Cached/shared summary is always the all-branches total (cache entries aren't branch-scoped);
      // `summary` below is what actually renders, swapped to the focused branch's totals when applicable.
      const allBranchesSummary =
        payload.branchCardsData.length > 0
          ? computeAllBranchesSummary(payload.branchCardsData, payload.expenseCategoryByBranch)
          : payload.summary;
      const focusedBranch = activeBranchIdRef.current
        ? payload.branchCardsData.find((b) => b.id === activeBranchIdRef.current)
        : null;
      const summary = focusedBranch
        ? computeBranchSummary(focusedBranch, payload.expenseCategoryByBranch)
        : allBranchesSummary;

      if (background) {
        setBranchCardsData((prev) =>
          payload.branchCardsData.length > 0 ? payload.branchCardsData : prev,
        );
        setBranchRevenueDistribution((prev) =>
          preferNonEmptyArray(payload.branchRevenueDistribution, prev),
        );
        if (!activeBranchIdRef.current) {
          setTopProductsData((prev) => preferNonEmptyArray(payload.topProductsData, prev));
        }
        setExpenseCategoryByBranch((prev) =>
          preferNonEmptyRecord(payload.expenseCategoryByBranch, prev),
        );
        setExpenseRentByBranch((prev) =>
          preferNonEmptyRecord(payload.expenseRentByBranch || {}, prev),
        );
        setExpenseSalaryByBranch((prev) =>
          preferNonEmptyRecord(payload.expenseSalaryByBranch || {}, prev),
        );
        setSummaryData((prev) =>
          summary.totalSales > 0 || summary.totalExpenses > 0 ? summary : (prev ?? summary),
        );
      } else {
        setBranchCardsData((prev) =>
          payload.branchCardsData.length > 0 ? payload.branchCardsData : prev,
        );
        setBranchRevenueDistribution((prev) =>
          preferNonEmptyArray(payload.branchRevenueDistribution, prev),
        );
        if (!activeBranchIdRef.current) {
          setTopProductsData(payload.topProductsData);
        }
        setExpenseCategoryByBranch(payload.expenseCategoryByBranch);
        setExpenseRentByBranch(payload.expenseRentByBranch || {});
        setExpenseSalaryByBranch(payload.expenseSalaryByBranch || {});
        setSummaryData(summary);
      }

      patchAdminDashboardCache(analyticsCacheKey, {
        summary: allBranchesSummary,
        branchCardsData: payload.branchCardsData,
        branchRevenueDistribution: payload.branchRevenueDistribution,
        topProductsData: payload.topProductsData,
        expenseCategoryByBranch: payload.expenseCategoryByBranch,
        expenseRentByBranch: payload.expenseRentByBranch,
        expenseSalaryByBranch: payload.expenseSalaryByBranch,
      });
    },
    [analyticsCacheKey],
  );

  const hydrateFromCache = useCallback((cached: AdminDashboardCachePayload) => {
    const branchFocused = activeBranchIdRef.current != null;

    if (cached.branchChartsById) {
      const { start, end } = getDateRangeForAnalytics();
      seedBranchPrefetchFromChartsById(cached.branchChartsById, start, end);
    }

    if (cached.summary && !branchFocused) {
      setSummaryData(cached.summary);
    }
    const cachedTrend = cached.trendByPeriod?.[trendPeriod];
    if (!branchFocused && cachedTrend?.length && hasNonZeroTrendRows(cachedTrend)) {
      setMonthlyData(cachedTrend);
    }
    applyAdminBundlePayload(
      {
        summary: cached.summary ?? { totalSales: 0, totalExpenses: 0, totalRevenue: 0 },
        branchCardsData: cached.branchCardsData,
        branchRevenueDistribution: cached.branchRevenueDistribution,
        topProductsData: cached.topProductsData,
        expenseCategoryByBranch: cached.expenseCategoryByBranch,
        expenseRentByBranch: cached.expenseRentByBranch,
        expenseSalaryByBranch: cached.expenseSalaryByBranch,
      },
      { background: true },
    );
    setAnalyticsLoading(false);
  }, [applyAdminBundlePayload, getDateRangeForAnalytics, seedBranchPrefetchFromChartsById, trendPeriod]);

  const loadTrend = useCallback(
    async (background: boolean) => {
      const reqId = ++trendReqIdRef.current;
      if (!background) setTrendLoading(true);
      try {
        const currentRange = getCurrentMonthRange();
        const start = compareDateRange.start || currentRange.start;
        const end = compareDateRange.end || currentRange.end;
        const apiRange = getTrendApiDateRange(trendPeriod, start, end);

        let chartData: AdminDashboardTrendPoint[];

        if (activeBranchId) {
          chartData = await fetchBranchPerformanceTrend(activeBranchId, start, end, trendPeriod);
          if (reqId !== trendReqIdRef.current) return;
        } else {
          const params = new URLSearchParams();
          params.set('period', trendPeriod);
          params.set('start_date', apiRange.start);
          params.set('end_date', apiRange.end);

          const rows: ApiPerformanceTrendRow[] = await fetchPerformanceTrendApi(params);
          if (reqId !== trendReqIdRef.current) return;

          let rowsForChart = rows.map((r) => ({
            name: r.name,
            totalSales: Number(r.totalSales || 0),
            totalExpenses: Number(r.totalExpenses || 0),
            ...(r.sale_date ? { date: String(r.sale_date).slice(0, 10) } : {}),
          }));

          // Total Sales = gross POS from performance-trend (no net remap / no cash recon).
          chartData = rowsForChart;

          if (trendPeriod === 'weekly' && chartData.length > 0 && chartData.every((d) => d.date)) {
            const lastKey = chartData[chartData.length - 1].date!;
            const anchor = new Date(`${lastKey}T12:00:00`);
            const now = new Date();
            const isAnchorToday =
              anchor.getFullYear() === now.getFullYear() &&
              anchor.getMonth() === now.getMonth() &&
              anchor.getDate() === now.getDate();
            if (isAnchorToday) {
              const copy = [...chartData];
              copy[copy.length - 1] = { ...copy[copy.length - 1], name: 'Today' };
              chartData = copy;
            }
          } else if (trendPeriod === 'weekly' && chartData.length === 7) {
            const anchor =
              (compareDateRange.end ? new Date(compareDateRange.end) : null) ??
              (compareDateRange.start ? new Date(compareDateRange.start) : null) ??
              new Date();

            const jsDay = anchor.getDay();
            const todayIdxMon0 = (jsDay + 6) % 7;
            const startIdx = (todayIdxMon0 + 1) % 7;
            const rotated = [...chartData.slice(startIdx), ...chartData.slice(0, startIdx)];

            const now = new Date();
            const isAnchorToday =
              anchor.getFullYear() === now.getFullYear() &&
              anchor.getMonth() === now.getMonth() &&
              anchor.getDate() === now.getDate();

            const anchorName = isAnchorToday
              ? 'Today'
              : WEEKDAY_LABELS_MON_FIRST[todayIdxMon0] ?? rotated[rotated.length - 1].name;

            const anchorMidday = new Date(anchor);
            anchorMidday.setHours(12, 0, 0, 0);
            const withDates = rotated.map((row, idx) => {
              const offsetDays = idx - (rotated.length - 1);
              const d = new Date(
                anchorMidday.getFullYear(),
                anchorMidday.getMonth(),
                anchorMidday.getDate() + offsetDays,
                12,
                0,
                0,
              );
              return { ...row, date: toYYYYMMDD(d) };
            });

            withDates[withDates.length - 1] = { ...withDates[withDates.length - 1], name: anchorName };
            chartData = withDates;
          }
        }

        if (reqId !== trendReqIdRef.current) return;

        if (!hasNonZeroTrendRows(chartData)) {
          setMonthlyData([]);
          if (!activeBranchId) {
            patchAdminDashboardCache(analyticsCacheKey, {
              trendByPeriod: { [trendPeriod]: [] },
            });
          }
          return;
        }

        setMonthlyData(chartData);
        if (!activeBranchId) {
          patchAdminDashboardCache(analyticsCacheKey, {
            trendByPeriod: { [trendPeriod]: chartData },
          });
        }
      } catch (error) {
        if (reqId !== trendReqIdRef.current) return;
        console.error('[AdminDashboard] Failed to load performance trend:', error);
      } finally {
        if (reqId === trendReqIdRef.current) setTrendLoading(false);
      }
    },
    [
      activeBranchId,
      analyticsCacheKey,
      compareDateRange.end,
      compareDateRange.start,
      trendPeriod,
    ],
  );

  const loadAdminBundle = useCallback(
    async (background: boolean) => {
      const reqId = ++analyticsReqIdRef.current;
      if (!background) {
        setAnalyticsLoading(true);
      }
      try {
        const currentRange = getCurrentMonthRange();
        const start = compareDateRange.start || currentRange.start;
        const end = compareDateRange.end || currentRange.end;

        const bundle = await fetchAdminDashboardBundleApi({
          start,
          end,
          branchId: 'all',
          period: 'monthly',
        });
        if (reqId !== analyticsReqIdRef.current) return;

        applyAdminBundlePayload(
          {
            summary: bundle.summary,
            branchCardsData: bundle.branchCardsData,
            branchRevenueDistribution: bundle.branchRevenueDistribution,
            topProductsData: bundle.topProductsData,
            expenseCategoryByBranch: bundle.expenseCategoryByBranch,
            expenseRentByBranch: bundle.expenseRentByBranch,
            expenseSalaryByBranch: bundle.expenseSalaryByBranch,
          },
          { background },
        );

        if (
          !activeBranchIdRef.current &&
          trendPeriodRef.current === 'monthly' &&
          hasNonZeroTrendRows(bundle.trendData)
        ) {
          setMonthlyData(bundle.trendData);
          patchAdminDashboardCache(analyticsCacheKey, {
            trendByPeriod: { monthly: bundle.trendData },
          });
        }

        if (bundle.branchChartsById && Object.keys(bundle.branchChartsById).length > 0) {
          seedBranchPrefetchFromChartsById(bundle.branchChartsById, start, end);
          patchAdminDashboardCache(analyticsCacheKey, {
            branchChartsById: bundle.branchChartsById,
          });
        }

        let topProducts = bundle.topProductsData;
        allBranchesTopProductsRef.current = topProducts;
        let expenseMap = bundle.expenseCategoryByBranch;
        let branchCards = bundle.branchCardsData;
        let summary = bundle.summary;

        const needsTopProducts = topProducts.length === 0;
        const needsExpenseBreakdown = Object.keys(expenseMap).length === 0;
        if (needsTopProducts || needsExpenseBreakdown) {
          try {
            const analyticsParams = new URLSearchParams();
            analyticsParams.set('start_date', start);
            analyticsParams.set('end_date', end);

            const [topSelling, expenseBreakdown] = await Promise.all([
              needsTopProducts
                ? fetchTopSellingApi(
                    new URLSearchParams({
                      start_date: start,
                      end_date: end,
                      limit: '5',
                    } as any),
                  )
                : Promise.resolve(null),
              needsExpenseBreakdown
                ? fetchExpenseCategoryBreakdownApi(new URLSearchParams(analyticsParams))
                : Promise.resolve(null),
            ]);
            if (reqId !== analyticsReqIdRef.current) return;

            if (Array.isArray(topSelling) && topSelling.length > 0) {
              topProducts = topSelling.map((item) => ({
                name: item.MENU_NAME,
                sales: item.total_quantity,
              }));
            }
            if (Array.isArray(expenseBreakdown) && expenseBreakdown.length > 0) {
              const maps = buildExpenseMaps(expenseBreakdown);
              expenseMap = maps.expenseMap;
              const expenseByBranch = maps.expenseByBranch;
              if (branchCards.length > 0) {
                branchCards = branchCards.map((card) => ({
                  ...card,
                  totalExpenses: expenseByBranch[card.id] ?? card.totalExpenses,
                }));
              }
              const totalExpenses = Object.values(expenseByBranch).reduce(
                (sum, v) => sum + (Number(v) || 0),
                0,
              );
              if (totalExpenses > 0) {
                summary = {
                  ...summary,
                  totalExpenses,
                  totalRevenue: summary.totalSales - totalExpenses,
                };
              }
            }

            applyAdminBundlePayload(
              {
                summary,
                branchCardsData: branchCards,
                branchRevenueDistribution: bundle.branchRevenueDistribution,
                topProductsData: topProducts,
                    expenseCategoryByBranch: expenseMap,
                expenseRentByBranch: bundle.expenseRentByBranch,
                expenseSalaryByBranch: bundle.expenseSalaryByBranch,
                  },
              { background },
            );
          } catch (error) {
            console.warn('[AdminDashboard] Supplemental bundle fetch failed:', error);
          }
        }

        const focusedId = activeBranchIdRef.current;
        if (focusedId != null) {
          void refreshBranchDashboardChartsRef.current?.(focusedId, trendPeriodRef.current);
        }

      } catch (error) {
        if (reqId !== analyticsReqIdRef.current) return;
        console.error('Failed to load admin dashboard bundle:', error);
      } finally {
        if (reqId === analyticsReqIdRef.current) {
          setAnalyticsLoading(false);
        }
      }
    },
    [
      analyticsCacheKey,
      applyAdminBundlePayload,
      compareDateRange.end,
      compareDateRange.start,
      seedBranchPrefetchFromChartsById,
    ],
  );

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const cached = readAdminDashboardCacheIncludingStale(analyticsCacheKey);
      if (hasAdminDashboardCacheData(cached)) {
        hydrateFromCache(cached);
        // Always revalidate — stale browser cache was causing different totals per user.
        void loadAdminBundle(true);
        return;
      }

      await waitForAdminDashboardPrefetch(analyticsCacheKey);
      if (cancelled) return;

      const afterPrefetch = readAdminDashboardCacheIncludingStale(analyticsCacheKey);
      if (hasAdminDashboardCacheData(afterPrefetch)) {
        hydrateFromCache(afterPrefetch);
        void loadAdminBundle(true);
        return;
      }

      void loadAdminBundle(false);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [analyticsCacheKey, hydrateFromCache, loadAdminBundle, analyticsReloadKey]);

  // Stale drill caches after dashboard data refresh (e.g. cash recon edit).
  useEffect(() => {
    if (analyticsReloadKey === 0) return;
    trendDrillBranchesCacheRef.current.clear();
    trendDrillBreakdownCacheRef.current.clear();
    trendDrillExpensesListCacheRef.current.clear();
  }, [analyticsReloadKey]);

  // Bundle covers trend on mount / date change; refetch only when user switches Weekly/Monthly/Yearly.
  useEffect(() => {
    if (isFirstTrendEffectRef.current) {
      isFirstTrendEffectRef.current = false;
      prevTrendPeriodEffectBranchRef.current = activeBranchId;
      prevTrendPeriodRef.current = trendPeriod;
      return;
    }

    const branchChanged = prevTrendPeriodEffectBranchRef.current !== activeBranchId;
    const periodChanged = prevTrendPeriodRef.current !== trendPeriod;
    prevTrendPeriodEffectBranchRef.current = activeBranchId;
    prevTrendPeriodRef.current = trendPeriod;

    if (activeBranchId) {
      // Initial branch focus is handled by the branch-focus effect below.
      if (branchChanged || !periodChanged) return;

      const focusedBranch = branchCardsData.find((b) => b.id === activeBranchId);
      const focusedBranchExpenses = focusedBranch
        ? Number(focusedBranch.totalExpenses) || 0
        : 0;

      setTrendLoading(false);
      if (shouldSkipBranchTrendFetch(trendPeriod, focusedBranch, focusedBranchExpenses)) {
        setMonthlyData([]);
        setTopProductsData([]);
        return;
      }

      const hasCachedBranchCharts = applyBranchPrefetchToCharts(activeBranchId, trendPeriod);
      setBranchChartsLoading(!hasCachedBranchCharts);
      void refreshBranchDashboardCharts(activeBranchId, trendPeriod, {
        background: hasCachedBranchCharts,
      });
      return;
    }

    const cached = readAdminDashboardCacheIncludingStale(analyticsCacheKey);
    const cachedTrend = cached?.trendByPeriod?.[trendPeriod];
    if (cachedTrend?.length && hasNonZeroTrendRows(cachedTrend)) {
      setMonthlyData(cachedTrend);
      setTrendLoading(false);
      // Monthly trend already comes from the admin bundle — avoid a redundant Py round-trip.
      if (trendPeriod !== 'monthly' || !isAdminDashboardCacheFresh(analyticsCacheKey)) {
        void loadTrend(true);
      }
      return;
    }
    void loadTrend(true);
  }, [
    activeBranchId,
    analyticsCacheKey,
    applyBranchPrefetchToCharts,
    branchCardsData,
    loadTrend,
    refreshBranchDashboardCharts,
    trendPeriod,
  ]);

  // Branch focus filters charts only — keep all-branch card expenses intact.
  useEffect(() => {
    const prev = prevFocusedBranchIdRef.current;
    if (prev === activeBranchId) return;
    prevFocusedBranchIdRef.current = activeBranchId;

    if (!activeBranchId) {
      topProductsReqIdRef.current += 1;
      setBranchChartsLoading(false);
      if (allBranchesTopProductsRef.current.length > 0) {
        setTopProductsData(allBranchesTopProductsRef.current);
      }
      setTopProductsLoading(false);
      if (prev != null) {
        const period = trendPeriodRef.current;
        const cached = readAdminDashboardCacheIncludingStale(analyticsCacheKey);
        const cachedTrend = cached?.trendByPeriod?.[period];
        if (cachedTrend?.length && hasNonZeroTrendRows(cachedTrend)) {
          setMonthlyData(cachedTrend);
          setTrendLoading(false);
          if (period !== 'monthly' || !isAdminDashboardCacheFresh(analyticsCacheKey)) {
            void loadTrend(true);
          }
        } else {
          void loadTrend(true);
        }
      }
      return;
    }

    const focusedBranch = branchCardsData.find((b) => b.id === activeBranchId);
    const focusedBranchExpenses = focusedBranch ? getEffectiveBranchTotalExpenses(focusedBranch) : 0;

    setTrendLoading(false);
    setTopProductsLoading(false);
    topProductsReqIdRef.current += 1;

    if (shouldSkipBranchTrendFetch(trendPeriod, focusedBranch, focusedBranchExpenses)) {
      setBranchChartsLoading(false);
      setMonthlyData([]);
      setTopProductsData([]);
      return;
    }

    const hasCachedBranchCharts = applyBranchPrefetchToCharts(activeBranchId, trendPeriod);
    setBranchChartsLoading(!hasCachedBranchCharts);
    void refreshBranchDashboardCharts(activeBranchId, trendPeriod, {
      background: hasCachedBranchCharts,
    });
  }, [
    activeBranchId,
    applyBranchPrefetchToCharts,
    branchCardsData,
    loadTrend,
    refreshBranchDashboardCharts,
    trendPeriod,
  ]);

  useEffect(() => {
    if (!isComparePanelOpen) {
      setIsCompareDateOpen(false);
      setIsComparePanelLoading(false);
    }
  }, [isComparePanelOpen]);

  const handleBranchCompareToggle = (branchId: number) => {
    const branch = sourceForCompare.find((b) => b.id === branchId);
    if (branch && isExcludedFromAllBranchesView(branch.name)) return;
    setCompareBranchIds((prev) => {
      if (prev.includes(branchId)) {
        return prev.filter((id) => id !== branchId);
      }

      return [...prev, branchId];
    });
  };

  const handleBranchFocus = (branch: BranchPerformanceData) => {
    const isCurrentlyActive = activeBranchId === branch.id;
    if (isCurrentlyActive) {
      setActiveBranchId(null);
      return;
    }

    const period = trendPeriodRef.current;
    const { entry } = getBranchPrefetchEntry(branch.id);
    const cachedTrend = entry?.trendByPeriod[period];
    if (cachedTrend !== undefined) {
      setMonthlyData(cachedTrend);
      setTopProductsData(entry!.topProducts);
      setBranchChartsLoading(false);
      setTrendLoading(false);
      setTopProductsLoading(false);
    }

    setActiveBranchId(branch.id);
  };

  const sourceForCompare = branchCardsData;
  const branchesForCompareList = useMemo(
    () => sortBranchesBySidebarOrder(sourceForCompare, { exclude3core: true }),
    [sourceForCompare],
  );

  const compareSelectableIds = useMemo(
    () => branchesForCompareList.map((b) => b.id),
    [branchesForCompareList],
  );
  const allCompareSelected =
    compareSelectableIds.length > 0 &&
    compareSelectableIds.every((id) => compareBranchIds.includes(id));

  const handleCompareSelectAll = () => {
    if (compareSelectableIds.length === 0) return;
    setCompareBranchIds(allCompareSelected ? [] : compareSelectableIds);
  };

  useEffect(() => {
    setCompareBranchIds((prev) =>
      prev.filter((id) => {
        const b = sourceForCompare.find((x) => x.id === id);
        return b && !isExcludedFromAllBranchesView(b.name);
      }),
    );
  }, [sourceForCompare]);

  const selectedCompareBranches = compareBranchIds
    .map((id) => branchesForCompareList.find((branch) => branch.id === id))
    .filter((branch): branch is BranchPerformanceData => Boolean(branch));
  const canCompare = selectedCompareBranches.length >= 2;

  // Fetch same-period (3일 전 기준) + MTD vs full prior month + trailing-3-month avg.
  useEffect(() => {
    if (!isComparePanelOpen || !canCompare) {
      setIsComparePanelLoading(false);
      return;
    }

    const currentRange = getCurrentMonthRange();
    const start = compareDateRange.start || currentRange.start;
    const end = compareDateRange.end || currentRange.end;
    const samePeriodWindows = getSamePeriodWindows(start, end, SAME_PERIOD_LOOKBACK_DAYS);
    const mtdVsPrevMonth = getMtdVsFullPreviousMonth(end);
    const prevThreeMonths = getPreviousThreeMonthsRange(end);
    if (!samePeriodWindows || !mtdVsPrevMonth || !prevThreeMonths) {
      setIsComparePanelLoading(false);
      return;
    }

    let cancelled = false;
    setIsComparePanelLoading(true);

    const fetchBundle = (range: DateRange) =>
      fetchAdminDashboardBundleApi({
        start: range.start,
        end: range.end,
        branchId: 'all',
        includeBranchCharts: false,
        mode: 'compare',
      });

    (async () => {
      try {
        const { current: sameCurrent, previous: samePrev } = samePeriodWindows;
        const { current: mtdCurrent, previous: fullPrevMonth } = mtdVsPrevMonth;
        const rangeKey = (r: DateRange) => `${r.start}|${r.end}`;
        const cache = new Map<string, ReturnType<typeof fetchBundle>>();

        const getCached = (range: DateRange) => {
          const key = rangeKey(range);
          let promise = cache.get(key);
          if (!promise) {
            promise = fetchBundle(range);
            cache.set(key, promise);
          }
          return promise;
        };

        const [
          sameCurrentBundle,
          samePrevBundle,
          mtdCurrentBundle,
          fullPrevMonthBundle,
          threeMonthBundle,
        ] = await Promise.all([
          getCached(sameCurrent),
          getCached(samePrev),
          getCached(mtdCurrent),
          getCached(fullPrevMonth),
          getCached(prevThreeMonths),
        ]);
        if (cancelled) return;

        const fromBundle = (bundle: {
          branchCardsData?: Array<{ id: number; totalSales: number; totalExpenses?: number }>;
          expenseCategoryByBranch?: Record<number, Record<string, number>>;
        }) =>
          branchCardsToMetricMaps(
            bundle.branchCardsData || [],
            bundle.expenseCategoryByBranch,
          );

        setCompareSamePeriodCurrent(fromBundle(sameCurrentBundle));
        setCompareSamePeriodPrev(fromBundle(samePrevBundle));
        setCompareSamePeriodExpenseCategoryByBranch(
          sameCurrentBundle.expenseCategoryByBranch || {},
        );
        setCompareSamePeriodExpenseRentByBranch(sameCurrentBundle.expenseRentByBranch || {});
        setCompareSamePeriodExpenseSalaryByBranch(sameCurrentBundle.expenseSalaryByBranch || {});
        setCompareLastMonthCurrent(fromBundle(mtdCurrentBundle));
        setCompareLastMonthPrev(fromBundle(fullPrevMonthBundle));
        setCompareThreeMonthAvg(
          averageMetricMaps(fromBundle(threeMonthBundle), TRAILING_AVG_MONTHS),
        );
      } catch (err) {
        if (cancelled) return;
        console.warn('[AdminDashboard] Failed to load compare prior-period metrics:', err);
        setCompareSamePeriodCurrent(EMPTY_COMPARE_METRICS);
        setCompareSamePeriodPrev(EMPTY_COMPARE_METRICS);
        setCompareSamePeriodExpenseCategoryByBranch({});
        setCompareSamePeriodExpenseRentByBranch({});
        setCompareSamePeriodExpenseSalaryByBranch({});
        setCompareLastMonthCurrent(EMPTY_COMPARE_METRICS);
        setCompareLastMonthPrev(EMPTY_COMPARE_METRICS);
        setCompareThreeMonthAvg(EMPTY_COMPARE_METRICS);
      } finally {
        if (!cancelled) setIsComparePanelLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isComparePanelOpen,
    canCompare,
    compareDateRange.start,
    compareDateRange.end,
  ]);

  // When user focuses a branch card, mirror that branch's totals in the summary row.
  useEffect(() => {
    if (branchCardsData.length === 0) return;

    if (!activeBranchId) {
      const totalSales = branchCardsData.reduce((s, b) => s + (Number(b.totalSales) || 0), 0);
      const totalExpenses = branchCardsData.reduce(
        (s, b) => s + getEffectiveBranchTotalExpenses(b),
        0,
      );
      setSummaryData({
        totalSales,
        totalExpenses,
        totalRevenue: totalSales - totalExpenses,
      });
      return;
    }

    const branch = branchCardsData.find((b) => b.id === activeBranchId);
    if (!branch) return;
    const totalExpenses = getEffectiveBranchTotalExpenses(branch);
    const totalSales = branch.totalSales;
    setSummaryData({
      totalRevenue: totalSales - totalExpenses,
      totalSales,
      totalExpenses,
    });
  }, [activeBranchId, branchCardsData, expenseCategoryByBranch]);

  // Persist latest computed summary for fast subsequent loads.
  useEffect(() => {
    if (!summaryData) return;
    if (branchCardsData.length === 0) return;
    try {
      localStorage.setItem(summaryCacheKey, JSON.stringify(summaryData));
    } catch {
      // Ignore storage quota / privacy mode errors.
    }
  }, [
    activeBranchId,
    branchCardsData.length,
    summaryCacheKey,
    summaryData,
  ]);

  const formatCurrency = (value: number) => {
    const safe = Number.isFinite(value) ? Math.trunc(value) : 0;
    return `₱${safe.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  const formatSignedCurrency = (value: number) => {
    const safe = Number.isFinite(value) ? Math.trunc(value) : 0;
    const abs = Math.abs(safe).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    if (safe < 0) return `-₱${abs}`;
    return `₱${abs}`;
  };

  /**
   * Amount + index % (100 = flat). e.g. ₱1,824,312 (88.1%).
   * `amountSource: 'current'` for expenses (readable vs Main Expenses);
   * `'previous'` keeps legacy baseline display for sales/profit.
   * When baseline ≈ 0 → percent is `—` (no fake 200% / ±100).
   */
  const formatDiffIndexDisplay = (
    current: number,
    previous: number,
    amountSource: 'current' | 'previous' = 'previous',
    stackedTrend = false,
  ) => {
    const cur = Number(current) || 0;
    const prev = Number(previous) || 0;
    const amountValue = amountSource === 'current' ? cur : prev;
    if (isUnreliableCompareBase(prev)) {
      return {
        amount: formatSignedCurrency(Math.trunc(amountValue)),
        percent: stackedTrend ? '—' : '(—)',
        sentiment: 'flat' as const,
        unreliable: true,
        showTrendIcon: stackedTrend,
      };
    }
    const index = monthIndexFromPct(pctChange(cur, prev));
    return {
      amount: formatSignedCurrency(Math.trunc(amountValue)),
      percent: `(${index.toFixed(1)}%)`,
      sentiment: (index >= 100 ? 'up' : 'down') as 'up' | 'down' | 'flat',
      unreliable: false,
      showTrendIcon: stackedTrend,
    };
  };

  /** Absolute amount + share of denominator, e.g. ₱50,000 (20.0%). */
  const formatCurrencyWithShare = (amount: number, total: number) => {
    const amt = Number(amount) || 0;
    const tot = Number(total) || 0;
    const share = tot > 0 ? (amt / tot) * 100 : 0;
    return {
      amount: formatCurrency(amt),
      percent: `(${share.toFixed(1)}%)`,
    };
  };

  const compareWindowMeta = useMemo(() => {
    const currentRange = getCurrentMonthRange();
    const start = compareDateRange.start || currentRange.start;
    const end = compareDateRange.end || currentRange.end;
    const samePeriod = getSamePeriodWindows(start, end, SAME_PERIOD_LOOKBACK_DAYS);
    const mtdVsPrevMonth = getMtdVsFullPreviousMonth(end);
    const prevThreeMonths = getPreviousThreeMonthsRange(end);
    return {
      selected: { start, end },
      samePeriod,
      mtdVsPrevMonth,
      prevThreeMonths,
    };
  }, [compareDateRange.start, compareDateRange.end]);

  useEffect(() => {
    if (!compareBreakdownPopup) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCompareBreakdownPopup(null);
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-compare-breakdown-popup]') || target?.closest('[data-compare-breakdown-trigger]')) {
        return;
      }
      setCompareBreakdownPopup(null);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [compareBreakdownPopup]);

  useEffect(() => {
    setCompareBreakdownPopup(null);
  }, [compareDateRange.start, compareDateRange.end, isComparePanelOpen]);

  const placeComparePopup = (anchor: DOMRect, width: number, estHeight: number) => {
    const pad = 8;
    const left = Math.max(pad, Math.min(anchor.left, window.innerWidth - width - pad));
    const spaceBelow = window.innerHeight - anchor.bottom - pad;
    const spaceAbove = anchor.top - pad;
    const preferBelow = spaceBelow >= Math.min(estHeight, 280) || spaceBelow >= spaceAbove;
    let top = preferBelow ? anchor.bottom + pad : Math.max(pad, anchor.top - estHeight - pad);
    // Keep fully on-screen even if estimate was short.
    top = Math.max(
      pad,
      Math.min(top, window.innerHeight - Math.min(estHeight, window.innerHeight - pad * 2) - pad),
    );
    return { top, left };
  };

  const openCompareBreakdown = (
    e: React.MouseEvent<HTMLElement>,
    key: string,
    branchName: string,
    metricLabel: string,
    kind: CompareBreakdownKind,
    current: number,
    previous: number,
    /** When true (expenses), decrease = good — match main cell colors. */
    invertSentiment = false,
  ) => {
    e.stopPropagation();
    if (compareBreakdownPopup?.key === key) {
      setCompareBreakdownPopup(null);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const popupWidth = 360;
    const { top, left } = placeComparePopup(rect, popupWidth, 360);

    const { selected, samePeriod, mtdVsPrevMonth, prevThreeMonths } = compareWindowMeta;
    const cur = Number(current) || 0;
    const prev = Number(previous) || 0;
    const diff = Math.trunc(cur - prev);
    const unreliable = isUnreliableCompareBase(prev);
    const isNewExpense = unreliable && cur > 0 && invertSentiment;
    const change = unreliable ? 0 : pctChange(cur, prev);
    const index = unreliable ? null : monthIndexFromPct(change);

    const flipTone = (tone: 'up' | 'down' | 'neutral'): 'up' | 'down' | 'neutral' => {
      if (!invertSentiment || tone === 'neutral') return tone;
      return tone === 'up' ? 'down' : 'up';
    };

    // For NEW / missing baseline, keep amounts neutral — colored % tones are misleading.
    const currentTone = unreliable
      ? 'neutral'
      : flipTone(cur > prev ? 'up' : cur < prev ? 'down' : 'neutral');
    const previousTone = unreliable
      ? 'neutral'
      : flipTone(prev > cur ? 'up' : prev < cur ? 'down' : 'neutral');
    const resultTone = unreliable
      ? invertSentiment && diff > 0
        ? 'down'
        : 'neutral'
      : flipTone(diff > 0 ? 'up' : diff < 0 ? 'down' : 'neutral');
    const indexTone =
      index == null ? 'neutral' : flipTone(index >= 100 ? 'up' : 'down');

    let currentTitle = 'Current';
    let baseTitle = 'Previous';
    let currentRangeLabel = formatRangeLabel(selected);
    let baseRangeLabel = '—';

    if (kind === 'same_period' && samePeriod) {
      currentTitle = 'Current (same period)';
      baseTitle = 'Previous (same period)';
      currentRangeLabel = formatRangeLabel(samePeriod.current);
      baseRangeLabel = formatRangeLabel(samePeriod.previous);
    } else if (kind === 'vs_last_month' && mtdVsPrevMonth) {
      currentTitle = 'Current (MTD)';
      baseTitle = 'Previous (full month)';
      currentRangeLabel = formatRangeLabel(mtdVsPrevMonth.current);
      baseRangeLabel = formatRangeLabel(mtdVsPrevMonth.previous);
    } else if (kind === 'vs_average' && prevThreeMonths) {
      currentTitle = 'Current (MTD)';
      baseTitle = '3-month average';
      currentRangeLabel = mtdVsPrevMonth
        ? formatRangeLabel(mtdVsPrevMonth.current)
        : currentRangeLabel;
      baseRangeLabel = `${formatRangeLabel(prevThreeMonths)} ÷ ${TRAILING_AVG_MONTHS}`;
    }

    const rows: CompareBreakdownPopup['rows'] = [
      {
        label: currentTitle,
        sub: currentRangeLabel,
        value: formatCurrency(cur),
        tone: currentTone,
      },
      {
        label: baseTitle,
        sub: baseRangeLabel,
        value: formatCurrency(prev),
        tone: previousTone,
      },
    ];
    if (kind === 'vs_average') {
      rows.push({
        label: '3-mo total (approx)',
        sub: prevThreeMonths ? formatRangeLabel(prevThreeMonths) : undefined,
        value: formatCurrency(prev * TRAILING_AVG_MONTHS),
        tone: 'neutral',
      });
    }
    rows.push({
      label: 'Difference',
      value: formatSignedCurrency(diff),
      tone: resultTone,
    });
    rows.push({
      label: isNewExpense ? 'Status' : 'Index',
      value: isNewExpense ? 'NEW' : index == null ? 'N/A' : `${index.toFixed(1)}%`,
      tone: indexTone,
    });

    const absPrev = Math.abs(prev);
    const formulaSummary = unreliable
      ? isNewExpense
        ? [
            'No prior expenses in the compare window, so % change cannot be computed (would divide by ₱0).',
            `Shown as NEW: ${formatCurrency(cur)} this period vs ₱0 last period.`,
          ].join('\n')
        : [
            'Index % needs a previous baseline above ₱0.',
            'Previous period is ₱0 (or missing), so the % is hidden to avoid a fake 100% / infinity figure.',
          ].join('\n')
      : [
          `Index = Current ÷ Previous × 100`,
          `= ${formatCurrency(cur)} ÷ ${formatCurrency(absPrev)} × 100`,
          `≈ ${index!.toFixed(1)}%`,
        ].join('\n');

    setCompareBreakdownPopup({
      key,
      top,
      left,
      branchName,
      metricLabel,
      rows,
      formulaSummary,
      formulaIsNote: unreliable,
    });
  };

  /** Popup for % of Total Expenses / % of Sales cells. */
  const openExpensePctBreakdown = (
    e: React.MouseEvent<HTMLElement>,
    key: string,
    branchName: string,
    metricLabel: string,
    kind: 'expense_share' | 'expense_rate',
    numerator: number,
    denominator: number,
    resultPct: number,
    /** Per-branch amounts that sum to company/selected total (share only). */
    shareParts?: Array<{ name: string; amount: number }>,
    /** Label for numerator when kind is expense_rate (Expenses / Profit). */
    numeratorLabel?: string,
  ) => {
    e.stopPropagation();
    if (compareBreakdownPopup?.key === key) {
      setCompareBreakdownPopup(null);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const popupWidth = 360;
    const isShare = kind === 'expense_share';
    const parts = shareParts || [];
    const { top, left } = placeComparePopup(
      rect,
      popupWidth,
      isShare ? 180 + parts.length * 32 : 280,
    );

    const { selected } = compareWindowMeta;
    const rangeLabel = formatRangeLabel(selected);
    const num = Number(numerator) || 0;
    const den = Number(denominator) || 0;
    // Always derive % from amounts so Rate matches the formula (ignore stale/wrong resultPct).
    const pct = den >= 1 ? (num / den) * 100 : Number.isFinite(resultPct) ? resultPct : 0;
    const missingDenom = den < 1;

    const rows: CompareBreakdownPopup['rows'] = [];

    if (isShare) {
      // One list = how the total is built (no duplicate "Branch expenses" row).
      for (const part of parts) {
        const isFocus = part.name === branchName;
        rows.push({
          label: part.name,
          value: formatCurrency(part.amount),
          tone: isFocus ? 'up' : 'neutral',
        });
      }
      rows.push({
        label: 'Total',
        sub: `${parts.length} branches · ${rangeLabel}`,
        value: formatCurrency(den),
        tone: 'neutral',
      });
    } else {
      rows.push(
        {
          label: numeratorLabel || 'Expenses',
          sub: rangeLabel,
          value: formatCurrency(num),
          tone: 'neutral',
        },
        {
          label: 'Sales',
          value: formatCurrency(den),
          tone: 'neutral',
        },
      );
    }

    rows.push({
      label: isShare ? 'Share' : 'Rate',
      value: missingDenom ? '—' : `${pct.toFixed(1)}%`,
      tone: 'neutral',
    });

    const formulaSummary = missingDenom
      ? isShare
        ? 'Share unavailable — selected branches expense total is ₱0.'
        : 'Rate unavailable — branch sales are ₱0.'
      : isShare
        ? [
            `Share = Branch ÷ Total × 100`,
            `= ${formatCurrency(num)} ÷ ${formatCurrency(den)} × 100`,
            `≈ ${pct.toFixed(1)}%`,
          ].join('\n')
        : [
            `Rate = ${numeratorLabel || 'Expenses'} ÷ Sales × 100`,
            `= ${formatCurrency(num)} ÷ ${formatCurrency(den)} × 100`,
            `≈ ${pct.toFixed(1)}%`,
          ].join('\n');

    setCompareBreakdownPopup({
      key,
      top,
      left,
      branchName,
      metricLabel,
      rows,
      formulaSummary,
      formulaIsNote: missingDenom,
    });
  };

  const selectedCount = selectedCompareBranches.length;
  const compareStartDate = toDate(compareDateRange.start);
  const compareEndDate = toDate(compareDateRange.end);
  const comparePickerValue: [Date | null, Date | null] = [compareStartDate, compareEndDate];
  const compareDefaultMonth = getCurrentMonthRange();
  const isCompareDefaultMonth =
    compareDateRange.start === compareDefaultMonth.start &&
    compareDateRange.end === compareDefaultMonth.end;
  const comparePanelWidthClass =
    selectedCount <= 2 ? 'w-[75vw] max-w-5xl' : selectedCount <= 4 ? 'w-[85vw] max-w-6xl' : 'w-[95vw] max-w-[1800px]';
  const compareTitle =
    selectedCount <= 2
      ? selectedCompareBranches.map((branch) => branch.name).join(' vs ')
      : `${selectedCompareBranches.slice(0, 2).map((branch) => branch.name).join(' vs ')} +${selectedCount - 2} more`;

  const pickMetric = (
    maps: CompareMetricMaps,
    metric: keyof CompareMetricMaps,
  ): number[] => selectedCompareBranches.map((branch) => maps[metric][branch.id] ?? 0);

  const currentPeriodExpenses = selectedCompareBranches.map((branch) => {
    const branchMap = expenseCategoryByBranch[branch.id];
    const expensesFromBreakdown = branchMap
      ? Object.values(branchMap).reduce((sum, v) => sum + (Number(v) || 0), 0)
      : 0;
    return Math.max(expensesFromBreakdown, Number(branch.totalExpenses) || 0);
  });
  const currentPeriodSales = selectedCompareBranches.map((branch) => Number(branch.totalSales) || 0);
  const currentPeriodProfit = currentPeriodSales.map((sales, i) => sales - currentPeriodExpenses[i]);

  /**
   * Shared period windows for Sales / Expenses / Profit:
   * 1) 전월 동기 — same-period (3일 전 기준)
   * 2) 전월 대비 — MTD vs full prior month
   * 3) 평균 대비 — MTD vs trailing 3 full months ÷ 3
   * Cell shows previous amount + index % (same as Sales/Profit; expenses invert % colors).
   */
  const buildCompareMetricRows = (
    prefix: string,
    metric: 'sales' | 'expenses' | 'profit',
  ): ComparisonRow[] => {
    const isExpense = metric === 'expenses';
    return [
      {
        id: `${prefix}-vs-last-month-same-period`,
        label: COMPARE_METRIC_LABELS.vsSamePeriod,
        values: pickMetric(compareSamePeriodCurrent, metric),
        compareBases: pickMetric(compareSamePeriodPrev, metric),
        bestMode: isExpense ? 'min' : 'max',
        format: 'diff_index',
        amountSource: 'previous',
        invertSentiment: isExpense || undefined,
        breakdownKind: 'same_period',
      },
      {
        id: `${prefix}-vs-last-month`,
        label: COMPARE_METRIC_LABELS.vsLastMonth,
        values: pickMetric(compareLastMonthCurrent, metric),
        compareBases: pickMetric(compareLastMonthPrev, metric),
        bestMode: isExpense ? 'min' : 'max',
        format: 'diff_index',
        amountSource: 'previous',
        invertSentiment: isExpense || undefined,
        breakdownKind: 'vs_last_month',
      },
      {
        id: `${prefix}-vs-average`,
        label: COMPARE_METRIC_LABELS.vsAverage,
        values: pickMetric(compareLastMonthCurrent, metric),
        compareBases: pickMetric(compareThreeMonthAvg, metric),
        bestMode: isExpense ? 'min' : 'max',
        format: 'diff_index',
        amountSource: 'previous',
        invertSentiment: isExpense || undefined,
        breakdownKind: 'vs_average',
      },
    ];
  };

  const previousPeriodExpenses = pickMetric(compareLastMonthPrev, 'expenses');
  const companyExpenseTotal = currentPeriodExpenses.reduce((s, v) => s + (Number(v) || 0), 0);

  const expenseAnalyticsRows: ExpenseAnalyticsRow[] = (() => {
    const draft = selectedCompareBranches.map((branch, i) => {
      const current = Number(currentPeriodExpenses[i]) || 0;
      const previous = Number(previousPeriodExpenses[i]) || 0;
      const diff = Math.trunc(current - previous);
      const sharePct = companyExpenseTotal > 0 ? (current / companyExpenseTotal) * 100 : 0;
      const diffKind = resolveExpenseDiffKind(current, previous);
      const meaningfulPct =
        previous >= EXPENSE_PCT_MIN_PREVIOUS ? pctChange(current, previous) : null;
      return {
        branchId: branch.id,
        branchName: branch.name,
        current,
        previous,
        diff,
        sharePct,
        rank: 0,
        pctChange: meaningfulPct,
        diffKind,
      } satisfies ExpenseAnalyticsRow;
    });

    // Rank by current expense descending (1 = highest spender).
    const bySpend = [...draft].sort((a, b) => b.current - a.current);
    bySpend.forEach((row, idx) => {
      row.rank = idx + 1;
    });
    return draft.sort((a, b) => a.rank - b.rank);
  })();

  // Main Expenses: selected-period amounts ÷ that branch's total sales (매출액).
  const mainExpenseBreakdown = selectedCompareBranches.map((branch) => {
    const map = expenseCategoryByBranch[branch.id];
    const hasMap = Boolean(map && Object.keys(map).length > 0);
    const backendRent = Number(expenseRentByBranch[branch.id]) || 0;
    const backendSalary = Number(expenseSalaryByBranch[branch.id]) || 0;

    if (!hasMap) {
      return { food: 0, rent: backendRent, salary: backendSalary };
    }

    const buckets = sumMainExpenseBuckets(map);
    let food = buckets.food;
    let rent = buckets.rent;
    let salary = buckets.salary;
    let other = buckets.other;

    // Item-level rent via EXP_DESC (e.g. 가게월세 under Fixed Costs, "Shop Rental").
    // Category map misses those; backend getRentSalaryByBranch scans EXP_DESC.
    if (backendRent > rent) {
      const extraRent = backendRent - rent;
      rent = backendRent;
      // Pull extra rent out of the bucket where those rows were classified.
      // Fixed Costs / Indirect → other. Legacy: some rent sat under Food Supplies.
      if (other >= extraRent) {
        other -= extraRent;
      } else if (food >= extraRent) {
        food -= extraRent;
      } else {
        const fromOther = Math.min(other, extraRent);
        other -= fromOther;
        const rem = extraRent - fromOther;
        if (rem > 0) food = Math.max(0, food - rem);
      }
    }

    // Take richer salary (category map has DJ/PROMOTER/C.A.; backend may catch more).
    salary = Math.max(salary, backendSalary);

    return { food, rent, salary };
  });
  const mainFoodValues = mainExpenseBreakdown.map((b) => b.food);
  const mainRentValues = mainExpenseBreakdown.map((b) => b.rent);
  const mainSalaryValues = mainExpenseBreakdown.map((b) => b.salary);
  // Remainder after food + rent + salary within selected-period total expenses.
  const mainOthersValues = currentPeriodExpenses.map((total, i) => {
    const remaining = total - mainFoodValues[i] - mainRentValues[i] - mainSalaryValues[i];
    return remaining > 0 ? remaining : 0;
  });

  /** % of branch total sales (매출액). */
  const withSalesShare = (): Pick<ComparisonRow, 'format' | 'compareBases'> => ({
    format: 'currency_share',
    compareBases: currentPeriodSales,
  });

  // Align BI rows to comparison column order (selectedCompareBranches).
  const expenseByBranchId = new Map(
    expenseAnalyticsRows.map((row) => [row.branchId, row] as const),
  );
  const expenseOrdered = selectedCompareBranches.map(
    (branch) =>
      expenseByBranchId.get(branch.id) ?? {
        branchId: branch.id,
        branchName: branch.name,
        current: 0,
        previous: 0,
        diff: 0,
        sharePct: 0,
        rank: selectedCompareBranches.length,
        pctChange: null,
        diffKind: 'na' as const,
      },
  );

  const expenseRateValues = selectedCompareBranches.map((_, i) => {
    const sales = Number(currentPeriodSales[i]) || 0;
    const expenses = Number(currentPeriodExpenses[i]) || 0;
    if (sales < 1) return 0;
    return (expenses / sales) * 100;
  });

  /** Net profit ÷ branch sales (margin %). */
  const profitRateValues = selectedCompareBranches.map((_, i) => {
    const sales = Number(currentPeriodSales[i]) || 0;
    const profit = Number(currentPeriodProfit[i]) || 0;
    if (sales < 1) return 0;
    return (profit / sales) * 100;
  });

  // Expenses % and Profit % = share of that branch's total sales.
  const benchmarkRows: ComparisonRow[] = [
    {
      id: 'totalSales',
      label: COMPARE_METRIC_LABELS.totalSales,
      values: currentPeriodSales,
      bestMode: 'max' as const,
    },
    {
      id: 'totalExpenses',
      label: COMPARE_METRIC_LABELS.totalExpenses,
      values: currentPeriodExpenses,
      bestMode: 'min' as const,
      format: 'currency_pct',
      compareBases: expenseRateValues,
      pctBreakdown: 'expense_rate',
    },
    {
      id: 'totalRevenue',
      label: COMPARE_METRIC_LABELS.totalProfit,
      values: currentPeriodProfit,
      bestMode: 'max' as const,
      format: 'currency_pct',
      compareBases: profitRateValues,
      pctBreakdown: 'expense_rate',
    },
  ];

  // Match Sales: same-period, vs last month, vs average (share/rate live on totals above).
  const withStackedIndex = (rows: ComparisonRow[]): ComparisonRow[] =>
    rows.map((row) => ({ ...row, format: 'diff_index_stack' as const }));

  const expenseMetricRows = withStackedIndex(buildCompareMetricRows('expense', 'expenses'));

  // Totals → Sales → Expenses → Profit → Main Expenses composition.
  const unifiedComparisonRows: UnifiedComparisonRow[] = [
    ...benchmarkRows,
    { id: 'section-sales', rowType: 'section', label: t('admin_dashboard.sections.sales') },
    ...withStackedIndex(buildCompareMetricRows('sales', 'sales')),
    {
      id: 'section-expenses',
      rowType: 'section',
      label: t('admin_dashboard.sections.expenses'),
    },
    ...expenseMetricRows,
    { id: 'section-profit', rowType: 'section', label: t('admin_dashboard.sections.profit') },
    ...withStackedIndex(buildCompareMetricRows('profit', 'profit')),
    { id: 'section-main-expenses', rowType: 'section', label: t('admin_dashboard.sections.main_expenses') },
    {
      id: 'main-food-supplies',
      label: COMPARE_METRIC_LABELS.foodSupplies,
      values: mainFoodValues,
      bestMode: 'min',
      ...withSalesShare(),
    },
    {
      id: 'main-rent',
      label: COMPARE_METRIC_LABELS.rent,
      values: mainRentValues,
      bestMode: 'min',
      ...withSalesShare(),
    },
    {
      id: 'main-salary',
      label: COMPARE_METRIC_LABELS.salary,
      values: mainSalaryValues,
      bestMode: 'min',
      ...withSalesShare(),
    },
    {
      id: 'main-others',
      label: COMPARE_METRIC_LABELS.others,
      values: mainOthersValues,
      bestMode: 'min',
      ...withSalesShare(),
    },
  ];

  const getEffectiveBranchTotalExpenses = (branch: BranchPerformanceData): number => {
    const branchMap = expenseCategoryByBranch[branch.id];
    if (!branchMap) return branch.totalExpenses;
    const fromBreakdown = Object.values(branchMap).reduce((sum, v) => sum + (Number(v) || 0), 0);
    return Math.max(fromBreakdown, Number(branch.totalExpenses) || 0);
  };

  const handleCompareDateRangeChange = (
    update: [Date | null, Date | null] | null,
    options?: { closeOnComplete?: boolean },
  ) => {
    const [s, e] = update ?? [null, null];
    const manilaToday = getManilaTodayYmd();
    let start = s ? toYYYYMMDD(s) : '';
    let end = e ? toYYYYMMDD(e) : '';
    if (end && end > manilaToday) end = manilaToday;
    if (start && end && start > end) start = end;
    const nextRange = { start, end };
    const closeOnComplete = options?.closeOnComplete ?? true;
    if (closeOnComplete && s && e) setIsCompareDateOpen(false);

    // Same month clicked twice (or same range re-selected) — do not flip the
    // skeleton on. The fetch effect only re-runs when start/end strings change,
    // so loading would otherwise stay true forever.
    if (start === compareDateRange.start && end === compareDateRange.end) return;

    // Show comparison skeleton as soon as a full range is picked so values don't
    // flash stale numbers while prior-period bundles reload.
    if (isComparePanelOpen && nextRange.start && nextRange.end) {
      setIsComparePanelLoading(true);
    }
    setCompareDateRange(nextRange);
    onDateRangeChange(nextRange);
  };

  const resetCompareDateRangeToDefaultMonth = () => {
    const def = getCurrentMonthRange();
    handleCompareDateRangeChange([toDate(def.start), toDate(def.end)], { closeOnComplete: true });
  };

  const trendAnchorDate = useMemo(() => {
    // For weekly, the chart is rotated so that the "anchor" day is rightmost.
    // Use same fallback order as the rotation logic.
    return (
      (compareDateRange.end ? new Date(compareDateRange.end) : null) ??
      (compareDateRange.start ? new Date(compareDateRange.start) : null) ??
      new Date()
    );
  }, [compareDateRange.end, compareDateRange.start]);

  const trendFallbackYear = useMemo(() => {
    const base = (compareDateRange.start ? new Date(compareDateRange.start) : null) ?? trendAnchorDate;
    return base.getFullYear();
  }, [compareDateRange.start, trendAnchorDate]);

  const trendRangeStart = useMemo(() => (compareDateRange.start ? new Date(`${compareDateRange.start}T00:00:00`) : null), [
    compareDateRange.start,
  ]);
  const trendRangeEnd = useMemo(() => (compareDateRange.end ? new Date(`${compareDateRange.end}T23:59:59`) : null), [
    compareDateRange.end,
  ]);

  const TrendXAxisTick = useMemo(() => {
    // Recharts tick renderer. Returns SVG nodes.
    const Tick = (props: any) => {
      const { x, y, payload } = props ?? {};
      const label = normalizeTickLabel(payload?.value);

      let jsDay: number | null = null;
      let showMarker = false;

      // Weekly labels: "Mon".."Sun" (or "Today").
      const abbr = label.slice(0, 3);
      if (label === 'Today') {
        jsDay = trendAnchorDate.getDay();
        showMarker = true;
      } else if (WEEKDAY_ABBR_TO_JS_DAY[abbr] != null) {
        jsDay = WEEKDAY_ABBR_TO_JS_DAY[abbr]!;
        showMarker = true;
      } else {
        // Monthly/yearly labels vary by backend. Only color when we can confidently
        // interpret the label as an actual day on the calendar.
        let parsed: Date | null = null;

        // Day-of-month only (e.g. "1", "12", "31") → use anchor month/year.
        if (/^\d{1,2}$/.test(label)) {
          const dayOfMonth = Number(label);
          if (dayOfMonth >= 1 && dayOfMonth <= 31) {
            parsed = new Date(
              trendAnchorDate.getFullYear(),
              trendAnchorDate.getMonth(),
              dayOfMonth,
              12,
              0,
              0,
            );
          }
        } else if (
          // Likely date strings: ISO, has comma year, or "MonName day" formats
          /^\d{4}-\d{2}-\d{2}$/.test(label) ||
          /,\s*\d{4}\s*$/.test(label) ||
          /[A-Za-z]{3,}\s+\d{1,2}/.test(label)
        ) {
          parsed = parseDateFromTickLabel(label, trendFallbackYear);
        }

        // If we have a selected range, require parsed date to fall inside it to avoid
        // accidentally coloring month labels like "Jan", "Feb", etc.
        if (parsed && trendRangeStart && parsed < trendRangeStart) parsed = null;
        if (parsed && trendRangeEnd && parsed > trendRangeEnd) parsed = null;

        if (parsed) jsDay = parsed.getDay();
      }

      const weekend = jsDay == null ? null : weekendStyleForDay(jsDay);
      const fill = weekend?.fill ?? '#94a3b8';
      // Weekly: always show a dot marker. Color follows the same fill.
      const marker = showMarker ? '●' : '';

      return (
        <g transform={`translate(${x},${y})`}>
          <text x={0} y={0} dy={16} textAnchor="middle" fill={fill} fontSize={12} fontWeight={weekend ? 800 : 500}>
            {marker ? `${marker} ${label}` : label}
          </text>
        </g>
      );
    };

    return Tick;
  }, [trendAnchorDate, trendFallbackYear, trendRangeEnd, trendRangeStart]);

  const TrendTooltipContent = useMemo(() => {
    const Content = (props: any) => {
      const { active, payload, label } = props ?? {};
      if (!active || !payload || payload.length === 0) return null;

      const labelRaw = normalizeTickLabel(label);
      const dataPoint = payload?.[0]?.payload as (MonthlyData & {
        rawTotalSales?: number;
        rawTotalExpenses?: number;
      }) | undefined;

      const parseIso = (iso: string): Date | null => {
        if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
        const d = new Date(`${iso}T12:00:00`);
        return Number.isNaN(d.getTime()) ? null : d;
      };

      let labelText = labelRaw;
      let labelJsDay: number | null = null;

      if (trendPeriod === 'yearly') {
        labelText = labelRaw;
        labelJsDay = null;
      } else if (trendPeriod === 'weekly') {
        const iso = dataPoint?.date;
        const d = iso ? parseIso(iso) : null;
        if (d) {
          labelJsDay = d.getDay();
          labelText = `${d.getDate()} - ${weekdayAbbrFromJsDay(labelJsDay)}`;
        } else {
          // Fallback: if no date, keep label.
          labelText = labelRaw;
        }
      } else {
        // Monthly
        let parsed: Date | null = null;
        if (/^\d{1,2}$/.test(labelRaw)) {
          const dayOfMonth = Number(labelRaw);
          if (dayOfMonth >= 1 && dayOfMonth <= 31) {
            parsed = new Date(trendAnchorDate.getFullYear(), trendAnchorDate.getMonth(), dayOfMonth, 12, 0, 0);
          }
        } else {
          parsed = parseDateFromTickLabel(labelRaw, trendFallbackYear);
        }

        if (parsed && !Number.isNaN(parsed.getTime())) {
          if (trendRangeStart && parsed < trendRangeStart) parsed = null;
          else if (trendRangeEnd && parsed > trendRangeEnd) parsed = null;
        }

        if (parsed) {
          labelJsDay = parsed.getDay();
          labelText = `${parsed.getDate()} - ${weekdayAbbrFromJsDay(labelJsDay)}`;
        } else {
          labelText = labelRaw;
        }
      }

      const weekend = labelJsDay == null ? null : weekendStyleForDay(labelJsDay);
      const labelStyle: { color?: string; fontWeight?: number } =
        weekend && trendPeriod !== 'yearly' ? { color: weekend.fill, fontWeight: 800 } : {};

      const getName = (dataKey: string) => {
        if (dataKey === 'totalSales') return t('admin_dashboard.total_sales');
        if (dataKey === 'negativeExpenses') return t('admin_dashboard.total_expenses');
        return dataKey;
      };

      const formatMoney = (v: any) =>
        `₱${Math.trunc(Math.abs(Number(v) || 0)).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

      // Always show both series — Recharts omits zero/null bars from payload.
      const tooltipItems = [
        { dataKey: 'totalSales', color: 'rgb(139, 92, 246)', raw: Number(dataPoint?.rawTotalSales ?? 0) },
        { dataKey: 'negativeExpenses', color: 'rgb(245, 158, 11)', raw: Number(dataPoint?.rawTotalExpenses ?? 0) },
      ];
      const profit = Math.trunc(tooltipItems[0].raw) - Math.trunc(tooltipItems[1].raw);

      return (
        <div
          style={{
            background: '#fff',
            borderRadius: '12px',
            border: 'none',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            padding: '10px 12px',
          }}
        >
          <div style={{ marginBottom: 8, ...labelStyle, fontSize: 12 }}>
            {labelText}
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {tooltipItems.map((item, idx) => (
              <div key={`${item.dataKey}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: 9999, background: item.color, display: 'inline-block' }} />
                <span style={{ fontSize: 12, color: '#475569', minWidth: 86 }}>{getName(item.dataKey)}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>{formatMoney(item.raw)}</span>
              </div>
            ))}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                borderTop: '1px solid #e2e8f0',
                paddingTop: 6,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 9999, background: 'rgb(34, 197, 94)', display: 'inline-block' }} />
              <span style={{ fontSize: 12, color: '#475569', minWidth: 86 }}>Total Profit</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: profit < 0 ? '#dc2626' : '#0f172a' }}>
                {profit < 0 ? '-' : ''}{formatMoney(profit)}
              </span>
            </div>
          </div>
        </div>
      );
    };

    return Content;
  }, [t, trendAnchorDate, trendFallbackYear, trendPeriod, trendRangeEnd, trendRangeStart]);

  const hasNonZeroTrendData = useMemo(() => hasNonZeroTrendRows(monthlyData), [monthlyData]);

  const trendYScale = useMemo(() => {
    const sales = monthlyData.map((d) => clampFiniteNonNegative(d.totalSales));
    const expenses = monthlyData.map((d) => clampFiniteNonNegative(d.totalExpenses));
    return buildTrendYScale(sales, expenses);
  }, [monthlyData]);

  const trendYTicks = useMemo(() => buildTrendYTicks(), []);

  const TrendYAxisTick = useMemo(() => {
    const SALES_COLOR = 'rgb(139, 92, 246)';
    const EXPENSE_COLOR = 'rgb(245, 158, 11)';
    const Tick = (props: any) => {
      const { x = 0, y = 0, payload } = props ?? {};
      const chartValue = Number(payload?.value);
      if (!Number.isFinite(chartValue)) return null;

      const text = formatTrendYAxisTick(chartValue, trendYScale);
      const fill =
        chartValue > 0 ? SALES_COLOR : chartValue < 0 ? EXPENSE_COLOR : '#94a3b8';

      return (
        <g transform={`translate(${Number(x)},${Number(y)})`}>
          <text
            x={0}
            y={0}
            dy={4}
            textAnchor="end"
            fill={fill}
            fontSize={12}
            fontWeight={chartValue !== 0 ? 600 : 500}
          >
            {text}
          </text>
        </g>
      );
    };
    return Tick;
  }, [trendYScale]);

  const trendChartData = useMemo(() => {
    const { salesMax } = trendYScale;
    return monthlyData.map((d) => {
      const rawSales = clampFiniteNonNegative(d.totalSales);
      const rawExpenses = clampFiniteNonNegative(d.totalExpenses);
      return {
        ...d,
        totalSales: toTrendChartSales(rawSales, salesMax),
        negativeExpenses: toTrendChartExpense(rawExpenses, trendYScale),
        rawTotalSales: rawSales,
        rawTotalExpenses: rawExpenses,
      };
    });
  }, [monthlyData, trendYScale]);

  const dailyAverageSales = useMemo(() => {
    if (!summaryData) return null;
    const startDate = toDate(compareDateRange.start);
    const endDate = toDate(compareDateRange.end);
    if (!startDate || !endDate) return null;
    const dayCount = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1);
    return summaryData.totalSales / dayCount;
  }, [summaryData, compareDateRange.start, compareDateRange.end]);

  const closeTrendDrill = useCallback(() => {
    trendDrillReqIdRef.current += 1;
    setTrendDrillOpen(false);
    setTrendDrillStep('branches');
    setTrendDrillBranch(null);
    setTrendDrillBranches([]);
    setTrendDrillChartTotal(null);
    setTrendDrillSalesRows([]);
    setTrendDrillSalesRecon(0);
    setTrendDrillExpenseGroups([]);
    setTrendDrillAllowBranchNav(true);
    setTrendDrillExpenseSub(null);
    setTrendDrillExpenseItems([]);
    setTrendDrillExpenseItemsLoading(false);
    setTrendDrillCalendarOpen(false);
  }, []);

  const openTrendDrillBranches = useCallback(
    async (
      metric: TrendDrillMetric,
      point: { name?: string; date?: string },
      chartTotal: number,
      explicit?: { range: DateRange; label: string },
    ) => {
      const resolved =
        explicit ??
        resolveTrendBarDateRange(point, trendPeriod, trendAnchorDate, trendFallbackYear);
      if (!resolved) return;

      const reqId = ++trendDrillReqIdRef.current;
      const targetTotal = Number.isFinite(chartTotal) ? Math.max(0, chartTotal) : 0;
      const cacheKey = `${metric}|${resolved.range.start}|${resolved.range.end}`;
      const cachedRows = trendDrillBranchesCacheRef.current.get(cacheKey);

      setTrendDrillMetric(metric);
      setTrendDrillRange(resolved.range);
      setTrendDrillLabel(resolved.label);
      setTrendDrillChartTotal(targetTotal > 0 ? targetTotal : null);
      setTrendDrillAllowBranchNav(true);
      setTrendDrillStep('branches');
      setTrendDrillBranch(null);
      setTrendDrillSalesRows([]);
      setTrendDrillSalesRecon(0);
      setTrendDrillExpenseGroups([]);
      setTrendDrillExpenseSub(null);
      setTrendDrillExpenseItems([]);
      setTrendDrillOpen(true);

      if (cachedRows) {
        setTrendDrillBranches(cachedRows);
        setTrendDrillBranchesLoading(false);
        if (targetTotal > 0) setTrendDrillChartTotal(targetTotal);
        return;
      }

      setTrendDrillBranches([]);
      setTrendDrillBranchesLoading(true);

      try {
        // drill = branch-sales + expense totals only (skips full expense-breakdown).
        const bundle = await fetchAdminDashboardBundleApi({
          start: resolved.range.start,
          end: resolved.range.end,
          branchId: 'all',
          mode: 'drill',
        });
        if (reqId !== trendDrillReqIdRef.current) return;

        // Sales drill uses gross POS (Total Sales) — same basis as the performance-trend bar.
        // Expenses use branch-card totals. Exclusions (3Core) roll into "Other branches".
        const mapped = (bundle.branchCardsData || [])
          .filter((b) => b)
          .map((b) => {
            const grossRaw = b.reportSalesGross;
            const gross = Number(grossRaw);
            const salesAmount =
              grossRaw != null && Number.isFinite(gross)
                ? gross
                : Number(b.totalSales) || 0;
            return {
              id: Number(b.id),
              name: String(b.name || `Branch ${b.id}`),
              amount: metric === 'sales' ? salesAmount : Number(b.totalExpenses) || 0,
              residual: false as boolean | undefined,
            };
          });

        const visibleRows = mapped
          .filter((b) => !isExcludedFromAllBranchesView(b.name) && b.amount > 0)
          .sort((a, b) => b.amount - a.amount);

        const excludedSum = mapped
          .filter((b) => isExcludedFromAllBranchesView(b.name))
          .reduce((sum, b) => sum + (Number(b.amount) || 0), 0);

        const rows = [...visibleRows];
        if (Math.abs(excludedSum) >= 0.5) {
          rows.push({
            id: -1,
            name: 'Other branches',
            amount: excludedSum,
            residual: true,
          });
        }

        const listTotal =
          visibleRows.reduce((sum, b) => sum + b.amount, 0) + excludedSum;
        trendDrillBranchesCacheRef.current.set(cacheKey, rows);
        setTrendDrillBranches(rows);
        // Prefer chart bar total when present so footer matches the graph tooltip.
        if (targetTotal > 0) {
          setTrendDrillChartTotal(targetTotal);
        } else if (listTotal > 0) {
          setTrendDrillChartTotal(listTotal);
        } else {
          setTrendDrillChartTotal(null);
        }
      } catch (err) {
        console.error('Failed to load trend drill branch totals:', err);
        if (reqId !== trendDrillReqIdRef.current) return;
        setTrendDrillBranches([]);
      } finally {
        if (reqId === trendDrillReqIdRef.current) setTrendDrillBranchesLoading(false);
      }
    },
    [trendAnchorDate, trendFallbackYear, trendPeriod],
  );

  const openTrendDrillBreakdown = useCallback(
    async (
      branch: { id: number; name: string; residual?: boolean },
      opts?: {
        range?: DateRange;
        metric?: TrendDrillMetric;
        label?: string;
        chartTotal?: number;
        allowBranchNav?: boolean;
      },
    ) => {
      if (branch.residual || branch.id < 0) return;
      const range = opts?.range ?? trendDrillRange;
      const metric = opts?.metric ?? trendDrillMetric;
      const { start, end } = range;
      if (!start || !end) return;

      const reqId = ++trendDrillReqIdRef.current;
      const cacheKey = `${metric}|${branch.id}|${start}|${end}`;
      const cached = trendDrillBreakdownCacheRef.current.get(cacheKey);

      if (opts?.metric) setTrendDrillMetric(opts.metric);
      if (opts?.range) setTrendDrillRange(opts.range);
      if (opts?.label) setTrendDrillLabel(opts.label);
      if (opts?.chartTotal != null && opts.chartTotal > 0) setTrendDrillChartTotal(opts.chartTotal);
      if (opts?.allowBranchNav != null) setTrendDrillAllowBranchNav(opts.allowBranchNav);
      setTrendDrillBranch(branch);
      setTrendDrillStep('breakdown');
      setTrendDrillOpen(true);

      if (cached) {
        setTrendDrillSalesRows(cached.salesRows);
        setTrendDrillSalesRecon(cached.salesRecon);
        setTrendDrillExpenseGroups(cached.expenseGroups);
        setTrendDrillBreakdownLoading(false);
        return;
      }

      setTrendDrillBreakdownLoading(true);
      setTrendDrillSalesRows([]);
      setTrendDrillSalesRecon(0);
      setTrendDrillExpenseGroups([]);

      try {
        if (metric === 'sales') {
          const params = new URLSearchParams();
          params.set('start_date', start);
          params.set('end_date', end);
          params.set('limit', '50');
          params.set('branch_id', String(branch.id));
          const [rows, recon] = await Promise.all([
            fetchTopSellingApi(params),
            fetchCashReconciliationAggregates({
              start,
              end,
              branchId: String(branch.id),
            }).catch(() => ({ total: 0, byDate: {} as Record<string, number> })),
          ]);
          if (reqId !== trendDrillReqIdRef.current) return;
          const salesRows = Array.isArray(rows) ? rows : [];
          const dayKey = start === end ? start : '';
          const fromMap = dayKey ? Number(recon.byDate?.[dayKey] ?? 0) : 0;
          const reconAmt = fromMap || Number(recon.total ?? 0);
          const salesRecon = Number.isFinite(reconAmt) ? Math.max(0, reconAmt) : 0;
          trendDrillBreakdownCacheRef.current.set(cacheKey, {
            salesRows,
            salesRecon,
            expenseGroups: [],
          });
          setTrendDrillSalesRows(salesRows);
          setTrendDrillSalesRecon(salesRecon);
        } else {
          const params = new URLSearchParams();
          params.set('start_date', start);
          params.set('end_date', end);
          params.set('branch_id', String(branch.id));
          const rows = await fetchExpenseCategoryBreakdownApi(params);
          if (reqId !== trendDrillReqIdRef.current) return;
          const groups = groupExpenseBreakdownForBranch(Array.isArray(rows) ? rows : [], branch.id);
          trendDrillBreakdownCacheRef.current.set(cacheKey, {
            salesRows: [],
            salesRecon: 0,
            expenseGroups: groups,
          });
          setTrendDrillExpenseGroups(groups);
        }
      } catch (err) {
        console.error('Failed to load trend drill breakdown:', err);
        if (reqId !== trendDrillReqIdRef.current) return;
        setTrendDrillSalesRows([]);
        setTrendDrillSalesRecon(0);
        setTrendDrillExpenseGroups([]);
      } finally {
        if (reqId === trendDrillReqIdRef.current) setTrendDrillBreakdownLoading(false);
      }
    },
    [trendDrillMetric, trendDrillRange],
  );

  const openTrendDrillExpenseItems = useCallback(
    async (
      sub: { main: string; name: string; amount: number },
      opts?: { range?: DateRange; label?: string },
    ) => {
      if (!trendDrillBranch || trendDrillBranch.id <= 0) return;
      const range = opts?.range ?? trendDrillRange;
      const { start, end } = range;
      if (!start || !end) return;

      const reqId = ++trendDrillReqIdRef.current;
      if (opts?.range) setTrendDrillRange(opts.range);
      if (opts?.label) setTrendDrillLabel(opts.label);
      setTrendDrillExpenseSub(sub);
      // Keep parent categories modal open; items open in a nested popup.
      setTrendDrillExpenseItemsLoading(true);
      setTrendDrillExpenseItems([]);

      try {
        const listKey = `${trendDrillBranch.id}|${start}|${end}`;
        let rows = trendDrillExpensesListCacheRef.current.get(listKey);
        if (!rows) {
          rows = await getExpenses(String(trendDrillBranch.id), {
            startDate: start,
            endDate: end,
          });
          if (reqId !== trendDrillReqIdRef.current) return;
          const list = Array.isArray(rows) ? rows : [];
          trendDrillExpensesListCacheRef.current.set(listKey, list);
          rows = list;
        } else if (reqId !== trendDrillReqIdRef.current) {
          return;
        }
        const mainKey = sub.main.trim();
        const subKey = sub.name.trim();
        const matched = rows
          .filter((exp) => {
            if ((Number(exp.expAmount) || 0) <= 0) return false;
            if ((exp.expCat || '').trim() !== mainKey) return false;
            return (exp.expName || '').trim() === subKey;
          })
          .sort((a, b) => {
            const ad = String(a.encodedDt || '');
            const bd = String(b.encodedDt || '');
            return bd.localeCompare(ad);
          });
        setTrendDrillExpenseItems(matched);
      } catch (err) {
        console.error('Failed to load expense item breakdown:', err);
        if (reqId !== trendDrillReqIdRef.current) return;
        setTrendDrillExpenseItems([]);
      } finally {
        if (reqId === trendDrillReqIdRef.current) setTrendDrillExpenseItemsLoading(false);
      }
    },
    [trendDrillBranch, trendDrillRange],
  );

  const closeTrendDrillExpenseItems = useCallback(() => {
    setTrendDrillExpenseSub(null);
    setTrendDrillExpenseItems([]);
    setTrendDrillExpenseItemsLoading(false);
  }, []);

  const handleTrendBarClick = useCallback(
    (metric: TrendDrillMetric, data: any) => {
      const payload = (data?.payload ?? data) as
        | {
            name?: string;
            date?: string;
            rawTotalSales?: number;
            rawTotalExpenses?: number;
          }
        | undefined;
      if (!payload) return;
      const chartTotal =
        metric === 'sales'
          ? Number(payload.rawTotalSales ?? 0)
          : Number(payload.rawTotalExpenses ?? 0);

      // Focused branch → skip branch list, open that branch's breakdown.
      if (activeBranchId != null) {
        const resolved = resolveTrendBarDateRange(
          payload,
          trendPeriod,
          trendAnchorDate,
          trendFallbackYear,
        );
        if (!resolved) return;
        const branchName =
          branchCardsData.find((b) => b.id === activeBranchId)?.name ??
          focusedBranchName ??
          `Branch ${activeBranchId}`;
        void openTrendDrillBreakdown(
          { id: activeBranchId, name: branchName },
          {
            range: resolved.range,
            metric,
            label: resolved.label,
            chartTotal,
            allowBranchNav: false,
          },
        );
        return;
      }

      void openTrendDrillBranches(metric, payload, chartTotal);
    },
    [
      activeBranchId,
      branchCardsData,
      focusedBranchName,
      openTrendDrillBranches,
      openTrendDrillBreakdown,
      trendAnchorDate,
      trendFallbackYear,
      trendPeriod,
    ],
  );

  const lookupTrendChartTotalForRange = useCallback(
    (range: DateRange, metric: TrendDrillMetric): number => {
      const { start, end } = range;
      if (!start || !end) return 0;

      if (start === end) {
        const day = Number(start.slice(8, 10));
        const point = monthlyData.find((d) => {
          if (d.date && String(d.date).slice(0, 10) === start) return true;
          if (trendPeriod === 'monthly' && Number(d.name) === day) return true;
          return false;
        });
        if (!point) return 0;
        return metric === 'sales' ? Number(point.totalSales) || 0 : Number(point.totalExpenses) || 0;
      }

      // Month bucket (yearly): match by month index / label
      const startD = parseLocalYmd(start);
      if (!startD) return 0;
      const monthIdx = startD.getMonth();
      const point =
        monthlyData[monthIdx] ??
        monthlyData.find((d) => {
          const key = String(d.name || '')
            .toLowerCase()
            .replace(/\./g, '')
            .trim();
          return MONTH_LABEL_TO_INDEX[key] === monthIdx || MONTH_LABEL_TO_INDEX[key.slice(0, 3)] === monthIdx;
        });
      if (!point) return 0;
      return metric === 'sales' ? Number(point.totalSales) || 0 : Number(point.totalExpenses) || 0;
    },
    [monthlyData, trendPeriod],
  );

  const trendDrillCanShiftDate = useMemo(() => {
    const { start, end } = trendDrillRange;
    if (!start || !end) return { prev: false, next: false };
    const boundStart = compareDateRange.start || '';
    const boundEnd = compareDateRange.end || '';

    if (start === end) {
      const d = parseLocalYmd(start);
      if (!d) return { prev: false, next: false };
      const prevYmd = toYYYYMMDD(addDaysLocal(d, -1));
      const nextYmd = toYYYYMMDD(addDaysLocal(d, 1));
      return {
        prev: !boundStart || prevYmd >= boundStart,
        next: !boundEnd || nextYmd <= boundEnd,
      };
    }

    // Month range (yearly)
    const s = parseLocalYmd(start);
    if (!s) return { prev: false, next: false };
    const prevMonthEnd = toYYYYMMDD(new Date(s.getFullYear(), s.getMonth(), 0));
    const nextMonthStart = toYYYYMMDD(new Date(s.getFullYear(), s.getMonth() + 1, 1));
    return {
      prev: !boundStart || prevMonthEnd >= boundStart,
      next: !boundEnd || nextMonthStart <= boundEnd,
    };
  }, [compareDateRange.end, compareDateRange.start, trendDrillRange]);

  const applyTrendDrillDateRange = useCallback(
    (nextRange: DateRange, nextLabel: string) => {
      if (!nextRange.start || !nextRange.end) return;
      const chartTotal = lookupTrendChartTotalForRange(nextRange, trendDrillMetric);
      setTrendDrillCalendarOpen(false);

      // Refresh nested expense-items popup if open, and parent category view.
      if (trendDrillExpenseSub && trendDrillBranch && trendDrillBranch.id > 0) {
        setTrendDrillRange(nextRange);
        setTrendDrillLabel(nextLabel);
        setTrendDrillChartTotal(chartTotal > 0 ? chartTotal : null);
        void openTrendDrillBreakdown(trendDrillBranch, {
          range: nextRange,
          metric: trendDrillMetric,
          label: nextLabel,
          chartTotal,
          allowBranchNav: trendDrillAllowBranchNav,
        });
        void openTrendDrillExpenseItems(trendDrillExpenseSub, {
          range: nextRange,
          label: nextLabel,
        });
        return;
      }

      // Stay on branch breakdown when already drilled into a branch.
      if (trendDrillStep === 'breakdown' && trendDrillBranch && trendDrillBranch.id > 0) {
        void openTrendDrillBreakdown(trendDrillBranch, {
          range: nextRange,
          metric: trendDrillMetric,
          label: nextLabel,
          chartTotal,
          allowBranchNav: trendDrillAllowBranchNav,
        });
        return;
      }

      void openTrendDrillBranches(trendDrillMetric, {}, chartTotal, {
        range: nextRange,
        label: nextLabel,
      });
    },
    [
      lookupTrendChartTotalForRange,
      openTrendDrillBranches,
      openTrendDrillBreakdown,
      openTrendDrillExpenseItems,
      trendDrillAllowBranchNav,
      trendDrillBranch,
      trendDrillExpenseSub,
      trendDrillMetric,
      trendDrillStep,
    ],
  );

  const navigateTrendDrillDate = useCallback(
    (delta: -1 | 1) => {
      const { start, end } = trendDrillRange;
      if (!start || !end) return;

      let nextRange: DateRange | null = null;
      let nextLabel = '';

      if (start === end) {
        const d = parseLocalYmd(start);
        if (!d) return;
        const shifted = addDaysLocal(d, delta);
        const ymd = toYYYYMMDD(shifted);
        if (compareDateRange.start && ymd < compareDateRange.start) return;
        if (compareDateRange.end && ymd > compareDateRange.end) return;
        nextRange = { start: ymd, end: ymd };
        nextLabel = formatYmdDisplay(ymd);
      } else {
        const s = parseLocalYmd(start);
        if (!s) return;
        const monthStart = new Date(s.getFullYear(), s.getMonth() + delta, 1);
        const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
        nextRange = { start: toYYYYMMDD(monthStart), end: toYYYYMMDD(monthEnd) };
        if (compareDateRange.start && nextRange.end < compareDateRange.start) return;
        if (compareDateRange.end && nextRange.start > compareDateRange.end) return;
        nextLabel = monthStart.toLocaleString(undefined, { month: 'short', year: 'numeric' });
      }

      if (!nextRange) return;
      applyTrendDrillDateRange(nextRange, nextLabel);
    },
    [applyTrendDrillDateRange, compareDateRange.end, compareDateRange.start, trendDrillRange],
  );

  const jumpTrendDrillToDay = useCallback(
    (day: Date | null) => {
      if (!day || Number.isNaN(day.getTime())) return;
      let ymd = toYYYYMMDD(day);
      if (compareDateRange.start && ymd < compareDateRange.start) ymd = compareDateRange.start;
      if (compareDateRange.end && ymd > compareDateRange.end) ymd = compareDateRange.end;
      applyTrendDrillDateRange({ start: ymd, end: ymd }, formatYmdDisplay(ymd));
    },
    [applyTrendDrillDateRange, compareDateRange.end, compareDateRange.start],
  );

  const trendDrillPickerDate = useMemo(() => {
    const key =
      trendDrillRange.start && trendDrillRange.end && trendDrillRange.start === trendDrillRange.end
        ? trendDrillRange.start
        : trendDrillRange.start || trendDrillRange.end;
    return key ? parseLocalYmd(key) : null;
  }, [trendDrillRange.end, trendDrillRange.start]);

  const trendDrillPickerMinDate = useMemo(
    () => (compareDateRange.start ? parseLocalYmd(compareDateRange.start) ?? undefined : undefined),
    [compareDateRange.start],
  );
  const trendDrillPickerMaxDate = useMemo(
    () => (compareDateRange.end ? parseLocalYmd(compareDateRange.end) ?? undefined : undefined),
    [compareDateRange.end],
  );

  const trendDrillBranchesTotal = useMemo(() => {
    if (trendDrillChartTotal != null && trendDrillChartTotal > 0) return trendDrillChartTotal;
    return trendDrillBranches.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
  }, [trendDrillBranches, trendDrillChartTotal]);

  const trendDrillSalesMenuTotal = useMemo(() => {
    const menuTotal = trendDrillSalesRows.reduce((sum, r) => sum + (Number(r.total_revenue) || 0), 0);
    return menuTotal + (Number(trendDrillSalesRecon) || 0);
  }, [trendDrillSalesRecon, trendDrillSalesRows]);

  /** Prefer clicked bar / branch total so footer matches the chart. */
  const trendDrillSalesTotal = useMemo(() => {
    if (trendDrillChartTotal != null && trendDrillChartTotal > 0) return trendDrillChartTotal;
    return trendDrillSalesMenuTotal;
  }, [trendDrillChartTotal, trendDrillSalesMenuTotal]);

  const trendDrillSalesOther = useMemo(() => {
    if (trendDrillChartTotal == null || trendDrillChartTotal <= 0) return 0;
    const gap = trendDrillChartTotal - trendDrillSalesMenuTotal;
    return Math.abs(gap) >= 0.5 ? gap : 0;
  }, [trendDrillChartTotal, trendDrillSalesMenuTotal]);

  const trendDrillExpenseGroupsTotal = useMemo(
    () => trendDrillExpenseGroups.reduce((sum, g) => sum + (Number(g.total) || 0), 0),
    [trendDrillExpenseGroups],
  );

  const trendDrillExpenseItemsTotal = useMemo(
    () => trendDrillExpenseItems.reduce((sum, r) => sum + (Number(r.expAmount) || 0), 0),
    [trendDrillExpenseItems],
  );

  const trendDrillExpenseTotal = useMemo(() => {
    if (trendDrillChartTotal != null && trendDrillChartTotal > 0 && trendDrillMetric === 'expenses') {
      return trendDrillChartTotal;
    }
    return trendDrillExpenseGroupsTotal;
  }, [trendDrillChartTotal, trendDrillExpenseGroupsTotal, trendDrillMetric]);

  const renderExpenseDiffCell = (current: number, previous: number) => {
    const cur = Number(current) || 0;
    const prev = Number(previous) || 0;
    const diff = Math.trunc(cur - prev);
    const kind = resolveExpenseDiffKind(cur, prev);

    // No prior-period baseline (₱0) — % would be fake / ∞, so mark NEW instead of a %.
    if (kind === 'new') {
      return (
        <span className="inline-flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold tabular-nums tracking-tight text-slate-700">
            {formatSignedCurrency(diff)}
          </span>
          <span
            className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700"
            title="No expenses in the previous compare window — % change is not shown (would divide by ₱0)."
          >
            {t('admin_dashboard.expense_diff.new')}
          </span>
        </span>
      );
    }
    if (kind === 'na') {
      return <span className="text-sm font-semibold text-slate-400">N/A</span>;
    }

    // Amount stays neutral (like Sales); only % + arrow carry sentiment color.
    const isUp = diff > 0;
    const isDown = diff < 0;
    const pctTone = isUp ? 'text-red-600' : isDown ? 'text-emerald-600' : 'text-slate-500';
    const abs = Math.abs(diff).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    const signed = isUp ? `+₱${abs}` : isDown ? `-₱${abs}` : `₱${abs}`;
    const changePct = !isUnreliableCompareBase(prev) ? pctChange(cur, prev) : null;

    return (
      <div className="flex items-center gap-2">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-black leading-none ${
            isUp
              ? 'bg-red-100 text-red-600'
              : isDown
                ? 'bg-emerald-100 text-emerald-600'
                : 'bg-slate-100 text-slate-500'
          }`}
          aria-hidden
        >
          {isUp ? '↑' : isDown ? '↓' : '·'}
        </span>
        <span className="text-sm font-bold tabular-nums tracking-tight text-slate-700">
          {signed}
          {changePct != null ? (
            <span className={`font-semibold ${pctTone}`}>
              {' '}
              ({changePct > 0 ? '+' : ''}
              {changePct.toFixed(1)}%)
            </span>
          ) : null}
        </span>
      </div>
    );
  };

  /** Compact % pill beside Total Expenses / Total Profit — green if ≥ peers' avg, else yellow. */
  const renderInlinePctBadge = (
    pct: number,
    kind: 'expense_share' | 'expense_rate',
    peers?: number[],
  ) => {
    const safe = Number.isFinite(pct) ? Math.max(0, pct) : 0;
    const isShare = kind === 'expense_share';

    let tone: string;
    if (!isShare && peers && peers.length > 0) {
      const valid = peers.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      const avg = valid.length > 0 ? valid.reduce((s, n) => s + n, 0) / valid.length : safe;
      tone =
        safe >= avg
          ? 'bg-emerald-100 text-emerald-700'
          : 'bg-amber-100 text-amber-700';
    } else if (isShare) {
      const isReview = safe >= EXPENSE_SHARE_REVIEW_PCT;
      const isElevated = safe >= EXPENSE_SHARE_REVIEW_PCT * 0.7;
      tone = isReview
        ? 'bg-red-100 text-red-700'
        : isElevated
          ? 'bg-indigo-100 text-indigo-700'
          : 'bg-slate-100 text-slate-700';
    } else {
      tone =
        safe >= EXPENSE_RATE_REVIEW_PCT
          ? 'bg-red-100 text-red-700'
          : safe >= EXPENSE_RATE_ELEVATED_PCT
            ? 'bg-amber-100 text-amber-700'
            : 'bg-emerald-100 text-emerald-700';
    }

    const title = isShare
      ? t('admin_dashboard.expense_table.share')
      : t('admin_dashboard.expense_table.of_sales');
    return (
      <span
        className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${tone}`}
        title={title}
      >
        {safe.toFixed(1)}%
      </span>
    );
  };

  const renderExpenseShareCell = (sharePct: number) => {
    const pct = Number.isFinite(sharePct) ? Math.max(0, sharePct) : 0;
    const clamped = Math.min(pct, 100);
    const isReview = pct >= EXPENSE_SHARE_REVIEW_PCT;
    const isElevated = pct >= EXPENSE_SHARE_REVIEW_PCT * 0.7;
    const barColor = isReview
      ? 'bg-gradient-to-r from-rose-500 to-red-500'
      : isElevated
        ? 'bg-gradient-to-r from-violet-500 to-indigo-500'
        : 'bg-gradient-to-r from-slate-400 to-slate-500';
    const pctColor = isReview
      ? 'text-red-700'
      : isElevated
        ? 'text-indigo-700'
        : 'text-slate-800';
    return (
      <div className="min-w-[7.5rem] space-y-2">
        <span className={`text-base font-bold tabular-nums tracking-tight ${pctColor}`}>
          {pct.toFixed(1)}%
        </span>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200/60">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ease-out ${barColor}`}
            style={{ width: `${clamped}%` }}
          />
        </div>
      </div>
    );
  };

  /** Expenses as % of branch sales — lower is better. */
  const renderExpenseRateCell = (ratePct: number) => {
    const pct = Number.isFinite(ratePct) ? Math.max(0, ratePct) : 0;
    const clamped = Math.min(pct, 100);
    const isReview = pct >= EXPENSE_RATE_REVIEW_PCT;
    const isElevated = pct >= EXPENSE_RATE_ELEVATED_PCT;
    const barColor = isReview
      ? 'bg-gradient-to-r from-rose-500 to-red-500'
      : isElevated
        ? 'bg-gradient-to-r from-amber-400 to-orange-500'
        : 'bg-gradient-to-r from-emerald-400 to-teal-500';
    const pctColor = isReview
      ? 'text-red-700'
      : isElevated
        ? 'text-amber-700'
        : 'text-emerald-700';
    return (
      <div className="min-w-[7.5rem] space-y-2">
        <span className={`text-base font-bold tabular-nums tracking-tight ${pctColor}`}>
          {pct.toFixed(1)}%
        </span>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200/60">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ease-out ${barColor}`}
            style={{ width: `${clamped}%` }}
          />
        </div>
      </div>
    );
  };

  const renderComparisonTable = (rows: UnifiedComparisonRow[]) => (
    <div className="min-w-[760px] rounded-2xl border border-brand-primary/15 bg-white shadow-sm">
      <div
        className="grid sticky top-0 z-40 bg-white border-b border-brand-primary/20"
        style={{ gridTemplateColumns: `280px repeat(${selectedCount}, minmax(180px, 1fr))` }}
      >
        <div className="px-5 py-4 flex items-center justify-center text-center text-base font-bold uppercase tracking-wide text-brand-primary border-r border-brand-primary/20">
          {t('admin_dashboard.comparison_metric')}
        </div>
        {selectedCompareBranches.map((branch) => {
          const logoUrl = resolveBranchLogoUrl(branchLogoById[branch.id]);
          const showLogo = Boolean(logoUrl) && !failedBranchLogoIds.has(branch.id);
          return (
            <div
              key={`head-${branch.id}`}
              className="px-3 py-3 border-l border-brand-primary/15 flex items-center justify-center gap-3 min-w-0 w-full"
            >
              <button
                type="button"
                title={branch.name}
                aria-label={branch.name}
                onClick={() => navigateToBranch(branch, { newWindow: true })}
                className="w-14 h-14 rounded-full bg-slate-100 border border-slate-200/80 overflow-hidden shrink-0 flex items-center justify-center cursor-pointer transition-transform hover:scale-105 hover:ring-2 hover:ring-brand-primary/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                {showLogo ? (
                  <img
                    src={logoUrl!}
                    alt=""
                    className="w-full h-full object-contain p-1"
                    onError={() =>
                      setFailedBranchLogoIds((prev) => {
                        const next = new Set(prev);
                        next.add(branch.id);
                        return next;
                      })
                    }
                  />
                ) : (
                  <span className="text-lg font-bold uppercase text-slate-400">
                    {String(branch.name || '?').trim().charAt(0) || '?'}
                  </span>
                )}
              </button>
              <p className="text-base font-bold text-slate-800 leading-tight break-words min-w-0">
                {branch.name}
              </p>
            </div>
          );
        })}
      </div>

      <div className="bg-white">
          {rows.map((row) => {
            if (isSectionRow(row)) {
              return (
                <div
                  key={row.id}
                  className="grid border-y border-indigo-200 bg-indigo-500/12"
                  style={{ gridTemplateColumns: `280px repeat(${selectedCount}, minmax(180px, 1fr))` }}
                >
                  <div
                    className="px-5 py-2.5 text-center text-base leading-none font-black uppercase tracking-[0.12em] text-indigo-900"
                    style={{
                      gridColumn: `1 / ${selectedCount + 2}`,
                      fontFamily: '"Arial Black", "Inter", "Segoe UI", sans-serif',
                    }}
                  >
                    {row.label}
                  </div>
                </div>
              );
            }

            const usesCompareBase =
              row.format === 'diff_index' ||
              row.format === 'diff_percent' ||
              row.format === 'diff_index_stack' ||
              row.format === 'expense_diff';
            const rankValues = usesCompareBase
              ? row.values.map((v, i) => {
                  const base = row.compareBases?.[i] ?? 0;
                  if (row.format === 'expense_diff') {
                    const kind = resolveExpenseDiffKind(v, base);
                    if (kind === 'na' || kind === 'new') {
                      return row.bestMode === 'min'
                        ? Number.POSITIVE_INFINITY
                        : Number.NEGATIVE_INFINITY;
                    }
                    return v - base;
                  }
                  // Unreliable baselines never win TOP.
                  if (isUnreliableCompareBase(base)) {
                    return row.bestMode === 'min' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
                  }
                  return pctChange(v, base);
                })
              : row.values;
            const reliableRankValues = usesCompareBase
              ? rankValues.filter((v) => Number.isFinite(v))
              : rankValues;
            const benchmarkValue =
              reliableRankValues.length === 0
                ? null
                : row.bestMode === 'max'
                  ? Math.max(...reliableRankValues)
                  : Math.min(...reliableRankValues);
            const topCount =
              benchmarkValue == null
                ? 0
                : rankValues.filter((v) => v === benchmarkValue).length;

            return (
              <div
                key={row.id}
                className="grid border-b border-brand-primary/10 last:border-b-0 hover:bg-brand-primary/5 transition-colors duration-200"
                style={{ gridTemplateColumns: `280px repeat(${selectedCount}, minmax(180px, 1fr))` }}
              >
                <div
                  className={`px-5 py-4 flex items-center text-sm font-semibold bg-brand-primary/5 border-r border-brand-primary/10 ${
                    row.id === 'totalExpenses' ? 'text-red-600' : 'text-slate-700'
                  }`}
                >
                  {row.label}
                </div>
                {row.values.map((value, index) => {
                  const rankValue = rankValues[index];
                  const isTop =
                    benchmarkValue != null && rankValue === benchmarkValue && topCount === 1;
                  const prevBase = row.compareBases?.[index] ?? 0;

                  const indexDisplay =
                    row.format === 'diff_index_stack'
                      ? formatDiffIndexDisplay(value, prevBase, row.amountSource ?? 'previous', true)
                      : row.format === 'diff_index' || row.format === 'diff_percent'
                        ? formatDiffIndexDisplay(value, prevBase, row.amountSource ?? 'previous')
                        : null;
                  const shareDisplay =
                    row.format === 'currency_share'
                      ? formatCurrencyWithShare(value, prevBase)
                      : null;
                  const splitDisplay = indexDisplay ?? shareDisplay;

                  const customContent =
                    row.format === 'currency_pct'
                      ? (
                          <span className="inline-flex items-center gap-2 flex-wrap">
                            <span
                              className={`text-sm font-semibold ${
                                row.id === 'totalExpenses'
                                  ? 'text-red-600'
                                  : row.id === 'totalRevenue'
                                    ? value >= 0
                                      ? 'text-emerald-600'
                                      : 'text-red-600'
                                    : isTop
                                      ? 'text-brand-primary'
                                      : 'text-slate-700'
                              }`}
                            >
                              {formatCurrency(value)}
                            </span>
                            {renderInlinePctBadge(
                              Number(prevBase) || 0,
                              row.pctBreakdown === 'expense_rate' ? 'expense_rate' : 'expense_share',
                              row.compareBases,
                            )}
                          </span>
                        )
                      : row.format === 'expense_diff'
                      ? renderExpenseDiffCell(value, prevBase)
                      : row.format === 'expense_share'
                        ? renderExpenseShareCell(value)
                        : row.format === 'expense_rate'
                          ? renderExpenseRateCell(value)
                          : row.format === 'rank'
                            ? (
                                <span
                                  className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                                    value === 1
                                      ? 'bg-indigo-100 text-indigo-700'
                                      : 'bg-slate-100 text-slate-600'
                                  }`}
                                >
                                  {Math.trunc(value)}
                                </span>
                              )
                            : null;

                  const plainDisplay =
                    customContent || splitDisplay
                      ? null
                      : row.format === 'percent'
                        ? `${(Number.isFinite(value) ? value : 0).toFixed(1)}%`
                        : row.format === 'diff_index' ||
                            row.format === 'diff_percent' ||
                            row.format === 'diff_index_stack' ||
                            row.format === 'currency_share' ||
                            row.format === 'expense_share' ||
                            row.format === 'expense_rate'
                          ? null
                          : value < 1 && row.id === 'expense-previous'
                            ? '—'
                            : formatCurrency(value);

                  const sentiment = indexDisplay?.sentiment;
                  const effectiveSentiment =
                    row.invertSentiment && (sentiment === 'up' || sentiment === 'down')
                      ? sentiment === 'up'
                        ? 'down'
                        : 'up'
                      : sentiment;
                  const percentColorClass =
                    row.format === 'currency_share'
                      ? 'text-slate-500'
                      : effectiveSentiment === 'up'
                        ? 'text-emerald-600'
                        : effectiveSentiment === 'down'
                          ? 'text-red-600'
                          : 'text-slate-500';

                  const plainColorClass = isTop ? 'text-brand-primary' : 'text-slate-700';
                  const branch = selectedCompareBranches[index];
                  const cellKey = `${row.id}-${branch.id}`;
                  const canBreakDownCompare =
                    Boolean(row.breakdownKind) &&
                    (row.format === 'diff_index' ||
                      row.format === 'diff_percent' ||
                      row.format === 'diff_index_stack' ||
                      row.format === 'expense_diff');
                  const canBreakDownExpensePct =
                    row.format === 'expense_share' ||
                    row.format === 'expense_rate' ||
                    row.format === 'currency_share' ||
                    (row.format === 'currency_pct' && Boolean(row.pctBreakdown));
                  const canBreakDown = canBreakDownCompare || canBreakDownExpensePct;
                  const isBreakdownOpen = compareBreakdownPopup?.key === cellKey;

                  const valueContent = customContent ? (
                    customContent
                  ) : splitDisplay && indexDisplay?.showTrendIcon ? (
                    <div className="flex flex-col items-start gap-0.5">
                      <span className="text-sm font-semibold text-slate-700 tabular-nums tracking-tight">
                        {splitDisplay.amount}
                      </span>
                      {indexDisplay.unreliable ? (
                        <span className="text-[11px] font-medium text-slate-400">—</span>
                      ) : (
                        <span
                          className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${percentColorClass}`}
                        >
                          {/* Arrows only for 전월 동기 (same_period); 전월 대비 / 평균 대비 = % only */}
                          {row.breakdownKind === 'same_period' ? (
                            sentiment === 'up' ? (
                              <TrendingUp size={11} />
                            ) : sentiment === 'down' ? (
                              <TrendingDown size={11} />
                            ) : null
                          ) : null}
                          {splitDisplay.percent}
                        </span>
                      )}
                    </div>
                  ) : splitDisplay ? (
                    <span className="text-sm font-semibold">
                      <span className="text-slate-700">{splitDisplay.amount}</span>
                      {' '}
                      <span className={percentColorClass}>{splitDisplay.percent}</span>
                    </span>
                  ) : (
                    <span className={`text-sm font-semibold ${plainColorClass}`}>
                      {plainDisplay}
                    </span>
                  );

                  return (
                    <div
                      key={cellKey}
                      className="px-5 py-4 border-l border-brand-primary/10"
                    >
                      <div className="flex items-center justify-between gap-3">
                        {canBreakDown ? (
                          <button
                            type="button"
                            data-compare-breakdown-trigger
                            onClick={(e) => {
                              if (canBreakDownExpensePct) {
                                const branchExpenses = currentPeriodExpenses[index] ?? 0;
                                const branchSales = Number(currentPeriodSales[index]) || 0;
                                const isMainExpenseRow = String(row.id || '').startsWith('main-');

                                // Main Expenses: category amount ÷ this branch's total sales.
                                if (row.format === 'currency_share' || isMainExpenseRow) {
                                  const categoryAmount = Number(value) || 0;
                                  const salesBase = Number(prevBase) > 0 ? Number(prevBase) : branchSales;
                                  openExpensePctBreakdown(
                                    e,
                                    cellKey,
                                    branch.name,
                                    t('admin_dashboard.expense_table.of_sales'),
                                    'expense_rate',
                                    categoryAmount,
                                    salesBase,
                                    salesBase > 0 ? (categoryAmount / salesBase) * 100 : 0,
                                    undefined,
                                    row.label,
                                  );
                                  return;
                                }

                                const pctKind =
                                  row.format === 'currency_pct'
                                    ? row.pctBreakdown!
                                    : row.format === 'expense_share'
                                      ? 'expense_share'
                                      : 'expense_rate';
                                const resultPct =
                                  row.format === 'currency_pct'
                                    ? Number(prevBase) || 0
                                    : Number(value) || 0;
                                const metricLabel =
                                  pctKind === 'expense_share'
                                    ? t('admin_dashboard.expense_table.share')
                                    : t('admin_dashboard.expense_table.of_sales');
                                if (pctKind === 'expense_share') {
                                  openExpensePctBreakdown(
                                    e,
                                    cellKey,
                                    branch.name,
                                    metricLabel,
                                    'expense_share',
                                    branchExpenses,
                                    companyExpenseTotal,
                                    resultPct,
                                    selectedCompareBranches.map((b, i) => ({
                                      name: b.name,
                                      amount: Number(currentPeriodExpenses[i]) || 0,
                                    })),
                                  );
                                } else {
                                  const isProfitRow = row.id === 'totalRevenue';
                                  const numerator = isProfitRow
                                    ? Number(currentPeriodProfit[index]) || 0
                                    : branchExpenses;
                                  openExpensePctBreakdown(
                                    e,
                                    cellKey,
                                    branch.name,
                                    metricLabel,
                                    'expense_rate',
                                    numerator,
                                    branchSales,
                                    branchSales > 0 ? (numerator / branchSales) * 100 : 0,
                                    undefined,
                                    isProfitRow
                                      ? COMPARE_METRIC_LABELS.totalProfit
                                      : COMPARE_METRIC_LABELS.totalExpenses,
                                  );
                                }
                                return;
                              }
                              openCompareBreakdown(
                                e,
                                cellKey,
                                branch.name,
                                row.label,
                                row.breakdownKind!,
                                value,
                                prevBase,
                                Boolean(row.invertSentiment),
                              );
                            }}
                            className={`text-left rounded-xl px-0.5 -mx-0.5 py-0.5 transition-colors hover:bg-brand-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40 ${
                              isBreakdownOpen ? 'bg-brand-primary/10 ring-1 ring-brand-primary/30' : ''
                            }`}
                            title="Click for computation breakdown"
                          >
                            {valueContent}
                          </button>
                        ) : (
                          valueContent
                        )}
                        {isTop &&
                          !row.hideTop &&
                          row.format !== 'rank' &&
                          row.format !== 'expense_share' &&
                          row.format !== 'expense_rate' && (
                          <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full bg-brand-primary/15 text-brand-primary">
                            {t('admin_dashboard.top')}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
      </div>
    </div>
  );

  const hasDashboardContent = branchCardsData.length > 0;
  const isPageLoading = !hasDashboardContent && analyticsLoading;

  return (
    <>
      <AnimatePresence mode="wait">
        {isPageLoading ? (
        <motion.div 
          key="skeleton"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="grid grid-cols-1 lg:grid-cols-4 gap-8 pt-6"
        >
          <div className="lg:col-span-3 space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <Skeleton className="h-28 rounded-2xl" />
              <Skeleton className="h-28 rounded-2xl" />
              <Skeleton className="h-28 rounded-2xl" />
            </div>
            <Skeleton className="h-[500px] rounded-2xl" />
          </div>
          <div className="lg:col-span-1 space-y-3">
            <Skeleton className="h-8 w-48 mb-2 rounded-lg" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-56 rounded-2xl" />
            ))}
          </div>
        </motion.div>
        ) : (
        <motion.div 
          key="content"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="grid grid-cols-1 lg:grid-cols-4 gap-8 pt-6"
        >
          <div className="lg:col-span-3 space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 pt-4">
              <SummaryCard
                title={t('admin_dashboard.total_sales')}
                value={
                  summaryData
                    ? `₱${Math.trunc(summaryData.totalSales).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                    : '...'
                }
                icon={TrendingUp}
                color="bg-[rgb(139,92,246)]"
              />
              <SummaryCard
                title={t('admin_dashboard.total_expenses')}
                value={
                  summaryData
                    ? `₱${Math.trunc(summaryData.totalExpenses).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                    : '...'
                }
                icon={TrendingDown}
                color="bg-[rgb(245,158,11)]"
              />
              <SummaryCard
                title="Total Profit"
                value={
                  summaryData
                    ? `₱${Math.trunc(summaryData.totalRevenue).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                    : '...'
                }
                icon={DollarSign}
                color="bg-green-500"
              />
            </div>
            
            <div className="bg-white p-6 rounded-2xl shadow-sm hover:shadow-md transition-shadow duration-300 border border-slate-100">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-slate-800">
                    {t('admin_dashboard.performance_trend')}
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {activeBranchId
                      ? 'Click a sales or expenses bar to view day breakdown'
                      : 'Click a sales or expenses bar to break down by branch'}
                  </p>
                </div>

                <div className="inline-flex items-center rounded-2xl bg-slate-50 p-1 border border-slate-200 shadow-sm">
                  <button
                    type="button"
                    aria-pressed={trendPeriod === 'weekly'}
                    onClick={() => setTrendPeriod('weekly')}
                    className={`cursor-pointer px-3 py-1.5 rounded-xl text-sm font-semibold border transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40 ${
                      trendPeriod === 'weekly'
                        ? 'bg-white text-brand-primary shadow-sm border-slate-200'
                        : 'bg-transparent text-slate-600 border-transparent hover:text-slate-900 hover:bg-white/70'
                    }`}
                  >
                    Weekly
                  </button>
                  <button
                    type="button"
                    aria-pressed={trendPeriod === 'monthly'}
                    onClick={() => setTrendPeriod('monthly')}
                    className={`cursor-pointer px-3 py-1.5 rounded-xl text-sm font-semibold border transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40 ${
                      trendPeriod === 'monthly'
                        ? 'bg-white text-brand-primary shadow-sm border-slate-200'
                        : 'bg-transparent text-slate-600 border-transparent hover:text-slate-900 hover:bg-white/70'
                    }`}
                  >
                    Monthly
                  </button>
                  <button
                    type="button"
                    aria-pressed={trendPeriod === 'yearly'}
                    onClick={() => setTrendPeriod('yearly')}
                    className={`cursor-pointer px-3 py-1.5 rounded-xl text-sm font-semibold border transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40 ${
                      trendPeriod === 'yearly'
                        ? 'bg-white text-brand-primary shadow-sm border-slate-200'
                        : 'bg-transparent text-slate-600 border-transparent hover:text-slate-900 hover:bg-white/70'
                    }`}
                  >
                    Yearly
                  </button>
                </div>
              </div>
              <div className="relative w-full min-w-0 h-96 min-h-[384px]">
                {trendLoading && monthlyData.length === 0 ? (
                  <Skeleton className="h-full w-full rounded-xl" />
                ) : trendChartData.length === 0 || !hasNonZeroTrendData ? (
                  activeBranchId && branchChartsLoading ? (
                    <Skeleton className="h-full w-full rounded-xl" />
                  ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-sm text-slate-500">
                    <p>
                      {activeBranchId && focusedBranchName
                        ? t('admin_dashboard.no_branch_revenue_data', { branch: focusedBranchName })
                        : t('admin_dashboard.no_revenue_data')}
                    </p>
                  </div>
                  )
                ) : (
                <>
                <TrendChartContainer className="h-full w-full" minHeight={384} render={({ width, height }) => (
                  <BarChart
                    key={`${activeBranchId || 'all'}-${trendPeriod}`}
                    width={width}
                    height={height}
                    data={trendChartData}
                    margin={{ top: 28, right: 20, left: 8, bottom: 8 }}
                    stackOffset="sign"
                  >
                    <XAxis 
                      dataKey="name" 
                      tick={TrendXAxisTick}
                      axisLine={false}
                      tickLine={false}
                      interval={0}
                      minTickGap={0}
                    />
                    <YAxis 
                      tick={TrendYAxisTick}
                      axisLine={false}
                      tickLine={false}
                      width={60}
                      domain={trendYScale.domain}
                      ticks={trendYTicks}
                    />
                    <Tooltip 
                      content={TrendTooltipContent}
                      cursor={{ fill: 'transparent' }}
                    />
                    <Legend
                      iconType="circle"
                      wrapperStyle={{ paddingTop: '20px' }}
                      content={({ payload }) => (
                        <div className="flex flex-wrap items-center justify-center pt-5">
                          {payload?.map((entry) => (
                            <span key={entry.value} className="flex items-center ml-2 mr-8 text-sm font-medium text-slate-600">
                              <span
                                className="inline-block w-2.5 h-2.5 rounded-full mr-1.5"
                                style={{ backgroundColor: entry.color }}
                              />
                              {entry.value === 'totalSales' ? t('admin_dashboard.total_sales') :
                               entry.value === 'negativeExpenses' ? t('admin_dashboard.total_expenses') : entry.value}
                            </span>
                          ))}
                          {dailyAverageSales != null && (
                            <span className="ml-2 mr-8 text-sm font-bold text-slate-600">
                              {t('admin_dashboard.daily_average')} : ₱{Math.round(dailyAverageSales).toLocaleString()}
                            </span>
                          )}
                        </div>
                      )}
                    />
                    <Bar 
                      dataKey="totalSales" 
                      name="totalSales" 
                      fill="rgb(139, 92, 246)" 
                      radius={[6, 6, 0, 0]}
                      barSize={trendPeriod === 'monthly' ? 16 : 32}
                      stackId="stack"
                      isAnimationActive={!trendLoading}
                      cursor="pointer"
                      onClick={(data) => handleTrendBarClick('sales', data)}
                    />
                    <Bar 
                      dataKey="negativeExpenses" 
                      name="negativeExpenses" 
                      fill="rgb(245, 158, 11)" 
                      radius={[6, 6, 0, 0]}
                      barSize={trendPeriod === 'monthly' ? 16 : 32}
                      stackId="stack"
                      isAnimationActive={!trendLoading}
                      cursor="pointer"
                      onClick={(data) => handleTrendBarClick('expenses', data)}
                    />
                  </BarChart>
                )} />
                {trendLoading && monthlyData.length > 0 && !activeBranchId && (
                  <div
                    className="absolute inset-0 rounded-xl bg-white/50 pointer-events-none"
                    aria-hidden
                  />
                )}
                </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Pie Chart: Revenue Distribution (real data) */}
              <div className="bg-white p-6 rounded-2xl shadow-sm hover:shadow-md transition-shadow duration-300 border border-slate-100">
                <h3 className="text-lg font-bold text-slate-800 mb-4">{t('admin_dashboard.revenue_distribution')}</h3>
                <div className="w-full min-w-0 h-72 min-h-[288px]">
                  {analyticsLoading && visibleBranchRevenueDistribution.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <Skeleton className="h-40 w-40 rounded-full" />
                    </div>
                  ) : visibleBranchRevenueDistribution.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-sm text-slate-500">
                      {t('admin_dashboard.no_revenue_data')}
                    </div>
                  ) : (
                    <div className="h-full flex items-center gap-4">
                      <div className="w-1/2 space-y-3 max-h-full overflow-y-auto pr-2">
                        {visibleBranchRevenueDistribution.map((entry, index) => {
                          const percentage = totalRevenueDistribution > 0
                            ? (Number(entry.value || 0) / totalRevenueDistribution) * 100
                            : 0;

                          return (
                            <div key={`${entry.name}-${index}`} className="flex items-center gap-2 text-sm text-slate-700">
                              <span
                                className="inline-block h-3 w-3 rounded-full shrink-0"
                                style={{ backgroundColor: REVENUE_DISTRIBUTION_COLORS[index % REVENUE_DISTRIBUTION_COLORS.length] }}
                              />
                              <span className="font-medium text-slate-600 shrink-0">{percentage.toFixed(1)}%</span>
                              <span className="truncate" title={entry.name}>{entry.name}</span>
                            </div>
                          );
                        })}
                      </div>

                      <div className="w-1/2 h-full min-h-[240px]">
                        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={240}>
                          <PieChart>
                            <Pie
                              data={visibleBranchRevenueDistribution}
                              cx="50%"
                              cy="50%"
                              innerRadius={62}
                              outerRadius={90}
                              fill="#8884d8"
                              paddingAngle={3}
                              dataKey="value"
                              stroke="none"
                            >
                              {visibleBranchRevenueDistribution.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={REVENUE_DISTRIBUTION_COLORS[index % REVENUE_DISTRIBUTION_COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip
                              formatter={(value) => `₱${Number(value).toLocaleString()}`}
                              contentStyle={{
                                borderRadius: '12px',
                                border: 'none',
                                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                              }}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Horizontal Bar Chart: Top Selling Products (real data) */}
              <div className="bg-white p-6 rounded-2xl shadow-sm hover:shadow-md transition-shadow duration-300 border border-slate-100">
                <h3 className="text-lg font-bold text-slate-800 mb-4">{t('admin_dashboard.top_selling_products')}</h3>
                <div className="w-full min-w-0 h-72 min-h-[288px]">
                  {topProductsLoading && topProductsData.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <Skeleton className="h-40 w-full rounded-2xl" />
                    </div>
                  ) : topProductsData.length === 0 ? (
                    activeBranchId && branchChartsLoading ? (
                      <div className="flex items-center justify-center h-full">
                        <Skeleton className="h-40 w-full rounded-2xl" />
                      </div>
                    ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-sm text-slate-500">
                      <p>
                        {activeBranchId && focusedBranchName
                          ? t('admin_dashboard.no_branch_products_data', { branch: focusedBranchName })
                          : t('admin_dashboard.no_products_data')}
                      </p>
                    </div>
                    )
                  ) : (
                    <div className="h-full flex flex-col">
                      <div className="grid grid-cols-[41%_47%_12%] items-center gap-2 px-1 pb-2">
                        <div />
                        <div />
                        <div className="text-right text-xs font-semibold uppercase tracking-wide text-slate-500">qty sold</div>
                      </div>
                      <div className="flex-1 flex flex-col justify-evenly">
                        {topProductsChartData.map((entry) => (
                          <div key={`product-row-${entry.rank}`} className="grid grid-cols-[41%_47%_12%] items-center gap-2">
                            <div className="flex items-center gap-2 text-[15px] text-slate-700 min-w-0">
                              <span className="w-5 shrink-0 text-right text-slate-500 font-medium">{entry.rank}.</span>
                              <span className="truncate" title={entry.name}>{entry.cleanName}</span>
                            </div>
                            <div className="w-full h-6 flex items-center">
                              <div
                                className="h-6 rounded-[8px] transition-all duration-300"
                                style={{
                                  width: `${(Math.max(Number(entry.sales) || 0, 0) / topProductMaxSales) * 100}%`,
                                  backgroundColor: entry.barColor,
                                }}
                              />
                            </div>
                            <div className="text-right text-sm font-semibold text-slate-700 tabular-nums">
                              {Number(entry.sales).toLocaleString()}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="lg:col-span-1 space-y-4">
            {selectedCompareBranches.length > 0 && (
              <div className="sticky top-4 z-10 bg-slate-50 rounded-xl p-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!canCompare}
                    onClick={() => {
                      setIsComparePanelLoading(true);
                      setIsComparePanelOpen(true);
                    }}
                    className="min-w-0 flex-1 rounded-xl bg-brand-primary text-white font-semibold py-2.5 px-4 transition-all duration-200 hover:bg-brand-primary/90 disabled:bg-slate-300 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {t('admin_dashboard.compare')} ({selectedCompareBranches.length})
                  </button>
                  <label
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-brand-primary/20 bg-white px-2.5 py-2.5 cursor-pointer select-none hover:bg-brand-primary/5"
                    title={t('admin_dashboard.select_all_branches')}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-brand-primary focus:ring-brand-primary/40 cursor-pointer"
                      checked={allCompareSelected}
                      onChange={handleCompareSelectAll}
                      aria-label={t('admin_dashboard.select_all_branches')}
                    />
                    <span className="text-[11px] font-semibold text-slate-600 whitespace-nowrap">
                      {t('admin_dashboard.select_all_branches')}
                    </span>
                  </label>
                </div>
                <p className="mt-2 text-[11px] text-slate-500 text-center">
                  {t('admin_dashboard.select_branches_to_compare')}
                </p>
              </div>
            )}
            {(() => {
              const hasAnalytics = branchCardsData.length > 0;
              const list = hasAnalytics ? branchCardsData : [];
              const orderedList = sortBranchesBySidebarOrder(list, { exclude3core: true });

              if (orderedList.length === 0 && isPageLoading) {
                return (
                  <div className="space-y-3">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Skeleton key={i} className="h-56 rounded-2xl" />
                    ))}
                  </div>
                );
              }

              return orderedList.map((branch) => {
                const branchForCard: BranchPerformanceData = {
                  ...branch,
                  totalExpenses: getEffectiveBranchTotalExpenses(branch),
                };

                return (
                  <BranchPerformanceCard
                    key={branch.id}
                    branch={branchForCard}
                    onClick={() => handleBranchFocus(branchForCard)}
                    onMouseEnter={() => void prefetchBranchDashboardData(branch.id, trendPeriodRef.current)}
                      onCompareToggle={() => handleBranchCompareToggle(branch.id)}
                      onTotalSalesClick={() => {
                        setCashReconModalBranch(branchForCard);
                        setCashReconModalOpen(true);
                      }}
                      isSelected={compareBranchIds.includes(branch.id)}
                      isActive={activeBranchId === branch.id}
                  />
                );
              });
            })()}
          </div>
        </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isComparePanelOpen && canCompare && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 z-40"
              onClick={() => setIsComparePanelOpen(false)}
            />

            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 26, stiffness: 220 }}
              className={`fixed right-0 top-0 h-screen ${comparePanelWidthClass} bg-white shadow-2xl z-50 border-l border-brand-primary/15`}
            >
              <div className="h-full flex flex-col">
                <div className="flex items-center justify-between px-6 py-5 border-b border-brand-primary/15 bg-white">
                  <div>
                    <h2 className="text-xl font-bold text-brand-primary">{t('admin_dashboard.branch_comparison')}</h2>
                    <p className="text-sm text-slate-600 mt-1">
                      {compareTitle}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={resetCompareDateRangeToDefaultMonth}
                      disabled={isCompareDefaultMonth || isComparePanelLoading}
                      title={t('admin_dashboard.reset_date_range')}
                      aria-label={t('admin_dashboard.reset_date_range')}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-brand-primary bg-brand-primary text-white shadow-sm hover:bg-brand-primary/90 hover:border-brand-primary/90 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <RotateCcw size={16} />
                    </button>
                    <div className="relative">
                    <button
                      type="button"
                      onClick={() => setIsCompareDateOpen((open) => !open)}
                      className="flex items-center gap-3 bg-brand-primary/[0.04] px-5 py-2.5 rounded-xl shadow-sm border border-brand-primary/20 hover:bg-brand-primary/10 hover:border-brand-primary/40 transition-all cursor-pointer"
                    >
                      <Calendar size={18} className="text-brand-primary" />
                      <span className="text-sm text-slate-700 whitespace-nowrap">
                        {compareDateRange.start && compareDateRange.end
                          ? `${formatDate(compareDateRange.start, i18n.language)} - ${formatDate(compareDateRange.end, i18n.language)}`
                          : t('admin_dashboard.date_range')}
                      </span>
                      <ChevronDown size={16} className="text-brand-primary transition-colors" />
                    </button>

                    {isCompareDateOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-[55]"
                          onClick={() => setIsCompareDateOpen(false)}
                          aria-hidden
                        />
                        <div className="absolute top-full right-0 mt-2 z-[60]">
                          <div className="date-picker-multi-wrap">
                          <DatePicker
                            inline
                            selectsRange
                            monthsShown={DATE_PICKER_MONTHS_SHOWN}
                            showPreviousMonths
                            startDate={comparePickerValue[0]}
                            endDate={comparePickerValue[1]}
                            maxDate={parseYmdToLocalDate(getManilaTodayYmd()) ?? undefined}
                            openToDate={comparePickerValue[1] ?? comparePickerValue[0] ?? undefined}
                            onChange={(update) => handleCompareDateRangeChange(update, { closeOnComplete: true })}
                            dateFormat="MMM d, yyyy"
                            calendarClassName="react-datepicker-material react-datepicker-material--multi"
                            isClearable
                            renderCustomHeader={({
                              monthDate,
                              decreaseMonth,
                              increaseMonth,
                              prevMonthButtonDisabled,
                              nextMonthButtonDisabled,
                              customHeaderCount,
                            }) => {
                              const monthLabel = monthDate.toLocaleDateString(localeForLanguage(i18n.language), {
                                month: 'long',
                                year: 'numeric',
                              });
                              const isFirstMonth = customHeaderCount === 0;
                              const isLastMonth = customHeaderCount === DATE_PICKER_MONTHS_SHOWN - 1;

                              return (
                                <div className="react-datepicker-multi-month-header flex items-center justify-between">
                                  {isFirstMonth ? (
                                    <button
                                      type="button"
                                      onClick={decreaseMonth}
                                      disabled={prevMonthButtonDisabled}
                                      className={cn(
                                        'rounded transition-colors shrink-0',
                                        prevMonthButtonDisabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-100 cursor-pointer'
                                      )}
                                      aria-label="Previous month"
                                    >
                                      <ArrowLeft size={14} className="text-brand-muted" />
                                    </button>
                                  ) : (
                                    <span className="w-3 shrink-0" aria-hidden />
                                  )}

                                  <button
                                    type="button"
                                    onClick={() => {
                                      handleCompareDateRangeChange(getFullMonthRange(monthDate), { closeOnComplete: true });
                                    }}
                                    className="react-datepicker-multi-month-title font-bold text-brand-text hover:text-brand-primary cursor-pointer transition-colors rounded hover:bg-gray-100 text-center leading-tight"
                                    aria-label={`Select all of ${monthLabel}`}
                                  >
                                    {monthLabel}
                                  </button>

                                  {isLastMonth ? (
                                    <button
                                      type="button"
                                      onClick={increaseMonth}
                                      disabled={nextMonthButtonDisabled}
                                      className={cn(
                                        'rounded transition-colors shrink-0',
                                        nextMonthButtonDisabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-100 cursor-pointer'
                                      )}
                                      aria-label="Next month"
                                    >
                                      <ArrowLeft size={14} className="text-brand-muted rotate-180" />
                                    </button>
                                  ) : (
                                    <span className="w-3 shrink-0" aria-hidden />
                                  )}
                                </div>
                              );
                            }}
                          />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  </div>
                </div>

                <div className="px-6 pb-6 overflow-auto custom-scrollbar space-y-4">
                  {isComparePanelLoading || (isComparePanelOpen && analyticsLoading) ? (
                    <div className="mt-6 space-y-4" aria-busy="true" aria-label="Loading comparison">
                      <Skeleton className="h-12 rounded-2xl" />
                      <div className="rounded-2xl border border-brand-primary/15 bg-white overflow-hidden">
                        <div className="grid gap-3 px-4 py-3 border-b border-brand-primary/10 bg-brand-primary/[0.03]"
                          style={{ gridTemplateColumns: `minmax(9rem,1.2fr) repeat(${Math.max(selectedCompareBranches.length, 2)}, minmax(5rem,1fr))` }}
                        >
                          <Skeleton className="h-8 rounded-lg" />
                          {Array.from({ length: Math.max(selectedCompareBranches.length, 2) }).map((_, i) => (
                            <div key={i} className="flex flex-col items-center gap-2">
                              <Skeleton className="h-10 w-10 rounded-full" />
                              <Skeleton className="h-3 w-16 rounded" />
                            </div>
                          ))}
                        </div>
                        <div className="p-4 space-y-3">
                          {Array.from({ length: 10 }).map((_, i) => (
                            <div
                              key={i}
                              className="grid gap-3 items-center"
                              style={{ gridTemplateColumns: `minmax(9rem,1.2fr) repeat(${Math.max(selectedCompareBranches.length, 2)}, minmax(5rem,1fr))` }}
                            >
                              <Skeleton className="h-5 w-28 rounded" />
                              {Array.from({ length: Math.max(selectedCompareBranches.length, 2) }).map((__, j) => (
                                <Skeleton key={j} className="h-8 w-full max-w-[7rem] mx-auto rounded-lg" />
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mt-6 rounded-2xl border border-brand-primary/20 bg-gradient-to-r from-brand-primary/10 to-indigo-100/70 px-4 py-3 flex items-center justify-between shadow-sm">
                        <p className="text-sm font-semibold text-brand-primary">{t('admin_dashboard.comparison_board')}</p>
                        <p className="text-xs text-slate-600">{t('admin_dashboard.comparison_note')}</p>
                      </div>

                      {renderComparisonTable(unifiedComparisonRows)}
                    </>
                  )}
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {compareBreakdownPopup && (
        <div
          data-compare-breakdown-popup
          className="fixed z-[80] w-[360px] max-h-[min(480px,calc(100vh-16px))] overflow-y-auto rounded-xl border border-brand-primary/20 bg-white p-4 shadow-xl shadow-slate-900/10"
          style={{ top: compareBreakdownPopup.top, left: compareBreakdownPopup.left }}
          role="dialog"
          aria-label="Comparison computation breakdown"
          ref={(el) => {
            if (!el) return;
            const pad = 8;
            const rect = el.getBoundingClientRect();
            let nextTop = compareBreakdownPopup.top;
            let nextLeft = compareBreakdownPopup.left;
            if (rect.bottom > window.innerHeight - pad) {
              nextTop = Math.max(pad, window.innerHeight - rect.height - pad);
            }
            if (rect.right > window.innerWidth - pad) {
              nextLeft = Math.max(pad, window.innerWidth - rect.width - pad);
            }
            if (nextTop !== compareBreakdownPopup.top || nextLeft !== compareBreakdownPopup.left) {
              el.style.top = `${nextTop}px`;
              el.style.left = `${nextLeft}px`;
            }
          }}
        >
          <div className="mb-3 border-b border-slate-100 pb-2.5">
            <p className="text-sm font-bold tracking-wide text-brand-primary">
              {compareBreakdownPopup.branchName}
            </p>
            <p className="mt-0.5 text-xs leading-snug text-slate-500">
              {compareBreakdownPopup.metricLabel}
            </p>
          </div>
          <div className="space-y-2.5">
            {compareBreakdownPopup.rows.map((line) => {
              const valueColor =
                line.tone === 'up'
                  ? 'text-emerald-600'
                  : line.tone === 'down'
                    ? 'text-red-600'
                    : 'text-slate-800';
              return (
                <div key={`${line.label}-${line.sub ?? ''}`} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-700">{line.label}</p>
                    {line.sub ? (
                      <p className="text-[11px] leading-snug text-slate-400">{line.sub}</p>
                    ) : null}
                  </div>
                  <p className={`shrink-0 text-xs font-bold tabular-nums ${valueColor}`}>{line.value}</p>
                </div>
              );
            })}
          </div>
          <div className="mt-3.5 rounded-lg bg-slate-50 px-3 py-3 border border-slate-100">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-2">
              {compareBreakdownPopup.formulaIsNote ? 'Why this shows' : 'How % is computed'}
            </p>
            {compareBreakdownPopup.formulaIsNote ? (
              <div className="space-y-2 text-xs leading-relaxed text-slate-600">
                {compareBreakdownPopup.formulaSummary.split('\n').map((line, i) => (
                  <p key={`note-${i}`}>{line}</p>
                ))}
              </div>
            ) : (
              <div className="space-y-1 font-mono text-[11px] leading-5 text-slate-600 break-words">
                {compareBreakdownPopup.formulaSummary.split('\n').map((line, i) => (
                  <p
                    key={`formula-${i}`}
                    className={
                      i === 0
                        ? 'font-semibold text-slate-700'
                        : line.startsWith('≈')
                          ? 'font-bold text-slate-800'
                          : 'pl-2 text-slate-500'
                    }
                  >
                    {line}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <Modal
        isOpen={trendDrillOpen}
        onClose={closeTrendDrill}
        title={
          trendDrillStep === 'branches'
            ? `${trendDrillMetric === 'sales' ? 'Sales' : 'Expenses'} by branch`
            : trendDrillMetric === 'sales'
              ? `Top menus · ${trendDrillBranch?.name ?? ''}`
              : `Expense breakdown · ${trendDrillBranch?.name ?? ''}`
        }
        subtitle={
          <div className="flex flex-col items-start gap-1.5">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Previous date"
                disabled={
                  !trendDrillCanShiftDate.prev ||
                  trendDrillBranchesLoading ||
                  trendDrillBreakdownLoading ||
                  trendDrillExpenseItemsLoading
                }
                onClick={() => navigateTrendDrillDate(-1)}
                className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border-0 shadow-sm hover:opacity-90 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer ${trendDrillBranchRankClass(trendDrillMetric)}`}
              >
                <ChevronLeft size={16} />
              </button>
              <div className="relative">
                <button
                  type="button"
                  aria-label="Pick date"
                  title="Click to pick a date"
                  onClick={() => setTrendDrillCalendarOpen((open) => !open)}
                  className="text-sm text-slate-700 m-0 min-w-[7.5rem] px-2 py-1 rounded-lg text-center font-semibold tabular-nums cursor-pointer hover:bg-slate-100 border border-transparent hover:border-slate-200"
                >
                  {trendDrillLabel}
                  {trendDrillRange.start &&
                  trendDrillRange.end &&
                  trendDrillRange.start !== trendDrillRange.end
                    ? ` · ${formatDate(trendDrillRange.start)} – ${formatDate(trendDrillRange.end)}`
                    : ''}
                </button>
                {trendDrillCalendarOpen ? (
                  <>
                    <div
                      className="fixed inset-0 z-[85]"
                      onClick={() => setTrendDrillCalendarOpen(false)}
                      aria-hidden
                    />
                    <div
                      className="absolute z-[90] top-full left-1/2 -translate-x-1/2 mt-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DatePicker
                        inline
                        selected={trendDrillPickerDate}
                        onChange={jumpTrendDrillToDay}
                        minDate={trendDrillPickerMinDate}
                        maxDate={trendDrillPickerMaxDate}
                        calendarClassName="react-datepicker-material"
                      />
                    </div>
                  </>
                ) : null}
              </div>
              <button
                type="button"
                aria-label="Next date"
                disabled={
                  !trendDrillCanShiftDate.next ||
                  trendDrillBranchesLoading ||
                  trendDrillBreakdownLoading ||
                  trendDrillExpenseItemsLoading
                }
                onClick={() => navigateTrendDrillDate(1)}
                className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border-0 shadow-sm hover:opacity-90 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer ${trendDrillBranchRankClass(trendDrillMetric)}`}
              >
                <ChevronRight size={16} />
              </button>
            </div>
            {trendDrillStep === 'breakdown' && trendDrillAllowBranchNav ? (
              <button
                type="button"
                onClick={() => {
                  setTrendDrillStep('branches');
                  setTrendDrillBranch(null);
                  closeTrendDrillExpenseItems();
                }}
                className="inline-flex items-center gap-1 text-sm font-bold text-brand-primary hover:text-brand-utilities cursor-pointer"
              >
                <ChevronLeft size={16} />
                Branches
              </button>
            ) : null}
          </div>
        }
        maxWidth="3xl"
        bodyClassName="px-5 py-4"
        closeButtonClassName={`${trendDrillBranchRankClass(trendDrillMetric)} hover:opacity-90`}
        footer={
          <div className="flex items-center justify-between gap-3 w-full">
            <span className="text-sm text-slate-500">
              {trendDrillStep === 'branches'
                ? trendDrillBranchesLoading
                  ? 'Loading…'
                  : `${trendDrillBranches.filter((b) => !b.residual).length} branch${
                      trendDrillBranches.filter((b) => !b.residual).length === 1 ? '' : 'es'
                    }`
                : trendDrillBranch?.name ?? ''}
            </span>
            <div className="flex items-center gap-3">
              <span className="text-sm font-bold tabular-nums text-slate-800">
                Total{' '}
                {formatModalMoney(
                  trendDrillStep === 'branches'
                    ? trendDrillBranchesTotal
                    : trendDrillMetric === 'sales'
                      ? trendDrillSalesTotal
                      : trendDrillExpenseTotal,
                )}
              </span>
              <button
                type="button"
                onClick={closeTrendDrill}
                className={`px-3 py-1.5 rounded-lg border-0 text-sm font-semibold shadow-sm hover:opacity-90 cursor-pointer ${trendDrillBranchRankClass(trendDrillMetric)}`}
              >
                Close
              </button>
            </div>
          </div>
        }
      >
        {trendDrillStep === 'branches' ? (
          trendDrillBranchesLoading ? (
            <div className="py-10 text-center text-sm text-slate-500">Loading branches…</div>
          ) : trendDrillBranches.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">No branch totals in this range.</div>
          ) : (
            <div className="space-y-2">
              {trendDrillBranches.map((branch, idx) => {
                const isResidual = Boolean(branch.residual);
                const rankIdx = trendDrillBranches
                  .slice(0, idx)
                  .filter((b) => !b.residual).length;
                const row = (
                  <>
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 ${
                          isResidual
                            ? 'bg-slate-100 text-slate-500'
                            : trendDrillBranchRankClass(trendDrillMetric)
                        }`}
                      >
                        {isResidual ? '·' : rankIdx + 1}
                      </span>
                      <span
                        className={`text-sm truncate ${
                          isResidual ? 'font-medium text-slate-500 italic' : 'font-semibold text-slate-900'
                        }`}
                      >
                        {branch.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`text-sm font-bold tabular-nums ${
                          isResidual ? 'text-slate-500' : 'text-slate-900'
                        }`}
                      >
                        {formatModalMoney(branch.amount)}
                      </span>
                      {!isResidual ? <ChevronRight size={16} className="text-slate-300" /> : null}
                    </div>
                  </>
                );
                if (isResidual) {
                  return (
                    <div
                      key={`residual-${branch.name}`}
                      className="w-full flex items-center justify-between gap-3 p-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/40"
                    >
                      {row}
                    </div>
                  );
                }
                return (
                  <button
                    key={branch.id}
                    type="button"
                    onClick={() => {
                      closeTrendDrillExpenseItems();
                      void openTrendDrillBreakdown(branch, {
                        chartTotal: Number(branch.amount) || 0,
                      });
                    }}
                    className="w-full text-left flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-100 bg-slate-50/60 hover:border-violet-200 hover:bg-violet-50/40 cursor-pointer transition-colors"
                  >
                    {row}
                  </button>
                );
              })}
            </div>
          )
        ) : trendDrillBreakdownLoading ? (
          <div className="py-10 text-center text-sm text-slate-500">Loading breakdown…</div>
        ) : trendDrillMetric === 'sales' ? (
          trendDrillSalesRows.length === 0 && trendDrillSalesRecon <= 0 && trendDrillSalesOther === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">No sales items in this range.</div>
          ) : (
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
                  {trendDrillSalesRows.map((row, idx) => (
                    <tr key={`${row.IDNo}-${idx}`} className="border-b border-slate-100 last:border-b-0">
                      <td className="px-3 py-2 text-sm font-semibold text-slate-700 tabular-nums">
                        {idx + 1}
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-800">{row.MENU_NAME || 'Unknown'}</td>
                      <td className="px-3 py-2 text-sm text-slate-700 text-right tabular-nums">
                        {Number(row.total_quantity || 0).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-sm font-bold text-slate-900 text-right tabular-nums">
                        {formatModalMoney(Number(row.total_revenue || 0))}
                      </td>
                    </tr>
                  ))}
                  {trendDrillSalesRecon > 0 ? (
                    <tr className="border-b border-teal-100 bg-teal-50/50">
                      <td className="px-3 py-2 text-sm text-teal-800">—</td>
                      <td className="px-3 py-2 text-sm font-semibold text-teal-900">
                        {t('cash_reconciliation.card_cash_reconciliation')}
                      </td>
                      <td className="px-3 py-2 text-sm text-teal-700 text-right tabular-nums">—</td>
                      <td className="px-3 py-2 text-sm font-bold text-teal-900 text-right tabular-nums">
                        {formatModalMoney(trendDrillSalesRecon)}
                      </td>
                    </tr>
                  ) : null}
                  {trendDrillSalesOther !== 0 ? (
                    <tr className="border-b border-slate-100 bg-slate-50/70">
                      <td className="px-3 py-2 text-sm text-slate-500">—</td>
                      <td className="px-3 py-2 text-sm font-medium italic text-slate-500">
                        Other sales
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-400 text-right tabular-nums">—</td>
                      <td className="px-3 py-2 text-sm font-bold tabular-nums text-slate-600 text-right">
                        {formatModalMoney(trendDrillSalesOther)}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )
        ) : trendDrillExpenseGroups.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-500">No expense categories in this range.</div>
        ) : (
          <TrendDrillExpenseAccordion
            key={`${trendDrillBranch?.id ?? 0}|${trendDrillRange.start}|${trendDrillRange.end}`}
            groups={trendDrillExpenseGroups}
            onSubClick={(sub) => void openTrendDrillExpenseItems(sub)}
          />
        )}
      </Modal>

      <Modal
        isOpen={trendDrillExpenseSub !== null}
        onClose={closeTrendDrillExpenseItems}
        title={`${trendDrillExpenseSub?.name ?? 'Items'} · ${trendDrillBranch?.name ?? ''}`}
        subtitle={
          <p className="text-sm text-slate-500 m-0">
            {trendDrillExpenseSub?.main ? `${trendDrillExpenseSub.main} · ` : ''}
            {trendDrillLabel}
          </p>
        }
        maxWidth="2xl"
        bodyClassName="px-5 py-4"
        layerClassName="z-[70]"
        closeButtonClassName={`${trendDrillBranchRankClass('expenses')} hover:opacity-90`}
        footer={
          <div className="flex items-center justify-between gap-3 w-full">
            <span className="text-sm text-slate-500">
              {trendDrillExpenseItemsLoading
                ? 'Loading…'
                : `${trendDrillExpenseItems.length} item${trendDrillExpenseItems.length === 1 ? '' : 's'}`}
            </span>
            <div className="flex items-center gap-3">
              <span className="text-sm font-bold tabular-nums text-slate-800">
                Total{' '}
                {formatModalMoney(
                  trendDrillExpenseSub?.amount ?? trendDrillExpenseItemsTotal,
                )}
              </span>
              <button
                type="button"
                onClick={closeTrendDrillExpenseItems}
                className={`px-3 py-1.5 rounded-lg border-0 text-sm font-semibold shadow-sm hover:opacity-90 cursor-pointer ${trendDrillBranchRankClass('expenses')}`}
              >
                Close
              </button>
            </div>
          </div>
        }
      >
        {trendDrillExpenseItemsLoading ? (
          <div className="py-10 text-center text-sm text-slate-500">Loading items…</div>
        ) : trendDrillExpenseItems.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-500">No expense items in this range.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="px-3 py-2 text-xs font-bold text-slate-500 uppercase">#</th>
                  <th className="px-3 py-2 text-xs font-bold text-slate-500 uppercase">Item</th>
                  <th className="px-3 py-2 text-xs font-bold text-slate-500 uppercase text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {trendDrillExpenseItems.map((exp, idx) => (
                  <tr key={exp.id} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-3 py-2 text-sm font-semibold text-slate-700 tabular-nums">
                      {idx + 1}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-800">
                      <p className="font-medium">{exp.expDesc || exp.expName || '—'}</p>
                      {exp.expSource ? (
                        <p className="text-[11px] text-slate-400 mt-0.5">{exp.expSource}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-sm font-bold text-slate-900 text-right tabular-nums">
                      {formatModalMoney(Number(exp.expAmount) || 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      <CashReconciliationModal
        open={cashReconModalOpen}
        onClose={() => {
          setCashReconModalOpen(false);
          setCashReconModalBranch(null);
        }}
        onDataChanged={() => {
          const branchId = cashReconModalBranch?.id ?? activeBranchIdRef.current;
          invalidateBranchPrefetch(branchId);
          setAnalyticsReloadKey((k) => k + 1);
        }}
        branchId={cashReconModalBranch != null ? Number(cashReconModalBranch.id) : null}
        branchName={cashReconModalBranch?.name ?? '—'}
        dateRange={{
          start: compareDateRange.start || getCurrentMonthRange().start,
          end: compareDateRange.end || getCurrentMonthRange().end,
        }}
        reportBasis="total"
        reportNetSalesDisplay={formatModalMoney(
          cashReconModalBranch?.reportSalesPos ??
            Math.max(
              0,
              (cashReconModalBranch?.totalSales ?? 0) - (cashReconModalBranch?.reconTotal ?? 0),
            ),
        )}
        cashReconPeriodDisplay={formatModalMoney(cashReconModalBranch?.reconTotal ?? 0)}
        totalNetSalesDisplay={formatModalMoney(cashReconModalBranch?.totalSales ?? 0)}
      />
    </>
  );
};
