import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DatePicker from 'react-datepicker';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import {
  fetchAdminDashboardBundleApi,
  fetchTopSellingApi,
  type ApiDailyPerBranchItem,
  type ApiTopSellingItem,
} from '../../services/analyticsService';
import { fetchCashReconciliationAggregates } from '../../services/cashReconciliationService';
import { isExcludedFromAllBranchesView } from '../../utils/branchLogo';

type DateRange = { start: string; end: string };

export type SalesDayDrillOpenArgs = {
  saleDate: string;
  label: string;
  chartTotal: number;
};

type BranchRow = {
  id: number;
  name: string;
  amount: number;
  residual?: boolean;
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Day the user clicked on the Total sales chart. */
  initial: SalesDayDrillOpenArgs | null;
  /** Header date range — clamps prev/next navigation. */
  boundRange: DateRange;
  /** When set, skip branch list and open menus for this branch. */
  lockedBranch?: { id: number; name: string } | null;
  /** Optional preloaded day×branch rows (All Branches). */
  dailyPerBranch?: ApiDailyPerBranchItem[];
  /** Limit branch list when race-graph filter is active. */
  filterBranchIds?: number[];
  formatMoney: (n: number) => string;
};

const parseLocalYmd = (ymd: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const toYYYYMMDD = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const addDays = (d: Date, n: number) => {
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  next.setDate(next.getDate() + n);
  return next;
};

const formatDayLabel = (ymd: string) => {
  const d = parseLocalYmd(ymd);
  if (!d) return ymd;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const RANK_CLASS = 'bg-[rgb(139,92,246)] text-white';

export const SalesDayDrillModal: React.FC<Props> = ({
  open,
  onClose,
  initial,
  boundRange,
  lockedBranch = null,
  dailyPerBranch = [],
  filterBranchIds,
  formatMoney,
}) => {
  const { t } = useTranslation();
  const reqIdRef = useRef(0);

  const [step, setStep] = useState<'branches' | 'menus'>('branches');
  const [saleDate, setSaleDate] = useState('');
  const [label, setLabel] = useState('');
  const [chartTotal, setChartTotal] = useState<number | null>(null);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branch, setBranch] = useState<{ id: number; name: string } | null>(null);
  const [allowBranchNav, setAllowBranchNav] = useState(true);
  const [menuRows, setMenuRows] = useState<ApiTopSellingItem[]>([]);
  const [salesRecon, setSalesRecon] = useState(0);
  const [menusLoading, setMenusLoading] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const filterSet = useMemo(
    () => (filterBranchIds && filterBranchIds.length > 0 ? new Set(filterBranchIds) : null),
    [filterBranchIds],
  );

  const buildBranchesFromDaily = useCallback(
    (day: string): BranchRow[] | null => {
      if (!dailyPerBranch.length) return null;
      const rows = dailyPerBranch
        .filter((r) => String(r.sale_date).slice(0, 10) === day)
        .filter((r) => !isExcludedFromAllBranchesView(r.branch_name))
        .filter((r) => (filterSet ? filterSet.has(Number(r.branch_id)) : true))
        .map((r) => ({
          id: Number(r.branch_id),
          name: String(r.branch_name || `Branch ${r.branch_id}`),
          amount: Number(r.total_sales) || 0,
        }))
        .filter((r) => r.amount > 0)
        .sort((a, b) => b.amount - a.amount);
      return rows;
    },
    [dailyPerBranch, filterSet],
  );

  const loadBranches = useCallback(
    async (day: string, totalHint: number) => {
      const reqId = ++reqIdRef.current;
      setBranchesLoading(true);
      setBranches([]);

      const fromDaily = buildBranchesFromDaily(day);
      if (fromDaily && fromDaily.length > 0) {
        if (reqId !== reqIdRef.current) return;
        setBranches(fromDaily);
        setChartTotal(totalHint > 0 ? totalHint : fromDaily.reduce((s, b) => s + b.amount, 0));
        setBranchesLoading(false);
        return;
      }

      try {
        const bundle = await fetchAdminDashboardBundleApi({
          start: day,
          end: day,
          branchId: 'all',
          mode: 'drill',
        });
        if (reqId !== reqIdRef.current) return;
        const mapped = (bundle.branchCardsData || [])
          .filter((b) => b)
          .map((b) => {
            const grossRaw = b.reportSalesGross;
            const gross = Number(grossRaw);
            const salesAmount =
              grossRaw != null && Number.isFinite(gross) ? gross : Number(b.totalSales) || 0;
            return {
              id: Number(b.id),
              name: String(b.name || `Branch ${b.id}`),
              amount: salesAmount,
              residual: false as boolean | undefined,
            };
          });

        const visible = mapped
          .filter((b) => !isExcludedFromAllBranchesView(b.name) && b.amount > 0)
          .filter((b) => (filterSet ? filterSet.has(b.id) : true))
          .sort((a, b) => b.amount - a.amount);

        const excludedSum = mapped
          .filter((b) => isExcludedFromAllBranchesView(b.name))
          .reduce((sum, b) => sum + (Number(b.amount) || 0), 0);

        const rows = [...visible];
        if (!filterSet && Math.abs(excludedSum) >= 0.5) {
          rows.push({ id: -1, name: 'Other branches', amount: excludedSum, residual: true });
        }

        setBranches(rows);
        const listTotal = rows.reduce((s, b) => s + b.amount, 0);
        setChartTotal(totalHint > 0 ? totalHint : listTotal > 0 ? listTotal : null);
      } catch (err) {
        console.error('Sales day drill: failed to load branches', err);
        if (reqId === reqIdRef.current) setBranches([]);
      } finally {
        if (reqId === reqIdRef.current) setBranchesLoading(false);
      }
    },
    [buildBranchesFromDaily, filterSet],
  );

  const loadMenus = useCallback(
    async (branchId: number, day: string, totalHint?: number) => {
      const reqId = ++reqIdRef.current;
      setMenusLoading(true);
      setMenuRows([]);
      setSalesRecon(0);
      if (totalHint != null && totalHint > 0) setChartTotal(totalHint);

      try {
        const params = new URLSearchParams();
        params.set('start_date', day);
        params.set('end_date', day);
        params.set('limit', '50');
        params.set('branch_id', String(branchId));
        const [rows, recon] = await Promise.all([
          fetchTopSellingApi(params),
          fetchCashReconciliationAggregates({
            start: day,
            end: day,
            branchId: String(branchId),
          }).catch(() => ({ total: 0, byDate: {} as Record<string, number> })),
        ]);
        if (reqId !== reqIdRef.current) return;
        setMenuRows(Array.isArray(rows) ? rows : []);
        const reconAmt = Number(recon.byDate?.[day] ?? recon.total ?? 0);
        setSalesRecon(Number.isFinite(reconAmt) ? Math.max(0, reconAmt) : 0);
      } catch (err) {
        console.error('Sales day drill: failed to load menus', err);
        if (reqId === reqIdRef.current) {
          setMenuRows([]);
          setSalesRecon(0);
        }
      } finally {
        if (reqId === reqIdRef.current) setMenusLoading(false);
      }
    },
    [],
  );

  const openForDay = useCallback(
    async (args: SalesDayDrillOpenArgs) => {
      const day = String(args.saleDate).slice(0, 10);
      setSaleDate(day);
      setLabel(args.label || formatDayLabel(day));
      setChartTotal(args.chartTotal > 0 ? args.chartTotal : null);
      setCalendarOpen(false);

      if (lockedBranch && lockedBranch.id > 0) {
        setAllowBranchNav(false);
        setBranch(lockedBranch);
        setStep('menus');
        setBranches([]);
        void loadMenus(lockedBranch.id, day, args.chartTotal);
        return;
      }

      setAllowBranchNav(true);
      setBranch(null);
      setStep('branches');
      setMenuRows([]);
      setSalesRecon(0);
      await loadBranches(day, args.chartTotal);
    },
    [loadBranches, loadMenus, lockedBranch],
  );

  useEffect(() => {
    if (!open || !initial) return;
    void openForDay(initial);
  }, [open, initial, openForDay]);

  const canShift = useMemo(() => {
    if (!saleDate) return { prev: false, next: false };
    const d = parseLocalYmd(saleDate);
    if (!d) return { prev: false, next: false };
    const prev = toYYYYMMDD(addDays(d, -1));
    const next = toYYYYMMDD(addDays(d, 1));
    return {
      prev: !boundRange.start || prev >= boundRange.start,
      next: !boundRange.end || next <= boundRange.end,
    };
  }, [saleDate, boundRange.start, boundRange.end]);

  const shiftDay = useCallback(
    (delta: number) => {
      const d = parseLocalYmd(saleDate);
      if (!d) return;
      const next = toYYYYMMDD(addDays(d, delta));
      if (boundRange.start && next < boundRange.start) return;
      if (boundRange.end && next > boundRange.end) return;
      const nextLabel = formatDayLabel(next);
      void openForDay({ saleDate: next, label: nextLabel, chartTotal: 0 });
    },
    [saleDate, boundRange.start, boundRange.end, openForDay],
  );

  const jumpToDay = useCallback(
    (date: Date | null) => {
      if (!date) return;
      const ymd = toYYYYMMDD(date);
      if (boundRange.start && ymd < boundRange.start) return;
      if (boundRange.end && ymd > boundRange.end) return;
      setCalendarOpen(false);
      void openForDay({ saleDate: ymd, label: formatDayLabel(ymd), chartTotal: 0 });
    },
    [boundRange.start, boundRange.end, openForDay],
  );

  const openBranchMenus = useCallback(
    (row: BranchRow) => {
      if (row.residual || row.id < 0) return;
      setBranch({ id: row.id, name: row.name });
      setStep('menus');
      void loadMenus(row.id, saleDate, Number(row.amount) || 0);
    },
    [loadMenus, saleDate],
  );

  const menuTotal = useMemo(() => {
    const sum = menuRows.reduce((s, r) => s + (Number(r.total_revenue) || 0), 0);
    return sum + (Number(salesRecon) || 0);
  }, [menuRows, salesRecon]);

  const salesOther = useMemo(() => {
    if (chartTotal == null || chartTotal <= 0) return 0;
    const gap = chartTotal - menuTotal;
    return Math.abs(gap) >= 0.5 ? gap : 0;
  }, [chartTotal, menuTotal]);

  const branchesTotal = useMemo(() => {
    if (chartTotal != null && chartTotal > 0) return chartTotal;
    return branches.reduce((s, b) => s + b.amount, 0);
  }, [branches, chartTotal]);

  const footerTotal = step === 'branches' ? branchesTotal : chartTotal != null && chartTotal > 0 ? chartTotal : menuTotal;

  const pickerDate = useMemo(() => parseLocalYmd(saleDate), [saleDate]);
  const minDate = useMemo(() => parseLocalYmd(boundRange.start) ?? undefined, [boundRange.start]);
  const maxDate = useMemo(() => parseLocalYmd(boundRange.end) ?? undefined, [boundRange.end]);

  const busy = branchesLoading || menusLoading;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={
        step === 'branches'
          ? 'Sales by branch'
          : `Top menus · ${branch?.name ?? ''}`
      }
      subtitle={
        <div className="flex flex-col items-start gap-1.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous date"
              disabled={!canShift.prev || busy}
              onClick={() => shiftDay(-1)}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border-0 shadow-sm hover:opacity-90 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer ${RANK_CLASS}`}
            >
              <ChevronLeft size={16} />
            </button>
            <div className="relative">
              <button
                type="button"
                aria-label="Pick date"
                title="Click to pick a date"
                onClick={() => setCalendarOpen((o) => !o)}
                className="text-sm text-slate-700 m-0 min-w-[7.5rem] px-2 py-1 rounded-lg text-center font-semibold tabular-nums cursor-pointer hover:bg-slate-100 border border-transparent hover:border-slate-200"
              >
                {label || formatDayLabel(saleDate)}
              </button>
              {calendarOpen ? (
                <>
                  <div
                    className="fixed inset-0 z-[85]"
                    onClick={() => setCalendarOpen(false)}
                    aria-hidden
                  />
                  <div
                    className="absolute z-[90] top-full left-1/2 -translate-x-1/2 mt-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DatePicker
                      inline
                      selected={pickerDate}
                      onChange={jumpToDay}
                      minDate={minDate}
                      maxDate={maxDate}
                      calendarClassName="react-datepicker-material"
                    />
                  </div>
                </>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Next date"
              disabled={!canShift.next || busy}
              onClick={() => shiftDay(1)}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border-0 shadow-sm hover:opacity-90 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer ${RANK_CLASS}`}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          {step === 'menus' && allowBranchNav ? (
            <button
              type="button"
              onClick={() => {
                setStep('branches');
                setBranch(null);
                setMenuRows([]);
                setSalesRecon(0);
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
      closeButtonClassName={`${RANK_CLASS} hover:opacity-90`}
      footer={
        <div className="flex items-center justify-between gap-3 w-full">
          <span className="text-sm text-slate-500">
            {step === 'branches'
              ? branchesLoading
                ? 'Loading…'
                : `${branches.filter((b) => !b.residual).length} branch${
                    branches.filter((b) => !b.residual).length === 1 ? '' : 'es'
                  }`
              : branch?.name ?? ''}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-sm font-bold tabular-nums text-slate-800">
              Total {formatMoney(footerTotal)}
            </span>
            <button
              type="button"
              onClick={onClose}
              className={`px-3 py-1.5 rounded-lg border-0 text-sm font-semibold shadow-sm hover:opacity-90 cursor-pointer ${RANK_CLASS}`}
            >
              Close
            </button>
          </div>
        </div>
      }
    >
      {step === 'branches' ? (
        branchesLoading ? (
          <div className="py-10 text-center text-sm text-slate-500">Loading branches…</div>
        ) : branches.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-500">No branch totals in this range.</div>
        ) : (
          <div className="space-y-2">
            {branches.map((row, idx) => {
              const isResidual = Boolean(row.residual);
              const rankIdx = branches.slice(0, idx).filter((b) => !b.residual).length;
              const content = (
                <>
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 ${
                        isResidual ? 'bg-slate-100 text-slate-500' : RANK_CLASS
                      }`}
                    >
                      {isResidual ? '·' : rankIdx + 1}
                    </span>
                    <span
                      className={`text-sm truncate ${
                        isResidual ? 'font-medium text-slate-500 italic' : 'font-semibold text-slate-900'
                      }`}
                    >
                      {row.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`text-sm font-bold tabular-nums ${
                        isResidual ? 'text-slate-500' : 'text-slate-900'
                      }`}
                    >
                      {formatMoney(row.amount)}
                    </span>
                    {!isResidual ? <ChevronRight size={16} className="text-slate-300" /> : null}
                  </div>
                </>
              );
              if (isResidual) {
                return (
                  <div
                    key={`residual-${row.name}`}
                    className="w-full flex items-center justify-between gap-3 p-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/40"
                  >
                    {content}
                  </div>
                );
              }
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => openBranchMenus(row)}
                  className="w-full text-left flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-100 bg-slate-50/60 hover:border-violet-200 hover:bg-violet-50/40 cursor-pointer transition-colors"
                >
                  {content}
                </button>
              );
            })}
          </div>
        )
      ) : menusLoading ? (
        <div className="py-10 text-center text-sm text-slate-500">Loading breakdown…</div>
      ) : menuRows.length === 0 && salesRecon <= 0 && salesOther === 0 ? (
        <div className="py-10 text-center text-sm text-slate-500">No sales items in this range.</div>
      ) : (
        <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-slate-200">
                <th className="px-3 py-2 text-xs font-bold text-slate-500 uppercase">#</th>
                <th className="px-3 py-2 text-xs font-bold text-slate-500 uppercase">Menu</th>
                <th className="px-3 py-2 text-xs font-bold text-slate-500 uppercase text-right">Qty</th>
                <th className="px-3 py-2 text-xs font-bold text-slate-500 uppercase text-right">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {menuRows.map((row, idx) => (
                <tr key={`${row.IDNo}-${idx}`} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-3 py-2 text-sm font-semibold text-slate-700 tabular-nums">
                    {idx + 1}
                  </td>
                  <td className="px-3 py-2 text-sm text-slate-800">{row.MENU_NAME || 'Unknown'}</td>
                  <td className="px-3 py-2 text-sm text-slate-700 text-right tabular-nums">
                    {Number(row.total_quantity || 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-sm font-bold text-slate-900 text-right tabular-nums">
                    {formatMoney(Number(row.total_revenue || 0))}
                  </td>
                </tr>
              ))}
              {salesRecon > 0 ? (
                <tr className="border-b border-teal-100 bg-teal-50/50">
                  <td className="px-3 py-2 text-sm text-teal-800">—</td>
                  <td className="px-3 py-2 text-sm font-semibold text-teal-900">
                    {t('cash_reconciliation.card_cash_reconciliation')}
                  </td>
                  <td className="px-3 py-2 text-sm text-teal-700 text-right tabular-nums">—</td>
                  <td className="px-3 py-2 text-sm font-bold text-teal-900 text-right tabular-nums">
                    {formatMoney(salesRecon)}
                  </td>
                </tr>
              ) : null}
              {salesOther !== 0 ? (
                <tr className="border-b border-slate-100 bg-slate-50/70">
                  <td className="px-3 py-2 text-sm text-slate-500">—</td>
                  <td className="px-3 py-2 text-sm font-medium italic text-slate-500">Other sales</td>
                  <td className="px-3 py-2 text-sm text-slate-400 text-right tabular-nums">—</td>
                  <td className="px-3 py-2 text-sm font-bold tabular-nums text-slate-600 text-right">
                    {formatMoney(salesOther)}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
};
