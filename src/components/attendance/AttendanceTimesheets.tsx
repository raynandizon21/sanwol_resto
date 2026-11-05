import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { SkeletonTable } from '../ui/Skeleton';
import { cn } from '../../lib/utils';
import {
  getTimesheets,
  ISSUE_FLAGS,
  MAX_TIMESHEETS_DAYS,
  type Timesheets,
  type TimesheetsEmployee,
  type WorkDay,
  type WorkShift,
} from '../../services/attendanceService';
import { formatYmdDisplay, getManilaTodayYmd } from '../../utils/manilaDateTime';
import { useZkLiveReload } from './zktecoShared';
import { dayStatusLabel, flagLabel, formatClock, formatMinutes, weekdayOf, weekdayShort } from './attendanceShared';
import { capAtToday, datesOf, dayCount, kindOf, periodOf, stepPeriod, type PeriodKind, type Range } from './timesheetPeriods';

// ---- Display ----

/** "2026-11-03 10:02" -> "10:02a" (compact, for the grid). */
const shortClock = (value: string | null) => {
  const full = formatClock(value);
  return full === '—' ? full : full.replace(' AM', 'a').replace(' PM', 'p');
};

/** "10:02a–7:15p", "10:02a–now", "—–7:15p". */
const shiftText = (shift: WorkShift, now: string, clock: (v: string | null) => string = shortClock, sep = '–') =>
  `${clock(shift.in)}${sep}${shift.open ? now : clock(shift.out)}`;

/** Decimal hours for spreadsheets: 510 -> "8.50". */
const decimalHours = (minutes: number) => (minutes / 60).toFixed(2);

const personLabel = (t: TFunction, e: TimesheetsEmployee) => e.name || `${t('attendance.unknown_user', 'Not on device')} (${e.pin})`;

const fileSafe = (value: string) => value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const dayIssues = (day: WorkDay) => day.flags.filter((f) => ISSUE_FLAGS.includes(f));

// ---- Component ----

interface AttendanceTimesheetsProps {
  branchId: string | number;
  branchName: string | null;
  dateRange: Range;
  /** Sets the header's date range (the cutoff buttons). */
  onDateRangeChange?: (range: Range) => void;
  /** Opens a person's timesheet on a date (to see the punches and fix them). */
  onOpenTimesheet: (employee: { employeeId: number; name: string | null; pin: string }, date?: string) => void;
}

/**
 * Everyone's timesheet for the header's date range: one row per person, one column per day with
 * the shifts (time-in – time-out) and hours, plus totals. Clicking a day opens the person's
 * timesheet there. Exports to CSV (one row per day worked) and PDF (the grid, then totals).
 */
