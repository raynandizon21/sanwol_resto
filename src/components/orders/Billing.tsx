import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  AlertTriangle,
  Loader2,
  Receipt,
  CreditCard,
  Wallet,
  DollarSign,
  Eye,
} from 'lucide-react';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Modal } from '../ui/Modal';
import { SidePanel } from '../ui/SidePanel';
import { Select2 } from '../ui/Select2';
import { SkeletonPageHeader, SkeletonStatCards, SkeletonTable } from '../ui/Skeleton';
import { cn } from '../../lib/utils';
import {
  formatEncodedDt,
  isEncodedDtWithinDateRange,
} from '../../utils/manilaDateTime';
import { toast } from 'sonner';
import type { Branch } from '../partials/Header';

type BillingStatus = 1 | 2 | 3;

type BillingRecord = {
  IDNo: number;
  ORDER_ID: number;
  ORDER_NO: string;
  BRANCH_ID: number | null;
  TABLE_ID: number | null;
  TABLE_NUMBER?: string | null;
  PAYMENT_METHOD: string | null;
  AMOUNT_DUE: number;
  AMOUNT_PAID: number;
  STATUS: BillingStatus;
  PAYMENT_REF: string | null;
  ENCODED_DT: string | null;
  ENCODED_BY_USERNAME?: string | null;
};

type PaymentHistoryRow = {
  IDNo: number;
  ORDER_ID: number;
  PAYMENT_METHOD: string;
  AMOUNT_PAID: number;
  PAYMENT_REF: string | null;
  ENCODED_DT: string | null;
  ENCODED_BY_USERNAME: string | null;
};

interface BillingProps {
  selectedBranch: Branch | null;
  dateRange: {
    start: string;
    end: string;
  };
}

