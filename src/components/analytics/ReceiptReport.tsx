import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Search, X, Receipt, Loader2 } from 'lucide-react';
import { type Branch } from '../partials/Header';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Skeleton } from '../ui/Skeleton';
import { Modal } from '../ui/Modal';
import {
  fetchReceiptReportApi,
  fetchReceiptDetailApi,
  type ApiReceiptReportRow,
  type ApiReceiptDetail,
} from '../../services/analyticsService';
import { getOrderById, getOrderItems } from '../../services/orderService';
import { useAnalyticsReportLoad } from '../../hooks/useAnalyticsReportLoad';

type ReceiptReportProps = {
  selectedBranch: Branch | null;
  dateRange: {
    start: string;
    end: string;
  };
};

type ReceiptReportRow = {
  id: string;
  receiptNumber: string;
  date: string;
  type: string;
  total: number;
  discount: number;
};

type ReceiptReportCachePayload = {
  rows: ReceiptReportRow[];
};

type ReceiptLineItem = {
  name: string;
  qty: number;
  unitPrice: number;
  amount: number;
  note?: string;
};

type ReceiptDetail = {
  orderLabel: string;
  staff: string;
  pos: string;
  serviceType: string;
  paymentMethod: string;
  transactionNo: string;
  discount: number;
  items: ReceiptLineItem[];
};

const MOCK_RECEIPT_BASE: Omit<ReceiptReportRow, 'id'>[] = [];

