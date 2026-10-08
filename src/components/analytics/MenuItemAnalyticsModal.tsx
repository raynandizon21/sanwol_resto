import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, BarChart3 } from 'lucide-react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { Modal } from '../ui/Modal';
import { fetchMenuItemTrendApi } from '../../services/analyticsService';

type DateRange = { start: string; end: string };

export type MenuItemAnalyticsTarget = {
  goods: string;
  branchId: number | null;
  branchName: string;
  amount: number;
  qty: number;
};

type MetricPair = { amount: number; qty: number };

type CompareRow = {
  id: string;
  label: string;
  current: MetricPair;
  previous: MetricPair;
};

type MenuItemAnalyticsPanelProps = {
  target: MenuItemAnalyticsTarget | null;
  dateRange: DateRange;
  /** When false, skip fetching (e.g. panel hidden). Default true. */
  active?: boolean;
  className?: string;
  /** Hide card chrome/header — used inside Modal which already has a title. */
  bare?: boolean;
};

type MenuItemAnalyticsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  target: MenuItemAnalyticsTarget | null;
  dateRange: DateRange;
};

const CHART_COLOR_QTY = 'rgb(139, 92, 246)';
const CHART_COLOR_AMOUNT = 'rgb(16, 185, 129)';

const toYYYYMMDD = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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

const shiftMonthClamped = (d: Date, deltaMonths: number): Date => {
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + deltaMonths, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
};

const getSamePeriodWindows = (
  start: string,
  end: string,
  lookbackDays = 3,
): { current: DateRange; previous: DateRange } | null => {
  const s = parseLocalYmd(start);
  const e = parseLocalYmd(end);
  if (!s || !e || s > e) return null;

  let currentEnd = addDaysLocal(e, -lookbackDays);
  if (currentEnd < s) currentEnd = new Date(s.getFullYear(), s.getMonth(), s.getDate());

  return {
    current: { start: toYYYYMMDD(s), end: toYYYYMMDD(currentEnd) },
    previous: {
      start: toYYYYMMDD(shiftMonthClamped(s, -1)),
      end: toYYYYMMDD(shiftMonthClamped(currentEnd, -1)),
    },
  };
};

const getMtdVsFullPreviousMonth = (end: string): { current: DateRange; previous: DateRange } | null => {
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

const monthLabel = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
};

const money = (n: number): string =>
  `₱${Math.trunc(Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/** Compact Y-axis tick: ₱1.2M / ₱450k / ₱0 */
const axisMoney = (v: number): string => {
  const n = Number(v) || 0;
  if (n === 0) return '₱0';
  if (Math.abs(n) >= 1_000_000) {
    const m = n / 1_000_000;
    return `₱${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (Math.abs(n) >= 1_000) return `₱${Math.round(n / 1_000)}k`;
  return money(n);
};

const pctChange = (current: number, previous: number): number | null => {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (Math.abs(prev) < 1) return null;
  return ((cur - prev) / prev) * 100;
};

/** Branch Comparison index: 100 = flat, 104.4 = +4.4%. */
const monthIndexFromPct = (percentChange: number): number => 100 + (Number(percentChange) || 0);

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

type DailyChartPoint = {
  date: string;
  label: string;
  dayNum: number;
  dayName: string;
  qty: number;
  amount: number;
  isSaturday: boolean;
  isSunday: boolean;
};

const sumDailyInRange = (
  daily: Array<{ sale_date: string; qty: number; amount: number }>,
  range: DateRange | null,
): MetricPair => {
  if (!range) return { amount: 0, qty: 0 };
  let amount = 0;
  let qty = 0;
  for (const row of daily) {
    const d = String(row.sale_date || '').slice(0, 10);
    if (d < range.start || d > range.end) continue;
    amount += Number(row.amount) || 0;
    qty += Number(row.qty) || 0;
  }
  return { amount, qty };
};

