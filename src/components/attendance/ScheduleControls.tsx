import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatYmdDisplay } from '../../utils/manilaDateTime';
import { shortRangeLabel, type PeriodKind, type Range } from './timesheetPeriods';

// The toolbar controls shared by the Schedules page and the Attendance Logs Summary, so both pick a
// period and filter by position the same way.

export const toolbarButton =
  'bg-white text-brand-text px-3.5 py-2 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:hover:bg-white';

/** The views, widest first. */
const VIEWS: PeriodKind[] = ['month', 'cutoff', 'week'];

/** "November 2026", "Nov 1 – 15, 2026" or "Nov 9, 2026 – Nov 15, 2026". */
export const periodLabel = (view: PeriodKind, range: Range) => {
  if (view === 'month') {
    return new Date(`${range.start}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  if (view === 'cutoff') return `${shortRangeLabel(range)}, ${range.start.slice(0, 4)}`;
  return `${formatYmdDisplay(range.start)} – ${formatYmdDisplay(range.end)}`;
};

export const ViewToggle: React.FC<{ value: PeriodKind; onChange: (view: PeriodKind) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  return (
    <div className="inline-flex bg-white rounded-xl p-1 shadow-sm" role="tablist">
      {VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'px-3.5 py-1.5 rounded-lg text-sm font-bold transition-colors',
            value === v ? 'bg-brand-primary text-white' : 'text-brand-muted hover:text-brand-text',
          )}
        >
          {v === 'month'
            ? t('attendance.view_month', 'Month')
            : v === 'cutoff'
              ? t('attendance.view_cutoff', 'Cutoff')
              : t('attendance.view_week', 'Week')}
        </button>
      ))}
    </div>
  );
};

export const PeriodStepper: React.FC<{ label: string; onStep: (delta: -1 | 1) => void; nextDisabled?: boolean }> = ({ label, onStep, nextDisabled }) => {
  const { t } = useTranslation();
  const arrow = 'p-1.5 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-brand-muted';
  return (
    <div className="flex items-center gap-1 bg-white rounded-xl shadow-sm px-1 py-1">
      <button type="button" onClick={() => onStep(-1)} className={arrow} aria-label={t('attendance.previous', 'Previous')}>
        <ChevronLeft size={18} />
      </button>
      <span className="text-sm font-bold text-brand-text min-w-[190px] text-center tabular-nums">{label}</span>
      <button type="button" onClick={() => onStep(1)} disabled={nextDisabled} className={arrow} aria-label={t('attendance.next', 'Next')}>
        <ChevronRight size={18} />
      </button>
    </div>
  );
};

export const PositionFilter: React.FC<{
  positions: { key: string; label: string }[];
  value: string[];
  onChange: (keys: string[]) => void;
}> = ({ positions, value, onChange }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={cn(toolbarButton, value.length && 'text-brand-primary')}>
        <Filter size={16} />
        {value.length
          ? t('attendance.positions_n', { count: value.length, defaultValue: `Positions (${value.length})` })
          : t('attendance.all_positions', 'All positions')}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="absolute z-30 mt-2 w-72 bg-white rounded-xl shadow-xl border border-gray-100 p-2 max-h-80 overflow-y-auto">
          <button
            type="button"
            onClick={() => onChange([])}
            className="w-full text-left px-3 py-2 rounded-lg text-sm font-bold text-brand-primary hover:bg-brand-primary/5"
          >
            {t('attendance.all_positions', 'All positions')}
          </button>
          {positions.map((p) => (
            <label key={p.key} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 cursor-pointer">
              <input
                type="checkbox"
                checked={value.includes(p.key)}
                onChange={(e) => onChange(e.target.checked ? [...value, p.key] : value.filter((x) => x !== p.key))}
                className="accent-brand-primary"
              />
              {p.label || <span className="italic text-brand-muted">{t('attendance.no_position', 'No position')}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
};
