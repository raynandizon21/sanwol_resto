import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Loader2,
  AlertCircle,
  Plus,
  Pencil,
  Trash2,
  Search,
  ChevronLeft,
  ChevronRight,
  Check,
  AlertTriangle,
} from 'lucide-react';
import {
  fetchCashReconciliation,
  createCashReconciliation,
  updateCashReconciliation,
  deleteCashReconciliation,
  type CashReconciliationRow,
} from '../../services/cashReconciliationService';
import { showsMoneyCents } from '../../utils/branchFeatures';

const formatMoney = (value: number, withCents = false) => {
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

const parseAmount = (row: CashReconciliationRow) => {
  const raw = row.AMOUNT;
  return typeof raw === 'string' ? Number(raw) : Number(raw ?? 0);
};

/** Digits + optional single decimal (max 2 places), strip other chars */
const sanitizeAmountTyping = (s: string) => {
  let t = s.replace(/,/g, '').replace(/[^\d.]/g, '');
  const firstDot = t.indexOf('.');
  if (firstDot !== -1) {
    const intP = t.slice(0, firstDot);
    const decP = t.slice(firstDot + 1).replace(/\./g, '').slice(0, 2);
    t = intP + (t.includes('.') ? `.${decP}` : '');
  }
  return t;
};

const formatAmountWithCommas = (sanitized: string) => {
  if (!sanitized) return '';
  if (sanitized === '.') return '0.';
  const hasDot = sanitized.includes('.');
  const [intRaw, ...decParts] = sanitized.split('.');
  const dec = decParts.join('').slice(0, 2);
  let intDigits = intRaw ?? '';
  if (intDigits === '' && hasDot) intDigits = '0';
  if (intDigits === '' && !hasDot) return '';
  const intClean = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return hasDot ? `${intClean}.${dec}` : intClean;
};

const parseFormattedAmountToNumber = (display: string) => {
  const n = Number(display.replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

const formatEncodedDt = (v: string | null | undefined) => {
  if (v == null || v === '') return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/** Calendar date YYYY-MM-DD from API. Prefer over slice(0,10) on ISO datetimes (avoids ±1 day from TZ). */
const businessDateYmd = (v: unknown): string => {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
};

/** Display BUSINESS_DATE like Encoded’s date part (e.g. Apr 14, 2026); parse YMD at noon to avoid TZ shift. */
const formatBusinessDateDisplay = (v: unknown) => {
  const ymd = businessDateYmd(v);
  if (!ymd) return '—';
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
};

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

type CashReconciliationModalProps = {
  open: boolean;
  onClose: () => void;
  /** Refetch parent aggregates (e.g. net sales KPI) after list changes */
  onDataChanged?: () => void;
  branchId: number | null;
  branchName: string;
  dateRange: { start: string; end: string };
  /** Daily-sales report (no reconciliation): net when `reportBasis` is net, gross total_sales when `total` */
  reportNetSalesDisplay: string;
  /** Sum of cash reconciliation amounts for the period */
  cashReconPeriodDisplay: string;
  /** Report + cash reconciliation (matches opened KPI: Net sales or Total sales) */
  totalNetSalesDisplay: string;
  /** `net` = Sales Analytics / Net sales row; `total` = gross POS + recon (Admin branch cards) */
  reportBasis?: 'net' | 'total';
};

export const CashReconciliationModal: React.FC<CashReconciliationModalProps> = ({
  open,
  onClose,
  onDataChanged,
  branchId,
  branchName,
  dateRange,
  reportNetSalesDisplay,
  cashReconPeriodDisplay,
  totalNetSalesDisplay,
  reportBasis = 'net',
}) => {
  const { t } = useTranslation();
  const showMoneyCents = showsMoneyCents(branchId);
  const money = useCallback((value: number) => formatMoney(value, showMoneyCents), [showMoneyCents]);
  const [rows, setRows] = useState<CashReconciliationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [newDate, setNewDate] = useState(dateRange.end);
  const [newAmount, setNewAmount] = useState('');

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editAmount, setEditAmount] = useState('');

  const [tableSearch, setTableSearch] = useState('');
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);
  const [tablePage, setTablePage] = useState(0);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

  const branchOk = branchId != null && Number.isFinite(branchId);
  const bid = branchOk ? String(branchId) : '';

  const load = useCallback(async () => {
    if (!branchOk) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCashReconciliation(bid, dateRange);
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('cash_reconciliation.load_error'));
    } finally {
      setLoading(false);
    }
  }, [branchOk, bid, dateRange.start, dateRange.end, t]);

  useEffect(() => {
    if (open) {
      setNewDate(dateRange.end);
      setNewAmount('');
      setEditingId(null);
      setTableSearch('');
      setPageSize(10);
      setTablePage(0);
      setPendingDeleteId(null);
      void load();
    }
  }, [open, dateRange.start, dateRange.end, load]);

  useEffect(() => {
    if (!open) setPendingDeleteId(null);
  }, [open]);

  useEffect(() => {
    setTablePage(0);
  }, [tableSearch, pageSize]);

  const filteredRows = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const dateStr = businessDateYmd(row.BUSINESS_DATE).toLowerCase();
      const amtPlain = String(parseAmount(row)).toLowerCase();
      const amtFmt = money(parseAmount(row)).toLowerCase();
      const enc = formatEncodedDt(row.ENCODED_DT).toLowerCase();
      const idStr = String(row.IDNo);
      return (
        dateStr.includes(q) ||
        amtPlain.includes(q) ||
        amtFmt.includes(q) ||
        enc.includes(q) ||
        idStr.includes(q)
      );
    });
  }, [rows, tableSearch, money]);

  const totalFiltered = filteredRows.length;
  const totalTablePages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const safeTablePage = Math.min(tablePage, totalTablePages - 1);
  const pagedRows = useMemo(() => {
    const start = safeTablePage * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, safeTablePage, pageSize]);

  const showingFrom = totalFiltered === 0 ? 0 : safeTablePage * pageSize + 1;
  const showingTo = Math.min(safeTablePage * pageSize + pageSize, totalFiltered);

  const startAdd = async () => {
    if (!branchOk) return;
    const raw = newAmount.replace(/,/g, '').trim();
    if (raw === '') {
      setError(t('cash_reconciliation.amount_required'));
      return;
    }
    const amt = parseFormattedAmountToNumber(newAmount);
    if (!Number.isFinite(amt)) {
      setError(t('cash_reconciliation.invalid_amount'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createCashReconciliation({
        branchId: bid,
        businessDate: newDate,
        amount: amt,
      });
      setNewAmount('');
      await load();
      onDataChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('cash_reconciliation.save_error'));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (row: CashReconciliationRow) => {
    setEditingId(row.IDNo);
    setEditDate(businessDateYmd(row.BUSINESS_DATE));
    const n = parseAmount(row);
    setEditAmount(formatAmountWithCommas(sanitizeAmountTyping(Number.isFinite(n) ? String(n) : '0')));
  };

  const saveEdit = async () => {
    if (!branchOk || editingId == null) return;
    const rawEdit = editAmount.replace(/,/g, '').trim();
    if (rawEdit === '') {
      setError(t('cash_reconciliation.amount_required'));
      return;
    }
    const amt = parseFormattedAmountToNumber(editAmount);
    if (!Number.isFinite(amt)) {
      setError(t('cash_reconciliation.invalid_amount'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateCashReconciliation(editingId, {
        branchId: bid,
        businessDate: editDate,
        amount: amt,
      });
      setEditingId(null);
      await load();
      onDataChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('cash_reconciliation.save_error'));
    } finally {
      setSaving(false);
    }
  };

  const pendingDeleteRow = useMemo(
    () => (pendingDeleteId == null ? null : rows.find((r) => r.IDNo === pendingDeleteId) ?? null),
    [pendingDeleteId, rows]
  );

  const executeDelete = async () => {
    if (!branchOk || pendingDeleteId == null) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    setSaving(true);
    setError(null);
    try {
      await deleteCashReconciliation(id, bid);
      if (editingId === id) setEditingId(null);
      await load();
      onDataChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('cash_reconciliation.delete_error'));
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/25 z-[80]"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', damping: 26, stiffness: 320 }}
            className="fixed left-1/2 top-[4vh] z-[90] w-[min(100vw-2rem,840px)] max-h-[92vh] flex flex-col rounded-2xl border border-gray-200 bg-white shadow-2xl -translate-x-1/2 min-h-0"
          >
            <div className="border-b border-gray-100 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-brand-text">{t('cash_reconciliation.title')}</h2>
                  <p className="text-xs text-brand-muted mt-0.5">
                    {branchName} · {dateRange.start} → {dateRange.end}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="p-2 rounded-lg text-brand-muted hover:bg-gray-100 transition-colors shrink-0"
                  aria-label="Close"
                >
                  <X size={20} />
                </button>
              </div>

              {/* KPI-style strip (single container, like Sales Analytics stat row) */}
              <div className="mt-4 w-full">
                <div className="w-full rounded-2xl border border-gray-200 bg-white overflow-hidden shadow-sm">
                  <div className="grid grid-cols-1 sm:grid-cols-3 sm:divide-x sm:divide-gray-100">
                    <div className="px-4 py-4 text-center sm:py-5 border-b border-gray-100 sm:border-b-0">
                      <p className="text-brand-muted text-sm font-medium mb-1">
                        {reportBasis === 'total'
                          ? t('cash_reconciliation.card_total_sales_report')
                          : t('cash_reconciliation.card_net_sales_report')}
                      </p>
                      <p className="text-3xl/none md:text-[2rem] font-bold text-brand-text tabular-nums">{reportNetSalesDisplay}</p>
                    </div>
                    <div className="px-4 py-4 text-center sm:py-5 border-b border-gray-100 sm:border-b-0">
                      <p className="text-brand-muted text-sm font-medium mb-1">{t('cash_reconciliation.card_cash_reconciliation')}</p>
                      <p className="text-3xl/none md:text-[2rem] font-bold text-brand-text tabular-nums">{cashReconPeriodDisplay}</p>
                    </div>
                    <div className="px-4 py-5 text-center border-b-2 border-b-[rgb(139,92,246)]">
                      <p className="text-brand-muted text-sm font-medium mb-1">
                        {reportBasis === 'total'
                          ? t('cash_reconciliation.card_grand_total_sales')
                          : t('cash_reconciliation.card_total_net_sales')}
                      </p>
                      <p className="text-3xl/none md:text-[2rem] font-bold text-brand-text tabular-nums">{totalNetSalesDisplay}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
              {!branchOk && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                  <AlertCircle size={18} className="shrink-0 mt-0.5" />
                  {t('cash_reconciliation.select_branch_hint')}
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
                  <AlertCircle size={18} className="shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              {branchOk && (
                <div className="space-y-3 border-t border-gray-100 pt-4">
                  <p className="text-xs font-semibold text-brand-text flex items-center gap-1.5">
                    <Plus size={14} className="text-violet-600" />
                    {t('cash_reconciliation.add_row')}
                  </p>
                  <div className="flex flex-wrap gap-2 items-end">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-medium text-brand-muted">{t('cash_reconciliation.business_date')}</label>
                      <input
                        type="date"
                        value={newDate}
                        onChange={(e) => setNewDate(e.target.value)}
                        className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm bg-white"
                      />
                    </div>
                    <div className="flex flex-col gap-1 flex-1 min-w-[120px]">
                      <label className="text-[10px] font-medium text-brand-muted">
                        {t('cash_reconciliation.amount')}
                        <span className="text-red-500 ml-0.5" aria-hidden>
                          *
                        </span>
                      </label>
                      <input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        required
                        placeholder="0.00"
                        value={newAmount}
                        onChange={(e) => {
                          setError(null);
                          setNewAmount(formatAmountWithCommas(sanitizeAmountTyping(e.target.value)));
                        }}
                        className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm bg-white"
                        aria-required="true"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void startAdd()}
                      className="h-[34px] px-4 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50"
                    >
                      {t('cash_reconciliation.save')}
                    </button>
                  </div>
                </div>
              )}

              {branchOk && loading ? (
                <div className="flex justify-center py-12 text-brand-muted">
                  <Loader2 className="animate-spin" size={28} />
                </div>
              ) : branchOk ? (
                <div className="flex flex-col min-h-[240px] border-t border-gray-100 pt-4 mt-1">
                  {rows.length > 0 && (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between py-2">
                      <div className="relative flex-1 min-w-[200px] max-w-xl">
                        <Search
                          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted"
                          size={16}
                          aria-hidden
                        />
                        <input
                          type="search"
                          value={tableSearch}
                          onChange={(e) => setTableSearch(e.target.value)}
                          placeholder={t('cash_reconciliation.search_table')}
                          className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm text-brand-text placeholder:text-brand-muted/70 focus:border-violet-300 focus:outline-none focus:ring-1 focus:ring-violet-200"
                        />
                      </div>
                      <label className="flex items-center gap-2 text-xs font-medium text-brand-muted shrink-0">
                        <span>{t('cash_reconciliation.rows_per_page')}</span>
                        <select
                          value={pageSize}
                          onChange={(e) => setPageSize(Number(e.target.value) as (typeof PAGE_SIZE_OPTIONS)[number])}
                          className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-brand-text"
                        >
                          {PAGE_SIZE_OPTIONS.map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full text-sm min-w-[640px]">
                      <thead>
                        <tr className="text-left text-xs font-medium text-brand-muted border-b border-gray-200 bg-slate-50/70">
                          <th className="px-3 py-2">{t('cash_reconciliation.business_date')}</th>
                          <th className="px-3 py-2 text-right">{t('cash_reconciliation.amount')}</th>
                          <th className="px-3 py-2">{t('cash_reconciliation.encoded_date')}</th>
                          <th className="px-3 py-2 text-right w-[120px]">{t('cash_reconciliation.actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="px-3 py-12 text-center text-brand-muted text-sm">
                              {t('cash_reconciliation.empty')}
                            </td>
                          </tr>
                        ) : totalFiltered === 0 ? (
                          <tr>
                            <td colSpan={4} className="px-3 py-12 text-center text-brand-muted text-sm">
                              {t('cash_reconciliation.no_matches')}
                            </td>
                          </tr>
                        ) : (
                          pagedRows.map((row) => (
                            <tr key={row.IDNo} className="border-b border-gray-50 last:border-0">
                              <td className="px-3 py-2.5 align-middle">
                                {editingId === row.IDNo ? (
                                  <input
                                    type="date"
                                    value={editDate}
                                    onChange={(e) => setEditDate(e.target.value)}
                                    className="rounded border border-gray-200 px-1.5 py-1 text-sm w-full max-w-[160px]"
                                  />
                                ) : (
                                  <span className="text-xs text-brand-muted">
                                    {formatBusinessDateDisplay(row.BUSINESS_DATE)}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right align-middle">
                                {editingId === row.IDNo ? (
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={editAmount}
                                    onChange={(e) => {
                                      setError(null);
                                      setEditAmount(formatAmountWithCommas(sanitizeAmountTyping(e.target.value)));
                                    }}
                                    className="rounded border border-gray-200 px-1.5 py-1 text-sm w-full max-w-[140px] ml-auto text-right bg-white"
                                    aria-required="true"
                                  />
                                ) : (
                                  <span className="font-medium tabular-nums">{money(parseAmount(row))}</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 align-middle text-xs text-brand-muted">
                                {formatEncodedDt(row.ENCODED_DT)}
                              </td>
                              <td className="px-3 py-2.5 text-right align-middle">
                                {editingId === row.IDNo ? (
                                  <div className="flex justify-end gap-1">
                                    <button
                                      type="button"
                                      disabled={saving}
                                      onClick={() => void saveEdit()}
                                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"
                                      title={t('cash_reconciliation.save')}
                                      aria-label={t('cash_reconciliation.save')}
                                    >
                                      <Check size={18} strokeWidth={2.25} />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setEditingId(null)}
                                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-brand-muted hover:bg-gray-100"
                                      title={t('cash_reconciliation.cancel')}
                                      aria-label={t('cash_reconciliation.cancel')}
                                    >
                                      <X size={18} />
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex justify-end gap-1">
                                    <button
                                      type="button"
                                      onClick={() => startEdit(row)}
                                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-violet-600 hover:bg-violet-50"
                                      title={t('cash_reconciliation.edit')}
                                      aria-label={t('cash_reconciliation.edit')}
                                    >
                                      <Pencil size={17} strokeWidth={2.25} />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setPendingDeleteId(row.IDNo)}
                                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-red-600 hover:bg-red-50"
                                      title={t('cash_reconciliation.delete')}
                                      aria-label={t('cash_reconciliation.delete')}
                                    >
                                      <Trash2 size={17} strokeWidth={2.25} />
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  {rows.length > 0 && totalFiltered > 0 && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between py-2 border-t border-gray-100 text-xs text-brand-muted">
                      <span>
                        {t('cash_reconciliation.showing', {
                          from: showingFrom,
                          to: showingTo,
                          total: totalFiltered,
                        })}
                      </span>
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          disabled={safeTablePage <= 0}
                          onClick={() => setTablePage((p) => Math.max(0, p - 1))}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
                          aria-label="Previous page"
                        >
                          <ChevronLeft size={18} />
                        </button>
                        <span className="tabular-nums px-2 min-w-[4.5rem] text-center">
                          {safeTablePage + 1} / {totalTablePages}
                        </span>
                        <button
                          type="button"
                          disabled={safeTablePage >= totalTablePages - 1}
                          onClick={() => setTablePage((p) => Math.min(totalTablePages - 1, p + 1))}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
                          aria-label="Next page"
                        >
                          <ChevronRight size={18} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </motion.div>

          <AnimatePresence>
            {pendingDeleteId != null && (
              <motion.div
                key="cash-recon-delete-dialog"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[100] flex items-center justify-center p-4"
              >
                <motion.button
                  type="button"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 cursor-default border-0 bg-black/45"
                  onClick={() => !saving && setPendingDeleteId(null)}
                  aria-label={t('common.cancel')}
                />
                <motion.div
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="cr-delete-title"
                  initial={{ opacity: 0, scale: 0.96, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 10 }}
                  transition={{ type: 'spring', damping: 28, stiffness: 320 }}
                  className="relative z-10 w-full max-w-[420px] rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex gap-3">
                    <div
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600"
                      aria-hidden
                    >
                      <AlertTriangle size={22} strokeWidth={2} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 id="cr-delete-title" className="text-base font-semibold text-brand-text">
                        {t('cash_reconciliation.delete_dialog_title')}
                      </h3>
                      <p className="mt-1.5 text-sm text-brand-muted leading-relaxed">
                        {t('cash_reconciliation.confirm_delete')}
                      </p>
                      {pendingDeleteRow && (
                        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-brand-text tabular-nums">
                          <span className="text-brand-muted">
                            {formatBusinessDateDisplay(pendingDeleteRow.BUSINESS_DATE)}
                          </span>
                          {' · '}
                          <span className="font-semibold">{money(parseAmount(pendingDeleteRow))}</span>
                        </p>
                      )}
                      <p className="mt-2 text-xs text-brand-muted">{t('cash_reconciliation.delete_dialog_hint')}</p>
                    </div>
                  </div>
                  <div className="mt-6 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => setPendingDeleteId(null)}
                      className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-brand-text hover:bg-gray-50 disabled:opacity-50"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void executeDelete()}
                      className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {t('cash_reconciliation.delete')}
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
};