export const AttendanceTimesheets: React.FC<AttendanceTimesheetsProps> = ({
  branchId,
  branchName,
  dateRange,
  onDateRangeChange,
  onOpenTimesheet,
}) => {
  const { t } = useTranslation();
  const isAllBranches = String(branchId) === 'all';
  const today = getManilaTodayYmd();
  const tooLong = dayCount(dateRange) > MAX_TIMESHEETS_DAYS;

  const [data, setData] = useState<Timesheets | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (tooLong) {
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        setData(await getTimesheets(branchId, dateRange.start, dateRange.end));
        setError(null);
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [branchId, dateRange.start, dateRange.end, tooLong],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useZkLiveReload(branchId, ['attendance', 'users'], () => void load(true));

  // While another range loads, the last one stays on screen (dimmed) instead of a skeleton, so
  // switching periods doesn't flash. It can't be exported meanwhile (the file is named after the
  // header's range).
  const current = data;
  const stale = Boolean(data && (data.range.start !== dateRange.start || data.range.end !== dateRange.end));
  const dates = useMemo(() => (current ? datesOf(current.range) : []), [current]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (current?.employees ?? [])
      .filter((e) => !hideEmpty || e.days.some((d) => d.shifts.length > 0))
      .filter((e) => !q || [e.name ?? '', e.pin, e.position ?? ''].some((v) => v.toLowerCase().includes(q)))
      .sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿', undefined, { sensitivity: 'base' }) || a.pin.localeCompare(b.pin, undefined, { numeric: true }));
  }, [current, search, hideEmpty]);

  /** Per date, over the rows shown: hours worked and how many people worked. */
  const dayTotals = useMemo(
    () =>
      dates.map((date, i) => {
        let minutes = 0;
        let people = 0;
        for (const e of rows) {
          const d = e.days[i];
          if (!d || d.date !== date) continue;
          minutes += d.workedMinutes;
          if (d.shifts.some((s) => s.in)) people += 1;
        }
        return { minutes, people };
      }),
    [dates, rows],
  );
  const shownTotals = useMemo(
    () =>
      rows.reduce(
        (acc, e) => ({
          daysWorked: acc.daysWorked + e.totals.daysWorked,
          workedMinutes: acc.workedMinutes + e.totals.workedMinutes,
          regularMinutes: acc.regularMinutes + e.totals.regularMinutes,
          overMinutes: acc.overMinutes + e.totals.overMinutes,
          incompleteDays: acc.incompleteDays + e.totals.incompleteDays,
        }),
        { daysWorked: 0, workedMinutes: 0, regularMinutes: 0, overMinutes: 0, incompleteDays: 0 },
      ),
    [rows],
  );

  const nowLabel = t('attendance.now_short', 'now');
  const scopeLabel = isAllBranches ? t('attendance.all_branches', 'All branches') : branchName || '';
  const baseFilename = `timesheet_${fileSafe(scopeLabel || 'branch')}_${dateRange.start}_to_${dateRange.end}`;

  const exportCsv = () => {
    if (!current || stale) return;
    const headers = [
      t('attendance.name', 'Name'),
      t('attendance.pin', 'User ID'),
      t('attendance.position', 'Position'),
      t('attendance.date', 'Date'),
      t('attendance.day', 'Day'),
      t('attendance.status_check_in', 'Time-in'),
      t('attendance.status_check_out', 'Time-out'),
      t('attendance.shifts', 'Shifts'),
      t('attendance.hours_worked', 'Hours worked'),
      t('attendance.hours_decimal', 'Hours (decimal)'),
      t('attendance.regular_decimal', 'Regular (decimal)'),
      t('attendance.over_decimal', 'Over (decimal)'),
      t('attendance.day_status', 'Status'),
      t('attendance.problems', 'Problems'),
    ];
    const lines = [headers.map(csvCell).join(',')];
    for (const e of rows) {
      for (const d of e.days) {
        // Days with punches only; a day off has nothing to record.
        if (!d.shifts.length) continue;
        const firstIn = d.shifts.find((s) => s.in)?.in ?? null;
        const last = d.shifts[d.shifts.length - 1];
        // The day's last shift; blank when it has no time-out (the Problems column says so).
        const lastOut = last.open ? null : last.out;
        const cells: (string | number)[] = [
          personLabel(t, e),
          e.pin,
          e.position ?? '',
          d.date,
          weekdayShort(t, weekdayOf(d.date)),
          firstIn ? formatClock(firstIn) : '',
          last.open ? nowLabel : lastOut ? formatClock(lastOut) : '',
          d.shifts.map((s) => shiftText(s, nowLabel, formatClock, ' - ')).join('; '),
          formatMinutes(d.workedMinutes),
          decimalHours(d.workedMinutes),
          decimalHours(d.regularMinutes),
          decimalHours(d.overMinutes),
          dayStatusLabel(t, d.status),
          dayIssues(d).map((f) => flagLabel(t, f)).join('; '),
        ];
        lines.push(cells.map(csvCell).join(','));
      }
    }
    // BOM so Excel reads names with accents (ñ) correctly.
    downloadBlob(new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8;' }), `${baseFilename}.csv`);
  };

  const exportPdf = () => {
    if (!current || stale) return;
    const doc = new jsPDF('l', 'pt', 'a4');
    const title = `${t('attendance.view_timesheet', 'Timesheet')}${scopeLabel ? ` - ${scopeLabel}` : ''}`;
    const subtitle = `${formatYmdDisplay(dateRange.start)} - ${formatYmdDisplay(dateRange.end)}`;
    const header = () => {
      doc.setFontSize(13);
      doc.setTextColor(30, 30, 30);
      doc.text(title, 40, 32);
      doc.setFontSize(9);
      doc.setTextColor(110, 110, 110);
      doc.text(subtitle, 40, 46);
    };
    const pdfCell = (d: WorkDay | undefined) => {
      if (!d || !d.shifts.length) return d?.status === 'upcoming' ? '' : '-';
      const lines = d.shifts.map((s) => shiftText(s, nowLabel, shortClock, '-'));
      const issues = dayIssues(d);
      if (issues.length) lines.push(`! ${issues.map((f) => flagLabel(t, f)).join(', ')}`);
      else if (d.workedMinutes) lines.push(formatMinutes(d.workedMinutes));
      return lines.join('\n');
    };
    const headStyles = { fillColor: [79, 70, 229] as [number, number, number], fontSize: 7, halign: 'center' as const };
    const common = { theme: 'grid' as const, margin: { top: 58, left: 40, right: 40 }, didDrawPage: header };

    // The grid, 8 days at a time (each block repeats the names).
    const CHUNK = 8;
    for (let i = 0; i < dates.length; i += CHUNK) {
      const chunk = dates.slice(i, i + CHUNK);
      if (i > 0) doc.addPage();
      autoTable(doc, {
        ...common,
        startY: 58,
        head: [[t('attendance.name', 'Name'), ...chunk.map((d) => `${weekdayShort(t, weekdayOf(d))} ${Number(d.slice(8))}`)]],
        body: [
          ...rows.map((e) => [`${personLabel(t, e)}\n${t('attendance.pin', 'User ID')} ${e.pin}`, ...chunk.map((_, j) => pdfCell(e.days[i + j]))]),
          [t('attendance.total', 'Total'), ...chunk.map((_, j) => formatMinutes(dayTotals[i + j]?.minutes ?? 0))],
        ],
        styles: { fontSize: 7, cellPadding: 3, valign: 'middle' },
        headStyles,
        columnStyles: { 0: { cellWidth: 110, fontStyle: 'bold' } },
        bodyStyles: { halign: 'center' },
        didParseCell: (hook) => {
          if (hook.section === 'body' && hook.column.index === 0) hook.cell.styles.halign = 'left';
          if (hook.section === 'body' && hook.row.index === rows.length) hook.cell.styles.fontStyle = 'bold';
        },
      });
    }

    // Totals per person.
    doc.addPage();
    autoTable(doc, {
      ...common,
      startY: 58,
      head: [[
        t('attendance.name', 'Name'),
        t('attendance.pin', 'User ID'),
        t('attendance.position', 'Position'),
        t('attendance.days_worked', 'Days worked'),
        t('attendance.hours_worked', 'Hours worked'),
        t('attendance.regular_hours', 'Regular hours'),
        t('attendance.over_standard', 'Over the standard day'),
        t('attendance.needs_fixing', 'Needs fixing'),
      ]],
      body: [
        ...rows.map((e) => [
          personLabel(t, e),
          e.pin,
          e.position ?? '',
          String(e.totals.daysWorked),
          `${formatMinutes(e.totals.workedMinutes)} (${decimalHours(e.totals.workedMinutes)})`,
          formatMinutes(e.totals.regularMinutes),
          formatMinutes(e.totals.overMinutes),
          e.totals.incompleteDays ? String(e.totals.incompleteDays) : '-',
        ]),
        [
          t('attendance.total', 'Total'),
          '',
          '',
          String(shownTotals.daysWorked),
          `${formatMinutes(shownTotals.workedMinutes)} (${decimalHours(shownTotals.workedMinutes)})`,
          formatMinutes(shownTotals.regularMinutes),
          formatMinutes(shownTotals.overMinutes),
          shownTotals.incompleteDays ? String(shownTotals.incompleteDays) : '-',
        ],
      ],
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { ...headStyles, fontSize: 8, halign: 'left' },
      didParseCell: (hook) => {
        if (hook.section === 'body' && hook.row.index === rows.length) hook.cell.styles.fontStyle = 'bold';
      },
    });
    doc.save(`${baseFilename}.pdf`);
  };

  // ---- Period bar ----
  const kind = kindOf(dateRange, today);
  const applyPeriod = (range: Range) => {
    if (!onDateRangeChange || range.start > today) return;
    onDateRangeChange(capAtToday(range, today));
  };
  const presets: { key: PeriodKind; label: string; range: Range }[] = [
    { key: 'week', label: t('attendance.period_this_week', 'This week'), range: periodOf('week', today) },
    { key: 'first_half', label: t('attendance.period_first_half', '1–15'), range: periodOf('first_half', dateRange.start) },
    { key: 'second_half', label: t('attendance.period_second_half', '16–end'), range: periodOf('second_half', dateRange.start) },
    { key: 'month', label: t('attendance.period_month', 'Whole month'), range: periodOf('month', dateRange.start) },
  ];
  const prev = kind ? stepPeriod(kind, dateRange, -1) : null;
  const next = kind ? stepPeriod(kind, dateRange, 1) : null;
  const navButton =
    'p-2 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-brand-muted';

  const periodBar = onDateRangeChange && (
    <div className="flex items-center gap-1 bg-white rounded-xl shadow-sm p-1">
      <button type="button" className={navButton} disabled={!prev} onClick={() => prev && applyPeriod(prev)} aria-label={t('attendance.period_prev', 'Previous period')}>
        <ChevronLeft size={16} />
      </button>
      {presets.map((p) => {
        const capped = capAtToday(p.range, today);
        const active = capped.start === dateRange.start && capped.end === dateRange.end;
        return (
          <button
            key={p.key}
            type="button"
            disabled={p.range.start > today}
            onClick={() => applyPeriod(p.range)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-40',
              active ? 'bg-brand-primary text-white' : 'text-brand-muted hover:bg-gray-50',
            )}
          >
            {p.label}
          </button>
        );
      })}
      <button
        type="button"
        className={navButton}
        disabled={!next || next.start > today}
        onClick={() => next && applyPeriod(next)}
        aria-label={t('attendance.period_next', 'Next period')}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );

  const openCell = (e: TimesheetsEmployee, date?: string) => {
    if (e.employeeId != null) onOpenTimesheet({ employeeId: e.employeeId, name: e.name, pin: e.pin }, date);
  };

  const exportButtons = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={exportCsv}
        disabled={!current || stale || rows.length === 0}
        title={t('attendance.export_csv', 'Export CSV (one row per day worked)')}
        className="flex items-center justify-center h-9 w-9 rounded-lg bg-green-50 hover:bg-green-100 transition-colors disabled:opacity-40"
      >
        <img src="/csv.png" alt={t('attendance.export_csv', 'Export CSV (one row per day worked)')} className="h-6 w-6" />
      </button>
      <button
        type="button"
        onClick={exportPdf}
        disabled={!current || stale || rows.length === 0}
        title={t('attendance.export_pdf', 'Export PDF')}
        className="flex items-center justify-center h-9 w-9 rounded-lg bg-red-50 hover:bg-red-100 transition-colors disabled:opacity-40"
      >
        <img src="/pdf.png" alt={t('attendance.export_pdf', 'Export PDF')} className="h-6 w-6" />
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
            <input
              type="text"
              placeholder={t('attendance.search_people_placeholder', 'Search by name, user ID or position')}
              className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-80 shadow-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-brand-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideEmpty}
              onChange={(e) => setHideEmpty(e.target.checked)}
              className="rounded border-gray-300 text-brand-primary focus:ring-brand-primary/20"
            />
            {t('attendance.hide_no_punches', 'Hide people with no punches')}
          </label>
        </div>
        <div className="flex items-center gap-3">
          {periodBar}
          {exportButtons}
        </div>
      </div>

      {tooLong ? (
        <div className="bg-orange-50 border border-orange-100 text-orange-700 p-4 rounded-xl text-sm font-medium">
          {t('attendance.timesheet_too_long', {
            days: MAX_TIMESHEETS_DAYS,
            defaultValue: `The timesheet shows up to ${MAX_TIMESHEETS_DAYS} days. Choose a shorter range, or use the buttons above.`,
          })}
        </div>
      ) : error && !current ? (
        <div className="bg-red-50 border border-red-100 text-red-600 p-4 rounded-xl text-sm font-medium">{error}</div>
      ) : !current ? (
        <SkeletonTable columns={8} rows={8} showToolbar={false} />
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-sm p-8 text-center text-sm text-brand-muted">
          {current.employees.length === 0
            ? t('attendance.summary_empty', 'No one is registered on the device for this branch yet, and there are no punches in this range.')
            : t('attendance.timesheet_no_match', 'No one matches.')}
        </div>
      ) : (
        <>
          <div className={cn('bg-white rounded-2xl shadow-sm overflow-hidden transition-opacity', (loading || stale) && 'opacity-60')}>
            <div className="overflow-auto max-h-[70vh]">
              <table className="text-left border-separate border-spacing-0">
                <thead>
                  <tr>
                    <th className="sticky top-0 left-0 z-30 bg-violet-50 px-4 py-3 text-[13px] font-medium uppercase tracking-wider text-brand-text border-b border-r-[3px] border-b-gray-100 border-r-white min-w-[200px]">
                      {t('attendance.name', 'Name')}
                    </th>
                    {dates.map((date) => {
                      const wd = weekdayOf(date);
                      return (
                        <th
                          key={date}
                          className={cn(
                            'sticky top-0 z-20 px-2 py-2 text-center border-b border-gray-100 min-w-[104px]',
                            wd === 0 ? 'bg-gray-50' : 'bg-white',
                            date === today && 'bg-brand-primary/5',
                          )}
                        >
                          <span className="block text-[11px] font-medium uppercase tracking-wider text-brand-muted">{weekdayShort(t, wd)}</span>
                          <span className={cn('block text-sm font-bold tabular-nums', date === today ? 'text-brand-primary' : 'text-brand-text')}>
                            {new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                          </span>
                        </th>
                      );
                    })}
                    {[
                      t('attendance.days_worked', 'Days worked'),
                      t('attendance.hours_worked', 'Hours worked'),
                      t('attendance.regular_hours', 'Regular hours'),
                      t('attendance.over_standard', 'Over the standard day'),
                      t('attendance.needs_fixing', 'Needs fixing'),
                    ].map((label) => (
                      <th
                        key={label}
                        className="sticky top-0 z-20 bg-white px-3 py-3 text-[11px] font-medium uppercase tracking-wider text-brand-muted text-right border-b border-l border-gray-100 min-w-[96px]"
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.employeeId != null ? `e${e.employeeId}` : `u${e.deviceId}:${e.pin}`} className="group">
                      <td className="sticky left-0 z-10 bg-violet-50 group-hover:bg-violet-100 px-4 py-2 border-b border-r-[3px] border-b-gray-100 border-r-white align-middle">
                        <button
                          type="button"
                          disabled={e.employeeId == null}
                          onClick={() => openCell(e)}
                          className="text-left disabled:cursor-default"
                        >
                          <span className={cn('block text-sm font-bold', e.name ? 'text-brand-text hover:underline' : 'text-brand-muted italic')}>
                            {personLabel(t, e)}
                          </span>
                          <span className="block text-xs text-brand-muted font-medium">
                            {t('attendance.pin', 'User ID')} {e.pin}
                            {e.position ? ` · ${e.position}` : ''}
                          </span>
                          <span className="block text-xs text-brand-text font-bold tabular-nums mt-0.5">
                            {formatMinutes(e.totals.workedMinutes)}
                            {!e.active && e.employeeId != null && (
                              <span className="ml-1.5 font-medium text-brand-muted">· {t('attendance.tag_removed', 'Removed')}</span>
                            )}
                          </span>
                        </button>
                      </td>
                      {dates.map((date, i) => (
                        <DayCell
                          key={date}
                          day={e.days[i]?.date === date ? e.days[i] : undefined}
                          isSunday={weekdayOf(date) === 0}
                          isToday={date === today}
                          standardHours={e.standardHours}
                          nowLabel={nowLabel}
                          clickable={e.employeeId != null}
                          onClick={() => openCell(e, date)}
                        />
                      ))}
                      <TotalCell>{e.totals.daysWorked || '—'}</TotalCell>
                      <TotalCell bold>{formatMinutes(e.totals.workedMinutes)}</TotalCell>
                      <TotalCell>{formatMinutes(e.totals.regularMinutes)}</TotalCell>
                      <TotalCell>{e.totals.overMinutes ? formatMinutes(e.totals.overMinutes) : '—'}</TotalCell>
                      <TotalCell>
                        {e.totals.incompleteDays ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-orange-50 text-orange-700">
                            <AlertTriangle size={12} />
                            {e.totals.incompleteDays}
                          </span>
                        ) : (
                          '—'
                        )}
                      </TotalCell>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="sticky left-0 bottom-0 z-30 bg-violet-50 px-4 py-2 border-t border-r-[3px] border-t-gray-200 border-r-white text-sm font-bold text-brand-text">
                      {t('attendance.total', 'Total')}
                      <span className="block text-xs text-brand-muted font-medium">
                        {t('attendance.people_count', { count: rows.length, defaultValue: `${rows.length} people` })}
                      </span>
                    </td>
                    {dayTotals.map((d, i) => (
                      <td key={dates[i]} className="sticky bottom-0 z-20 bg-white px-2 py-2 text-center border-t border-gray-200">
                        <span className="block text-xs font-bold tabular-nums text-brand-text">{d.minutes ? formatMinutes(d.minutes) : '—'}</span>
                        {d.people > 0 && (
                          <span className="block text-[11px] text-brand-muted font-medium">
                            {t('attendance.people_count', { count: d.people, defaultValue: `${d.people} people` })}
                          </span>
                        )}
                      </td>
                    ))}
                    <TotalCell footer>{shownTotals.daysWorked}</TotalCell>
                    <TotalCell footer bold>{formatMinutes(shownTotals.workedMinutes)}</TotalCell>
                    <TotalCell footer>{formatMinutes(shownTotals.regularMinutes)}</TotalCell>
                    <TotalCell footer>{shownTotals.overMinutes ? formatMinutes(shownTotals.overMinutes) : '—'}</TotalCell>
                    <TotalCell footer>{shownTotals.incompleteDays || '—'}</TotalCell>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          <p className="text-xs text-brand-muted font-medium">
            {t(
              'attendance.timesheet_hint',
              'Each day shows its shifts (time-in – time-out) and hours worked; a shift belongs to the day of its time-in. A day that needs fixing isn’t counted until its punches are fixed: click it to open the timesheet.',
            )}
          </p>
        </>
      )}
    </div>
  );
};

