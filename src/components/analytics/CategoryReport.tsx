import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { AlertCircle, ChevronDown, Eye, ExternalLink, LayoutList, Loader2, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { type Branch } from '../partials/Header';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Modal } from '../ui/Modal';
import { Skeleton } from '../ui/Skeleton';
import {
  fetchCategoryReportApi,
  fetchCategoryMenuBreakdownApi,
  isRoomChargeTableDetailId,
  type ApiCategoryReportRow,
  type ApiCategoryMenuBreakdownRow,
} from '../../services/analyticsService';
import { useAnalyticsReportLoad } from '../../hooks/useAnalyticsReportLoad';

type CategoryReportProps = {
  selectedBranch: Branch | null;
  dateRange: {
    start: string;
    end: string;
  };
};

type CategoryReportRow = {
  id: string;
  category: string;
  mainCategory: string;
  subCategory: string;
  branch: string;
  salesQty: number;
  totalSales: number;
};

type CategoryReportCachePayload = {
  rows: CategoryReportRow[];
};

const formatCategoryLegend = (mainCategory: string, subCategory: string) => {
  const main = mainCategory.trim() || 'Uncategorized';
  const sub = subCategory.trim();
  return sub ? `${main} / ${sub}` : main;
};

export const CategoryReport: React.FC<CategoryReportProps> = ({ selectedBranch, dateRange }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchTerm, setSearchTerm] = useState('');
  const [rows, setRows] = useState<CategoryReportRow[]>([]);
  const [viewRow, setViewRow] = useState<CategoryReportRow | null>(null);
  const [breakdownRows, setBreakdownRows] = useState<ApiCategoryMenuBreakdownRow[]>([]);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState(false);
  const [breakdownSort, setBreakdownSort] = useState<{ key: 'menuName' | 'salesQty' | 'unitPrice' | 'netSales'; dir: 'asc' | 'desc' } | null>(
    null
  );

  const branchIdForCache =
    selectedBranch && String(selectedBranch.id) !== 'all' ? String(selectedBranch.id) : null;

  const hasCategoryCacheData = useCallback(
    (cached: CategoryReportCachePayload | null) => !!cached && cached.rows.length > 0,
    [],
  );

  const hydrateCategoryCache = useCallback((cached: CategoryReportCachePayload) => {
    setRows((prev) => (cached.rows.length > 0 ? cached.rows : prev));
  }, []);

  const clearCategoryCache = useCallback(() => {
    setRows([]);
  }, []);

  const fetchCategoryReportData = useCallback(async (): Promise<CategoryReportCachePayload> => {
    const params = new URLSearchParams();
    if (dateRange.start) params.set('start_date', dateRange.start);
    if (dateRange.end) params.set('end_date', dateRange.end);
    if (branchIdForCache) params.set('branch_id', branchIdForCache);

    const apiRows: ApiCategoryReportRow[] = await fetchCategoryReportApi(params);
    return {
      rows: apiRows.map((row) => ({
        id: String(row.id),
        category: row.category,
        mainCategory: row.mainCategory ?? row.category ?? 'Uncategorized',
        subCategory: row.subCategory ?? '',
        branch: row.branch || selectedBranch?.name || 'All Branches',
        salesQty: row.salesQty,
        totalSales: row.totalSales,
      })),
    };
  }, [branchIdForCache, dateRange.end, dateRange.start, selectedBranch?.name]);

  const { loading: reportLoading } = useAnalyticsReportLoad<CategoryReportCachePayload>({
    report: 'category',
    dateRange,
    branchId: branchIdForCache,
    hasCacheData: hasCategoryCacheData,
    fetchData: fetchCategoryReportData,
    onHydrate: hydrateCategoryCache,
    onClear: clearCategoryCache,
  });

  const money = (value: number) => {
    const safe = Number.isFinite(value) ? Math.trunc(value) : 0;
    return `${t('common.currency_symbol')}${safe.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  const qtyText = (value: number) => {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0';
    const isInt = Math.abs(n - Math.round(n)) < 1e-9;
    return isInt ? Math.round(n).toLocaleString() : (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  useEffect(() => {
    if (!viewRow) {
      setBreakdownRows([]);
      setBreakdownLoading(false);
      setBreakdownError(false);
      return;
    }
    const cid = Number(viewRow.id);
    if (cid === -9999) {
      setBreakdownRows([]);
      setBreakdownLoading(false);
      setBreakdownError(false);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams();
    params.set('category_id', String(cid));
    if (dateRange.start) params.set('start_date', dateRange.start);
    if (dateRange.end) params.set('end_date', dateRange.end);
    if (selectedBranch && String(selectedBranch.id) !== 'all') {
      params.set('branch_id', String(selectedBranch.id));
    }
    setBreakdownLoading(true);
    setBreakdownError(false);
    void fetchCategoryMenuBreakdownApi(params)
      .then((data) => {
        if (!cancelled) {
          setBreakdownRows(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBreakdownRows([]);
          setBreakdownError(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBreakdownLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [viewRow, dateRange.start, dateRange.end, selectedBranch?.id]);

  const filteredRows = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    if (!keyword) return rows;
    return rows.filter((row) => {
      const legend = formatCategoryLegend(row.mainCategory, row.subCategory).toLowerCase();
      return (
        row.category.toLowerCase().includes(keyword) ||
        row.branch.toLowerCase().includes(keyword) ||
        legend.includes(keyword)
      );
    });
  }, [rows, searchTerm]);

  const canOpenMenuLanding = useMemo(() => {
    if (!viewRow) return false;
    const cid = Number(viewRow.id);
    if (!Number.isFinite(cid) || cid <= 0) return false;
    return Boolean(selectedBranch && String(selectedBranch.id) !== 'all');
  }, [viewRow, selectedBranch]);

  const openMenuLanding = useCallback(() => {
    if (!viewRow || !canOpenMenuLanding || !selectedBranch) return;
    const params = new URLSearchParams(location.search);
    params.set('branchId', String(selectedBranch.id));
    params.set('categoryId', String(viewRow.id));
    navigate(`/menu-management?${params.toString()}`);
  }, [viewRow, canOpenMenuLanding, selectedBranch, location.search, navigate]);

  const categoryLegendLabel = useMemo(() => {
    if (!viewRow) return '';
    return formatCategoryLegend(viewRow.mainCategory, viewRow.subCategory);
  }, [viewRow]);

  const breakdownNetSalesTotal = useMemo(() => {
    const sumVisibleRows = breakdownRows.reduce((sum, row) => sum + Number(row.netSales || 0), 0);
    // Room Charge breakdown intentionally hides some legacy "per-table" menu lines to avoid duplicates.
    // Use the main table total for Room Charge so the modal always matches the category row.
    if (viewRow && Number(viewRow.id) === -9998) return Number(viewRow.totalSales || 0);
    return sumVisibleRows;
  }, [breakdownRows, viewRow]);

  const sortedBreakdownRows = useMemo(() => {
    if (!breakdownSort) return breakdownRows;
    const { key, dir } = breakdownSort;
    const factor = dir === 'asc' ? 1 : -1;
    const copy = breakdownRows.slice();
    copy.sort((a, b) => {
      const av = (a as any)?.[key];
      const bv = (b as any)?.[key];

      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;

      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * factor;
    });
    return copy;
  }, [breakdownRows, breakdownSort]);

  const columns: ColumnDef<CategoryReportRow>[] = [
    {
      header: t('category_report.columns.category'),
      accessorKey: 'category',
      className: 'min-w-[200px] border-r border-gray-200',
    },
    {
      header: 'Branch',
      accessorKey: 'branch',
      className: 'min-w-[190px]',
    },
    {
      header: t('category_report.columns.sales_quantity'),
      accessorKey: 'salesQty',
      render: (item) => item.salesQty.toLocaleString(),
      className: 'min-w-[130px] text-right',
    },
    {
      header: t('category_report.columns.total_sales'),
      accessorKey: 'totalSales',
      render: (item) => money(item.totalSales),
      className: 'min-w-[130px] text-right',
    },
    {
      header: t('category_report.columns.action'),
      sortable: false,
      className: 'w-[88px] text-center',
      render: (item) => (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setViewRow(item);
            }}
            className="p-2.5 text-brand-muted rounded-full ring-1 ring-transparent hover:text-brand-primary hover:bg-indigo-50 hover:ring-brand-primary/15 transition-all duration-200"
            title={t('category_report.view_details')}
          >
            <Eye size={17} strokeWidth={2} />
          </button>
        </div>
      ),
    },
  ];

  // --- Export Functions (CSV + PDF) ---
  const handleExportCsv = () => {
    const headers = [
      t('category_report.columns.category'),
      'Branch',
      t('category_report.columns.sales_quantity'),
      t('category_report.columns.total_sales'),
    ];

    const escapeCell = (value: string) => {
      const needsQuotes = /[",\n]/.test(value);
      const safe = value.replace(/"/g, '""');
      return needsQuotes ? `"${safe}"` : safe;
    };

    const rowsForCsv = filteredRows.map((row) => [
      row.category,
      row.branch,
      row.salesQty.toString(),
      row.totalSales.toString(),
    ]);

    const csv = [
      headers.map(escapeCell).join(','),
      ...rowsForCsv.map((r) => r.map(escapeCell).join(',')),
    ].join('\n');

    const branchNameStr = selectedBranch ? selectedBranch.name : 'All_Branches';
    const cleanBranchName = branchNameStr.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `category_report_${cleanBranchName}_${dateRange.start}_to_${dateRange.end}.csv`;

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
      t('category_report.columns.category'),
      'Branch',
      t('category_report.columns.sales_quantity'),
      t('category_report.columns.total_sales'),
    ];

    const body = filteredRows.map((row) => [
      row.category,
      row.branch,
      row.salesQty.toLocaleString(),
      money(row.totalSales),
    ]);

    autoTable(doc, {
      head: [headers],
      body,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [59, 130, 246] },
      margin: { top: 40 },
    });

    const branchNameStr = selectedBranch ? selectedBranch.name : 'All_Branches';
    const cleanBranchName = branchNameStr.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `category_report_${cleanBranchName}_${dateRange.start}_to_${dateRange.end}.pdf`;

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
                  placeholder={t('category_report.search_placeholder')}
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
            <DataTable
              data={filteredRows}
              columns={columns}
              keyExtractor={(item) => item.id}
              onRowClick={(item) => setViewRow(item)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <Modal
        isOpen={viewRow !== null}
        onClose={() => setViewRow(null)}
        title={viewRow?.category ?? ''}
        subtitle={
          viewRow ? (
            canOpenMenuLanding ? (
              <button
                type="button"
                onClick={openMenuLanding}
                className="group inline-flex max-w-full items-center gap-1.5 rounded-lg border border-indigo-100 bg-indigo-50/70 px-2.5 py-1.5 text-left text-xs font-semibold text-indigo-800 transition-colors hover:border-indigo-200 hover:bg-indigo-100/80 hover:text-indigo-950"
                title={t('category_report.open_in_menu')}
              >
                <span className="truncate">{categoryLegendLabel}</span>
                <ExternalLink
                  size={13}
                  strokeWidth={2.25}
                  className="shrink-0 opacity-60 transition-opacity group-hover:opacity-100"
                  aria-hidden
                />
              </button>
            ) : (
              <span className="inline-flex max-w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-600">
                <span className="truncate">{categoryLegendLabel}</span>
              </span>
            )
          ) : null
        }
        maxWidth="3xl"
        containerClassName="items-center justify-center px-3 sm:px-5"
        panelClassName="rounded-[1.35rem] shadow-2xl shadow-indigo-950/10 ring-1 ring-indigo-100/90 border-indigo-50/80 overflow-hidden"
        titleClassName="text-base sm:text-lg leading-snug line-clamp-2 text-balance"
        bodyClassName="px-4 py-5 sm:px-7 sm:py-6 overflow-hidden"
      >
        {viewRow && (
          <div className="text-sm text-brand-text flex min-h-0 flex-col">
            {Number(viewRow.id) === -9999 ? (
              <div className="rounded-2xl border border-amber-100 bg-amber-50/60 px-4 py-3.5 text-amber-900/90 text-sm leading-relaxed">
                {t('category_report.breakdown_synthetic')}
              </div>
            ) : (
              <div className="rounded-2xl border border-slate-200/90 bg-gradient-to-br from-slate-50/95 via-white to-indigo-50/25 shadow-inner overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5 border-b border-slate-200/70 bg-white/70 backdrop-blur-[2px]">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-100/90 text-indigo-700">
                      <LayoutList size={16} strokeWidth={2.25} aria-hidden />
                    </span>
                    <h4 className="text-sm font-bold text-brand-text tracking-tight truncate">
                      {Number(viewRow.id) === -9998
                        ? t('category_report.breakdown_room_charge_heading')
                        : t('category_report.breakdown_heading')}
                    </h4>
                  </div>
                  {!breakdownLoading && !breakdownError && breakdownRows.length > 0 ? (
                    <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-indigo-700/90 tabular-nums rounded-full bg-indigo-100/80 px-2.5 py-1">
                      {t('category_report.breakdown_rows_count', { count: breakdownRows.length })}
                    </span>
                  ) : null}
                </div>

                <div className="p-3 sm:p-4 min-h-0 flex flex-col">
                  {Number(viewRow.id) === -9998 ? (
                    <p className="mb-3 text-xs leading-relaxed text-brand-muted px-0.5">
                      {t('category_report.breakdown_room_charge_hint')}
                    </p>
                  ) : null}
                  {breakdownLoading ? (
                    <div className="flex flex-col items-center justify-center gap-3 py-16 rounded-xl border border-dashed border-slate-200 bg-white/50">
                      <Loader2 className="h-8 w-8 animate-spin text-indigo-500" aria-hidden />
                      <p className="text-xs font-medium text-brand-muted">{t('category_report.breakdown_loading_hint')}</p>
                    </div>
                  ) : breakdownError ? (
                    <div className="flex gap-3 rounded-xl border border-red-100 bg-red-50/70 px-4 py-3.5 text-red-800">
                      <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" aria-hidden />
                      <p className="text-sm leading-relaxed">{t('category_report.breakdown_error')}</p>
                    </div>
                  ) : breakdownRows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 py-14 rounded-xl border border-dashed border-slate-200 bg-white/40 text-center">
                      <LayoutList className="h-9 w-9 text-slate-300" strokeWidth={1.5} aria-hidden />
                      <p className="text-sm text-brand-muted max-w-xs leading-relaxed">
                        {t('category_report.breakdown_empty')}
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-1 min-h-0 max-h-[min(60vh,34rem)] flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white/90 shadow-sm">
                      <div className="custom-scrollbar min-h-0 flex-1 overflow-auto">
                        <table className="w-full text-sm border-collapse">
                          <thead className="sticky top-0 z-[1] border-b border-indigo-100/90 bg-gradient-to-b from-indigo-50 to-indigo-50/85 text-left text-[11px] font-bold text-indigo-900/75 uppercase tracking-wider shadow-[0_1px_0_rgba(15,23,42,0.06)]">
                            <tr>
                              {(
                                [
                                  {
                                    key: 'menuName' as const,
                                    label: t('category_report.breakdown_menu'),
                                    thClassName: 'text-left px-4 py-3 pl-4 sm:pl-5',
                                    cellBg: 'bg-indigo-50/90',
                                  },
                                  {
                                    key: 'salesQty' as const,
                                    label: t('category_report.breakdown_qty'),
                                    thClassName: 'text-right px-3 py-3 w-[5.5rem]',
                                    cellBg: 'bg-indigo-50/90',
                                  },
                                  {
                                    key: 'unitPrice' as const,
                                    label: t('category_report.breakdown_unit_price'),
                                    thClassName: 'text-right px-3 py-3 w-[7.5rem]',
                                    cellBg: 'bg-indigo-50/90',
                                  },
                                  {
                                    key: 'netSales' as const,
                                    label: t('category_report.breakdown_net_sales'),
                                    thClassName: 'text-right px-4 py-3 pr-4 sm:pr-5 min-w-[7rem]',
                                    cellBg: 'bg-indigo-50/90',
                                  },
                                ] as const
                              ).map((col) => {
                                const isActive = breakdownSort?.key === col.key;
                                const dir = isActive ? breakdownSort?.dir : null;
                                return (
                                  <th key={col.key} className={cn(col.cellBg, col.thClassName)}>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setBreakdownSort((prev) => {
                                          if (!prev || prev.key !== col.key) return { key: col.key, dir: 'asc' };
                                          return { key: col.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
                                        });
                                      }}
                                      className={cn(
                                        'inline-flex items-center gap-2 rounded-lg -mx-2 px-2 py-1 transition-colors',
                                        'hover:bg-white/50'
                                      )}
                                    >
                                      <span>{col.label}</span>
                                      <span
                                        className={cn(
                                          'text-indigo-800/70 transition-transform',
                                          dir === 'desc' ? 'rotate-180' : '',
                                          isActive ? 'opacity-100' : 'opacity-40'
                                        )}
                                        aria-hidden
                                      >
                                        <ChevronDown size={14} />
                                      </span>
                                    </button>
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {sortedBreakdownRows.map((row, index) => (
                              <tr
                                key={isRoomChargeTableDetailId(row.id) ? `rc-tbl-${row.id}` : row.id}
                                className={cn(
                                  'transition-colors duration-150 hover:bg-indigo-50/40',
                                  index % 2 === 1 ? 'bg-slate-50/35' : 'bg-white'
                                )}
                              >
                                <td className="px-4 py-3 pl-4 sm:pl-5 font-medium text-brand-text leading-snug">
                                  {row.menuName}
                                </td>
                                <td className="px-3 py-3 text-right tabular-nums text-slate-700">
                                  {qtyText(Number(row.salesQty || 0))}
                                </td>
                                <td className="px-3 py-3 text-right tabular-nums text-slate-600">
                                  {money(row.unitPrice ?? 0)}
                                </td>
                                <td className="px-4 py-3 pr-4 sm:pr-5 text-right tabular-nums font-semibold text-indigo-950/90">
                                  {money(row.netSales)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="flex shrink-0 items-center justify-end gap-3 border-t border-slate-200/80 bg-white/85 px-4 py-3 sm:px-5 backdrop-blur-[2px]">
                        <span className="text-[11px] font-black uppercase tracking-wide text-brand-muted">
                          {t('category_report.breakdown_net_sales')}
                        </span>
                        <span className="text-base font-black tabular-nums text-brand-text">
                          {money(breakdownNetSalesTotal)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

