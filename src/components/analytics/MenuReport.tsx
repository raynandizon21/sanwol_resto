import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { AlertCircle, ExternalLink, Loader2, Search, Store } from 'lucide-react';
import { Skeleton } from '../ui/Skeleton';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { type Branch } from '../partials/Header';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import {
  fetchDailySalesApi,
  fetchMenuReportApi,
  fetchMenuReportBundleApi,
  type ApiDailySalesItem,
  type ApiMenuReportRow,
} from '../../services/analyticsService';
import { useAnalyticsReportLoad } from '../../hooks/useAnalyticsReportLoad';

/** Measures container and renders chart with explicit width/height to avoid Recharts -1 warning */
function ChartContainer({
  className = '',
  render,
}: {
  className?: string;
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
    <div ref={ref} className={className} style={{ minHeight: 240 }}>
      {size.width > 0 && size.height > 0 ? render(size) : null}
    </div>
  );
}

type MenuReportProps = {
  selectedBranch: Branch | null;
  dateRange: {
    start: string;
    end: string;
  };
};

type MenuReportRow = {
  id: string;
  goods: string;
  mainCategory: string;
  subCategory: string;
  categoryId: number | null;
  salesQty: number;
  totalSales: number;
  netSales: number;
};

const formatMenuCategoryLabel = (mainCategory: string, subCategory: string) => {
  const main = mainCategory.trim() || 'Uncategorized';
  const sub = subCategory.trim();
  return sub ? `${main} / ${sub}` : main;
};

type MenuReportCachePayload = {
  rows: MenuReportRow[];
  dailySalesCurrent: ApiDailySalesItem[];
};

const BRANCH_BAR_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

type TopProductRow = {
  key: string;
  name: string;
  color: string;
  netSales: number;
};

const parseDateSafe = (value: string) => {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatDateLabel = (date: Date) =>
  date.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });

