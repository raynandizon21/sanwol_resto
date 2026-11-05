import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AlertTriangle, CalendarOff, ChevronLeft, ChevronRight, Info, Pencil, Plus, Trash2, X } from 'lucide-react';
import { SidePanel } from '../ui/SidePanel';
import { cn } from '../../lib/utils';
import {
  getTimesheet,
  ISSUE_FLAGS,
  removeExcusedDay,
  type ExcuseType,
  type Timesheet,
  type WorkDay,
  type TimesheetPunch,
} from '../../services/attendanceService';
import type { AttendanceLog } from '../../services/zktecoService';
import { getManilaTodayYmd, formatYmdDisplay } from '../../utils/manilaDateTime';
import { AddPunchDialog, DeletePunchDialog, EditPunchDialog, timesheetPunchToLog } from './PunchDialogs';
import { ExcuseDayDialog } from './ExcuseDayDialog';
import { punchStatusLabel, useZkLiveReload } from './zktecoShared';
import {
  DayStatusChip,
  dayStatusLabel,
  dayStatusMeta,
  excuseLabel,
  flagLabel,
  formatClock,
  formatMinutes,
  monthBounds,
  scheduleHours,
  shiftMonth,
  weekdayList,
  weekdayOf,
  weekdayShort,
} from './attendanceShared';

// Dialogs opened from the timesheet sit above the side panel (z-[101]).
const DIALOG_LAYER = 'z-[110]';

const iconButton =
  'p-1.5 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors';
const softButton =
  'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold text-brand-primary bg-brand-primary/10 hover:bg-brand-primary/15 transition-colors';

interface TimesheetViewProps {
  branchId: string | number;
  employeeId: number;
  /** Any date in the month to open on (default: this month). */
  initialDate?: string;
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/**
 * One person's month (basic time tracking): a calendar of hours worked per day, totals, and each
 * day's shifts and punches, with quick fixes (edit, delete, or add a forgotten punch).
 */
export const TimesheetView: React.FC<TimesheetViewProps> = ({ branchId, employeeId, initialDate, canAdd, canEdit, canDelete }) => {
  const { t } = useTranslation();
  const [month, setMonth] = useState(() => monthBounds(initialDate || getManilaTodayYmd()).start);
  const [sheet, setSheet] = useState<Timesheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialDate ?? null);
  const [editLog, setEditLog] = useState<AttendanceLog | null>(null);
  const [deleteLog, setDeleteLog] = useState<AttendanceLog | null>(null);
  const [addFor, setAddFor] = useState<{ date: string; status: number; shiftIn: string | null } | null>(null);
  const [markFor, setMarkFor] = useState<{ date: string; current: { type: ExcuseType; note: string | null } | null } | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const { start, end } = monthBounds(month);
        setSheet(await getTimesheet(branchId, employeeId, start, end));
        setError(null);
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [branchId, employeeId, month],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useZkLiveReload(branchId, ['attendance', 'users'], () => void load(true));

  const today = getManilaTodayYmd();
  const days = sheet?.days ?? [];
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  // With no day picked: days with punches, absences and marked days, newest first.
  const listed = selected
    ? days.filter((d) => d.date === selected)
    : [...days].reverse().filter((d) => d.shifts.length > 0 || ['absent', 'holiday', 'excused'].includes(d.status));

  const name = sheet?.employee.name ?? null;
  const monthLabel = new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const leading = weekdayOf(month);
  const totals = sheet?.totals;
  const standardHours = sheet?.rules.standardHours;

  const openEdit = (p: TimesheetPunch) => setEditLog(timesheetPunchToLog(p, name));
  const openDelete = (p: TimesheetPunch) => setDeleteLog(timesheetPunchToLog(p, name));
  const schedule = sheet?.employee.schedule ?? null;

  const unmark = async (date: string) => {
    if (!sheet) return;
    try {
      await removeExcusedDay(branchId, sheet.employee.employeeId, date);
      toast.success(t('attendance.excuse_removed', 'Mark removed'));
      void load(true);
    } catch (err) {
      toast.error((err as Error)?.message || t('attendance.excuse_failed', 'Could not mark the day'));
    }
  };