export const ReceiptReport: React.FC<ReceiptReportProps> = ({ selectedBranch, dateRange }) => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'sale' | 'refund'>('all');
  const [selectedReceipt, setSelectedReceipt] = useState<ReceiptReportRow | null>(null);
  const [receiptDetail, setReceiptDetail] = useState<ReceiptDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [receiptImageOpen, setReceiptImageOpen] = useState(false);
  const [receiptImageLoading, setReceiptImageLoading] = useState(false);
  const [receiptImageUrl, setReceiptImageUrl] = useState<string | null>(null);
  const [receiptOrders, setReceiptOrders] = useState<any[]>([]);
  const [receiptImageError, setReceiptImageError] = useState<string | null>(null);

  const money = (value: number) => {
    const safe = Number.isFinite(value) ? Math.trunc(value) : 0;
    return `${t('common.currency_symbol')}${safe.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };
  const moneyNoSymbol = (value: number) => {
    const safe = Number.isFinite(value) ? Math.trunc(value) : 0;
    return safe.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  };

  const headerTextClass = 'text-[13px] font-medium whitespace-nowrap bg-white';
  const bodyTextClass = 'text-sm text-brand-text bg-white group-hover:bg-brand-bg/50';
  const receiptHeaderClass = 'text-[13px] font-medium whitespace-nowrap bg-violet-50';
  const receiptBodyClass = 'text-sm text-brand-text bg-violet-50 group-hover:bg-violet-100';

  const [rows, setRows] = useState<ReceiptReportRow[]>([]);

  const branchIdForCache =
    selectedBranch && String(selectedBranch.id) !== 'all' ? String(selectedBranch.id) : null;

  const hasReceiptCacheData = useCallback(
    (cached: ReceiptReportCachePayload | null) => !!cached && cached.rows.length > 0,
    [],
  );

  const hydrateReceiptCache = useCallback((cached: ReceiptReportCachePayload) => {
    setRows(cached.rows);
  }, []);

  const clearReceiptCache = useCallback(() => {
    setRows([]);
  }, []);

  const fetchReceiptReportData = useCallback(async (): Promise<ReceiptReportCachePayload> => {
    const params = new URLSearchParams();
    if (dateRange.start) params.set('start_date', dateRange.start);
    if (dateRange.end) params.set('end_date', dateRange.end);
    if (branchIdForCache) params.set('branch_id', branchIdForCache);
    if (activeFilter !== 'all') params.set('type', activeFilter);

    const apiRows = await fetchReceiptReportApi(params);
    return {
      rows: apiRows.map((row) => ({
        id: String(row.id),
        receiptNumber: row.receiptNumber,
        date: row.date,
        type: row.type,
        total: row.total,
        discount: Number(row.discount ?? 0),
      })),
    };
  }, [activeFilter, branchIdForCache, dateRange.end, dateRange.start]);

  const { loading: reportLoading } = useAnalyticsReportLoad<ReceiptReportCachePayload>({
    report: 'receipt',
    dateRange,
    branchId: branchIdForCache,
    cacheExtra: activeFilter,
    hasCacheData: hasReceiptCacheData,
    fetchData: fetchReceiptReportData,
    onHydrate: hydrateReceiptCache,
    onClear: clearReceiptCache,
  });

  const filteredRows = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    const byType = rows.filter((row) => {
      if (activeFilter === 'all') return true;
      return row.type.toLowerCase() === activeFilter;
    });
    if (!keyword) return byType;
    return byType.filter(
      (row) =>
        row.receiptNumber.toLowerCase().includes(keyword) ||
        row.type.toLowerCase().includes(keyword)
    );
  }, [rows, searchTerm, activeFilter]);

  const allReceiptsCount = useMemo(
    () => rows.length,
    [rows]
  );
  const allReceiptsAmount = useMemo(
    () => rows.reduce((sum, row) => sum + Number(row.total || 0), 0),
    [rows]
  );
  const salesAmount = useMemo(
    () =>
      rows
        .filter((row) => row.type.toLowerCase() === 'sale')
        .reduce((sum, row) => sum + Number(row.total || 0), 0),
    [rows]
  );
  const refundAmountTotal = useMemo(
    () =>
      rows
        .filter((row) => row.type.toLowerCase() === 'refund')
        .reduce((sum, row) => sum + Number(row.total || 0), 0),
    [rows]
  );
  const activeDetail = useMemo(() => {
    if (!selectedReceipt || !receiptDetail) return null;
    return receiptDetail;
  }, [selectedReceipt, receiptDetail]);

  const openReceiptImage = async (row: ReceiptReportRow) => {
    setReceiptImageOpen(true);
    setReceiptImageLoading(true);
    setReceiptImageUrl(null);
    setReceiptOrders([]);
    setReceiptImageError(null);
    try {
      const res = await fetch(`/data-api/receipt-scan-history/order/${row.id}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error || json?.message || 'No receipt image found for this order');
      }
      setReceiptImageUrl(json?.data?.receipt_image_data_url ?? null);
      setReceiptOrders(Array.isArray(json?.data?.orders) ? json.data.orders : []);
    } catch (e) {
      console.error('Failed to load receipt image', e);
      const msg = e instanceof Error ? e.message : 'No receipt image found for this order';
      setReceiptImageError(msg);
    } finally {
      setReceiptImageLoading(false);
    }
  };

  const columns: ColumnDef<ReceiptReportRow>[] = [
    {
      header: t('receipt_report.columns.receipt_number'),
      accessorKey: 'receiptNumber',
      className: 'min-w-[160px] border-r border-gray-200',
      headerClassName: receiptHeaderClass,
      cellClassName: receiptBodyClass,
    },
    {
      header: t('receipt_report.columns.date'),
      accessorKey: 'date',
      className: 'min-w-[200px]',
      headerClassName: headerTextClass,
      cellClassName: bodyTextClass,
    },
    {
      header: t('receipt_report.columns.type'),
      accessorKey: 'type',
      className: 'min-w-[110px]',
      headerClassName: headerTextClass,
      cellClassName: `${bodyTextClass} font-medium`,
      render: (item) => (item.type.toLowerCase() === 'refund' ? t('receipt_report.type_refund') : t('receipt_report.type_sale')),
    },
    {
      header: t('receipt_report.columns.discount'),
      accessorKey: 'discount',
      sortable: true,
      className: 'min-w-[130px] text-right',
      headerClassName: headerTextClass,
      cellClassName: `${bodyTextClass} text-right`,
      render: (item) => money(item.discount),
    },
    {
      header: t('receipt_report.columns.total'),
      accessorKey: 'total',
      sortable: true,
      className: 'min-w-[130px] text-right',
      headerClassName: headerTextClass,
      cellClassName: `${bodyTextClass} text-right`,
      render: (item) => money(item.total),
    },
    {
      header: 'Receipt',
      accessorKey: 'receiptNumber',
      sortable: true,
      className: 'w-[90px] text-right',
      headerClassName: headerTextClass,
      cellClassName: `${bodyTextClass} text-right`,
      render: (item) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void openReceiptImage(item);
          }}
          className="inline-flex items-center justify-center p-2 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors"
          title="View receipt"
        >
          <Receipt size={16} />
        </button>
      ),
    },
  ];

  // --- Export Functions (CSV + PDF) ---
  const handleExportCsv = () => {
    const headers = [
      t('receipt_report.columns.receipt_number'),
      t('receipt_report.columns.date'),
      t('receipt_report.columns.type'),
      t('receipt_report.columns.discount'),
      t('receipt_report.columns.total'),
    ];

    const escapeCell = (value: string) => {
      const needsQuotes = /[",\n]/.test(value);
      const safe = value.replace(/"/g, '""');
      return needsQuotes ? `"${safe}"` : safe;
    };

    const rowsForCsv = filteredRows.map((row) => {
      const typeLabel = row.type.toLowerCase() === 'refund' ? t('receipt_report.type_refund') : t('receipt_report.type_sale');
      return [
        row.receiptNumber,
        row.date,
        typeLabel,
        row.discount.toString(),
        row.total.toString(),
      ];
    });

    const csv = [
      headers.map(escapeCell).join(','),
      ...rowsForCsv.map((r) => r.map(escapeCell).join(',')),
    ].join('\n');

    const branchNameStr = selectedBranch ? selectedBranch.name : 'All_Branches';
    const cleanBranchName = branchNameStr.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `receipt_report_${cleanBranchName}_${dateRange.start}_to_${dateRange.end}.csv`;

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
      t('receipt_report.columns.receipt_number'),
      t('receipt_report.columns.date'),
      t('receipt_report.columns.type'),
      t('receipt_report.columns.discount'),
      t('receipt_report.columns.total'),
    ];

    const body = filteredRows.map((row) => {
      const typeLabel = row.type.toLowerCase() === 'refund' ? t('receipt_report.type_refund') : t('receipt_report.type_sale');
      return [
        row.receiptNumber,
        row.date,
        typeLabel,
        money(row.discount),
        money(row.total),
      ];
    });

    autoTable(doc, {
      head: [headers],
      body,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [37, 99, 235] },
      margin: { top: 40 },
    });

    const branchNameStr = selectedBranch ? selectedBranch.name : 'All_Branches';
    const cleanBranchName = branchNameStr.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `receipt_report_${cleanBranchName}_${dateRange.start}_to_${dateRange.end}.pdf`;

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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-2xl" />
              ))}
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
                  placeholder={t('receipt_report.search_placeholder')}
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <button
                type="button"
                onClick={() => setActiveFilter('all')}
                className={`text-left rounded-2xl px-5 py-4 border shadow-sm transition-colors ${activeFilter === 'all'
                  ? 'bg-brand-primary/5 border-brand-primary/40'
                  : 'bg-white border-gray-100 hover:bg-gray-50'
                  }`}
              >
                <p className="text-sm text-brand-muted mb-1">{t('receipt_report.filter_all_receipts')}</p>
                <p className="text-2xl font-bold text-brand-text">{allReceiptsCount.toLocaleString()}</p>
              </button>
              <button
                type="button"
                onClick={() => setActiveFilter('sale')}
                className={`text-left rounded-2xl px-5 py-4 border shadow-sm transition-colors ${activeFilter === 'sale'
                  ? 'bg-brand-primary/5 border-brand-primary/40'
                  : 'bg-white border-gray-100 hover:bg-gray-50'
                  }`}
              >
                <p className="text-sm text-brand-muted mb-1">{t('receipt_report.filter_sale')}</p>
                <p className="text-2xl font-bold text-brand-text">{money(salesAmount)}</p>
              </button>
              <button
                type="button"
                onClick={() => setActiveFilter('refund')}
                className={`text-left rounded-2xl px-5 py-4 border shadow-sm transition-colors ${activeFilter === 'refund'
                  ? 'bg-brand-primary/5 border-brand-primary/40'
                  : 'bg-white border-gray-100 hover:bg-gray-50'
                  }`}
              >
                <p className="text-sm text-brand-muted mb-1">{t('receipt_report.filter_refund_amount')}</p>
                <p className="text-2xl font-bold text-brand-text">{money(refundAmountTotal)}</p>
              </button>
            </div>
            <DataTable
        data={filteredRows}
        columns={columns}
        keyExtractor={(item) => item.id}
        onRowClick={async (row) => {
          setSelectedReceipt(row);
          setReceiptDetail(null);
          setDetailError(null);
          setDetailLoading(true);
          try {
            const [detail, order, orderItems] = await Promise.all([
              fetchReceiptDetailApi(row.id),
              getOrderById(String(row.id)),
              getOrderItems(String(row.id)),
            ]);

            const fromOrderItems: ReceiptLineItem[] = (orderItems || []).map((it) => ({
              name: String(it.MENU_NAME || `#${it.MENU_ID}`),
              qty: Number(it.QTY || 0),
              unitPrice: Number(it.UNIT_PRICE || 0),
              amount: Number(it.LINE_TOTAL || 0),
              note: it.REMARKS ?? undefined,
            }));

            // If service charge is stored on the order header (not as an order_item),
            // include it so the slip matches the totals.
            const hasChargeAlready = fromOrderItems.some((it) =>
              /\b(room|service)\s*charge\b/i.test(String(it?.name || '').trim()),
            );
            const headerCharge = order ? Number((order as any).SERVICE_CHARGE || 0) : 0;

            let itemsForSlip = fromOrderItems;
            if (!hasChargeAlready && headerCharge > 0) {
              const tableId = (order as any)?.TABLE_ID;
              if (tableId != null && String(tableId).trim() !== '') {
                try {
                  const res = await fetch(`/data-api/restaurant_table/${encodeURIComponent(String(tableId))}`, {
                    credentials: 'include',
                    headers: (() => {
                      const token = localStorage.getItem('token');
                      return {
                        Accept: 'application/json',
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                      } as Record<string, string>;
                    })(),
                  });
                  const json = await res.json().catch(() => ({} as any));
                  const tbl = json?.data ?? json;
                  const roomChargeUnit = Number(tbl?.ROOM_CHARGE ?? tbl?.roomCharge ?? 0);

                  // Orders module treats "room charge" based on table ROOM_CHARGE (not on table label text).
                  if (roomChargeUnit > 0) {
                    const q = headerCharge / roomChargeUnit;
                    const qty = (() => {
                      if (!Number.isFinite(q) || q <= 0) return 1;
                      // Allow decimals (e.g. 1.5 x 5,000) but keep whole numbers clean.
                      if (Math.abs(q - Math.round(q)) < 1e-9) return Math.round(q);
                      return Math.round(q * 100) / 100;
                    })();
                    const unitPrice = roomChargeUnit;
                    itemsForSlip = [
                      ...fromOrderItems,
                      { name: 'Room charge', qty, unitPrice, amount: headerCharge, note: undefined },
                    ];
                  } else {
                    itemsForSlip = [
                      ...fromOrderItems,
                      { name: 'Service charge', qty: 1, unitPrice: headerCharge, amount: headerCharge, note: undefined },
                    ];
                  }
                } catch {
                  itemsForSlip = [
                    ...fromOrderItems,
                    { name: 'Service charge', qty: 1, unitPrice: headerCharge, amount: headerCharge, note: undefined },
                  ];
                }
              } else {
                itemsForSlip = [
                  ...fromOrderItems,
                  { name: 'Service charge', qty: 1, unitPrice: headerCharge, amount: headerCharge, note: undefined },
                ];
              }
            }

            const fallbackItems: ReceiptLineItem[] = (detail.items || []).map((item) => ({
              name: item.name,
              qty: item.qty,
              unitPrice: item.unitPrice,
              amount: item.amount,
              note: item.note ?? undefined,
            }));

            setReceiptDetail({
              orderLabel: detail.orderLabel,
              staff: detail.staff,
              pos: detail.pos,
              serviceType: detail.serviceType,
              paymentMethod: detail.paymentMethod,
              transactionNo: detail.transactionNo,
              discount: Math.max(0, Number((order as any)?.DISCOUNT_AMOUNT ?? 0)),
              items: itemsForSlip.length ? itemsForSlip : fallbackItems,
            });
          } catch (error) {
            console.error('Failed to load receipt detail', error);
            setDetailError(t('receipt_report.detail_error'));
          } finally {
            setDetailLoading(false);
          }
        }}
      />
          </motion.div>
        )}
      </AnimatePresence>
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {selectedReceipt && activeDetail && (
              <>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setSelectedReceipt(null)}
                  className="fixed inset-0 bg-black/20 z-[60]"
                />
                <motion.aside
                  initial={{ x: '100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '100%' }}
                  transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                  className="fixed top-0 right-0 h-full w-96 bg-white shadow-2xl z-[70] flex flex-col"
                >
                  <div className="p-4 border-b border-gray-100 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setSelectedReceipt(null)}
                      className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-brand-muted"
                    >
                      <X size={18} />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pb-5 text-brand-text">
                    <div className="text-center border-b border-gray-200 pb-3 pt-2">
                      <p className="text-[40px] leading-none tracking-tight">{money(selectedReceipt.total)}</p>
                      <p className="text-sm text-brand-muted mt-1">{t('receipt_report.detail_aggregate')}</p>
                    </div>

                    {!detailLoading && !activeDetail && (
                      <div className="py-6 text-center text-sm text-brand-muted">
                        {t('receipt_report.detail_no_items')}
                      </div>
                    )}

                    {detailLoading && (
                      <div className="py-6 text-center text-sm text-brand-muted">
                        {t('receipt_report.detail_loading')}
                      </div>
                    )}

                    {!detailLoading && activeDetail && (
                      <>
                        <div className="py-3 border-b border-gray-200 text-sm leading-6">
                          <p>{activeDetail.orderLabel}</p>
                          <p>{t('receipt_report.detail_staff')}: {activeDetail.staff}</p>
                          <p>{t('receipt_report.detail_pos')}: {activeDetail.pos}</p>
                        </div>

                        <div className="py-3 border-b border-gray-200">
                          <p className="text-sm font-semibold">{activeDetail.serviceType}</p>
                          <div className="mt-2 pt-2 border-t border-gray-200 space-y-2">
                            {activeDetail.items.map((item, idx) => (
                              <div key={`${item.name}-${idx}`}>
                                <div className="flex items-center justify-between text-sm">
                                  <span>{item.name}</span>
                                  <span>{money(item.amount)}</span>
                                </div>
                                <p className="text-xs text-brand-muted">
                                  {item.qty} x {money(item.unitPrice)}
                                </p>
                                {item.note && <p className="text-xs italic text-brand-muted">{item.note}</p>}
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}

                    <div className="py-3 border-b border-gray-200 space-y-1.5">
                      <div className="flex items-center justify-between text-sm font-semibold">
                        <span>{t('receipt_report.columns.total')}</span>
                        <span>{money(selectedReceipt.total)}</span>
                      </div>
                      {activeDetail && activeDetail.discount > 0 && (
                        <div className="flex items-center justify-between text-sm">
                          <span>{t('receipt_report.columns.discount')}</span>
                          <span>-{money(activeDetail.discount)}</span>
                        </div>
                      )}
                      {activeDetail && (
                        <div className="flex items-center justify-between text-sm">
                          <span>{activeDetail.paymentMethod}</span>
                          <span>{money(selectedReceipt.total)}</span>
                        </div>
                      )}
                    </div>

                    <div className="pt-3 flex items-center justify-between text-sm text-brand-muted">
                      <span>{selectedReceipt.date}</span>
                      <span>{activeDetail.transactionNo}</span>
                    </div>
                  </div>
                </motion.aside>
              </>
            )}
          </AnimatePresence>,
          document.body
        )}

      <Modal
        isOpen={receiptImageOpen}
        onClose={() => {
          setReceiptImageOpen(false);
          setReceiptImageUrl(null);
          setReceiptOrders([]);
          setReceiptImageError(null);
        }}
        title="Receipt"
        maxWidth="6xl"
      >
        {receiptImageLoading ? (
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
                                        {moneyNoSymbol(Number(it.LINE_TOTAL || 0))}
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
                                      {moneyNoSymbol(Number(o.SUBTOTAL || 0))}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between gap-3">
                                    <span className="text-brand-muted font-bold uppercase tracking-widest text-[11px]">
                                      Service charge
                                    </span>
                                    <span className="font-extrabold tabular-nums w-[92px] text-right text-slate-800">
                                      {moneyNoSymbol(Number(o.SERVICE_CHARGE || 0))}
                                    </span>
                                  </div>
                                  <div className="pt-2 mt-1 border-t border-gray-200/80 flex items-center justify-between gap-3">
                                    <span className="text-brand-muted font-bold uppercase tracking-widest text-[11px]">
                                      Total
                                    </span>
                                    <span className="font-black tabular-nums w-[92px] text-right text-violet-700 text-base">
                                      {money(Number(o.GRAND_TOTAL || (Number(o.SUBTOTAL || 0) + Number(o.SERVICE_CHARGE || 0))))}
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
        ) : receiptImageError ? (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-6 text-sm text-brand-muted">
            <div className="font-bold text-brand-text mb-1">No receipt image</div>
            <div>{receiptImageError}</div>
          </div>
        ) : (
          <div className="text-sm text-brand-muted">No receipt image.</div>
        )}
      </Modal>
    </div>
  );
};