export const MenuReport: React.FC<MenuReportProps> = ({ selectedBranch, dateRange }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchTerm, setSearchTerm] = useState('');
  const [rows, setRows] = useState<MenuReportRow[]>([]);
  const [dailySalesCurrent, setDailySalesCurrent] = useState<ApiDailySalesItem[]>([]);
  /** When set, chart shows only this product's bar; when null, shows stacked bars for all. */
  const [selectedProductKey, setSelectedProductKey] = useState<string | null>(null);

  const branchIdForCache =
    selectedBranch && String(selectedBranch.id) !== 'all' ? String(selectedBranch.id) : null;

  const canOpenMenuLanding = Boolean(selectedBranch && String(selectedBranch.id) !== 'all');

  const openMenuLanding = useCallback(
    (categoryId: number | null | undefined) => {
      if (!canOpenMenuLanding || !selectedBranch || !categoryId || categoryId <= 0) return;
      const params = new URLSearchParams(location.search);
      params.set('branchId', String(selectedBranch.id));
      params.set('categoryId', String(categoryId));
      navigate(`/menu-management?${params.toString()}`);
    },
    [canOpenMenuLanding, selectedBranch, location.search, navigate],
  );

  const hasMenuCacheData = useCallback(
    (cached: MenuReportCachePayload | null) =>
      !!cached && (cached.rows.length > 0 || cached.dailySalesCurrent.length > 0),
    [],
  );

  const hydrateMenuCache = useCallback((cached: MenuReportCachePayload) => {
    setRows((prev) => (cached.rows.length > 0 ? cached.rows : prev));
    setDailySalesCurrent((prev) => (cached.dailySalesCurrent.length > 0 ? cached.dailySalesCurrent : prev));
  }, []);

  const clearMenuCache = useCallback(() => {
    setRows([]);
    setDailySalesCurrent([]);
  }, []);

  const fetchMenuReportData = useCallback(async (): Promise<MenuReportCachePayload> => {
    const mapRows = (apiRows: ApiMenuReportRow[]) =>
      apiRows.map((row) => ({
        id: String(row.id),
        goods: row.goods,
        mainCategory: row.mainCategory ?? row.category ?? 'Uncategorized',
        subCategory: row.subCategory ?? '',
        categoryId:
          row.categoryId != null && Number(row.categoryId) > 0 ? Number(row.categoryId) : null,
        salesQty: row.salesQty,
        totalSales: row.totalSales,
        netSales: row.netSales,
      }));

    try {
      const bundle = await fetchMenuReportBundleApi({
        start: dateRange.start,
        end: dateRange.end,
        branchId: branchIdForCache,
      });

      if (bundle.menuRows.length > 0 || bundle.dailySalesCurrent.length > 0) {
        return {
          rows: mapRows(bundle.menuRows),
          dailySalesCurrent: bundle.dailySalesCurrent,
        };
      }
    } catch (error) {
      console.warn('[MenuReport] bundle fetch failed, falling back:', error);
    }

    const params = new URLSearchParams();
    if (dateRange.start) params.set('start_date', dateRange.start);
    if (dateRange.end) params.set('end_date', dateRange.end);
    if (branchIdForCache) params.set('branch_id', branchIdForCache);

    const [apiRows, dailySales] = await Promise.all([
      fetchMenuReportApi(params),
      fetchDailySalesApi(new URLSearchParams(params)),
    ]);

    return {
      rows: mapRows(apiRows),
      dailySalesCurrent: dailySales,
    };
  }, [branchIdForCache, dateRange.end, dateRange.start]);

  const { loading: reportLoading } = useAnalyticsReportLoad<MenuReportCachePayload>({
    report: 'menu',
    dateRange,
    branchId: branchIdForCache,
    hasCacheData: hasMenuCacheData,
    fetchData: fetchMenuReportData,
    onHydrate: hydrateMenuCache,
    onClear: clearMenuCache,
  });

  const money = (value: number) =>
    `${t('common.currency_symbol')}${value.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;

  const filteredRows = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    if (!keyword) return rows;
    return rows.filter((row) => {
      const categoryLabel = formatMenuCategoryLabel(row.mainCategory, row.subCategory).toLowerCase();
      return row.goods.toLowerCase().includes(keyword) || categoryLabel.includes(keyword);
    });
  }, [rows, searchTerm]);

  const columns: ColumnDef<MenuReportRow>[] = [
    {
      header: t('menu_report.columns.goods'),
      accessorKey: 'goods',
      className: 'min-w-[180px] border-r border-gray-200',
    },
    {
      header: t('menu_report.columns.main_sub_category'),
      accessorKey: 'mainCategory',
      className: 'min-w-[170px]',
      render: (item) => {
        const label = formatMenuCategoryLabel(item.mainCategory, item.subCategory);
        const clickable = canOpenMenuLanding && item.categoryId != null && item.categoryId > 0;
        if (!clickable) {
          return (
            <span className="inline-flex max-w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-600">
              <span className="truncate">{label}</span>
            </span>
          );
        }
        return (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openMenuLanding(item.categoryId);
            }}
            className="group inline-flex max-w-full items-center gap-1.5 rounded-lg border border-indigo-100 bg-indigo-50/70 px-2.5 py-1.5 text-left text-xs font-semibold text-indigo-800 transition-colors hover:border-indigo-200 hover:bg-indigo-100/80 hover:text-indigo-950"
            title={t('menu_report.open_in_menu')}
          >
            <span className="truncate">{label}</span>
            <ExternalLink
              size={13}
              strokeWidth={2.25}
              className="shrink-0 opacity-60 transition-opacity group-hover:opacity-100"
              aria-hidden
            />
          </button>
        );
      },
    },
    {
      header: t('menu_report.columns.sales_quantity'),
      accessorKey: 'salesQty',
      render: (item) => item.salesQty.toLocaleString(),
      className: 'min-w-[130px] text-right',
    },
    {
      header: t('menu_report.columns.total_sales'),
      accessorKey: 'totalSales',
      render: (item) => money(item.totalSales),
      className: 'min-w-[130px] text-right',
    },
  ];

  // --- Export Functions (CSV + PDF) ---
  const handleExportCsv = () => {
    const headers = [
      t('menu_report.columns.goods'),
      t('menu_report.columns.main_sub_category'),
      t('menu_report.columns.sales_quantity'),
      t('menu_report.columns.total_sales'),
    ];

    const escapeCell = (value: string) => {
      const needsQuotes = /[",\n]/.test(value);
      const safe = value.replace(/"/g, '""');
      return needsQuotes ? `"${safe}"` : safe;
    };

    const rowsForCsv = filteredRows.map((row) => [
      row.goods,
      formatMenuCategoryLabel(row.mainCategory, row.subCategory),
      row.salesQty.toString(),
      row.totalSales.toString(),
    ]);

    const csv = [
      headers.map(escapeCell).join(','),
      ...rowsForCsv.map((r) => r.map(escapeCell).join(',')),
    ].join('\n');

    const branchNameStr = selectedBranch ? selectedBranch.name : 'All_Branches';
    const cleanBranchName = branchNameStr.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `menu_report_${cleanBranchName}_${dateRange.start}_to_${dateRange.end}.csv`;

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
      t('menu_report.columns.goods'),
      t('menu_report.columns.main_sub_category'),
      t('menu_report.columns.sales_quantity'),
      t('menu_report.columns.total_sales'),
    ];

    const body = filteredRows.map((row) => [
      row.goods,
      formatMenuCategoryLabel(row.mainCategory, row.subCategory),
      row.salesQty.toLocaleString(),
      money(row.totalSales),
    ]);

    autoTable(doc, {
      head: [headers],
      body,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [56, 189, 248] },
      margin: { top: 40 },
    });

    const branchNameStr = selectedBranch ? selectedBranch.name : 'All_Branches';
    const cleanBranchName = branchNameStr.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `menu_report_${cleanBranchName}_${dateRange.start}_to_${dateRange.end}.pdf`;

    doc.save(filename);
  };

  // Same net sales computation as SalesAnalytics: net_sales = total_sales - refund - discount
  const trendData = useMemo(
    () =>
      dailySalesCurrent.map((item) => {
        const parsed = parseDateSafe(item.sale_date);
        const label = parsed ? formatDateLabel(parsed) : item.sale_date;
        const totalSales = Number(item.total_sales || 0);
        const refund = Number((item as any).refund ?? 0);
        const discount = Number((item as any).discount ?? 0);
        const rawNetSales =
          (item as any).net_sales != null
            ? Number((item as any).net_sales)
            : Math.max(0, totalSales - refund - discount);
        const netSales = Math.max(0, rawNetSales);
        return { label, netSales };
      }),
    [dailySalesCurrent]
  );

  const chartPointCount = trendData.length;
  const responsiveBarSize = useMemo(() => {
    if (chartPointCount <= 2) return 180;
    if (chartPointCount <= 4) return 120;
    if (chartPointCount <= 7) return 72;
    if (chartPointCount <= 14) return 42;
    if (chartPointCount <= 31) return 24;
    if (chartPointCount <= 62) return 16;
    return 10;
  }, [chartPointCount]);

  const responsiveBarCategoryGap = useMemo(() => {
    if (chartPointCount <= 2) return '0%';
    if (chartPointCount <= 4) return '4%';
    if (chartPointCount <= 7) return '8%';
    if (chartPointCount <= 14) return '12%';
    return '18%';
  }, [chartPointCount]);

  const responsiveXAxisInterval = useMemo(() => {
    if (chartPointCount <= 14) return 0;
    if (chartPointCount <= 31) return 1;
    if (chartPointCount <= 62) return 3;
    return 6;
  }, [chartPointCount]);

  const useSlantedXAxisLabels = chartPointCount > 31;
  const responsiveXAxisAngle: 0 | -35 = useSlantedXAxisLabels ? -35 : 0;
  const responsiveXAxisTextAnchor: 'middle' | 'end' = useSlantedXAxisLabels ? 'end' : 'middle';
  const responsiveXAxisHeight = useSlantedXAxisLabels ? 72 : 48;
  const responsiveXAxisTickMargin = useSlantedXAxisLabels ? 12 : 8;

  // Top 5 products by net sales, computed from menu-report rows (includes charges rows).
  const baseTopProducts: TopProductRow[] = useMemo(
    () =>
      [...rows]
        .filter((r) => Number(r.netSales || 0) > 0)
        .sort((a, b) => Number(b.netSales || 0) - Number(a.netSales || 0))
        .slice(0, 5)
        .map((r, index) => ({
          // Use the display name as the series key so tooltips show names (not synthetic IDs like -9998).
          // If duplicate names exist, append the id for uniqueness.
          key: rows.some((x) => x !== r && String(x.goods).trim() === String(r.goods).trim())
            ? `${String(r.goods).trim()}__${String(r.id ?? index)}`
            : String(r.goods).trim(),
          name: r.goods,
          color: BRANCH_BAR_COLORS[index % BRANCH_BAR_COLORS.length],
          netSales: Number(r.netSales || 0),
        })),
    [rows]
  );

  const productGraphData = useMemo(() => {
    if (!baseTopProducts.length || !trendData.length) return [];
    const totalTrendNetSales = trendData.reduce((sum, row) => sum + (row.netSales || 0), 0);
    const dayWeights =
      totalTrendNetSales > 0
        ? trendData.map((row) => (row.netSales || 0) / totalTrendNetSales)
        : trendData.map(() => 1 / trendData.length);

    return trendData.map((row, dayIndex) => {
      const entry: Record<string, number | string> = { label: row.label };
      baseTopProducts.forEach((p) => {
        const weight = dayWeights[dayIndex] ?? 0;
        entry[p.key] = (p.netSales || 0) * weight;
      });
      return entry;
    });
  }, [trendData, baseTopProducts]);

  const topProductRows: TopProductRow[] = useMemo(() => {
    // Use exact menu-report netSales so it matches the DataTable's net sales.
    // productGraphData is a rounded allocation for the chart, so summing it can drift.
    return baseTopProducts;
  }, [baseTopProducts]);

  const tooltipProps = {
    formatter: (value: number, name: string) => {
      // Map series key back to display name (strip uniqueness suffix).
      const display = String(name).split('__')[0];
      return [money(Number(value)), display] as any;
    },
    // Ensure tooltip items are sorted by highest value first.
    itemSorter: (item: any) => -Number(item?.value || 0),
    cursor: false as const,
    contentStyle: {
      backgroundColor: '#ffffff',
      border: 'none',
      borderRadius: '10px',
      boxShadow: '0 6px 18px rgba(15, 23, 42, 0.08)',
    },
    labelStyle: { color: '#0f172a', fontWeight: 700, marginBottom: '4px' },
    itemStyle: { color: '#334155', fontWeight: 600 },
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
              <div className="grid grid-cols-1 xl:grid-cols-[430px_minmax(0,1fr)] 2xl:grid-cols-[470px_minmax(0,1fr)] gap-6">
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <Skeleton className="h-4 w-32 rounded-lg" />
                    <Skeleton className="h-4 w-16 rounded-lg" />
                  </div>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 w-full rounded-xl" />
                  ))}
                </div>
                <div className="space-y-3">
                  <Skeleton className="h-6 w-48 rounded-lg" />
                  <Skeleton className="h-60 w-full min-h-[240px] rounded-2xl" />
                </div>
              </div>
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
          <Search
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted"
          />
          <input
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t('menu_report.search_placeholder')}
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

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden pt-4">
        <div className="grid grid-cols-1 items-stretch xl:grid-cols-[430px_minmax(0,1fr)] 2xl:grid-cols-[470px_minmax(0,1fr)]">
          <div className="px-5 py-4 border-b xl:border-b-0 xl:border-r border-gray-100">
            <div className="flex items-center justify-between text-sm font-normal text-brand-text mb-3.5">
              <span>{t('sales_analytics.top_5_products')}</span>
              <span className="text-brand-muted">{t('sales_analytics.net_sales')}</span>
            </div>
            <div className="overflow-hidden rounded-xl min-h-[120px] flex items-stretch justify-center">
              {topProductRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 px-4 text-center w-full">
                  <Store size={26} className="text-gray-300 mb-1.5" />
                  <p className="text-xs text-brand-muted font-medium">
                    {t('sales_analytics.no_data_available')}
                  </p>
                </div>
              ) : (
                <table className="w-full table-auto">
                  <tbody>
                    {topProductRows.map((item) => {
                      const isSelected = selectedProductKey === item.key;
                      return (
                        <tr
                          key={item.key}
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedProductKey((prev) => (prev === item.key ? null : item.key))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelectedProductKey((prev) => (prev === item.key ? null : item.key));
                            }
                          }}
                          className={`transition-colors cursor-pointer hover:bg-gray-50 ${isSelected ? 'bg-violet-50 ring-1 ring-violet-200 ring-inset rounded-lg' : ''}`}
                        >
                          <td className="px-3 py-3 align-top">
                            <div className="flex items-start gap-3">
                              <span
                                className="w-5 h-5 rounded-full shrink-0"
                                style={{ backgroundColor: item.color }}
                              />
                              <p className="text-sm text-brand-text whitespace-normal break-words leading-5">
                                {item.name}
                              </p>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right text-sm font-medium text-brand-text whitespace-nowrap">
                            {money(item.netSales)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-lg font-normal text-brand-text">
                {t('sales_analytics.sales_graph_by_product')}
              </h4>
            </div>
            <ChartContainer
              className="w-full min-w-0 h-60 min-h-[240px]"
              render={({ width, height }) => (
                <BarChart
                  width={width}
                  height={height}
                  data={productGraphData}
                  barCategoryGap={responsiveBarCategoryGap}
                  barGap={0}
                >
                  <CartesianGrid stroke="#e5e7eb" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: '#64748b', fontSize: 11 }}
                    interval={responsiveXAxisInterval}
                    angle={responsiveXAxisAngle}
                    textAnchor={responsiveXAxisTextAnchor}
                    height={responsiveXAxisHeight}
                    tickMargin={responsiveXAxisTickMargin}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#64748b', fontSize: 12 }}
                    tickFormatter={(v) => `₱${Math.round(Number(v) / 1000)}k`}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip {...tooltipProps} />
                  {selectedProductKey ? (
                    (() => {
                      const series = topProductRows.find((s) => s.key === selectedProductKey);
                      if (!series) return null;
                      return (
                        <Bar
                          key={series.key}
                          dataKey={series.key}
                          fill={series.color}
                          barSize={responsiveBarSize}
                        />
                      );
                    })()
                  ) : (
                    topProductRows.map((series) => (
                      <Bar
                        key={series.key}
                        dataKey={series.key}
                        stackId="products"
                        fill={series.color}
                        barSize={responsiveBarSize}
                      />
                    ))
                  )}
                </BarChart>
              )}
            />
          </div>
        </div>
      </div>

      <DataTable data={filteredRows} columns={columns} keyExtractor={(item) => item.id} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
