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
  type AttendanceTotals,
  type Timesheets,
  type TimesheetsEmployee,
  type WorkDay,
  type WorkShift,
} from '../../services/attendanceService';
import { formatYmdDisplay, getManilaTodayYmd } from '../../utils/manilaDateTime';
import { useZkLiveReload } from './zktecoShared';
import {
  dayMarkLabel,
  dayStatusLabel,
  dayStatusMeta,
  flagLabel,
  formatClock,
  formatMinutes,
  offDutyLabel,
  shiftText as plannedShiftText,
  weekdayOf,
  weekdayShort,
} from './attendanceShared';
import {
  capAtToday,
  cutoffPeriodOf,
  datesOf,
  dayCount,
  kindOf,
  periodOf,
  shortRangeLabel,
  stepPeriod,
  type Range,
} from './timesheetPeriods';

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

// The User ID is shown only for punches of someone not on the device (nothing else tells them apart).
const personLabel = (t: TFunction, e: TimesheetsEmployee) => e.name || `${t('attendance.unknown_user', 'Not on device')} (${e.pin})`;

/** What the Schedules page says for a day: "Opening (10:00 AM – 7:00 PM)", "Leave: Sick", or "". */
const plannedText = (t: TFunction, day: WorkDay) =>
  day.shift
    ? plannedShiftText(day.shift)
    : day.offDuty
      ? [offDutyLabel(t, day.offDuty.type), day.offDuty.note].filter(Boolean).join(': ')
      : '';

/** "2 · 35m" (days · minutes), or "—". */
const countAndMinutes = (days: number, minutes: number) => (days ? `${days} · ${formatMinutes(minutes)}` : '—');

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

/** Late / undertime notes of a day: ["Late 20m", "Undertime 15m"]. */
const timingNotes = (t: TFunction, day: WorkDay) =>
  [
    day.lateMinutes ? `${t('attendance.late', 'Late')} ${formatMinutes(day.lateMinutes)}` : null,
    day.undertimeMinutes ? `${t('attendance.undertime', 'Undertime')} ${formatMinutes(day.undertimeMinutes)}` : null,
  ].filter((v): v is string => Boolean(v));

const ZERO_TOTALS: AttendanceTotals = {
  daysWorked: 0,
  daysWithHours: 0,
  workedMinutes: 0,
  regularMinutes: 0,
  overMinutes: 0,
  incompleteDays: 0,
  absentDays: 0,
  lateDays: 0,
  lateMinutes: 0,
  undertimeDays: 0,
  undertimeMinutes: 0,
  excusedDays: 0,
  scheduledDays: 0,
  averageMinutes: 0,
};

// ---- Component ----

interface AttendanceTimesheetsProps {
  branchId: string | number;
  branchName: string | null;
  dateRange: Range;
  /** Sets the header's date range (the period buttons). */
  onDateRangeChange?: (range: Range) => void;
  /** Opens a person's timesheet on a date (to see the punches and fix them). */
  onOpenTimesheet: (employee: { employeeId: number; name: string | null; pin: string }, date?: string) => void;
}