/** Zero-filled calendar series for the selected header date range. */
const buildDailySeries = (
  daily: Array<{ sale_date: string; qty: number; amount: number }>,
  range: DateRange,
): DailyChartPoint[] => {
  const byDate = new Map<string, { qty: number; amount: number }>();
  for (const row of daily) {
    const d = String(row.sale_date || '').slice(0, 10);
    if (!d) continue;
    const prev = byDate.get(d) || { qty: 0, amount: 0 };
    byDate.set(d, {
      qty: prev.qty + (Number(row.qty) || 0),
      amount: prev.amount + (Number(row.amount) || 0),
    });
  }

  const start = parseLocalYmd(range.start);
  const end = parseLocalYmd(range.end);
  if (!start || !end || start > end) return [];

  const points: DailyChartPoint[] = [];
  for (let cur = new Date(start.getFullYear(), start.getMonth(), start.getDate()); cur <= end; ) {
    const date = toYYYYMMDD(cur);
    const jsDay = cur.getDay();
    const hit = byDate.get(date) || { qty: 0, amount: 0 };
    points.push({
      date,
      label: cur.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }),
      dayNum: cur.getDate(),
      dayName: DAY_NAMES[jsDay],
      qty: hit.qty,
      amount: hit.amount,
      isSaturday: jsDay === 6,
      isSunday: jsDay === 0,
    });
    cur = addDaysLocal(cur, 1);
  }
  return points;
};

function useMenuItemAnalytics(
  target: MenuItemAnalyticsTarget | null,
  dateRange: DateRange,
  active: boolean,
) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareRows, setCompareRows] = useState<CompareRow[]>([]);
  const [monthly, setMonthly] = useState<Array<{ label: string; amount: number; qty: number }>>([]);
  const [dailySeries, setDailySeries] = useState<DailyChartPoint[]>([]);
  const [trendYear, setTrendYear] = useState<string>('');

  useEffect(() => {
    if (!active || !target) return;

    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const same = getSamePeriodWindows(dateRange.start, dateRange.end);
        const mtd = getMtdVsFullPreviousMonth(dateRange.end);
        const endDate = parseLocalYmd(dateRange.end) || new Date();

        // Cover 6 calendar months + same-period previous window + selected range in one fetch.
        const chartStart = new Date(endDate.getFullYear(), endDate.getMonth() - 5, 1);
        const fetchStartCandidates = [toYYYYMMDD(chartStart), dateRange.start];
        if (same?.previous.start) fetchStartCandidates.push(same.previous.start);
        if (mtd?.previous.start) fetchStartCandidates.push(mtd.previous.start);
        const fetchStart = fetchStartCandidates.filter(Boolean).sort()[0];
        const fetchEnd = toYYYYMMDD(endDate);

        const daily = await fetchMenuItemTrendApi({
          goods: target.goods,
          start: fetchStart,
          end: fetchEnd,
          branchId: target.branchId,
        });

        if (cancelled) return;

        setDailySeries(buildDailySeries(daily, dateRange));

        const sameCur = sumDailyInRange(daily, same?.current ?? null);
        const samePrev = sumDailyInRange(daily, same?.previous ?? null);
        const mtdCur = sumDailyInRange(daily, mtd?.current ?? null);
        const mtdPrev = sumDailyInRange(daily, mtd?.previous ?? null);

        const last3Full: DateRange[] = [];
        for (let i = 1; i <= 3; i += 1) {
          const start = new Date(endDate.getFullYear(), endDate.getMonth() - i, 1);
          const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
          last3Full.push({ start: toYYYYMMDD(start), end: toYYYYMMDD(end) });
        }
        const avgParts = last3Full.map((r) => sumDailyInRange(daily, r));
        const avg: MetricPair = {
          amount: avgParts.reduce((s, p) => s + p.amount, 0) / Math.max(avgParts.length, 1),
          qty: avgParts.reduce((s, p) => s + p.qty, 0) / Math.max(avgParts.length, 1),
        };

        setCompareRows([
          {
            id: 'same_period',
            label: t('sales_analytics.item_analytics_vs_same_period'),
            current: sameCur,
            previous: samePrev,
          },
          {
            id: 'vs_last_month',
            label: t('sales_analytics.item_analytics_vs_last_month'),
            current: mtdCur,
            previous: mtdPrev,
          },
          {
            id: 'vs_average',
            label: t('sales_analytics.item_analytics_vs_average'),
            current: mtdCur,
            previous: avg,
          },
        ]);

        const monthRows: Array<{ label: string; amount: number; qty: number }> = [];
        const years = new Set<number>();
        for (let i = 5; i >= 0; i -= 1) {
          const start = new Date(endDate.getFullYear(), endDate.getMonth() - i, 1);
          years.add(start.getFullYear());
          const isCurrent =
            start.getFullYear() === endDate.getFullYear() && start.getMonth() === endDate.getMonth();
          const end = isCurrent
            ? endDate
            : new Date(start.getFullYear(), start.getMonth() + 1, 0);
          const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
          const totals = sumDailyInRange(daily, {
            start: toYYYYMMDD(start),
            end: toYYYYMMDD(end),
          });
          monthRows.push({
            label: monthLabel(key),
            amount: totals.amount,
            qty: totals.qty,
          });
        }
        const yearList = [...years].sort((a, b) => a - b);
        setTrendYear(
          yearList.length <= 1 ? String(yearList[0] ?? endDate.getFullYear()) : `${yearList[0]}–${yearList[yearList.length - 1]}`,
        );
        setMonthly(monthRows);
      } catch (err) {
        if (cancelled) return;
        console.error(err);
        setError(t('sales_analytics.network_error'));
        setCompareRows([]);
        setMonthly([]);
        setDailySeries([]);
        setTrendYear('');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [active, target?.goods, target?.branchId, target?.branchName, dateRange.start, dateRange.end, t]);

  return { loading, error, compareRows, monthly, dailySeries, trendYear, t };
}

