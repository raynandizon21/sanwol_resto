import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { ChevronDown, ChevronLeft, ChevronRight, Download, Filter, Info, Printer } from 'lucide-react';
import { SkeletonTable } from '../ui/Skeleton';
import { type Branch } from '../partials/Header';
import { cn } from '../../lib/utils';
import {
  getSchedule,
  setScheduleDays,
  type ScheduleData,
  type ScheduleEmployee,
  type ScheduleEntry,
  type ScheduleValue,
} from '../../services/attendanceService';
import { formatYmdDisplay, getManilaTodayYmd } from '../../utils/manilaDateTime';
import { useZkLiveReload } from './zktecoShared';
import {
  addDaysYmd,
  monthBounds,
  offDutyLabel,
  scheduleHours,
  shiftMonth,
  shortClock,
  textOn,
  weekdayOf,
  weekdaysLabel,
  weekdayShort,
} from './attendanceShared';
import { positionRank } from './profileFields';
import { OFF_DUTY_STYLES, ScheduleCellDialog } from './ScheduleCellDialog';
import { buildSchedulePdf } from './schedulePdf';
import { printPdf } from './printPdf';
import { cutoffsIn, shortRangeLabel, type Range } from './timesheetPeriods';

type View = 'month' | 'week';
type Cell = { employeeId: number; date: string };
type Selection = { r0: number; c0: number; r1: number; c1: number };

type SheetAction = 'print' | 'download';

/** Saves a built file under `filename`. */
const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const toolbarButton =
  'bg-white text-brand-text px-3.5 py-2 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:hover:bg-white';

/** Monday of the week containing `ymd` (weeks run Monday–Sunday, like the timesheet's "This week"). */
const mondayOf = (ymd: string) => addDaysYmd(ymd, -((weekdayOf(ymd) + 6) % 7));

const datesBetween = (start: string, end: string) => {
  const list: string[] = [];
  for (let d = start; d <= end; d = addDaysYmd(d, 1)) list.push(d);
  return list;
};

/** Same entry (so the dialog can show what's set when every selected day has it). */
const sameEntry = (a: ScheduleEntry | null, b: ScheduleEntry | null) => {
  if (!a || !b) return a === b;
  if (a.type !== b.type) return false;
  if (a.type === 'shift' && b.type === 'shift') return a.shiftTypeId === b.shiftTypeId && a.start === b.start && a.end === b.end;
  return a.type !== 'shift' && b.type !== 'shift' && a.note === b.note;
};

const positionKey = (p: string | null) => String(p ?? '').trim().toLowerCase();

/** The positions present, in the Position dropdown's order (for the filter and the groups). */
const positionsOf = (employees: ScheduleEmployee[]) => {
  const seen = new Map<string, string>();
  for (const e of employees) if (!seen.has(positionKey(e.position))) seen.set(positionKey(e.position), e.position?.trim() || '');
  return [...seen.entries()]
    .sort((a, b) => {
      const [ra, ka] = positionRank(a[1]);
      const [rb, kb] = positionRank(b[1]);
      return ra - rb || ka.localeCompare(kb);
    })
    .map(([key, label]) => ({ key, label }));
};

/** Rows grouped by position (dropdown order), names A–Z inside each group; `filter` = position keys. */
const groupsOf = (employees: ScheduleEmployee[], filter: string[]) => {
  const shown = employees.filter((e) => !filter.length || filter.includes(positionKey(e.position)));
  return positionsOf(employees)
    .map(({ key, label }) => ({
      key,
      label,
      rows: shown
        .filter((e) => positionKey(e.position) === key)
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''))),
    }))
    .filter((g) => g.rows.length > 0);
};

/** Entries by "employeeId|date". */
const entriesOf = (data: ScheduleData | null) => {
  const map = new Map<string, ScheduleEntry>();
  for (const d of data?.days ?? []) {
    const { employeeId, date, ...entry } = d;
    map.set(`${employeeId}|${date}`, entry as ScheduleEntry);
  }
  return map;
};

interface SchedulesProps {
  selectedBranch: Branch | null;
}