const authHeaders = (): HeadersInit => {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

export const Billing: React.FC<BillingProps> = ({ selectedBranch, dateRange }) => {
  const { t } = useTranslation();
  const branchId = selectedBranch ? String(selectedBranch.id) : 'all';

  const EPS = 1e-6;

  const formatMoneyNoDecimals = useCallback((value: unknown) => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return '0';
    return Math.trunc(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }, []);

  const [records, setRecords] = useState<BillingRecord[]>([]);
  const [serverStats, setServerStats] = useState<{
    totalDue: number;
    totalPaid: number;
    paidCount: number;
    partialCount: number;
    unpaidCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [submittingPayment, setSubmittingPayment] = useState(false);

  const [activeRecord, setActiveRecord] = useState<BillingRecord | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<string>('CASH');
  const [paymentAmount, setPaymentAmount] = useState<string>('');
  const [paymentRef, setPaymentRef] = useState<string>('');

  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRows, setHistoryRows] = useState<PaymentHistoryRow[]>([]);

  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptImageUrl, setReceiptImageUrl] = useState<string | null>(null);
  const [receiptOrders, setReceiptOrders] = useState<any[]>([]);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const loadBillingReqIdRef = useRef(0);

  const loadBilling = useCallback(async () => {
    const reqId = ++loadBillingReqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (branchId && branchId !== 'all') {
        params.set('branch_id', branchId);
      }
      if (dateRange?.start) params.set('start_date', dateRange.start);
      if (dateRange?.end) params.set('end_date', dateRange.end);
      params.set('limit', '500');
      params.set('include_stats', '1');
      const qs = params.toString();
      const res = await fetch(`/data-api/billing/data${qs ? `?${qs}` : ''}`, {
        headers: authHeaders(),
      });
      const json = await res.json();
      if (reqId !== loadBillingReqIdRef.current) return;
      if (!res.ok || json?.success === false) {
        throw new Error(
          json?.error || json?.message || t('billing.unable_to_load_billing_records'),
        );
      }
      const raw = json.data ?? json;
      const mapped: BillingRecord[] = (Array.isArray(raw) ? raw : []).map((r: any) => ({
        IDNo: r.IDNo,
        ORDER_ID: r.ORDER_ID,
        ORDER_NO: r.ORDER_NO || '',
        BRANCH_ID: r.BRANCH_ID ?? null,
        TABLE_ID: r.TABLE_ID ?? null,
        TABLE_NUMBER: r.TABLE_NUMBER ?? null,
        PAYMENT_METHOD: r.PAYMENT_METHOD ?? null,
        AMOUNT_DUE: Number(r.AMOUNT_DUE || r.amount_due || 0),
        AMOUNT_PAID: Number(r.AMOUNT_PAID || r.amount_paid || 0),
        STATUS: Number(r.STATUS || r.status || 3) as BillingStatus,
        PAYMENT_REF: r.PAYMENT_REF ?? null,
        ENCODED_DT: r.ENCODED_DT ?? null,
        ENCODED_BY_USERNAME: r.ENCODED_BY_USERNAME ?? r.ENCODED_BY_NAME ?? null,
      }));
      setRecords(mapped);
      const s = json.meta?.stats;
      setServerStats(
        s
          ? {
              totalDue: Number(s.totalDue) || 0,
              totalPaid: Number(s.totalPaid) || 0,
              paidCount: Number(s.paidCount) || 0,
              partialCount: Number(s.partialCount) || 0,
              unpaidCount: Number(s.unpaidCount) || 0,
            }
          : null,
      );
    } catch (e: any) {
      if (reqId !== loadBillingReqIdRef.current) return;
      console.error('Failed to load billing records', e);
      setError(e?.message || t('billing.unable_to_load_billing_records'));
      setRecords([]);
      setServerStats(null);
    } finally {
      if (reqId === loadBillingReqIdRef.current) setLoading(false);
    }
  }, [branchId, dateRange.start, dateRange.end, t]);

  useEffect(() => {
    loadBilling();
    setSearchTerm('');
    setStatusFilter('all');
  }, [loadBilling]);

  const statusLabel = (status: BillingStatus) => {
    switch (status) {
      case 1:
        return t('billing.paid');
      case 2:
        return t('billing.partial');
      case 3:
        return t('billing.unpaid');
      default:
        return t('billing.unknown');
    }
  };

  const statusBadge = (status: BillingStatus) => {
    const label = statusLabel(status);
    const style =
      status === 1
        ? 'bg-green-100 text-green-600'
        : status === 2
        ? 'bg-yellow-100 text-yellow-600'
        : 'bg-red-100 text-red-600';
    return (
      <span className={cn('text-xs font-bold px-2 py-1 rounded-lg', style)}>
        {label}
      </span>
    );
  };

  const isWithinDateRange = useCallback(
    (encoded: string | null | undefined, rowBranchId?: number | string | null) =>
      isEncodedDtWithinDateRange(encoded, dateRange, rowBranchId ?? branchId),
    [dateRange.start, dateRange.end, branchId],
  );

  const recordsInDateRange = useMemo(
    () => records.filter((r) => isWithinDateRange(r.ENCODED_DT, r.BRANCH_ID)),
    [records, isWithinDateRange],
  );

  const filteredRecords = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return recordsInDateRange.filter((r) => {
      const matchSearch =
        !term ||
        r.ORDER_NO.toLowerCase().includes(term) ||
        (r.TABLE_NUMBER && String(r.TABLE_NUMBER).toLowerCase().includes(term));
      const matchStatus =
        statusFilter === 'all' || String(r.STATUS) === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [recordsInDateRange, searchTerm, statusFilter]);

  const stats = useMemo(() => {
    if (serverStats) return serverStats;
    const totalDue = recordsInDateRange.reduce((s, r) => {
      const remaining = Number(r.AMOUNT_DUE || 0) - Number(r.AMOUNT_PAID || 0);
      return s + Math.max(0, remaining);
    }, 0);
    const totalPaid = recordsInDateRange.reduce((s, r) => s + Number(r.AMOUNT_PAID || 0), 0);
    const paidCount = recordsInDateRange.filter((r) => r.STATUS === 1).length;
    const partialCount = recordsInDateRange.filter((r) => r.STATUS === 2).length;
    const unpaidCount = recordsInDateRange.filter((r) => r.STATUS === 3).length;
    return { totalDue, totalPaid, paidCount, partialCount, unpaidCount };
  }, [recordsInDateRange, serverStats]);

  const openPaymentModal = (record: BillingRecord) => {
    setActiveRecord(record);
    setPaymentMethod(record.PAYMENT_METHOD || 'CASH');
    // Pre-fill with the remaining balance to pay.
    const remaining =
      Math.max(0, Number(record.AMOUNT_DUE || 0) - Number(record.AMOUNT_PAID || 0));
    setPaymentAmount(remaining > 0 ? String(remaining) : '');
    setPaymentRef('');
    setPaymentModalOpen(true);
  };

  const openHistoryModal = async (record: BillingRecord) => {
    setActiveRecord(record);
    setHistoryModalOpen(true);
    setHistoryLoading(true);
    setHistoryRows([]);
    try {
      const res = await fetch(`/data-api/billing/${record.ORDER_ID}/payments`, {
        headers: authHeaders(),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        throw new Error(
          json?.error || json?.message || t('billing.failed_to_load_payments'),
        );
      }
      const raw = json.data ?? json;
      const mapped: PaymentHistoryRow[] = (Array.isArray(raw) ? raw : []).map(
        (p: any) => ({
          IDNo: p.IDNo,
          ORDER_ID: p.ORDER_ID,
          PAYMENT_METHOD: p.PAYMENT_METHOD || 'CASH',
          AMOUNT_PAID: Number(p.AMOUNT_PAID || 0),
          PAYMENT_REF: p.PAYMENT_REF ?? null,
          ENCODED_DT: p.ENCODED_DT ?? null,
          ENCODED_BY_USERNAME: p.ENCODED_BY_USERNAME ?? null,
        }),
      );
      setHistoryRows(mapped);
    } catch (e: any) {
      console.error('Failed to load payment history', e);
      toast.error(e?.message || t('billing.failed_to_load_payments'));
    } finally {
      setHistoryLoading(false);
    }
  };

  const openReceiptModal = async (record: BillingRecord) => {
    setActiveRecord(record);
    setReceiptModalOpen(true);
    setReceiptLoading(true);
    setReceiptImageUrl(null);
    setReceiptOrders([]);
    setReceiptError(null);
    try {
      const res = await fetch(`/data-api/receipt-scan-history/order/${record.ORDER_ID}`, {
        headers: authHeaders(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error || json?.message || 'No receipt image found for this order');
      }
      const url = json?.data?.receipt_image_data_url ?? null;
      setReceiptImageUrl(url);
      setReceiptOrders(Array.isArray(json?.data?.orders) ? json.data.orders : []);
    } catch (e: any) {
      const msg = e?.message || 'No receipt image found for this order';
      setReceiptError(msg);
    } finally {
      setReceiptLoading(false);
    }
  };

  const closePaymentModal = () => {
    if (submittingPayment) return;
    setPaymentModalOpen(false);
    setActiveRecord(null);
  };

  const closeHistoryModal = () => {
    setHistoryModalOpen(false);
    setActiveRecord(null);
  };

  const paymentRemaining = useMemo(() => {
    if (!activeRecord) return 0;
    return Math.max(
      0,
      Number(activeRecord.AMOUNT_DUE || 0) - Number(activeRecord.AMOUNT_PAID || 0),
    );
  }, [activeRecord]);

  const handleProcessPayment = async () => {
    if (!activeRecord) return;
    const amount = Number(paymentAmount);
    const remaining = paymentRemaining;

    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t('billing.failed_to_process_payment'));
      return;
    }
    // Prevent overpayment beyond remaining balance.
    if (amount - remaining > EPS) {
      toast.error(
        t('billing.overpayment_not_allowed', { remaining: formatMoneyNoDecimals(remaining) }),
      );
      return;
    }
    setSubmittingPayment(true);
    try {
      const res = await fetch(`/data-api/billing/${activeRecord.ORDER_ID}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          payment_method: paymentMethod,
          amount_paid: amount,
          payment_ref: paymentRef || null,
        }),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        throw new Error(
          json?.error || json?.message || t('billing.failed_to_process_payment'),
        );
      }
      toast.success(t('billing.payment_processed_successfully'));
      setPaymentModalOpen(false);
      setActiveRecord(null);
      await loadBilling();
    } catch (e: any) {
      console.error('Failed to process payment', e);
      toast.error(e?.message || t('billing.failed_to_process_payment'));
    } finally {
      setSubmittingPayment(false);
    }
  };

  const canSubmitPayment = useMemo(() => {
    if (!activeRecord) return false;
    const amount = Number(paymentAmount);
    return Number.isFinite(amount) && amount > 0 && amount - paymentRemaining <= EPS;
  }, [activeRecord, paymentAmount, paymentRemaining]);

  const paymentAmountNumber = Number(paymentAmount);
  const paymentOver =
    Number.isFinite(paymentAmountNumber) &&
    paymentAmountNumber > 0 &&
    paymentAmountNumber - paymentRemaining > EPS;

  const columns: ColumnDef<BillingRecord>[] = useMemo(
    () => [
      {
        header: t('billing.order_no'),
        render: (r) => (
          <div className="flex items-center gap-3 min-w-[160px]">
            <Receipt size={16} className="text-brand-muted shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-bold">{r.ORDER_NO}</p>
              <p className="text-[10px] text-brand-muted">
                {r.ENCODED_DT ? formatEncodedDt(r.ENCODED_DT) : t('billing.n_a')}
              </p>
            </div>
          </div>
        ),
      },
      {
        header: t('billing.payment_method'),
        render: (r) => (
          <span className="text-sm font-medium flex items-center gap-1.5">
            <CreditCard size={14} className="text-brand-muted" />
            {r.PAYMENT_METHOD || t('billing.unknown')}
          </span>
        ),
      },
      {
        header: t('billing.amount_due'),
        render: (r) => {
          const remaining = Number(r.AMOUNT_DUE || 0) - Number(r.AMOUNT_PAID || 0);
          return (
            <span className="text-sm font-bold text-brand-text">
              ₱
              {formatMoneyNoDecimals(Math.max(0, remaining))}
            </span>
          );
        },
      },
      {
        header: t('billing.amount_paid'),
        render: (r) => (
          <span className="text-sm font-bold text-green-600">
            ₱
            {formatMoneyNoDecimals(r.AMOUNT_PAID)}
          </span>
        ),
      },
      {
        header: t('billing.balance'),
        render: (r) => {
          const bal = Number(r.AMOUNT_DUE) - Number(r.AMOUNT_PAID || 0);
          return (
            <span className="text-sm font-bold text-orange-500">
              ₱
              {formatMoneyNoDecimals(bal)}
            </span>
          );
        },
      },
      {
        header: t('billing.status'),
        render: (r) => statusBadge(r.STATUS),
      },
      {
        header: t('billing.actions'),
        className: 'text-right',
        render: (r) => (
          <div className="flex justify-end items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void openReceiptModal(r);
              }}
              className="p-2 text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors rounded-lg"
              title="View receipt"
            >
              <Receipt size={16} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openHistoryModal(r);
              }}
              className="p-2 text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors rounded-lg"
              title={t('billing.view')}
            >
              <Eye size={16} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openPaymentModal(r);
              }}
              disabled={r.STATUS === 1}
              className={cn(
                'p-2 rounded-lg transition-colors flex items-center gap-1',
                r.STATUS === 1
                  ? 'text-brand-muted/40 cursor-not-allowed'
                  : 'text-emerald-600 hover:bg-emerald-50',
              )}
              title={t('billing.pay')}
            >
              <Wallet size={16} />
            </button>
          </div>
        ),
      },
    ],
    [t, formatMoneyNoDecimals],
  );

  return (
    <div className="pt-6">
      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div
            key="skeleton"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="space-y-8"
          >
            <SkeletonPageHeader />
            <SkeletonStatCards />
            <div className="bg-white rounded-2xl shadow-sm p-6">
              <SkeletonTable columns={6} rows={10} />
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
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <Search
                    size={18}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted"
                  />
                  <input
                    type="text"
                    placeholder={t('billing.pagination.search_placeholder')}
                    className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-80 shadow-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
                <Select2
                  options={[
                    { value: 'all', label: t('billing.status') },
                    { value: '1', label: t('billing.paid') },
                    { value: '2', label: t('billing.partial') },
                    { value: '3', label: t('billing.unpaid') },
                  ]}
                  value={statusFilter}
                  onChange={(v) => setStatusFilter((v as string) || 'all')}
                  placeholder={t('billing.status')}
                  className="w-40"
                />
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-3 bg-red-50 border border-red-100 text-red-700 p-4 rounded-2xl">
                <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                <div className="text-sm">
                  <p className="font-bold">{t('billing.error')}</p>
                  <p className="text-xs text-red-600 mt-0.5">{error}</p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-4 gap-6">
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">
                  {t('billing.amount_due_label')}
                </p>
                <h3 className="text-2xl font-bold text-brand-text">
                  ₱
                  {formatMoneyNoDecimals(stats.totalDue)}
                </h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">
                  {t('billing.amount_paid')}
                </p>
                <h3 className="text-2xl font-bold text-emerald-600">
                  ₱
                  {formatMoneyNoDecimals(stats.totalPaid)}
                </h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">
                  {t('billing.paid')}
                </p>
                <h3 className="text-2xl font-bold text-emerald-600">
                  {stats.paidCount}
                </h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">
                  {t('billing.unpaid')}
                </p>
                <h3 className="text-2xl font-bold text-red-500">
                  {stats.unpaidCount}
                </h3>
              </div>
            </div>

            <DataTable
              data={filteredRecords}
              columns={columns}
              keyExtractor={(item) => String(item.IDNo)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Process Payment Modal */}
      <Modal
        isOpen={paymentModalOpen}
        onClose={closePaymentModal}
        title={t('billing.process_payment')}
        maxWidth="sm"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={closePaymentModal}
              disabled={submittingPayment}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {t('billing.cancel')}
            </button>
            <button
              onClick={handleProcessPayment}
              disabled={submittingPayment || !canSubmitPayment}
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-emerald-600 shadow-lg shadow-emerald-600/30 hover:bg-emerald-700 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2"
            >
              {submittingPayment && (
                <Loader2 size={16} className="animate-spin" />
              )}
              {t('billing.save_payment')}
            </button>
          </div>
        }
      >
        {activeRecord && (
          <div className="space-y-4">
            <div className="bg-gray-50 rounded-xl p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
                <DollarSign size={20} className="text-emerald-600" />
              </div>
              <div>
                <p className="text-sm font-bold">
                  {t('billing.order_no')} {activeRecord.ORDER_NO}
                </p>
                <p className="text-xs text-brand-muted">
                  {t('billing.amount_due_label')}:{' '}
                  <span className="font-semibold">
                    ₱
                    {formatMoneyNoDecimals(activeRecord.AMOUNT_DUE)}
                  </span>{' '}
                  · {t('billing.amount_paid_label')}:{' '}
                  <span className="font-semibold text-emerald-600">
                    ₱
                    {formatMoneyNoDecimals(activeRecord.AMOUNT_PAID)}
                  </span>
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('billing.payment_method_label')}
              </label>
              <Select2
                options={[
                  { value: 'CASH', label: 'CASH' },
                  { value: 'CARD', label: 'CARD' },
                  { value: 'GCASH', label: 'GCASH' },
                  { value: 'BANK', label: 'BANK' },
                ]}
                value={paymentMethod}
                onChange={(val) => setPaymentMethod((val as string) || 'CASH')}
                placeholder={t('billing.payment_method')}
              />
            </div>

            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('billing.amount_paid_label')}
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                placeholder={t('billing.input_amount_placeholder')}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
              />
              {paymentOver && (
                <p className="text-[11px] font-bold text-red-600 mt-1">
                  {t('billing.overpayment_not_allowed', {
                    remaining: formatMoneyNoDecimals(paymentRemaining),
                  })}
                </p>
              )}
            </div>

            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('billing.payment_reference')}
              </label>
              <input
                type="text"
                value={paymentRef}
                onChange={(e) => setPaymentRef(e.target.value)}
                placeholder={t('billing.payment_reference_placeholder')}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
              />
            </div>
          </div>
        )}
      </Modal>

      {/* Payment History Side Panel */}
      <SidePanel
        isOpen={historyModalOpen}
        onClose={closeHistoryModal}
        title={t('billing.payment_breakdown')}
        width="md"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={closeHistoryModal}
              className="px-6 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors"
            >
              {t('billing.close')}
            </button>
          </div>
        }
      >
        {historyLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-brand-primary" />
          </div>
        ) : historyRows.length === 0 ? (
          <div className="py-6 text-center text-sm text-brand-muted">
            {t('billing.no_payments_found')}
          </div>
        ) : (
          <div className="space-y-3">
            {historyRows.map((row) => (
              <div
                key={row.IDNo}
                className="rounded-xl border border-gray-100 bg-white p-4"
              >
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-bold uppercase tracking-wider text-brand-muted">
                      {t('billing.date')}
                    </p>
                    <p className="mt-1 text-brand-muted">
                      {row.ENCODED_DT ? formatEncodedDt(row.ENCODED_DT) : t('billing.n_a')}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold uppercase tracking-wider text-brand-muted">
                      {t('billing.reference')}
                    </p>
                    <p className="mt-1 text-brand-muted break-all">
                      {row.PAYMENT_REF || '—'}
                    </p>
                  </div>

                  <div className="min-w-0">
                    <p className="font-bold uppercase tracking-wider text-brand-muted">
                      {t('billing.method')}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-brand-text break-words">
                      {row.PAYMENT_METHOD || t('billing.n_a')}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold uppercase tracking-wider text-brand-muted">
                      {t('billing.amount')}
                    </p>
                    <p className="mt-1 text-sm font-bold text-brand-text">
                      ₱{formatMoneyNoDecimals(row.AMOUNT_PAID)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </SidePanel>

      {/* Receipt Image Modal */}
      <Modal
        isOpen={receiptModalOpen}
        onClose={() => {
          if (receiptLoading) return;
          setReceiptModalOpen(false);
          setReceiptImageUrl(null);
          setReceiptOrders([]);
          setReceiptError(null);
        }}
        title="Receipt"
        maxWidth="6xl"
        footer={
          <button
            type="button"
            onClick={() => {
              setReceiptModalOpen(false);
              setReceiptImageUrl(null);
              setReceiptOrders([]);
              setReceiptError(null);
            }}
            className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors"
          >
            {t('billing.cancel')}
          </button>
        }
      >
        {receiptLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 size={32} className="animate-spin text-brand-primary" />
          </div>
        ) : receiptImageUrl ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-gray-200 overflow-hidden bg-gray-50">
              <button
                type="button"
                onClick={() => {
                  if (receiptImageUrl) window.open(receiptImageUrl, '_blank', 'noopener,noreferrer');
                }}
                className="w-full p-2"
                title="Click to view full size"
              >
                <img
                  src={receiptImageUrl}
                  alt="Receipt"
                  className="block w-full h-auto max-h-[78vh] object-contain rounded-xl bg-white"
                  draggable={false}
                />
              </button>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <div className="text-xs font-bold text-brand-muted uppercase tracking-widest">
                  Order breakdown
                </div>
                <div className="text-[11px] text-brand-muted mt-0.5">
                  Click image to view full size
                </div>
              </div>
              <div className="p-4 space-y-4">
                {receiptOrders.length === 0 ? (
                  <div className="text-sm text-brand-muted">No order items found.</div>
                ) : (
                  receiptOrders.map((o) => {
                    const items: any[] = Array.isArray(o?.items) ? o.items : [];
                    return (
                      <div key={String(o.ORDER_ID)} className="rounded-xl border border-gray-100 overflow-hidden">
                        <div className="px-4 py-3 bg-gray-50 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-extrabold text-brand-text truncate">
                              {o.ORDER_NO ? o.ORDER_NO : `#${o.ORDER_ID}`}
                            </div>
                            <div className="text-[11px] text-brand-muted truncate">
                              {o.TABLE_NUMBER != null && String(o.TABLE_NUMBER).trim() !== ''
                                ? `Table ${o.TABLE_NUMBER}`
                                : o.ORDER_TYPE || '—'}
                            </div>
                          </div>
                        </div>

                        <div className="p-3">
                          {items.length === 0 ? (
                            <div className="text-sm text-brand-muted">No items.</div>
                          ) : (
                            <div className="overflow-hidden rounded-lg border border-gray-100">
                              <table className="w-full text-xs">
                                <thead className="bg-white">
                                  <tr className="text-brand-muted">
                                    <th className="px-3 py-2 text-left font-bold uppercase tracking-widest">
                                      Item
                                    </th>
                                    <th className="px-3 py-2 text-right font-bold uppercase tracking-widest w-[56px]">
                                      Qty
                                    </th>
                                    <th className="px-3 py-2 text-right font-bold uppercase tracking-widest w-[92px]">
                                      Total
                                    </th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50">
                                  {items.map((it) => (
                                    <tr key={String(it.ORDER_ITEM_ID)} className="text-brand-text">
                                      <td className="px-3 py-2">
                                        <div className="font-semibold leading-snug">
                                          {it.MENU_NAME || `#${it.MENU_ID ?? ''}`}
                                        </div>
                                        {it.REMARKS ? (
                                          <div className="text-[11px] text-brand-muted mt-0.5 break-words">
                                            {it.REMARKS}
                                          </div>
                                        ) : null}
                                      </td>
                                      <td className="px-3 py-2 text-right tabular-nums font-semibold">
                                        {Number(it.QTY || 0)}
                                      </td>
                                      <td className="px-3 py-2 text-right tabular-nums font-bold">
                                        {formatMoneyNoDecimals(it.LINE_TOTAL || 0)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}

                          {(o.SERVICE_CHARGE != null && Number(o.SERVICE_CHARGE) > 0) ||
                          (o.SUBTOTAL != null && o.GRAND_TOTAL != null) ? (
                            <div className="mt-3">
                              <div className="rounded-xl bg-gray-50 px-3 py-2.5">
                                <div className="flex flex-col gap-2 text-sm">
                                  <div className="flex items-center justify-between gap-3">
                                    <span className="text-brand-muted font-bold uppercase tracking-widest text-[11px]">
                                      Subtotal
                                    </span>
                                    <span className="font-extrabold tabular-nums w-[92px] text-right text-slate-800">
                                      {formatMoneyNoDecimals(o.SUBTOTAL || 0)}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between gap-3">
                                    <span className="text-brand-muted font-bold uppercase tracking-widest text-[11px]">
                                      Service charge
                                    </span>
                                    <span className="font-extrabold tabular-nums w-[92px] text-right text-slate-800">
                                      {formatMoneyNoDecimals(o.SERVICE_CHARGE || 0)}
                                    </span>
                                  </div>
                                  <div className="pt-2 mt-1 border-t border-gray-200/80 flex items-center justify-between gap-3">
                                    <span className="text-brand-muted font-bold uppercase tracking-widest text-[11px]">
                                      Total
                                    </span>
                                    <span className="font-black tabular-nums w-[92px] text-right text-violet-700 text-base">
                                      ₱{formatMoneyNoDecimals(
                                        o.GRAND_TOTAL || (Number(o.SUBTOTAL || 0) + Number(o.SERVICE_CHARGE || 0)),
                                      )}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        ) : receiptError ? (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-6 text-sm text-brand-muted">
            <div className="font-bold text-brand-text mb-1">No receipt image</div>
            <div>{receiptError}</div>
            {activeRecord?.ORDER_NO ? (
              <div className="mt-2 text-xs font-mono">Order: {activeRecord.ORDER_NO}</div>
            ) : null}
          </div>
        ) : (
          <div className="text-sm text-brand-muted">No receipt image.</div>
        )}
      </Modal>
    </div>
  );
};

