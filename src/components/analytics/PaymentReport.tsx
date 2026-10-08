import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Search } from 'lucide-react';
import { type Branch } from '../partials/Header';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Skeleton } from '../ui/Skeleton';
import { fetchPaymentReportApi, type ApiPaymentReportRow } from '../../services/analyticsService';
import { useAnalyticsReportLoad } from '../../hooks/useAnalyticsReportLoad';

type PaymentReportProps = {
  selectedBranch: Branch | null;
  dateRange: {
    start: string;
    end: string;
  };
};

type PaymentReportRow = {
  id: string;
  paymentMethod: string;
  paymentTransaction: number;
  paymentAmount: number;
  refundTransaction: number;
  refundAmount: number;
  netAmount: number;
};

type PaymentReportCachePayload = {
  rows: PaymentReportRow[];
};

function buildPaymentRows(apiRows: ApiPaymentReportRow[]): PaymentReportRow[] {
  const computedRows: PaymentReportRow[] = apiRows.map((row) => ({
    id: String(row.id),
    paymentMethod: row.paymentMethod,
    paymentTransaction: row.paymentTransaction,
    paymentAmount: row.paymentAmount,
    refundTransaction: row.refundTransaction,
    refundAmount: row.refundAmount,
    netAmount: row.netAmount,
  }));

  const total = computedRows.reduce(
    (acc, row) => ({
      paymentTransaction: acc.paymentTransaction + row.paymentTransaction,
      paymentAmount: Number((acc.paymentAmount + row.paymentAmount).toFixed(2)),
      refundTransaction: acc.refundTransaction + row.refundTransaction,
      refundAmount: Number((acc.refundAmount + row.refundAmount).toFixed(2)),
      netAmount: Number((acc.netAmount + row.netAmount).toFixed(2)),
    }),
    { paymentTransaction: 0, paymentAmount: 0, refundTransaction: 0, refundAmount: 0, netAmount: 0 },
  );

  return [
    ...computedRows,
    {
      id: 'total',
      paymentMethod: 'total',
      paymentTransaction: total.paymentTransaction,
      paymentAmount: total.paymentAmount,
      refundTransaction: total.refundTransaction,
      refundAmount: total.refundAmount,
      netAmount: total.netAmount,
    },
  ];
}

const MOCK_PAYMENT_REPORT_BASE: Omit<PaymentReportRow, 'id'>[] = [];