const TotalCell: React.FC<{ children: React.ReactNode; bold?: boolean; footer?: boolean }> = ({ children, bold, footer }) => (
  <td
    className={cn(
      'px-3 py-2 text-right text-sm tabular-nums border-l border-gray-100 whitespace-nowrap',
      footer ? 'sticky bottom-0 z-20 bg-white border-t border-t-gray-200 font-bold' : 'border-b bg-white group-hover:bg-brand-bg/50',
      bold ? 'font-bold text-brand-text' : 'font-medium text-brand-text',
    )}
  >
    {children}
  </td>
);

const DayCell: React.FC<{
  day: WorkDay | undefined;
  isSunday: boolean;
  isToday: boolean;
  standardHours: number;
  nowLabel: string;
  clickable: boolean;
  onClick: () => void;
}> = ({ day, isSunday, isToday, standardHours, nowLabel, clickable, onClick }) => {
  const { t } = useTranslation();
  const base = cn('border-b border-gray-100 px-1.5 py-1.5 align-middle text-center', isSunday && 'bg-gray-50/70', isToday && 'bg-brand-primary/5');
  if (!day || !day.shifts.length) {
    return (
      <td className={base}>
        <span className={cn('text-xs', day?.status === 'upcoming' ? 'text-gray-200' : 'text-gray-300')}>{day?.status === 'upcoming' ? '' : '—'}</span>
      </td>
    );
  }
  const issues = dayIssues(day);
  const tone =
    day.status === 'incomplete'
      ? 'bg-orange-50 text-orange-800 hover:bg-orange-100'
      : day.status === 'on_shift'
        ? 'bg-brand-primary/10 text-brand-primary hover:bg-brand-primary/15'
        : 'bg-green-50 text-green-900 hover:bg-green-100';
  const title = [
    `${formatYmdDisplay(day.date)} · ${dayStatusLabel(t, day.status)}`,
    ...day.shifts.map((s) => shiftText(s, nowLabel, formatClock, ' – ') + (s.minutes != null ? ` (${formatMinutes(s.minutes)})` : '')),
    day.workedMinutes
      ? `${t('attendance.worked', 'Worked')} ${formatMinutes(day.workedMinutes)}${
          day.overMinutes
            ? ` · ${t('attendance.regular', 'Regular')} ${formatMinutes(day.regularMinutes)} · ${t('attendance.over', 'Over')} ${formatMinutes(day.overMinutes)}`
            : ''
        }`
      : null,
    ...issues.map((f) => flagLabel(t, f)),
    t('attendance.standard_day_label', { hours: standardHours, defaultValue: `Standard day: ${standardHours} h` }),
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <td className={base}>
      <button
        type="button"
        disabled={!clickable}
        onClick={onClick}
        title={title}
        className={cn('w-full rounded-lg px-1.5 py-1 transition-colors disabled:cursor-default', tone)}
      >
        {day.shifts.map((s, i) => (
          <span key={i} className="block text-[11px] font-medium tabular-nums whitespace-nowrap">
            {shiftText(s, nowLabel)}
          </span>
        ))}
        {issues.length > 0 ? (
          <span className="flex items-center justify-center gap-1 text-[11px] font-bold">
            <AlertTriangle size={11} className="shrink-0" />
            {t('attendance.fix_short', 'Fix')}
          </span>
        ) : day.workedMinutes > 0 ? (
          <span className="block text-xs font-bold tabular-nums">{formatMinutes(day.workedMinutes)}</span>
        ) : null}
      </button>
    </td>
  );
};