/**
 * Everyone's timesheet for the header's date range: one row per person, one column per day with
 * the shifts (time-in – time-out), hours, late and undertime, or why nobody punched (absent, rest
 * day, leave); plus totals. The cutoff buttons use the 1st–15th and 16th–end. Clicking a day
 * opens the person's timesheet there. Exports to CSV (one row per day) and PDF (grid, totals).
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
      .filter((e) => !q || [personLabel(t, e), e.position ?? ''].some((v) => v.toLowerCase().includes(q)))
      .sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿', undefined, { sensitivity: 'base' }) || a.pin.localeCompare(b.pin, undefined, { numeric: true }));
  }, [current, search, hideEmpty, t]);

  /** Per date, over the rows shown: hours worked, how many people worked, how many were absent. */
  const dayTotals = useMemo(
    () =>
      dates.map((date, i) => {
        let minutes = 0;
        let people = 0;
        let absent = 0;
        for (const e of rows) {
          const d = e.days[i];
          if (!d || d.date !== date) continue;
          minutes += d.workedMinutes;
          if (d.shifts.some((s) => s.in)) people += 1;
          if (d.status === 'absent') absent += 1;
        }
        return { minutes, people, absent };
      }),
    [dates, rows],
  );
  const shownTotals = useMemo(() => {
    const sum = { ...ZERO_TOTALS };
    for (const e of rows) for (const key of Object.keys(sum) as (keyof AttendanceTotals)[]) sum[key] += e.totals[key] || 0;
    return sum;
  }, [rows]);
  const anyTracked = rows.some((e) => e.totals.scheduledDays > 0);

  const nowLabel = t('attendance.now_short', 'now');
  const scopeLabel = isAllBranches ? t('attendance.all_branches', 'All branches') : branchName || '';
  const baseFilename = `timesheet_${fileSafe(scopeLabel || 'branch')}_${dateRange.start}_to_${dateRange.end}`;

  const exportCsv = () => {
    if (!current || stale) return;
    const headers = [
      t('attendance.name', 'Name'),
      t('attendance.position', 'Position'),
      t('attendance.date', 'Date'),
      t('attendance.day', 'Day'),
      t('attendance.day_status', 'Status'),
      t('attendance.schedule', 'Schedule'),
      t('attendance.status_check_in', 'Time-in'),
      t('attendance.status_check_out', 'Time-out'),
      t('attendance.shifts', 'Shifts'),
      t('attendance.hours_worked', 'Hours worked'),
      t('attendance.hours_decimal', 'Hours (decimal)'),
      t('attendance.regular_decimal', 'Regular (decimal)'),
      t('attendance.over_decimal', 'Over (decimal)'),
      t('attendance.late_minutes', 'Late (minutes)'),
      t('attendance.undertime_minutes', 'Undertime (minutes)'),
      t('attendance.problems', 'Problems'),
      t('attendance.note', 'Note'),
    ];
    const lines = [headers.map(csvCell).join(',')];
    for (const e of rows) {
      for (const d of e.days) {
        // Days with punches, absences and leave; days off and blank days have nothing to record.
        if (!d.shifts.length && !['absent', 'excused'].includes(d.status)) continue;
        const firstIn = d.shifts.find((s) => s.in)?.in ?? null;
        const last = d.shifts[d.shifts.length - 1];
        // The day's last shift; blank when it has no time-out (the Problems column says so).
        const lastOut = last && !last.open ? last.out : null;
        const note = d.offDuty?.note ?? '';
        const cells: (string | number)[] = [
          personLabel(t, e),
          e.position ?? '',
          d.date,
          weekdayShort(t, weekdayOf(d.date)),
          dayStatusLabel(t, d.status),
          d.shift ? plannedShiftText(d.shift) : d.offDuty ? offDutyLabel(t, d.offDuty.type) : '',
          firstIn ? formatClock(firstIn) : '',
          last?.open ? nowLabel : lastOut ? formatClock(lastOut) : '',
          d.shifts.map((s) => shiftText(s, nowLabel, formatClock, ' - ')).join('; '),
          formatMinutes(d.workedMinutes),
          decimalHours(d.workedMinutes),
          decimalHours(d.regularMinutes),
          decimalHours(d.overMinutes),
          d.lateMinutes,
          d.undertimeMinutes,
          dayIssues(d).map((f) => flagLabel(t, f)).join('; '),
          note,
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
      if (!d) return '';
      if (!d.shifts.length) return dayMarkLabel(t, d) ?? (d.status === 'upcoming' ? '' : '-');
      const lines = d.shifts.map((s) => shiftText(s, nowLabel, shortClock, '-'));
      const issues = dayIssues(d);
      if (issues.length) lines.push(`! ${issues.map((f) => flagLabel(t, f)).join(', ')}`);
      else if (d.workedMinutes) lines.push(formatMinutes(d.workedMinutes));
      lines.push(...timingNotes(t, d));
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
          ...rows.map((e) => [personLabel(t, e), ...chunk.map((_, j) => pdfCell(e.days[i + j]))]),
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
    const totalsRow = (label: string, position: string, x: AttendanceTotals) => [
      label,
      position,
      String(x.daysWorked),
      x.absentDays ? String(x.absentDays) : '-',
      countAndMinutes(x.lateDays, x.lateMinutes).replace('—', '-'),
      countAndMinutes(x.undertimeDays, x.undertimeMinutes).replace('—', '-'),
      `${formatMinutes(x.workedMinutes)} (${decimalHours(x.workedMinutes)})`,
      formatMinutes(x.regularMinutes),
      formatMinutes(x.overMinutes),
      x.incompleteDays ? String(x.incompleteDays) : '-',
    ];
    autoTable(doc, {
      ...common,
      startY: 58,
      head: [[
        t('attendance.name', 'Name'),
        t('attendance.position', 'Position'),
        t('attendance.days_worked', 'Days worked'),
        t('attendance.absent', 'Absent'),
        t('attendance.late', 'Late'),
        t('attendance.undertime', 'Undertime'),
        t('attendance.hours_worked', 'Hours worked'),
        t('attendance.regular_hours', 'Regular hours'),
        t('attendance.over_shift', 'Over the shift'),
        t('attendance.needs_fixing', 'Needs fixing'),
      ]],
      body: [
        ...rows.map((e) => totalsRow(personLabel(t, e), e.position ?? '', e.totals)),
        totalsRow(t('attendance.total', 'Total'), '', shownTotals),
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
  const thisCutoff = cutoffPeriodOf(today);
  const lastCutoff = stepPeriod('cutoff', thisCutoff, -1);
  const presets: { key: string; label: string; title: string; range: Range }[] = [
    { key: 'this_cutoff', label: t('attendance.period_this_cutoff', 'This cutoff'), title: shortRangeLabel(thisCutoff), range: thisCutoff },
    { key: 'last_cutoff', label: t('attendance.period_last_cutoff', 'Last cutoff'), title: shortRangeLabel(lastCutoff), range: lastCutoff },
    { key: 'week', label: t('attendance.period_this_week', 'This week'), title: shortRangeLabel(periodOf('week', today)), range: periodOf('week', today) },
    { key: 'month', label: t('attendance.period_month', 'Whole month'), title: shortRangeLabel(periodOf('month', dateRange.start)), range: periodOf('month', dateRange.start) },
  ];
  const prev = kind ? stepPeriod(kind, dateRange, -1) : null;
  const next = kind ? stepPeriod(kind, dateRange, 1) : null;
  const navButton =
    'p-2 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-brand-muted';
  const stepTitle =
    kind === 'cutoff'
      ? t('attendance.period_step_cutoff', 'Previous / next cutoff')
      : kind === 'week'
        ? t('attendance.period_step_week', 'Previous / next week')
        : kind === 'month'
          ? t('attendance.period_step_month', 'Previous / next month')
          : t('attendance.period_step_none', 'Pick a period to step through');

  const periodBar = onDateRangeChange && (
    <div className="flex items-center gap-1 bg-white rounded-xl shadow-sm p-1">
      <button type="button" className={navButton} disabled={!prev} onClick={() => prev && applyPeriod(prev)} title={stepTitle} aria-label={t('attendance.period_prev', 'Previous period')}>
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
            title={p.title}
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
        title={stepTitle}
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

  const totalHeaders = [
    t('attendance.days_worked', 'Days worked'),
    t('attendance.absent', 'Absent'),
    t('attendance.late', 'Late'),
    t('attendance.undertime', 'Undertime'),
    t('attendance.hours_worked', 'Hours worked'),
    t('attendance.regular_hours', 'Regular hours'),
    t('attendance.over_shift', 'Over the shift'),
    t('attendance.needs_fixing', 'Needs fixing'),
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
            <input
              type="text"
              placeholder={t('attendance.search_name_position_placeholder', 'Search by name or position')}
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
                    {totalHeaders.map((label) => (
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
                          {e.position && <span className="block text-xs text-brand-muted font-medium">{e.position}</span>}
                          <span className="block text-xs text-brand-text font-bold tabular-nums mt-0.5">
                            {formatMinutes(e.totals.workedMinutes)}
                            {e.employeeId != null && e.totals.scheduledDays === 0 && (
                              <span className="ml-1.5 font-medium text-brand-muted">· {t('attendance.not_scheduled', 'Not scheduled')}</span>
                            )}
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
                          nowLabel={nowLabel}
                          clickable={e.employeeId != null}
                          onClick={() => openCell(e, date)}
                        />
                      ))}
                      <TotalCell>{e.totals.daysWorked || '—'}</TotalCell>
                      <TotalCell tone={e.totals.absentDays ? 'text-red-700' : undefined}>{e.totals.absentDays || '—'}</TotalCell>
                      <TotalCell tone={e.totals.lateDays ? 'text-orange-700' : undefined}>{countAndMinutes(e.totals.lateDays, e.totals.lateMinutes)}</TotalCell>
                      <TotalCell tone={e.totals.undertimeDays ? 'text-orange-700' : undefined}>
                        {countAndMinutes(e.totals.undertimeDays, e.totals.undertimeMinutes)}
                      </TotalCell>
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
                        {d.absent > 0 && (
                          <span className="block text-[11px] text-red-700 font-bold">
                            {t('attendance.absent_count', { count: d.absent, defaultValue: `${d.absent} absent` })}
                          </span>
                        )}
                      </td>
                    ))}
                    <TotalCell footer>{shownTotals.daysWorked}</TotalCell>
                    <TotalCell footer>{shownTotals.absentDays || '—'}</TotalCell>
                    <TotalCell footer>{countAndMinutes(shownTotals.lateDays, shownTotals.lateMinutes)}</TotalCell>
                    <TotalCell footer>{countAndMinutes(shownTotals.undertimeDays, shownTotals.undertimeMinutes)}</TotalCell>
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
              'attendance.timesheet_hint_v2',
              'Each day shows its shifts (time-in – time-out), hours worked, and late or undertime against the schedule. Late and Undertime totals are days · time. A day that needs fixing isn’t counted until its punches are fixed: click a day to open the timesheet.',
            )}
          </p>
          {!anyTracked && (
            <p className="text-xs text-brand-muted font-medium">
              {t(
                'attendance.no_schedules_hint_v2',
                'Nobody here has shifts in this period, so late, undertime and absences aren’t checked. Set them on the Schedules page.',
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
};

const TotalCell: React.FC<{ children: React.ReactNode; bold?: boolean; footer?: boolean; tone?: string }> = ({ children, bold, footer, tone }) => (
  <td
    className={cn(
      'px-3 py-2 text-right text-sm tabular-nums border-l border-gray-100 whitespace-nowrap',
      footer ? 'sticky bottom-0 z-20 bg-white border-t border-t-gray-200 font-bold' : 'border-b bg-white group-hover:bg-brand-bg/50',
      bold ? 'font-bold' : 'font-medium',
      tone ?? 'text-brand-text',
    )}
  >
    {children}
  </td>
);

const DayCell: React.FC<{
  day: WorkDay | undefined;
  isSunday: boolean;
  isToday: boolean;
  nowLabel: string;
  clickable: boolean;
  onClick: () => void;
}> = ({ day, isSunday, isToday, nowLabel, clickable, onClick }) => {
  const { t } = useTranslation();
  const base = cn('border-b border-gray-100 px-1.5 py-1.5 align-middle text-center', isSunday && 'bg-gray-50/70', isToday && 'bg-brand-primary/5');
  if (!day) return <td className={base} />;

  // No punches: absent, day off or leave show as a labelled cell; a shift still to come
  // shows its name faintly; other days a dash.
  if (!day.shifts.length) {
    const mark = dayMarkLabel(t, day);
    if (!mark) {
      return (
        <td className={base} title={day.shift ? plannedText(t, day) : undefined}>
          {day.shift ? (
            <span className="text-[10px] font-medium text-gray-400 truncate block max-w-[80px] mx-auto">
              {day.shift.name ?? `${shortClock(`2000-01-01 ${day.shift.start}`)}–${shortClock(`2000-01-01 ${day.shift.end}`)}`}
            </span>
          ) : (
            <span className={cn('text-xs', day.status === 'upcoming' ? 'text-gray-200' : 'text-gray-300')}>{day.status === 'upcoming' ? '' : '—'}</span>
          )}
        </td>
      );
    }
    const meta = dayStatusMeta(day.status);
    const Icon = meta.icon;
    const title = [
      `${formatYmdDisplay(day.date)} · ${dayStatusLabel(t, day.status)}`,
      plannedText(t, day) || null,
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
          className={cn('w-full rounded-lg px-1.5 py-1.5 transition-colors disabled:cursor-default hover:brightness-95', meta.cell)}
        >
          <span className="flex items-center justify-center gap-1 text-[11px] font-bold">
            {Icon && <Icon size={11} className="shrink-0" />}
            <span className="truncate max-w-[80px]">{mark}</span>
          </span>
        </button>
      </td>
    );
  }

  const issues = dayIssues(day);
  const notes = timingNotes(t, day);
  const tone =
    day.status === 'incomplete'
      ? 'bg-orange-50 text-orange-800 hover:bg-orange-100'
      : day.status === 'on_shift'
        ? 'bg-brand-primary/10 text-brand-primary hover:bg-brand-primary/15'
        : 'bg-green-50 text-green-900 hover:bg-green-100';
  const mark = day.offDuty ? offDutyLabel(t, day.offDuty.type) : null;
  const title = [
    `${formatYmdDisplay(day.date)} · ${dayStatusLabel(t, day.status)}${mark ? ` · ${mark}` : ''}`,
    day.shift ? `${t('attendance.shift', 'Shift')}: ${plannedShiftText(day.shift)}` : t('attendance.not_scheduled', 'Not scheduled'),
    ...day.shifts.map((s) => shiftText(s, nowLabel, formatClock, ' – ') + (s.minutes != null ? ` (${formatMinutes(s.minutes)})` : '')),
    day.workedMinutes
      ? `${t('attendance.worked', 'Worked')} ${formatMinutes(day.workedMinutes)}${
          day.overMinutes
            ? ` · ${t('attendance.regular', 'Regular')} ${formatMinutes(day.regularMinutes)} · ${t('attendance.over', 'Over')} ${formatMinutes(day.overMinutes)}`
            : ''
        }`
      : null,
    ...notes,
    ...issues.map((f) => flagLabel(t, f)),
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
        {day.lateMinutes > 0 && (
          <span className="block text-[10px] font-bold text-orange-700 tabular-nums whitespace-nowrap">
            {t('attendance.late', 'Late')} {formatMinutes(day.lateMinutes)}
          </span>
        )}
        {day.undertimeMinutes > 0 && (
          <span className="block text-[10px] font-bold text-orange-700 tabular-nums whitespace-nowrap">
            {t('attendance.undertime_short', 'UT')} {formatMinutes(day.undertimeMinutes)}
          </span>
        )}
        {mark && <span className="block text-[10px] font-medium text-brand-muted truncate">{mark}</span>}
      </button>
    </td>
  );
};
