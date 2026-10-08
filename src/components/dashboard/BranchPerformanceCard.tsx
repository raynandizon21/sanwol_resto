import React from 'react';
import { useTranslation } from 'react-i18next';
import { TrendingUp, TrendingDown, MapPin, Check } from 'lucide-react';
import { cn } from '../../lib/utils';

export type BranchPerformanceData = {
  id: number;
  name: string;
  totalSales: number;
  /** POS net sales before recon (paid − refund/discount). */
  reportSalesPos?: number;
  /** Gross POS `total_sales` — aligns with Total Sales chart / performance-trend. */
  reportSalesGross?: number;
  reconTotal?: number;
  totalExpenses: number;
  totalOrders: number;
};

type BranchPerformanceCardProps = {
  branch: BranchPerformanceData;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onCompareToggle?: () => void;
  /** Opens cash reconciliation (Sales Analytics parity); click does not focus the card */
  onTotalSalesClick?: (e: React.MouseEvent) => void;
  isSelected?: boolean;
  isActive?: boolean;
};

export const BranchPerformanceCard: React.FC<BranchPerformanceCardProps> = ({
  branch,
  onClick,
  onMouseEnter,
  onCompareToggle,
  onTotalSalesClick,
  isSelected,
  isActive,
}) => {
  const { t } = useTranslation();
  const netRevenue = branch.totalSales - branch.totalExpenses;

  return (
    <div
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'relative overflow-hidden rounded-2xl shadow-sm border group transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 cursor-pointer',
        // Active (focused) branch: keep only left accent (no outer border color, no white hover bg)
        isActive
          ? 'border-transparent bg-brand-primary/5'
          : isSelected
          ? 'border-transparent shadow-md bg-white/95 hover:bg-white hover:border-transparent'
          : 'border-slate-100 bg-white/95 hover:bg-white hover:border-transparent',
      )}
    >
      {/* Left accent border */}
      <div className="absolute inset-0 left-0 w-[3px] rounded-r-2xl bg-gradient-to-b from-brand-primary to-indigo-500/80 opacity-70 group-hover:opacity-100 transition-opacity" />

      <div className="relative z-[1] p-3 flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-brand-primary/10 flex items-center justify-center text-brand-primary shadow-sm shadow-brand-primary/10">
              <MapPin size={14} />
            </div>
            <div>
              <h3 className="text-[13px] font-semibold text-brand-text tracking-tight group-hover:text-brand-primary transition-colors">
                {branch.name}
              </h3>
              <p className="text-[10px] text-brand-muted">{t('admin_dashboard.branch_overview')}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (onCompareToggle) onCompareToggle();
              }}
              className={cn(
                'relative inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold shadow-sm transition-all duration-200 cursor-pointer',
                isSelected
                  ? 'bg-brand-primary text-white shadow-brand-primary/40 shadow'
                : 'bg-brand-primary/10 text-brand-primary hover:bg-brand-primary/20 hover:text-brand-primary',
              )}
              aria-pressed={isSelected}
            >
              <span
                className={cn(
                  'flex items-center justify-center w-3.5 h-3.5 rounded-full border transition-colors duration-200',
                  isSelected ? 'bg-white border-transparent' : 'border-slate-400 bg-white',
                )}
              >
                {isSelected && <Check size={10} className="text-brand-primary" />}
              </span>
              <span>Compare</span>
            </button>
          </div>
        </div>

        {/* Horizontal metrics: Sales, Expenses, Profit */}
        <div className="mt-auto">
          <div className="mt-2 pt-2 border-t border-slate-100 space-y-1.5 text-[12px]">
            {onTotalSalesClick ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTotalSalesClick(e);
                }}
                className="flex w-full items-baseline justify-between gap-2 rounded-lg py-0.5 hover:bg-brand-primary/5 transition-colors cursor-pointer"
              >
                <p className="text-[11px] text-brand-muted">{t('admin_dashboard.total_sales')}</p>
                <p className="font-bold text-[12px] text-brand-text text-right tabular-nums">
                  ₱{Math.trunc(branch.totalSales).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </p>
              </button>
            ) : (
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[11px] text-brand-muted">{t('admin_dashboard.total_sales')}</p>
                <p className="font-bold text-[12px] text-brand-text text-right tabular-nums">
                  ₱{Math.trunc(branch.totalSales).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </p>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[11px] text-brand-muted">{t('admin_dashboard.total_expenses')}</p>
              <p className="font-bold text-[12px] text-brand-text text-right tabular-nums">
                ₱{Math.trunc(branch.totalExpenses).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </p>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[11px] text-brand-muted">Total Profit</p>
              <p className="font-bold text-[12px] text-brand-text text-right tabular-nums">
                ₱{Math.trunc(netRevenue).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