  return (
    <div className="space-y-5">
      {/* Month */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button type="button" className={iconButton} onClick={() => { setMonth(shiftMonth(month, -1)); setSelected(null); }} aria-label={t('attendance.prev_month', 'Previous month')}>
            <ChevronLeft size={18} />
          </button>
          <span className="text-sm font-bold text-brand-text min-w-[130px] text-center">{monthLabel}</span>
          <button type="button" className={iconButton} onClick={() => { setMonth(shiftMonth(month, 1)); setSelected(null); }} aria-label={t('attendance.next_month', 'Next month')}>
            <ChevronRight size={18} />
          </button>
        </div>
        {standardHours != null && (
          <div className="text-xs text-brand-muted font-medium text-right space-y-0.5">
            <p>{t('attendance.standard_day_label', { hours: standardHours, defaultValue: `Standard day: ${standardHours} h` })}</p>
            <p>
              {schedule
                ? `${t('attendance.schedule', 'Schedule')}: ${scheduleHours(schedule.start, schedule.end)}${
                    schedule.restDays.length ? ` · ${t('attendance.rest_short', 'Rest')}: ${weekdayList(t, schedule.restDays)}` : ''
                  }`
                : t('attendance.schedule_not_tracked', 'No schedule (not checked for late or absences)')}
            </p>
          </div>
        )}
      </div>

      {error && <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">{error}</div>}

      {/* Totals */}
      <div className="grid grid-cols-3 gap-2">
        {[
          [t('attendance.days_worked', 'Days worked'), totals ? String(totals.daysWorked) : '—'],
          [t('attendance.hours_worked', 'Hours worked'), totals ? formatMinutes(totals.workedMinutes) : '—'],
          [t('attendance.average_per_day', 'Average per day'), totals?.daysWithHours ? formatMinutes(totals.averageMinutes) : '—'],
          [t('attendance.regular_hours', 'Regular hours'), totals ? formatMinutes(totals.regularMinutes) : '—'],
          [t('attendance.over_standard', 'Over the standard day'), totals ? formatMinutes(totals.overMinutes) : '—'],
          [t('attendance.needs_fixing', 'Needs fixing'), totals ? String(totals.incompleteDays) : '—'],
          [t('attendance.absent', 'Absent'), totals ? String(totals.absentDays) : '—'],
          [t('attendance.late', 'Late'), totals ? (totals.lateDays ? `${totals.lateDays} · ${formatMinutes(totals.lateMinutes)}` : '0') : '—'],
          [
            t('attendance.undertime', 'Undertime'),
            totals ? (totals.undertimeDays ? `${totals.undertimeDays} · ${formatMinutes(totals.undertimeMinutes)}` : '0') : '—',
          ],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-gray-50 px-3 py-2">
            <p className="text-[11px] text-brand-muted font-medium">{label}</p>
            <p className="text-base font-bold tabular-nums text-brand-text">{loading ? '—' : value}</p>
          </div>
        ))}
      </div>

      {/* Calendar */}
      <div>
        <div className="grid grid-cols-7 gap-1 mb-1">
          {[0, 1, 2, 3, 4, 5, 6].map((d) => (
            <span key={d} className="text-[11px] font-bold text-brand-muted text-center">
              {weekdayShort(t, d)}
            </span>
          ))}
        </div>
        <div className={cn('grid grid-cols-7 gap-1 transition-opacity', loading && 'opacity-50')}>
          {Array.from({ length: leading }, (_, i) => (
            <span key={`pad-${i}`} />
          ))}
          {Array.from({ length: Number(monthBounds(month).end.slice(8)) }, (_, i) => {
            const ymd = `${month.slice(0, 8)}${String(i + 1).padStart(2, '0')}`;
            const day = byDate.get(ymd);
            const meta = day ? dayStatusMeta(day.status) : null;
            const worked = day?.workedMinutes ?? 0;
            const Icon = meta?.icon;
            return (
              <button
                key={ymd}
                type="button"
                onClick={() => setSelected(selected === ymd ? null : ymd)}
                title={
                  day
                    ? [
                        `${formatYmdDisplay(ymd)} · ${dayStatusLabel(t, day.status)}${worked ? ` · ${formatMinutes(worked)}` : ''}`,
                        day.holiday,
                        day.excuse ? excuseLabel(t, day.excuse.type) : null,
                        day.lateMinutes ? `${t('attendance.late', 'Late')} ${formatMinutes(day.lateMinutes)}` : null,
                        day.undertimeMinutes ? `${t('attendance.undertime', 'Undertime')} ${formatMinutes(day.undertimeMinutes)}` : null,
                      ]
                        .filter(Boolean)
                        .join('\n')
                    : ymd
                }
                className={cn(
                  'h-14 rounded-lg p-1.5 flex flex-col justify-between text-left border transition-shadow',
                  meta?.cell ?? 'bg-white text-brand-muted',
                  selected === ymd ? 'border-brand-primary ring-2 ring-brand-primary/20' : 'border-transparent',
                  ymd === today && 'outline outline-1 outline-brand-primary/40',
                )}
              >
                <span className="text-xs font-bold tabular-nums">{i + 1}</span>
                <span className="flex items-center justify-between gap-0.5 text-[10px] font-bold tabular-nums">
                  {worked ? formatMinutes(worked) : ''}
                  {Icon && day && day.status !== 'worked' && <Icon size={11} className="shrink-0" />}
                </span>
              </button>
            );
          })}
        </div>
        {/* Legend: color is never the only cue (each cell also has an icon and a tooltip). */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {(['worked', 'incomplete', 'on_shift', 'absent', 'rest_day', 'holiday', 'excused'] as const).map((s) => (
            <DayStatusChip key={s} status={s} t={t} />
          ))}
        </div>
      </div>

      {/* Days */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-brand-text">
            {selected ? formatYmdDisplay(selected) : t('attendance.days_with_activity', 'Days with activity')}
          </p>
          {selected && (
            <button type="button" onClick={() => setSelected(null)} className="text-xs font-bold text-brand-primary hover:underline">
              {t('attendance.show_all_days', 'Show all days')}
            </button>
          )}
        </div>
        {!loading && listed.length === 0 && !selected && (
          <p className="text-sm text-brand-muted">{t('attendance.no_activity', 'No punches this month.')}</p>
        )}
        {listed.map((day) => (
          <DayCard
            key={day.date}
            day={day}
            canAdd={canAdd && Boolean(sheet?.employee.employeeId)}
            canEdit={canEdit}
            canDelete={canDelete}
            onAdd={(status) =>
              // The day's latest time-in, so the dialog can catch a time-out entered before it.
              setAddFor({ date: day.date, status, shiftIn: [...day.shifts].reverse().find((s) => s.in)?.in ?? null })
            }
            onEdit={openEdit}
            onDelete={openDelete}
            canMark={canEdit && Boolean(sheet?.employee.employeeId)}
            onMark={() => setMarkFor({ date: day.date, current: day.excuse })}
            onUnmark={() => void unmark(day.date)}
          />
        ))}
      </div>

      <EditPunchDialog log={editLog} branchId={branchId} onClose={() => setEditLog(null)} onDone={() => void load(true)} layerClassName={DIALOG_LAYER} />
      <DeletePunchDialog log={deleteLog} branchId={branchId} onClose={() => setDeleteLog(null)} onDone={() => void load(true)} layerClassName={DIALOG_LAYER} />
      <AddPunchDialog
        isOpen={Boolean(addFor)}
        branchId={branchId}
        employee={sheet ? { employeeId: sheet.employee.employeeId, name, pin: sheet.employee.pin } : null}
        defaultDate={addFor?.date}
        defaultStatus={addFor?.status}
        shiftIn={addFor?.shiftIn}
        onClose={() => setAddFor(null)}
        onDone={() => void load(true)}
        layerClassName={DIALOG_LAYER}
      />
      <ExcuseDayDialog
        target={markFor && sheet ? { employeeId: sheet.employee.employeeId, name, date: markFor.date, current: markFor.current } : null}
        branchId={branchId}
        onClose={() => setMarkFor(null)}
        onDone={() => void load(true)}
        layerClassName={DIALOG_LAYER}
      />
    </div>
  );
};

/** The punch type a forgotten punch most likely is, from the day's problems. */
const suggestedStatus = (day: WorkDay): number => {
  if (day.flags.includes('missing_in')) return 0;
  if (day.flags.includes('missing_out') || day.flags.includes('long_shift')) return 1;
  return 0;
};

const DayCard: React.FC<{
  day: WorkDay & { punches: TimesheetPunch[] };
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onAdd: (status: number) => void;
  onEdit: (p: TimesheetPunch) => void;
  onDelete: (p: TimesheetPunch) => void;
  /** Attendance Logs → Edit: mark the day as leave / day off / holiday, or remove the mark. */
  canMark: boolean;
  onMark: () => void;
  onUnmark: () => void;
}> = ({ day, canAdd, canEdit, canDelete, onAdd, onEdit, onDelete, canMark, onMark, onUnmark }) => {
  const { t } = useTranslation();
  const issues = day.flags.filter((f) => ISSUE_FLAGS.includes(f));
  const notes = day.flags.filter((f) => !ISSUE_FLAGS.includes(f));
  const figures = day.workedMinutes
    ? [
        `${t('attendance.worked', 'Worked')} ${formatMinutes(day.workedMinutes)}`,
        day.overMinutes ? `${t('attendance.regular', 'Regular')} ${formatMinutes(day.regularMinutes)}` : null,
        day.overMinutes ? `${t('attendance.over', 'Over')} ${formatMinutes(day.overMinutes)}` : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="rounded-2xl border border-gray-100 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold text-brand-text">{formatYmdDisplay(day.date)}</p>
        <DayStatusChip status={day.status} t={t} />
      </div>

      {day.shifts.length > 0 && (
        <div className="space-y-0.5">
          {day.shifts.map((shift, i) => (
            <p key={i} className="text-sm text-brand-text font-medium tabular-nums">
              {t('attendance.status_check_in', 'Time-in')} {formatClock(shift.in)}
              {shift.inInferred && <span className="text-brand-muted">*</span>}
              {' → '}
              {shift.open ? (
                <span className="text-brand-primary">{t('attendance.still_working', 'still working')}</span>
              ) : (
                <>
                  {t('attendance.status_check_out', 'Time-out')} {formatClock(shift.out)}
                  {shift.outInferred && <span className="text-brand-muted">*</span>}
                </>
              )}
              {shift.minutes != null && <span className="text-brand-muted"> · {formatMinutes(shift.minutes)}</span>}
            </p>
          ))}
        </div>
      )}

      {figures.length > 0 && <p className="text-xs font-bold text-brand-muted tabular-nums">{figures.join(' · ')}</p>}

      {(day.lateMinutes > 0 || day.undertimeMinutes > 0) && (
        <p className="text-xs font-bold text-orange-700 tabular-nums">
          {[
            day.lateMinutes ? `${t('attendance.late', 'Late')} ${formatMinutes(day.lateMinutes)}` : null,
            day.undertimeMinutes ? `${t('attendance.undertime', 'Undertime')} ${formatMinutes(day.undertimeMinutes)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {day.status === 'absent' && (
        <p className="text-xs text-red-700 font-medium">
          {t('attendance.absent_hint', 'A work day by their schedule with no punches. If they were on leave, mark the day.')}
        </p>
      )}
      {day.holiday && (
        <p className="text-xs text-sky-700 font-medium">
          {t('attendance.branch_holiday', 'Branch holiday')}: {day.holiday}
        </p>
      )}
      {day.excuse && (
        <div className="flex items-center justify-between gap-2 bg-violet-50 text-violet-800 rounded-xl px-3 py-2">
          <span className="text-xs font-bold">
            {excuseLabel(t, day.excuse.type)}
            {day.excuse.note && <span className="font-medium"> · {day.excuse.note}</span>}
          </span>
          {canMark && (
            <span className="flex gap-0.5 shrink-0">
              <button type="button" className={iconButton} onClick={onMark} aria-label={t('attendance.excuse_edit', 'Change mark')}>
                <Pencil size={13} />
              </button>
              <button
                type="button"
                className={cn(iconButton, 'hover:text-red-600 hover:bg-red-50')}
                onClick={onUnmark}
                aria-label={t('attendance.excuse_remove', 'Remove mark')}
                title={t('attendance.excuse_remove', 'Remove mark')}
              >
                <X size={13} />
              </button>
            </span>
          )}
        </div>
      )}

      {issues.length > 0 && (
        <div className="bg-orange-50 rounded-xl px-3 py-2 space-y-1">
          {issues.map((f) => (
            <p key={f} className="flex items-center gap-1.5 text-xs font-bold text-orange-700">
              <AlertTriangle size={13} className="shrink-0" />
              {flagLabel(t, f)}
            </p>
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <div className="space-y-0.5">
          {notes.map((f) => (
            <p key={f} className="flex items-center gap-1.5 text-xs text-brand-muted">
              <Info size={12} className="shrink-0" />
              {flagLabel(t, f)}
            </p>
          ))}
        </div>
      )}

      {day.punches.length > 0 && (
        <div className="border-t border-gray-100 pt-2 space-y-1">
          {day.punches.map((p) => (
            <div key={`${p.source}:${p.id}`} className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-brand-text tabular-nums">
                {formatClock(p.punchDt)} · {punchStatusLabel(t, p.status) ?? t('attendance.status_none', 'No status')}
                {p.source === 'manual' && <span className="ml-1.5 text-brand-primary font-bold">{t('attendance.tag_manual', 'Added manually')}</span>}
                {p.source === 'device' && p.isEdited && <span className="ml-1.5 text-orange-600 font-bold">{t('attendance.tag_edited', 'Edited')}</span>}
              </span>
              <span className="flex gap-0.5">
                {canEdit && (
                  <button type="button" className={iconButton} onClick={() => onEdit(p)} aria-label={t('attendance.edit_punch_title', 'Edit punch')}>
                    <Pencil size={13} />
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    className={cn(iconButton, 'hover:text-red-600 hover:bg-red-50')}
                    onClick={() => onDelete(p)}
                    aria-label={t('attendance.delete_punch_title', 'Delete punch')}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {/* A forgotten punch can be added on any past or current day, with or without punches. */}
        {canAdd && day.status !== 'upcoming' && day.status !== 'excused' && (
          <button type="button" className={softButton} onClick={() => onAdd(suggestedStatus(day))}>
            <Plus size={13} />
            {t('attendance.add_punch_title', 'Add punch')}
          </button>
        )}
        {/* Leave filed ahead of time is marked on a future day too. */}
        {canMark && !day.excuse && (
          <button type="button" className={softButton} onClick={onMark}>
            <CalendarOff size={13} />
            {t('attendance.excuse_title', 'Mark day')}
          </button>
        )}
      </div>
    </div>
  );
};

interface TimesheetPanelProps extends Omit<TimesheetViewProps, 'employeeId'> {
  employee: { employeeId: number; name: string | null; pin: string } | null;
  onClose: () => void;
}

/** The timesheet in a side panel (from the Attendance Logs summary). */
export const TimesheetPanel: React.FC<TimesheetPanelProps> = ({ employee, onClose, ...rest }) => {
  const { t } = useTranslation();
  return (
    <SidePanel
      isOpen={Boolean(employee)}
      onClose={onClose}
      title={
        employee
          ? t('attendance.timesheet_title', {
              name: employee.name || '—',
              pin: employee.pin,
              defaultValue: `Timesheet · ${employee.name || '—'} (User ID ${employee.pin})`,
            })
          : ''
      }
      width="lg"
    >
      {employee && <TimesheetView key={`${employee.employeeId}:${rest.initialDate ?? ''}`} employeeId={employee.employeeId} {...rest} />}
    </SidePanel>
  );
};