export const PaymentReport: React.FC<PaymentReportProps> = ({ selectedBranch, dateRange }) => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [rows, setRows] = useState<PaymentReportRow[]>([]);

  const branchIdForCache =
    selectedBranch && String(selectedBranch.id) !== 'all' ? String(selectedBranch.id) : null;

  const hasPaymentCacheData = useCallback(
    (cached: PaymentReportCachePayload | null) =>
      !!cached && cached.rows.some((r) => r.id !== 'total'),
    [],
  );

  const hydratePaymentCache = useCallback((cached: PaymentReportCachePayload) => {
    setRows(cached.rows);
  }, []);

  const clearPaymentCache = useCallback(() => {
    setRows([]);
  }, []);

  const fetchPaymentReportData = useCallback(async (): Promise<PaymentReportCachePayload> => {
    const params = new URLSearchParams();
    if (dateRange.start) params.set('start_date', dateRange.start);
    if (dateRange.end) params.set('end_date', dateRange.end);
    if (branchIdForCache) params.set('branch_id', branchIdForCache);

    const apiRows = await fetchPaymentReportApi(params);
    return { rows: buildPaymentRows(apiRows) };
  }, [branchIdForCache, dateRange.end, dateRange.start]);

  const { loading: reportLoading } = useAnalyticsReportLoad<PaymentReportCachePayload>({
    report: 'payment',
    dateRange,
    branchId: branchIdForCache,
    hasCacheData: hasPaymentCacheData,
    fetchData: fetchPaymentReportData,
    onHydrate: hydratePaymentCache,
    onClear: clearPaymentCache,
  });

  const money = (value: number) => {
    const safe = Number.isFinite(value) ? Math.trunc(value) : 0;
    return `${t('common.currency_symbol')}${safe.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  const headerTextClass = 'text-[13px] font-medium whitespace-nowrap bg-white';
  const bodyTextClass = 'text-sm text-brand-text bg-white group-hover:bg-brand-bg/50';
  const methodHeaderClass = 'text-[13px] font-medium whitespace-nowrap bg-violet-50';
  const methodBodyClass = 'text-sm text-brand-text font-medium bg-violet-50 group-hover:bg-violet-100';

  const filteredRows = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    if (!keyword) return rows;
    return rows.filter((row) => row.paymentMethod.toLowerCase().includes(keyword));
  }, [rows, searchTerm]);

  const columns: ColumnDef<PaymentReportRow>[] = [
    {
      header: t('payment_report.columns.payment_method'),
      accessorKey: 'paymentMethod',
      className: 'min-w-[220px] border-r border-gray-200',
      headerClassName: methodHeaderClass,
      cellClassName: methodBodyClass,
      render: (item) => (
        <span className={item.paymentMethod.toLowerCase() === 'total' ? 'font-bold' : ''}>
          {item.paymentMethod.toLowerCase() === 'total' ? t('payment_report.total') : item.paymentMethod}
        </span>
      ),
    },
    {
      header: t('payment_report.columns.payment_transaction'),
      className: 'min-w-[170px] text-right',
      headerClassName: headerTextClass,
      cellClassName: bodyTextClass,
      render: (item) => (
        <span className={item.paymentMethod.toLowerCase() === 'total' ? 'font-bold' : ''}>
          {item.paymentTransaction.toLocaleString()}
        </span>
      ),
    },
    {
      header: t('payment_report.columns.payment_amount'),
      className: 'min-w-[170px] text-right',
      headerClassName: headerTextClass,
      cellClassName: bodyTextClass,
      render: (item) => (
        <span className={item.paymentMethod.toLowerCase() === 'total' ? 'font-bold' : ''}>
          {money(item.paymentAmount)}
        </span>
      ),
    },
    {
      header: t('payment_report.columns.refund_transaction'),
      className: 'min-w-[170px] text-right',
      headerClassName: headerTextClass,
      cellClassName: bodyTextClass,
      render: (item) => (
        <span className={item.paymentMethod.toLowerCase() === 'total' ? 'font-bold' : ''}>
          {item.refundTransaction.toLocaleString()}
        </span>
      ),
    },
    {
      header: t('payment_report.columns.refund_amount'),
      className: 'min-w-[150px] text-right',
      headerClassName: headerTextClass,
      cellClassName: bodyTextClass,
      render: (item) => (
        <span className={item.paymentMethod.toLowerCase() === 'total' ? 'font-bold' : ''}>
          {money(item.refundAmount)}
        </span>
      ),
    },
    {
      header: t('payment_report.columns.net_amount'),
      className: 'min-w-[150px] text-right',
      headerClassName: headerTextClass,
      cellClassName: bodyTextClass,
      render: (item) => (
        <span className={item.paymentMethod.toLowerCase() === 'total' ? 'font-bold' : ''}>
          {money(item.netAmount)}
        </span>
      ),
    },
  ];

  // --- Export Functions (CSV + PDF) ---
  const handleExportCsv = () => {
    const headers = [
      t('payment_report.columns.payment_method'),
      t('payment_report.columns.payment_transaction'),
      t('payment_report.columns.payment_amount'),
      t('payment_report.columns.refund_transaction'),
      t('payment_report.columns.refund_amount'),
      t('payment_report.columns.net_amount'),
    ];

    const escapeCell = (value: string) => {
      const needsQuotes = /[",\n]/.test(value);
      const safe = value.replace(/"/g, '""');
      return needsQuotes ? `"${safe}"` : safe;
    };

    const rowsForCsv = filteredRows.map((row) => {
      const pmLabel = row.paymentMethod.toLowerCase() === 'total' ? t('payment_report.total') : row.paymentMethod;
      return [
        pmLabel,
        row.paymentTransaction.toString(),
        row.paymentAmount.toString(),
        row.refundTransaction.toString(),
        row.refundAmount.toString(),
        row.netAmount.toString(),
      ];
    });

    const csv = [
      headers.map(escapeCell).join(','),
      ...rowsForCsv.map((r) => r.map(escapeCell).join(',')),
    ].join('\n');

    const branchNameStr = selectedBranch ? selectedBranch.name : 'All_Branches';
    const cleanBranchName = branchNameStr.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `payment_report_${cleanBranchName}_${dateRange.start}_to_${dateRange.end}.csv`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExportPdf = () => {
    const doc = new jsPDF('l', 'pt', 'a4');

    const headers = [
      t('payment_report.columns.payment_method'),
      t('payment_report.columns.payment_transaction'),
      t('payment_report.columns.payment_amount'),
      t('payment_report.columns.refund_transaction'),
      t('payment_report.columns.refund_amount'),
      t('payment_report.columns.net_amount'),
    ];

    const body = filteredRows.map((row) => {
      const pmLabel = row.paymentMethod.toLowerCase() === 'total' ? t('payment_report.total') : row.paymentMethod;
      return [
        pmLabel,
        row.paymentTransaction.toLocaleString(),
        money(row.paymentAmount),
        row.refundTransaction.toLocaleString(),
        money(row.refundAmount),
        money(row.netAmount),
      ];
    });

    autoTable(doc, {
      head: [headers],
      body,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [34, 197, 94] },
      margin: { top: 40 },
    });

    const branchNameStr = selectedBranch ? selectedBranch.name : 'All_Branches';
    const cleanBranchName = branchNameStr.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `payment_report_${cleanBranchName}_${dateRange.start}_to_${dateRange.end}.pdf`;

    doc.save(filename);
  };

  return (
    <div className="pt-6 space-y-4">
      <AnimatePresence mode="wait">
        {reportLoading ? (
          <motion.div
            key="skeleton"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="space-y-4"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-10 w-80 rounded-xl" />
              <Skeleton className="h-9 w-24 rounded-lg" />
            </div>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden p-5">
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
            className="space-y-4"
          >
            <div className="flex items-center justify-between">
              <div className="relative">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder={t('payment_report.search_placeholder')}
                  className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-80 shadow-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
                />
              </div>
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
            </div>
            <DataTable data={filteredRows} columns={columns} keyExtractor={(item) => item.id} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

