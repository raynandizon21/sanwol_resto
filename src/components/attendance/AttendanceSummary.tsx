import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarDays, ChevronRight } from 'lucide-react';
import { SkeletonTable } from '../ui/Skeleton';
import { cn } from '../../lib/utils';
import {
  getAttendanceSummary,
  type AttendanceSummary as Summary,
  type AttendanceTotals,
  type SummaryEmployee,
} from '../../services/attendanceService';
import { formatYmdDisplay, getManilaTodayYmd } from '../../utils/manilaDateTime';
import { useZkLiveReload } from './zktecoShared';
import { formatClock, formatMinutes, offDutyLabel, textOn } from './attendanceShared';
import { groupsOf, positionsOf } from './profileFields';
import { OFF_DUTY_STYLES } from './ScheduleCellDialog';
import { PeriodStepper, PositionFilter, ViewToggle, periodLabel } from './ScheduleControls';
import { capAtToday, periodOf, stepPeriod, type PeriodKind, type Range } from './timesheetPeriods';

type Counts = Pick<
  AttendanceTotals,
  'scheduledDays' | 'daysWorked' | 'absentDays' | 'lateDays' | 'lateMinutes' | 'dayOffDays' | 'excusedDays' | 'workedMinutes' | 'incompleteDays'
>;

const COUNT_KEYS: (keyof Counts)[] = [
  'scheduledDays',
  'daysWorked',
  'absentDays',
  'lateDays',
  'lateMinutes',
  'dayOffDays',
  'excusedDays',
  'workedMinutes',
  'incompleteDays',
];

const sumCounts = (rows: SummaryEmployee[]): Counts => {
  const out = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Counts;
  for (const e of rows) for (const k of COUNT_KEYS) out[k] += e.totals[k];
  return out;
};

const Stat: React.FC<{ value: number; label: string; attention?: boolean }> = ({ value, label, attention }) => (
  <div className="flex items-baseline gap-2">
    <span className={cn('text-xl font-bold tabular-nums', attention && value > 0 ? 'text-orange-600' : 'text-brand-text')}>{value}</span>
    <span className="text-xs font-medium text-brand-muted">{label}</span>
  </div>
);

interface AttendanceSummaryProps {
  branchId: string | number;
  dateRange: Range;
  /** The Month / Cutoff / Week choice (kept by the page, so it survives switching tabs). */
  period: PeriodKind;
  onPeriodChange: (period: PeriodKind) => void;
  onDateRangeChange?: (range: Range) => void;
  /** Opens a person's timesheet, optionally on a date. */
  onOpenTimesheet: (employee: { employeeId: number; name: string | null; pin: string }, date?: string) => void;
  /** The Summary / Timesheet / Punches tabs, shown at the end of the toolbar. */
  tabs?: React.ReactNode;
}

/**
 * Attendance for the period, built to read alongside the Schedules page: the same period and
 * position controls, today's schedule against actual punches, and everyone grouped by position
 * (same groups, order and names as Schedules) with totals per position and per person. Click a
 * person to open their timesheet.
 */