/**
 * Staff → Schedules: each employee's schedule per day, in a month or week grid (rows = people,
 * grouped by position; columns = days). Click a day, or drag across days and people, then pick a
 * shift, custom times, a day off, leave or absent. Late, undertime and absences in Attendance Logs
 * are checked against it. Also: the branch's shift types, a position filter, and a printable
 * schedule (one cutoff, 1–15 or 16–end, per PDF). It reloads by itself when anything changes
 * (no Live badge or Refresh button since 2026-11-06). See docs/attendance.md.
 */
export const Schedules: React.FC<SchedulesProps> = ({ selectedBranch }) => {
  const { t } = useTranslation();
  const branchId = selectedBranch?.id ?? 'all';
  const isAllBranches = String(branchId) === 'all';

  const [view, setView] = useState<View>('month');
  // First of the month (month view) or Monday (week view).
  const [anchor, setAnchor] = useState(() => monthBounds(getManilaTodayYmd()).start);
  const [data, setData] = useState<ScheduleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [positionFilter, setPositionFilter] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dialogCells, setDialogCells] = useState<Cell[] | null>(null);
  // Print and Download each pick a cutoff: the menu open, and the one being prepared.
  const [cutoffMenu, setCutoffMenu] = useState<SheetAction | null>(null);
  const [preparing, setPreparing] = useState<SheetAction | null>(null);
  const dragging = useRef(false);
  // A touch on a day: it opens that day when lifted without scrolling (touch never drags, so the
  // grid can still be scrolled on a phone or tablet).
  const touchTap = useRef<{ r: number; c: number; x: number; y: number } | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const sheetActionsRef = useRef<HTMLDivElement>(null);

  const range = view === 'month' ? monthBounds(anchor) : { start: anchor, end: addDaysYmd(anchor, 6) };
  const dates = useMemo(() => datesBetween(range.start, range.end), [range.start, range.end]);

  const load = useCallback(
    async (silent = false) => {
      if (isAllBranches) {
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        setData(await getSchedule(branchId, range.start, range.end));
        setError(null);
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [branchId, isAllBranches, range.start, range.end],
  );

  useEffect(() => {
    void load();
  }, [load]);
  // Changes from other screens (schedules, shift types) and new people reload the grid silently.
  useZkLiveReload(branchId, ['attendance', 'users'], () => void load(true));

  // Close the position filter and the cutoff menus on an outside click.
  useEffect(() => {
    if (!filterOpen && !cutoffMenu) return;
    const close = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
      if (sheetActionsRef.current && !sheetActionsRef.current.contains(e.target as Node)) setCutoffMenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [filterOpen, cutoffMenu]);

  const today = data?.today ?? getManilaTodayYmd();
  const canSet = Boolean(data?.permissions.setDays);
  const activeShiftTypes = useMemo(() => (data?.shiftTypes ?? []).filter((s) => s.active), [data]);
  const entries = useMemo(() => entriesOf(data), [data]);
  const entryOf = (employeeId: number, date: string) => entries.get(`${employeeId}|${date}`) ?? null;

  const positions = useMemo(() => positionsOf(data?.employees ?? []), [data]);
  const groups = useMemo(() => groupsOf(data?.employees ?? [], positionFilter), [data, positionFilter]);
  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  // People on shift per day (shown under the grid).
  const onShiftPerDay = useMemo(
    () => dates.map((d) => rows.filter((e) => entryOf(e.employeeId, d)?.type === 'shift').length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dates, rows, entries],
  );

  // ---- Navigation ----

  const step = (delta: number) => {
    setSelection(null);
    setAnchor((a) => (view === 'month' ? shiftMonth(a, delta) : addDaysYmd(a, 7 * delta)));
  };
  const switchView = (next: View) => {
    if (next === view) return;
    setSelection(null);
    setView(next);
    // The week to show: this week when it's in the month shown, else the month's first week.
    setAnchor((a) =>
      next === 'month' ? monthBounds(a).start : mondayOf(today.slice(0, 7) === a.slice(0, 7) ? today : a),
    );
  };
  const rangeLabel =
    view === 'month'
      ? new Date(`${anchor}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      : `${formatYmdDisplay(range.start)} – ${formatYmdDisplay(range.end)}`;

  // ---- Selecting days (click, or drag a rectangle across days and people) ----

  const cellsOf = (s: Selection): Cell[] => {
    const [ra, rb] = [Math.min(s.r0, s.r1), Math.max(s.r0, s.r1)];
    const [ca, cb] = [Math.min(s.c0, s.c1), Math.max(s.c0, s.c1)];
    const cells: Cell[] = [];
    for (let r = ra; r <= rb; r += 1) for (let c = ca; c <= cb; c += 1) if (rows[r]) cells.push({ employeeId: rows[r].employeeId, date: dates[c] });
    return cells;
  };
  const inSelection = (r: number, c: number) =>
    selection != null &&
    r >= Math.min(selection.r0, selection.r1) &&
    r <= Math.max(selection.r0, selection.r1) &&
    c >= Math.min(selection.c0, selection.c1) &&
    c <= Math.max(selection.c0, selection.c1);

  const updateSelection = (next: Selection | null) => {
    selectionRef.current = next;
    setSelection(next);
  };

  const onCellPointerDown = (e: React.PointerEvent, r: number, c: number) => {
    if (!canSet || e.button !== 0) return;
    if (e.pointerType !== 'mouse') {
      touchTap.current = { r, c, x: e.clientX, y: e.clientY };
      return;
    }
    e.preventDefault();
    // Let pointermove reach other cells (touch captures the pointer by default).
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragging.current = true;
    updateSelection({ r0: r, c0: c, r1: r, c1: c });
  };
  const onGridPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-cell]') as HTMLElement | null;
    if (!el) return;
    const r = Number(el.dataset.row);
    const c = Number(el.dataset.col);
    const s = selectionRef.current;
    if (s && (s.r1 !== r || s.c1 !== c)) updateSelection({ ...s, r1: r, c1: c });
  };
  useEffect(() => {
    const finish = (e: PointerEvent) => {
      const tap = touchTap.current;
      if (tap) {
        touchTap.current = null;
        // A tap (not a scroll): open that day.
        if (Math.abs(e.clientX - tap.x) < 10 && Math.abs(e.clientY - tap.y) < 10 && rows[tap.r]) {
          updateSelection({ r0: tap.r, c0: tap.c, r1: tap.r, c1: tap.c });
          setDialogCells([{ employeeId: rows[tap.r].employeeId, date: dates[tap.c] }]);
        }
        return;
      }
      if (!dragging.current) return;
      dragging.current = false;
      const s = selectionRef.current;
      if (s) setDialogCells(cellsOf(s));
    };
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragging.current) {
        dragging.current = false;
        updateSelection(null);
      }
    };
    // The browser cancels the pointer when a touch turns into a scroll.
    const cancelTap = () => {
      touchTap.current = null;
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancelTap);
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancelTap);
      window.removeEventListener('keydown', cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, dates]);

  const closeDialog = () => {
    setDialogCells(null);
    updateSelection(null);
  };

  const dialogInfo = useMemo(() => {
    if (!dialogCells?.length) return null;
    const people = [...new Set(dialogCells.map((c) => c.employeeId))];
    const days = [...new Set(dialogCells.map((c) => c.date))].sort();
    const who =
      people.length === 1
        ? data?.employees.find((e) => e.employeeId === people[0])?.name || '—'
        : t('attendance.n_people', { count: people.length, defaultValue: `${people.length} people` });
    const when =
      days.length === 1
        ? `${weekdayShort(t, weekdayOf(days[0]))}, ${formatYmdDisplay(days[0])}`
        : `${formatYmdDisplay(days[0])} – ${formatYmdDisplay(days[days.length - 1])}`;
    const list = dialogCells.map((c) => entryOf(c.employeeId, c.date));
    const total = dialogCells.length > 1 ? ` (${t('attendance.n_days_selected', { count: dialogCells.length, defaultValue: `${dialogCells.length} days` })})` : '';
    return {
      summary: `${who} · ${when}${total}`,
      dates: days,
      current: list.every((e) => sameEntry(e, list[0])) ? list[0] : null,
      anySet: list.some(Boolean),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogCells, entries, data, t]);

  const applyValue = async (value: ScheduleValue) => {
    if (!dialogCells?.length) return;
    try {
      await setScheduleDays(branchId, dialogCells, value);
      closeDialog();
      await load(true);
    } catch (err) {
      toast.error((err as Error)?.message || t('attendance.schedule_save_failed', 'Could not save the schedule'));
    }
  };

  // ---- Print (one cutoff per PDF) ----

  // The cutoffs the view overlaps: a month has two, a week one or two.
  const printCutoffs = cutoffsIn(range);

  /**
   * Builds one cutoff's PDF, then opens the browser's print screen for it (Print) or saves it
   * (Download): loads its days (the view may show only part of it), same filter and order.
   */
  const sheetForCutoff = async (cutoff: Range, action: SheetAction) => {
    setCutoffMenu(null);
    setPreparing(action);
    try {
      const sheet = await getSchedule(branchId, cutoff.start, cutoff.end);
      const sheetEntries = entriesOf(sheet);
      const sheetRows = groupsOf(sheet.employees, positionFilter).flatMap((g) => g.rows);
      if (!sheetRows.length) {
        toast.info(t('attendance.print_nobody', 'Nobody to print for this cutoff.'));
        return;
      }
      const sheetDates = datesBetween(cutoff.start, cutoff.end);
      const filterLabel = positionFilter.length
        ? positions.filter((p) => positionFilter.includes(p.key)).map((p) => p.label || t('attendance.no_position', 'No position')).join(', ')
        : t('attendance.all_positions', 'All positions');
      const blob = buildSchedulePdf({
        t,
        branchName: selectedBranch?.name ?? '',
        range: cutoff,
        filterLabel,
        rows: sheetRows.map((e) => ({
          name: e.name || '—',
          position: e.position || '',
          entries: sheetDates.map((d) => sheetEntries.get(`${e.employeeId}|${d}`) ?? null),
        })),
        shiftTypes: sheet.shiftTypes,
      });
      if (action === 'print') {
        await printPdf(blob);
      } else {
        downloadBlob(blob, `schedule_${(selectedBranch?.name || 'branch').replace(/[^a-zA-Z0-9]+/g, '_')}_${cutoff.start}_to_${cutoff.end}.pdf`);
      }
    } catch (err) {
      toast.error((err as Error)?.message || t('attendance.schedule_load_failed', 'Could not load the schedule.'));
    } finally {
      setPreparing(null);
    }
  };

  // ---- Render ----

  if (isAllBranches) {
    return (
      <div className="pt-6">
        <div className="bg-white rounded-2xl shadow-sm p-8 text-center text-brand-muted text-sm font-medium">
          {t('attendance.schedules_pick_branch', 'Choose a branch to see and set its schedules.')}
        </div>
      </div>
    );
  }

  const compact = view === 'month';
  const dayColWidth = compact ? 'min-w-[60px] w-[60px]' : 'min-w-[120px]';
  const isWeekend = (d: string) => weekdayOf(d) === 0 || weekdayOf(d) === 6;
  const filterLabel = positionFilter.length
    ? t('attendance.positions_n', { count: positionFilter.length, defaultValue: `Positions (${positionFilter.length})` })
    : t('attendance.all_positions', 'All positions');

  const renderEntry = (entry: ScheduleEntry | null) => {
    if (!entry) return null;
    if (entry.type === 'shift') {
      const bg = entry.color ?? '#E5E7EB';
      const times = `${shortClock(entry.start)}–${shortClock(entry.end)}`;
      return (
        <span className="block rounded-md px-1 py-1 leading-tight" style={{ backgroundColor: bg, color: textOn(bg) }}>
          <span className="block text-[11px] font-bold truncate">{entry.name ?? times}</span>
          {!compact && entry.name && <span className="block text-[10px] font-medium opacity-80 tabular-nums">{times}</span>}
        </span>
      );
    }
    return (
      <span className={cn('block rounded-md px-1 py-1 text-[11px] font-bold truncate leading-tight', OFF_DUTY_STYLES[entry.type])}>
        {offDutyLabel(t, entry.type)}
      </span>
    );
  };

  const entryTitle = (e: ScheduleEmployee, date: string, entry: ScheduleEntry | null) =>
    [
      `${e.name || '—'} · ${weekdayShort(t, weekdayOf(date))}, ${formatYmdDisplay(date)}`,
      entry
        ? entry.type === 'shift'
          ? `${entry.name ?? t('attendance.shift', 'Shift')}: ${scheduleHours(entry.start, entry.end)}`
          : [offDutyLabel(t, entry.type), entry.note].filter(Boolean).join(': ')
        : t('attendance.not_scheduled', 'Not scheduled'),
      (e.hired && date < e.hired) || (e.separated && date > e.separated) ? t('attendance.not_employed_day', 'Not employed on this date') : null,
    ]
      .filter(Boolean)
      .join('\n');

  return (
    <div className="space-y-6 pt-6">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: 'easeOut' }} className="space-y-6">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex bg-white rounded-xl p-1 shadow-sm" role="tablist">
              {(['month', 'week'] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => switchView(v)}
                  className={cn(
                    'px-3.5 py-1.5 rounded-lg text-sm font-bold transition-colors',
                    view === v ? 'bg-brand-primary text-white' : 'text-brand-muted hover:text-brand-text',
                  )}
                >
                  {v === 'month' ? t('attendance.view_month', 'Month') : t('attendance.view_week', 'Week')}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 bg-white rounded-xl shadow-sm px-1 py-1">
              <button type="button" onClick={() => step(-1)} className="p-1.5 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10" aria-label={t('attendance.previous', 'Previous')}>
                <ChevronLeft size={18} />
              </button>
              <span className="text-sm font-bold text-brand-text min-w-[190px] text-center tabular-nums">{rangeLabel}</span>
              <button type="button" onClick={() => step(1)} className="p-1.5 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10" aria-label={t('attendance.next', 'Next')}>
                <ChevronRight size={18} />
              </button>
            </div>
            <div className="relative" ref={filterRef}>
              <button type="button" onClick={() => setFilterOpen((o) => !o)} className={cn(toolbarButton, positionFilter.length && 'text-brand-primary')}>
                <Filter size={16} />
                {filterLabel}
                <ChevronDown size={14} />
              </button>
              {filterOpen && (
                <div className="absolute z-30 mt-2 w-72 bg-white rounded-xl shadow-xl border border-gray-100 p-2 max-h-80 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => setPositionFilter([])}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm font-bold text-brand-primary hover:bg-brand-primary/5"
                  >
                    {t('attendance.all_positions', 'All positions')}
                  </button>
                  {positions.map((p) => (
                    <label key={p.key} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={positionFilter.includes(p.key)}
                        onChange={(e) =>
                          setPositionFilter((f) => (e.target.checked ? [...f, p.key] : f.filter((x) => x !== p.key)))
                        }
                        className="accent-brand-primary"
                      />
                      {p.label || <span className="italic text-brand-muted">{t('attendance.no_position', 'No position')}</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2" ref={sheetActionsRef}>
              {(['print', 'download'] as const).map((action) => {
                const Icon = action === 'print' ? Printer : Download;
                const hasMenu = printCutoffs.length > 1;
                return (
                  <div key={action} className="relative">
                    <button
                      type="button"
                      onClick={() =>
                        hasMenu ? setCutoffMenu((m) => (m === action ? null : action)) : void sheetForCutoff(printCutoffs[0], action)
                      }
                      disabled={!data || !rows.length || preparing != null}
                      aria-haspopup={hasMenu ? 'menu' : undefined}
                      aria-expanded={hasMenu ? cutoffMenu === action : undefined}
                      className={toolbarButton}
                    >
                      <Icon size={16} />
                      {preparing === action
                        ? t('attendance.preparing', 'Preparing…')
                        : action === 'print'
                          ? t('attendance.print', 'Print')
                          : t('attendance.download', 'Download')}
                      {hasMenu && <ChevronDown size={14} />}
                    </button>
                    {cutoffMenu === action && (
                      <div role="menu" className="absolute right-0 z-30 mt-2 w-60 bg-white rounded-xl shadow-xl border border-gray-100 p-2">
                        <p className="px-3 pt-1 pb-2 text-xs font-bold uppercase tracking-wider text-brand-muted">
                          {action === 'print'
                            ? t('attendance.print_which_cutoff', 'Print which cutoff?')
                            : t('attendance.download_which_cutoff', 'Download which cutoff?')}
                        </p>
                        {printCutoffs.map((p) => {
                          const current = p.start <= today && today <= p.end;
                          return (
                            <button
                              key={p.start}
                              type="button"
                              role="menuitem"
                              onClick={() => void sheetForCutoff(p, action)}
                              className="w-full flex items-center justify-between gap-2 text-left px-3 py-2 rounded-lg text-sm font-bold text-brand-text hover:bg-brand-primary/5"
                            >
                              <span className="tabular-nums">{shortRangeLabel(p)}</span>
                              {current && (
                                <span className="text-[11px] font-bold text-brand-primary">{t('attendance.current_cutoff', 'Current')}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-100 text-red-600 p-4 rounded-xl text-sm font-medium">
            {t('attendance.schedule_load_failed', 'Could not load the schedule.')} {error}
          </div>
        )}

        {loading && !data ? (
          <SkeletonTable rows={6} columns={8} showToolbar={false} />
        ) : !data ? null : rows.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm p-8 text-center text-brand-muted text-sm font-medium">
            {data.employees.length
              ? t('attendance.schedules_none_filtered', 'Nobody in the chosen positions.')
              : t('attendance.schedules_no_people', 'No employees on this branch’s attendance device yet.')}
          </div>
        ) : (
          <div className={cn('bg-white rounded-2xl shadow-sm overflow-hidden transition-opacity', loading && 'opacity-60')}>
            <div className="overflow-auto max-h-[calc(100vh-260px)] select-none" onPointerMove={onGridPointerMove}>
              <table className="border-separate border-spacing-0 w-max min-w-full">
                <thead>
                  <tr>
                    <th className="sticky left-0 top-0 z-30 bg-gray-50 border-b border-r border-gray-200 px-4 py-2 text-left text-xs font-bold text-brand-muted min-w-[220px]">
                      {t('attendance.employee', 'Employee')}
                    </th>
                    {dates.map((d) => (
                      <th
                        key={d}
                        className={cn(
                          'sticky top-0 z-20 border-b border-r border-gray-200 px-1 py-1.5 text-center',
                          dayColWidth,
                          isWeekend(d) ? 'bg-gray-200/70 text-brand-text' : 'bg-gray-50 text-brand-text',
                        )}
                      >
                        <span className="block text-[10px] font-bold uppercase text-brand-muted">{weekdayShort(t, weekdayOf(d))}</span>
                        <span
                          className={cn(
                            'inline-flex items-center justify-center text-sm font-bold tabular-nums',
                            d === today && 'bg-brand-primary text-white rounded-full px-1.5',
                          )}
                        >
                          {compact ? Number(d.slice(8)) : formatYmdDisplay(d).replace(/, \d{4}$/, '')}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    let index = -1;
                    return groups.map((g) => (
                      <React.Fragment key={g.key || '_none'}>
                        <tr>
                          <td className="sticky left-0 z-10 bg-violet-50 border-b border-gray-200 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-violet-800">
                            {g.label || t('attendance.no_position', 'No position')}
                            <span className="ml-1.5 font-medium normal-case tracking-normal text-violet-600">· {g.rows.length}</span>
                          </td>
                          <td colSpan={dates.length} className="bg-violet-50 border-b border-gray-200" />
                        </tr>
                        {g.rows.map((e) => {
                          index += 1;
                          const r = index;
                          return (
                            <tr key={e.employeeId}>
                              <td className="sticky left-0 z-10 bg-white border-b border-r border-gray-200 px-4 py-1.5">
                                <span className={cn('block text-sm font-bold text-brand-text truncate max-w-[200px]', !e.active && 'text-brand-muted')}>
                                  {e.name || '—'}
                                </span>
                                {!e.active && (
                                  <span className="block text-[11px] text-brand-muted font-medium">{t('attendance.tag_removed', 'Removed')}</span>
                                )}
                              </td>
                              {dates.map((d, c) => {
                                const entry = entryOf(e.employeeId, d);
                                const outside = Boolean((e.hired && d < e.hired) || (e.separated && d > e.separated));
                                const selected = inSelection(r, c);
                                return (
                                  <td
                                    key={d}
                                    data-cell
                                    data-row={r}
                                    data-col={c}
                                    tabIndex={canSet ? 0 : undefined}
                                    title={entryTitle(e, d, entry)}
                                    onPointerDown={(ev) => onCellPointerDown(ev, r, c)}
                                    onKeyDown={(ev) => {
                                      if (canSet && (ev.key === 'Enter' || ev.key === ' ')) {
                                        ev.preventDefault();
                                        updateSelection({ r0: r, c0: c, r1: r, c1: c });
                                        setDialogCells([{ employeeId: e.employeeId, date: d }]);
                                      }
                                    }}
                                    className={cn(
                                      'border-b border-r border-gray-100 p-1 align-middle text-center h-12',
                                      dayColWidth,
                                      canSet && 'cursor-pointer hover:bg-brand-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary',
                                      isWeekend(d) && 'bg-gray-50',
                                      outside && 'bg-[repeating-linear-gradient(135deg,#f3f4f6_0,#f3f4f6_4px,#fff_4px,#fff_8px)]',
                                      !e.active && 'opacity-60',
                                      selected && '!bg-brand-primary/15 ring-2 ring-inset ring-brand-primary',
                                    )}
                                  >
                                    {renderEntry(entry)}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    ));
                  })()}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="sticky left-0 bottom-0 z-30 bg-gray-50 border-t border-r border-gray-200 px-4 py-2 text-xs font-bold text-brand-muted">
                      {t('attendance.on_shift_per_day', 'On shift')}
                    </td>
                    {onShiftPerDay.map((n, i) => (
                      <td key={dates[i]} className="sticky bottom-0 z-20 bg-gray-50 border-t border-r border-gray-200 px-1 py-2 text-center text-sm font-bold tabular-nums text-brand-text">
                        {n || <span className="text-gray-300">0</span>}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* Legend */}
        {data && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {activeShiftTypes.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1.5 bg-white rounded-lg shadow-sm pr-2.5">
                <span className="px-2 py-1 rounded-lg font-bold whitespace-nowrap" style={{ backgroundColor: s.color, color: textOn(s.color) }}>
                  {s.name}
                </span>
                <span className="font-medium text-brand-text tabular-nums whitespace-nowrap">
                  {scheduleHours(s.start, s.end)}
                  {s.weekdays.length < 7 && <span className="text-brand-muted"> · {weekdaysLabel(t, s.weekdays)}</span>}
                </span>
              </span>
            ))}
            {(['day_off', 'leave', 'absent'] as const).map((type) => (
              <span key={type} className={cn('px-2 py-1 rounded-lg font-bold', OFF_DUTY_STYLES[type])}>
                {offDutyLabel(t, type)}
              </span>
            ))}
            <span className="px-2 py-1 rounded-lg font-medium bg-white border border-gray-200 text-brand-muted">
              {t('attendance.blank_not_scheduled', 'Blank: not scheduled')}
            </span>
          </div>
        )}
        {data && canSet && (
          <p className="flex items-start gap-1.5 text-xs text-brand-muted font-medium">
            <Info size={13} className="shrink-0 mt-0.5" />
            {t(
              'attendance.schedules_hint',
              'Click a day, or drag across days and people, to set a shift, a day off, leave or absent. Late, undertime and absences in Attendance Logs follow this schedule; a blank day isn’t checked.',
            )}
          </p>
        )}
      </motion.div>

      <ScheduleCellDialog
        isOpen={Boolean(dialogCells?.length)}
        summary={dialogInfo?.summary ?? ''}
        shiftTypes={activeShiftTypes}
        dates={dialogInfo?.dates ?? []}
        current={dialogInfo?.current ?? null}
        anySet={Boolean(dialogInfo?.anySet)}
        onApply={applyValue}
        onClose={closeDialog}
      />

    </div>
  );
};