const CompareValue: React.FC<{
  current: number;
  previous: number;
  asMoney: boolean;
}> = ({ current, previous, asMoney }) => {
  const pct = pctChange(current, previous);
  const index = pct != null ? monthIndexFromPct(pct) : null;
  const up = index != null && index >= 100;
  // Match Branch Comparison: baseline amount + index % (e.g. 104.4%).
  const display = asMoney
    ? money(previous)
    : `${Math.round(previous).toLocaleString()}`;

  return (
    <div className="flex items-baseline justify-end gap-1 min-w-0">
      <span className="text-xs font-semibold text-slate-700 tabular-nums truncate">{display}</span>
      {index == null ? (
        <span className="text-[10px] font-medium text-slate-400">—</span>
      ) : (
        <span
          className={`text-[10px] font-medium ${
            up ? 'text-emerald-600' : 'text-red-500'
          }`}
        >
          ({index.toFixed(1)}%)
        </span>
      )}
    </div>
  );
};

/** Inline analytics card — used beside Top Revenue Items on single-branch view. */
export const MenuItemAnalyticsPanel: React.FC<MenuItemAnalyticsPanelProps> = ({
  target,
  dateRange,
  active = true,
  className = '',
  bare = false,
}) => {
  const { loading, error, compareRows, monthly, dailySeries, trendYear, t } = useMenuItemAnalytics(
    target,
    dateRange,
    active,
  );

  const emptyMonthly = monthly.every((m) => m.amount === 0 && m.qty === 0);
  const withSales = dailySeries.filter((d) => d.qty > 0);
  const bestDay = withSales.length
    ? [...withSales].sort((a, b) => b.qty - a.qty || b.amount - a.amount)[0]
    : null;
  const bestDayLabel = (() => {
    if (!bestDay) return '—';
    const d = parseLocalYmd(bestDay.date);
    const fullDate = d
      ? d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : bestDay.date;
    return `${fullDate} · ${bestDay.dayName}`;
  })();
  const periodQty = dailySeries.reduce((s, d) => s + d.qty, 0);
  const periodAmount = dailySeries.reduce((s, d) => s + d.amount, 0);
  const emptyDaily = dailySeries.length === 0 || periodQty === 0;
  const monthlyQtyAvg = Math.round(
    monthly.reduce((s, m) => s + m.qty, 0) / Math.max(monthly.length, 1),
  );
  const monthlyAmountAvg =
    monthly.reduce((s, m) => s + m.amount, 0) / Math.max(monthly.length, 1);

  const body = (
    <div
      className={`flex-1 min-h-0 min-w-0 max-w-full overflow-y-auto overflow-x-hidden flex flex-col ${
        bare ? 'px-5 py-3' : 'px-3 py-2.5'
      }`}
    >
      {!target ? (
        <div className="flex flex-1 min-h-[160px] flex-col items-center justify-center text-center text-sm text-slate-400">
          <BarChart3 size={32} className="mb-2 text-slate-300" />
          {t('sales_analytics.item_analytics_pick_item')}
        </div>
      ) : loading ? (
        <div className="flex flex-1 min-h-[160px] items-center justify-center">
          <Loader2 size={24} className="animate-spin text-violet-500" />
        </div>
      ) : error ? (
        <div className="flex flex-1 min-h-[120px] items-center justify-center text-sm text-red-500 font-medium">
          {error}
        </div>
      ) : (
        <div className="flex flex-col gap-2 min-w-0 max-w-full">
          {/* KPI strip */}
          <div className="grid grid-cols-3 gap-1.5">
            <div className="rounded-lg bg-emerald-50/70 border border-emerald-100 px-2 py-1.5 min-w-0">
              <div className="text-[9px] font-semibold uppercase tracking-wide text-emerald-700/80">
                {t('sales_analytics.item_analytics_best_day')}
              </div>
              <div className="text-[11px] font-bold text-emerald-700 leading-snug">
                {bestDayLabel}
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 border border-slate-100 px-2 py-1.5 min-w-0">
              <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                {t('sales_analytics.item_analytics_day_sales')}
              </div>
              <div className="text-sm font-bold text-slate-900 tabular-nums truncate">
                {bestDay ? money(bestDay.amount) : '—'}
              </div>
              <div className="text-[10px] text-violet-600 font-semibold tabular-nums truncate leading-tight">
                {bestDay ? `${bestDay.qty.toLocaleString()} ${t('sales_analytics.sold')}` : '—'}
              </div>
            </div>
            <div className="rounded-lg bg-violet-50/70 border border-violet-100 px-2 py-1.5 min-w-0">
              <div className="text-[9px] font-semibold uppercase tracking-wide text-violet-700/80">
                {t('sales_analytics.item_analytics_period_total')}
              </div>
              <div className="text-sm font-bold text-violet-800 tabular-nums truncate">
                {money(periodAmount)}
              </div>
              <div className="text-[10px] text-violet-600 font-semibold tabular-nums truncate leading-tight">
                {periodQty.toLocaleString()} {t('sales_analytics.sold')}
              </div>
            </div>
          </div>

          {/* Daily chart — fixed compact height */}
          <div className="rounded-lg border border-slate-200 bg-white p-2">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="text-[11px] font-semibold text-slate-700">
                {t('sales_analytics.item_analytics_daily_sales')}
              </p>
              <span className="text-[9px] text-slate-400">
                {t('sales_analytics.item_analytics_peak_hint')}
              </span>
            </div>
            {emptyDaily ? (
              <div className="h-32 flex items-center justify-center text-sm text-slate-500">
                {t('sales_analytics.item_analytics_no_daily')}
              </div>
            ) : (
              <div className="h-36 w-full min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={dailySeries}
                    margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                    barCategoryGap="12%"
                  >
                    <CartesianGrid stroke="#eef2ff" vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="dayNum"
                      interval={0}
                      height={20}
                      tickLine={false}
                      axisLine={false}
                      tick={({ x, y, payload }: { x?: number; y?: number; payload?: { value: number } }) => {
                        const point = dailySeries.find((d) => d.dayNum === Number(payload?.value));
                        const fill = point?.isSaturday
                          ? '#f87171'
                          : point?.isSunday
                            ? '#34d399'
                            : '#64748b';
                        return (
                          <text
                            x={x}
                            y={(y ?? 0) + 12}
                            textAnchor="middle"
                            fill={fill}
                            fontSize={10}
                            fontWeight={700}
                          >
                            {payload?.value}
                          </text>
                        );
                      }}
                    />
                    <YAxis
                      tick={{ fill: '#7c3aed', fontSize: 9 }}
                      axisLine={false}
                      tickLine={false}
                      width={28}
                      allowDecimals={false}
                    />
                    <Tooltip
                      formatter={(value: number, _name: string, props: { payload?: DailyChartPoint }) => {
                        const rev = Number(props?.payload?.amount) || 0;
                        return [
                          `${Math.round(Number(value) || 0).toLocaleString()} ${t('sales_analytics.sold')} · ${money(rev)}`,
                          t('sales_analytics.item_analytics_day_sales'),
                        ];
                      }}
                      labelFormatter={(_label, payload) => {
                        const p = payload?.[0]?.payload as DailyChartPoint | undefined;
                        return p ? `${p.label} (${p.dayName})` : '';
                      }}
                      contentStyle={{
                        borderRadius: 10,
                        border: '1px solid #e2e8f0',
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="qty" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                      {dailySeries.map((point) => (
                        <Cell
                          key={point.date}
                          fill={
                            bestDay && point.date === bestDay.date
                              ? '#34d399'
                              : point.qty > 0
                                ? CHART_COLOR_QTY
                                : '#e2e8f0'
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Compare — compact */}
          <div className="rounded-lg border border-slate-200 overflow-hidden min-w-0">
            <div className="px-2.5 py-1 bg-slate-50 border-b border-slate-100">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                {t('sales_analytics.item_analytics_comparison')}
              </p>
            </div>
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[42%]" />
                <col className="w-[29%]" />
                <col className="w-[29%]" />
              </colgroup>
              <thead>
                <tr className="text-left text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                  <th className="px-2.5 py-1">{t('sales_analytics.item_analytics_metric')}</th>
                  <th className="px-2 py-1 text-right">{t('sales_analytics.item_analytics_sold_qty')}</th>
                  <th className="px-2 py-1 text-right">{t('sales_analytics.item_analytics_amount')}</th>
                </tr>
              </thead>
              <tbody>
                {compareRows.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <td className="px-2.5 py-1 text-[11px] text-slate-700 font-medium leading-snug break-words">
                      {row.label}
                    </td>
                    <td className="px-2 py-1 overflow-hidden">
                      <CompareValue
                        current={row.current.qty}
                        previous={row.previous.qty}
                        asMoney={false}
                      />
                    </td>
                    <td className="px-2 py-1 overflow-hidden">
                      <CompareValue
                        current={row.current.amount}
                        previous={row.previous.amount}
                        asMoney
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Monthly — full-width cards, same size as Daily sales */}
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold text-slate-700">
              {t('sales_analytics.item_analytics_monthly_trend')}
            </p>
            {trendYear ? (
              <span className="text-[10px] font-medium text-slate-400">{trendYear}</span>
            ) : null}
          </div>
          {emptyMonthly ? (
            <div className="h-36 flex items-center justify-center text-sm text-slate-500 rounded-lg border border-slate-100">
              {t('sales_analytics.no_data_available')}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 min-w-0">
              <div className="rounded-lg border border-slate-200 bg-white p-2 min-w-0 overflow-hidden">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-[11px] font-semibold text-violet-800">
                    {t('sales_analytics.item_analytics_sold_qty')}
                  </span>
                  <span className="text-[10px] font-semibold text-violet-600 tabular-nums">
                    {monthlyQtyAvg.toLocaleString()} avg
                  </span>
                </div>
                <div className="h-36 w-full min-w-0 overflow-hidden">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={monthly}
                      margin={{ top: 4, right: 12, left: 0, bottom: 2 }}
                      barCategoryGap="12%"
                    >
                      <CartesianGrid stroke="#eef2ff" vertical={false} strokeDasharray="3 3" />
                      <XAxis
                        dataKey="label"
                        tick={{ fill: '#64748b', fontSize: 10, fontWeight: 600 }}
                        axisLine={false}
                        tickLine={false}
                        interval={0}
                        height={22}
                        padding={{ left: 4, right: 8 }}
                      />
                      <YAxis
                        tick={{ fill: '#7c3aed', fontSize: 9 }}
                        axisLine={false}
                        tickLine={false}
                        width={28}
                        allowDecimals={false}
                      />
                      <Tooltip
                        formatter={(value: number) => [
                          Math.round(Number(value) || 0).toLocaleString(),
                          t('sales_analytics.item_analytics_sold_qty'),
                        ]}
                        contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 11 }}
                      />
                      <Bar dataKey="qty" fill={CHART_COLOR_QTY} radius={[4, 4, 0, 0]} barSize={18} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-2 min-w-0 overflow-hidden">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-[11px] font-semibold text-emerald-800 truncate">
                    {t('sales_analytics.item_analytics_amount')}
                  </span>
                  <span className="text-[10px] font-semibold text-emerald-600 tabular-nums shrink-0">
                    {money(monthlyAmountAvg)} avg
                  </span>
                </div>
                <div className="h-36 w-full min-w-0 overflow-hidden">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={monthly} margin={{ top: 4, right: 14, left: 0, bottom: 2 }}>
                      <defs>
                        <linearGradient id="itemSalesFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={CHART_COLOR_AMOUNT} stopOpacity={0.35} />
                          <stop offset="100%" stopColor={CHART_COLOR_AMOUNT} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#d1fae5" vertical={false} strokeDasharray="3 3" />
                      <XAxis
                        dataKey="label"
                        tick={{ fill: '#64748b', fontSize: 10, fontWeight: 600 }}
                        axisLine={false}
                        tickLine={false}
                        interval={0}
                        height={22}
                        padding={{ left: 4, right: 10 }}
                      />
                      <YAxis
                        tick={{ fill: '#059669', fontSize: 9 }}
                        tickFormatter={(v) => axisMoney(Number(v))}
                        axisLine={false}
                        tickLine={false}
                        width={36}
                      />
                      <Tooltip
                        formatter={(value: number) => [
                          money(value),
                          t('sales_analytics.item_analytics_amount'),
                        ]}
                        contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 11 }}
                      />
                      <Area
                        type="monotone"
                        dataKey="amount"
                        stroke={CHART_COLOR_AMOUNT}
                        strokeWidth={2}
                        fill="url(#itemSalesFill)"
                        dot={{ r: 3, fill: CHART_COLOR_AMOUNT, strokeWidth: 0 }}
                        activeDot={{ r: 4 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (bare) return body;

  return (
    <div
      className={`bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden flex flex-col w-full h-full min-h-0 ${className}`}
    >
      <div className="flex items-start justify-between gap-3 px-3 py-2.5 border-b border-gray-100 shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-violet-100 text-violet-600 shrink-0">
              <BarChart3 size={13} />
            </span>
            <h4 className="text-sm font-semibold text-slate-900 truncate">
              {target?.goods || t('sales_analytics.item_analytics_title')}
            </h4>
          </div>
          {target ? (
            <p className="text-[10px] font-medium text-slate-500 pl-8 mt-0.5">
              {t('sales_analytics.high_revenue')} · {target.branchName}
            </p>
          ) : (
            <p className="text-[10px] font-medium text-slate-400 pl-8 mt-0.5">
              {t('sales_analytics.item_analytics_pick_item')}
            </p>
          )}
        </div>
      </div>
      {body}
    </div>
  );
};

/** Modal wrapper — used on All Branches view. */
export const MenuItemAnalyticsModal: React.FC<MenuItemAnalyticsModalProps> = ({
  isOpen,
  onClose,
  target,
  dateRange,
}) => {
  const { t } = useTranslation();
  const subtitle = useMemo(() => {
    if (!target) return null;
    return (
      <span className="text-xs text-slate-500">
        {t('sales_analytics.high_revenue')} · {target.branchName}
      </span>
    );
  }, [target, t]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={target?.goods || t('sales_analytics.item_analytics_title')}
      subtitle={subtitle}
      maxWidth="4xl"
      bodyClassName="p-0 overflow-x-hidden"
      panelClassName="overflow-hidden"
    >
      <MenuItemAnalyticsPanel
        target={target}
        dateRange={dateRange}
        active={isOpen}
        bare
      />
    </Modal>
  );
};