export const AttendanceSummary: React.FC<AttendanceSummaryProps> = ({
  branchId,
  dateRange,
  period,
  onPeriodChange,
  onDateRangeChange,
  onOpenTimesheet,
  tabs,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [positionFilter, setPositionFilter] = useState<string[]>([]);
  const latestLoad = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      const id = ++latestLoad.current;
      if (!silent) setLoading(true);
      try {
        const next = await getAttendanceSummary(branchId, dateRange.start, dateRange.end);
        if (id !== latestLoad.current) return;
        setSummary(next);
        setError(null);
      } catch (err) {
        if (id === latestLoad.current && !silent) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (id === latestLoad.current) setLoading(false);
      }
    },
    [branchId, dateRange.start, dateRange.end],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useZkLiveReload(branchId, ['attendance', 'users'], () => void load(true));

  const positions = useMemo(() => positionsOf(summary?.employees ?? []), [summary]);
  const groups = useMemo(() => groupsOf(summary?.employees ?? [], positionFilter), [summary, positionFilter]);
  // The newest problem of each person: where a click on their row opens the timesheet.
  const problemDate = useMemo(() => {
    const dates = new Map<number, string>();
    for (const issue of summary?.issues ?? []) {
      if (issue.employeeId != null && !dates.has(issue.employeeId)) dates.set(issue.employeeId, issue.date);
    }
    return dates;
  }, [summary]);

  const today = summary?.today.date ?? getManilaTodayYmd();
  const whole = periodOf(period, dateRange.start);
  const isWholePeriod = whole.start === dateRange.start && capAtToday(whole, today).end === dateRange.end;
  const nextPeriod = stepPeriod(period, dateRange, 1);

  const stepBy = (delta: -1 | 1) => onDateRangeChange?.(capAtToday(stepPeriod(period, dateRange, delta), today));
  const switchPeriod = (next: PeriodKind) => {
    if (next === period) return;
    const base = dateRange.start <= today && today <= dateRange.end ? today : dateRange.start;
    onPeriodChange(next);
    onDateRangeChange?.(capAtToday(periodOf(next, base), today));
  };
  const goToSchedules = () => navigate(`/schedules${location.search || ''}`);
  const canGoToSchedules = String(branchId) !== 'all';

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {onDateRangeChange && (
          <>
            <ViewToggle value={period} onChange={switchPeriod} />
            <PeriodStepper
              label={isWholePeriod ? periodLabel(period, whole) : `${formatYmdDisplay(dateRange.start)} – ${formatYmdDisplay(dateRange.end)}`}
              onStep={stepBy}
              nextDisabled={nextPeriod.start > today}
            />
            <PositionFilter positions={positions} value={positionFilter} onChange={setPositionFilter} />
          </>
        )}
      </div>
      {tabs}
    </div>
  );

  if (loading && !summary) {
    return (
      <div className="space-y-4">
        {toolbar}
        <div className="bg-white h-16 rounded-2xl shadow-sm animate-pulse" />
        <SkeletonTable columns={8} rows={8} showToolbar={false} />
      </div>
    );
  }
  if (error && !summary) {
    return (
      <div className="space-y-4">
        {toolbar}
        <div className="bg-red-50 border border-red-100 text-red-600 p-4 rounded-xl text-sm font-medium">{error}</div>
      </div>
    );
  }
  if (!summary) return null;

  const todayCounts = summary.today;
  const nothingToday = !todayCounts.scheduled && !todayCounts.inNow && !todayCounts.needsFixing;
  const hasShiftsInPeriod = summary.employees.some((e) => e.totals.scheduledDays > 0);

  const dash = <span className="text-brand-muted">—</span>;
  /** A count that only means something when shifts were set. */
  const checked = (value: number, hasShifts: boolean, tone?: string) =>
    value > 0 ? <span className={cn('font-bold', tone)}>{value}</span> : hasShifts ? '0' : dash;
  const counted = (value: number) => (value > 0 ? value : dash);

  const countCells = (c: Counts) => {
    const hasShifts = c.scheduledDays > 0;
    return (
      <>
        <td className="px-3 py-2 text-center">
          {hasShifts ? c.scheduledDays : <span className="text-xs font-medium text-brand-muted">{t('attendance.no_shifts', 'No shifts')}</span>}
        </td>
        <td className="px-3 py-2 text-center">{counted(c.daysWorked)}</td>
        <td className="px-3 py-2 text-center">{checked(c.absentDays, hasShifts, 'text-red-700')}</td>
        <td
          className="px-3 py-2 text-center"
          title={c.lateDays ? t('attendance.late_total', { time: formatMinutes(c.lateMinutes), defaultValue: `${formatMinutes(c.lateMinutes)} in total` }) : undefined}
        >
          {checked(c.lateDays, hasShifts, 'text-orange-700')}
        </td>
        <td className="px-3 py-2 text-center">{counted(c.dayOffDays)}</td>
        <td className="px-3 py-2 text-center">{counted(c.excusedDays)}</td>
        <td className="px-3 py-2 text-center whitespace-nowrap">{c.workedMinutes > 0 ? formatMinutes(c.workedMinutes) : dash}</td>
      </>
    );
  };

  const todayCell = (status: SummaryEmployee['today']) => {
    if (!status) return dash;
    const chip = status.shift ? (
      <span
        className="rounded px-1.5 text-[11px] leading-4 font-bold"
        style={{ backgroundColor: status.shift.color ?? '#E5E7EB', color: textOn(status.shift.color ?? '#E5E7EB') }}
      >
        {status.shift.name ?? `${formatClock(status.shift.start)} – ${formatClock(status.shift.end)}`}
      </span>
    ) : status.offDuty ? (
      <span className={cn('rounded px-1.5 text-[11px] leading-4 font-bold', OFF_DUTY_STYLES[status.offDuty.type])}>{offDutyLabel(t, status.offDuty.type)}</span>
    ) : null;
    const note = status.timeIn ? (
      <span className="text-xs font-medium text-brand-text tabular-nums">
        {t('attendance.in_at', { time: formatClock(status.timeIn), defaultValue: `in ${formatClock(status.timeIn)}` })}
        {status.lateMinutes > 0 && (
          <span className="ml-1.5 font-bold text-orange-700">
            {t('attendance.late_by', { time: formatMinutes(status.lateMinutes), defaultValue: `Late ${formatMinutes(status.lateMinutes)}` })}
          </span>
        )}
      </span>
    ) : status.notInYet ? (
      <span className="text-xs font-bold text-orange-700">{t('attendance.not_in_yet', 'Not in yet')}</span>
    ) : status.shift ? (
      <span className="text-xs font-medium text-brand-muted tabular-nums">
        {t('attendance.starts_at', { time: formatClock(status.shift.start), defaultValue: `Starts ${formatClock(status.shift.start)}` })}
      </span>
    ) : null;
    if (!chip && !note) return dash;
    return (
      <span className="flex items-center gap-2 whitespace-nowrap">
        {chip}
        {note}
      </span>
    );
  };

  const open = (e: SummaryEmployee) => {
    if (e.employeeId != null) onOpenTimesheet({ employeeId: e.employeeId, name: e.name, pin: e.pin }, problemDate.get(e.employeeId));
  };

  const dayOffHeader = offDutyLabel(t, 'day_off');
  const leaveHeader = offDutyLabel(t, 'leave');
  const headers = [
    t('attendance.shifts', 'Shifts'),
    t('attendance.worked', 'Worked'),
    t('attendance.absent', 'Absent'),
    t('attendance.late', 'Late'),
    dayOffHeader,
    leaveHeader,
    t('attendance.hours_worked', 'Hours worked'),
  ];

  return (
    <div className={cn('space-y-4 transition-opacity', loading && 'opacity-60')}>
      {toolbar}

      {/* Today: the schedule against who actually punched. */}
      <div className="bg-white rounded-2xl shadow-sm px-5 py-3 flex flex-wrap items-center gap-x-10 gap-y-2">
        <p className="text-sm font-bold text-brand-text">
          {t('attendance.today', 'Today')} <span className="font-medium text-brand-muted">· {formatYmdDisplay(todayCounts.date)}</span>
        </p>
        {nothingToday ? (
          <p className="flex items-center gap-3 text-sm font-medium text-brand-muted">
            {t('attendance.no_shifts_today', 'No shifts set for today.')}
            {hasShiftsInPeriod && canGoToSchedules && (
              <button type="button" onClick={goToSchedules} className="font-bold text-brand-primary hover:underline">
                {t('attendance.open_schedules', 'Open Schedules')}
              </button>
            )}
          </p>
        ) : (
          <>
            <Stat value={todayCounts.scheduled} label={t('attendance.scheduled', 'Scheduled')} />
            <Stat value={todayCounts.inNow} label={t('attendance.in_now', 'In now')} />
            <Stat value={todayCounts.notInYet} label={t('attendance.not_in_yet', 'Not in yet')} attention />
            <Stat value={todayCounts.late} label={t('attendance.late', 'Late')} attention />
            <Stat value={todayCounts.needsFixing} label={t('attendance.needs_fixing', 'Needs fixing')} attention />
          </>
        )}
      </div>

      {!summary.employees.length ? (
        <div className="bg-white rounded-2xl shadow-sm p-8 text-center text-sm text-brand-muted">
          {t('attendance.summary_empty', 'No one is registered on the device for this branch yet, and there are no punches in this range.')}
        </div>
      ) : (
        <>
          {!hasShiftsInPeriod && (
            <div className="bg-white rounded-2xl shadow-sm px-5 py-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium text-brand-muted">
                {t('attendance.no_shifts_period', 'No shifts set for this period, so absences and lateness aren’t checked.')}
              </p>
              {canGoToSchedules && (
                <button type="button" onClick={goToSchedules} className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-bold bg-brand-primary text-white hover:opacity-90">
                  <CalendarDays size={16} />
                  {t('attendance.set_shifts', 'Set shifts on the Schedules page')}
                </button>
              )}
            </div>
          )}

          {groups.length === 0 ? (
            <div className="bg-white rounded-2xl shadow-sm p-8 text-center text-brand-muted text-sm font-medium">
              {t('attendance.schedules_none_filtered', 'Nobody in the chosen positions.')}
            </div>
          ) : (
            <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full border-separate border-spacing-0 text-sm tabular-nums">
                  <thead>
                    <tr className="bg-gray-50 text-xs font-bold text-brand-muted">
                      <th className="px-4 py-2.5 text-left border-b border-gray-200 min-w-[220px]">{t('attendance.employee', 'Employee')}</th>
                      <th className="px-3 py-2.5 text-left border-b border-gray-200 min-w-[220px]">{t('attendance.today', 'Today')}</th>
                      {headers.map((h) => (
                        <th key={h} className="px-3 py-2.5 text-center border-b border-gray-200 whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                      <th className="px-3 py-2.5 border-b border-gray-200" />
                    </tr>
                  </thead>
                  <tbody className="[&_td]:border-b [&_td]:border-gray-100 [&>tr:last-child>td]:border-b-0">
                    {groups.map((g) => {
                      const groupCounts = sumCounts(g.rows);
                      return (
                        <React.Fragment key={g.key || '_none'}>
                          <tr className="bg-violet-50 text-violet-800 font-bold text-xs">
                            <td className="px-4 py-2 uppercase tracking-wider whitespace-nowrap">
                              {g.label || t('attendance.no_position', 'No position')}
                              <span className="ml-1.5 font-medium normal-case tracking-normal text-violet-600">· {g.rows.length}</span>
                            </td>
                            <td />
                            {countCells(groupCounts)}
                            <td />
                          </tr>
                          {g.rows.map((e) => {
                            const clickable = e.employeeId != null;
                            return (
                              <tr
                                key={e.employeeId != null ? `e${e.employeeId}` : `u${e.deviceId}:${e.pin}`}
                                onClick={() => open(e)}
                                onKeyDown={(ev) => {
                                  if (clickable && ev.key === 'Enter') open(e);
                                }}
                                tabIndex={clickable ? 0 : undefined}
                                className={cn(
                                  'text-brand-text font-medium',
                                  clickable && 'cursor-pointer hover:bg-brand-primary/5 focus:outline-none focus-visible:bg-brand-primary/5',
                                )}
                              >
                                <td className="px-4 py-2 font-bold whitespace-nowrap">
                                  <span className={cn(!e.name && 'text-brand-muted italic font-medium')}>
                                    {/* The User ID only for someone not on the device: nothing else tells them apart. */}
                                    {e.name || `${t('attendance.unknown_user', 'Not on device')} (${e.pin})`}
                                  </span>
                                  {e.employeeId != null && !e.active && (
                                    <span className="ml-1.5 text-[11px] font-medium text-brand-muted">{t('attendance.tag_removed', 'Removed')}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2">{todayCell(e.today)}</td>
                                {countCells(e.totals)}
                                <td className="px-3 py-2 text-right whitespace-nowrap">
                                  {e.totals.incompleteDays > 0 && (
                                    <span
                                      className="inline-flex items-center gap-1 px-2 py-0.5 mr-2 rounded-full text-xs font-bold bg-orange-50 text-orange-700"
                                      title={t('attendance.needs_fixing', 'Needs fixing')}
                                    >
                                      <AlertTriangle size={12} />
                                      {e.totals.incompleteDays}
                                    </span>
                                  )}
                                  {clickable && <ChevronRight size={16} className="text-brand-muted inline" />}
                                </td>
                              </tr>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
