import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarCheck, ChevronRight, Clock, Hourglass, Timer, UserCheck, UserX } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { SkeletonTable } from '../ui/Skeleton';
import { cn } from '../../lib/utils';
import { getAttendanceSummary, type AttendanceSummary as Summary, type SummaryEmployee } from '../../services/attendanceService';
import { formatYmdDisplay } from '../../utils/manilaDateTime';
import { useZkLiveReload } from './zktecoShared';
import { flagLabel, formatClock, formatMinutes, toHours } from './attendanceShared';

// Two series per chart (validated pair: brand indigo + orange, both ≥ 3:1 on white, CVD ΔE 31).
// Orange is "extra / attention" in both charts: hours over the standard day, days needing a fix.
const SERIES = { main: '#4f46e5', accent: '#eb6834' } as const;
const GRID = '#eef2f7';
const AXIS_TICK = { fontSize: 11, fill: '#64748b' };
// 2px surface gap between stacked segments and adjacent bars.
const GAP = { stroke: '#ffffff', strokeWidth: 2 };

type ChartRow = { label: string } & Record<string, number | string>;

/** "2026-10-05" -> "Oct 5" */
const shortDate = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const Legend: React.FC<{ items: { color: string; label: string }[] }> = ({ items }) => (
  <div className="flex flex-wrap gap-x-4 gap-y-1">
    {items.map((item) => (
      <span key={item.label} className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-muted">
        <span className="w-2.5 h-2.5 rounded-sm" style={{ background: item.color }} />
        {item.label}
      </span>
    ))}
  </div>
);

/** Tooltip in text ink; the swatch carries the series identity. recharts passes active/payload/label. */
const ChartTooltip: React.FC<{
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  label?: string | number;
  series: { key: string; label: string; color: string; format: (v: number) => string }[];
}> = ({ active, payload, label, series }) => {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as ChartRow;
  return (
    <div className="bg-white rounded-xl shadow-lg border border-gray-100 px-3 py-2 text-xs">
      <p className="font-bold text-brand-text mb-1">{String(row.tooltipLabel ?? label)}</p>
      {series.map((s) => (
        <p key={s.key} className="flex items-center justify-between gap-4 text-brand-text">
          <span className="inline-flex items-center gap-1.5 text-brand-muted">
            <span className="w-2 h-2 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
          <span className="font-bold tabular-nums">{s.format(Number(row[s.key]) || 0)}</span>
        </p>
      ))}
    </div>
  );
};

const Card: React.FC<{ title: string; subtitle?: string; legend?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  title,
  subtitle,
  legend,
  children,
  className,
}) => (
  <div className={cn('bg-white rounded-2xl shadow-sm p-5 space-y-3', className)}>
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div>
        <p className="text-sm font-bold text-brand-text">{title}</p>
        {subtitle && <p className="text-xs text-brand-muted font-medium">{subtitle}</p>}
      </div>
      {legend}
    </div>
    {children}
  </div>
);

const Tile: React.FC<{ icon: React.ElementType; label: string; value: React.ReactNode; tone?: string; children?: React.ReactNode }> = ({
  icon: Icon,
  label,
  value,
  tone = 'text-brand-text',
  children,
}) => (
  <div className="bg-white p-5 rounded-2xl shadow-sm">
    <p className="flex items-center gap-1.5 text-brand-muted text-sm font-medium mb-1">
      <Icon size={15} />
      {label}
    </p>
    <h3 className={cn('text-3xl font-bold tabular-nums', tone)}>{value}</h3>
    {children}
  </div>
);

interface AttendanceSummaryProps {
  branchId: string | number;
  dateRange: { start: string; end: string };
  /** Opens a person's timesheet, optionally on a date. */
  onOpenTimesheet: (employee: { employeeId: number; name: string | null; pin: string }, date?: string) => void;
}

/**
 * Attendance for the header's date range (basic time tracking): who's in today, hours worked per
 * day, people at work per day, staffing by hour, problems to fix and per-person totals (the table
 * view of the charts).
 */
export const AttendanceSummary: React.FC<AttendanceSummaryProps> = ({ branchId, dateRange, onOpenTimesheet }) => {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        setSummary(await getAttendanceSummary(branchId, dateRange.start, dateRange.end));
        setError(null);
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [branchId, dateRange.start, dateRange.end],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useZkLiveReload(branchId, ['attendance', 'users'], () => void load(true));

  const hoursSeries = [
    { key: 'regular', label: t('attendance.regular_hours', 'Regular hours'), color: SERIES.main, format: (v: number) => `${v} h` },
    { key: 'over', label: t('attendance.over_shift', 'Over the shift'), color: SERIES.accent, format: (v: number) => `${v} h` },
  ];
  const peopleSeries = [
    { key: 'people', label: t('attendance.people_complete', 'Worked'), color: SERIES.main, format: String },
    { key: 'incomplete', label: t('attendance.day_incomplete', 'Needs fixing'), color: SERIES.accent, format: String },
  ];
  const staffingSeries = [
    { key: 'average', label: t('attendance.people_at_work', 'People at work (average)'), color: SERIES.main, format: (v: number) => String(v) },
    { key: 'days', label: t('attendance.days_counted', 'Days counted'), color: 'transparent', format: (v: number) => String(v) },
  ];

  const dailyRows: ChartRow[] = useMemo(
    () =>
      (summary?.daily ?? []).map((d) => ({
        label: shortDate(d.date),
        tooltipLabel: formatYmdDisplay(d.date),
        regular: toHours(d.regularMinutes),
        over: toHours(d.overMinutes),
        people: d.people,
        incomplete: d.incomplete,
      })),
    [summary],
  );
  const hourlyRows: ChartRow[] = useMemo(
    () =>
      (summary?.hourly ?? []).map((h) => ({
        label: formatClock(`${String(h.hour).padStart(2, '0')}:00`).replace(':00', ''),
        tooltipLabel: `${formatClock(`${String(h.hour).padStart(2, '0')}:00`)} – ${formatClock(`${String((h.hour + 1) % 24).padStart(2, '0')}:00`)}`,
        average: h.average,
        days: h.days,
      })),
    [summary],
  );
  // Whole-number ticks (people), with at least 0–1 shown.
  const staffingMax = Math.max(1, Math.ceil(Math.max(0, ...(summary?.hourly ?? []).map((h) => h.average))));

  const open = (e: { employeeId: number | null; name: string | null; pin: string }, date?: string) => {
    if (e.employeeId != null) onOpenTimesheet({ employeeId: e.employeeId, name: e.name, pin: e.pin }, date);
  };

  const num = (value: React.ReactNode) => <span className="text-sm font-medium tabular-nums">{value}</span>;
  const columns: ColumnDef<SummaryEmployee>[] = [
    {
      header: t('attendance.name', 'Name'),
      accessorKey: 'name',
      sortable: true,
      render: (e) => (
        <div className="flex flex-col">
          <span className={cn('text-sm font-bold', e.name ? 'text-brand-text' : 'text-brand-muted italic')}>
            {/* The User ID only for someone not on the device: nothing else tells them apart. */}
            {e.name || `${t('attendance.unknown_user', 'Not on device')} (${e.pin})`}
          </span>
          {e.position && <span className="text-xs text-brand-muted font-medium">{e.position}</span>}
        </div>
      ),
    },
    { header: t('attendance.days_worked', 'Days worked'), render: (e) => num(e.totals.daysWorked) },
    {
      header: t('attendance.absent', 'Absent'),
      render: (e) =>
        e.totals.absentDays ? (
          <span className="text-sm font-bold tabular-nums text-red-700">{e.totals.absentDays}</span>
        ) : (
          num(e.totals.scheduledDays ? '0' : '—')
        ),
    },
    {
      header: t('attendance.late', 'Late'),
      render: (e) =>
        e.totals.lateDays ? (
          <span className="text-sm font-bold tabular-nums text-orange-700">
            {e.totals.lateDays} · {formatMinutes(e.totals.lateMinutes)}
          </span>
        ) : (
          num(e.totals.scheduledDays ? '0' : '—')
        ),
    },
    { header: t('attendance.hours_worked', 'Hours worked'), render: (e) => num(formatMinutes(e.totals.workedMinutes)) },
    { header: t('attendance.regular_hours', 'Regular hours'), render: (e) => num(formatMinutes(e.totals.regularMinutes)) },
    {
      header: t('attendance.over_shift', 'Over the shift'),
      render: (e) => num(e.totals.overMinutes ? formatMinutes(e.totals.overMinutes) : '—'),
    },
    {
      header: t('attendance.average_per_day', 'Average per day'),
      render: (e) => num(e.totals.daysWithHours ? formatMinutes(e.totals.averageMinutes) : '—'),
    },
    {
      header: t('attendance.needs_fixing', 'Needs fixing'),
      render: (e) =>
        e.totals.incompleteDays ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-orange-50 text-orange-700">
            <AlertTriangle size={12} />
            {e.totals.incompleteDays}
          </span>
        ) : (
          <span className="text-sm text-brand-muted">—</span>
        ),
    },
    {
      header: '',
      className: 'text-right',
      render: (e) => (e.employeeId != null ? <ChevronRight size={16} className="text-brand-muted inline" /> : null),
    },
  ];

  if (loading && !summary) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-white h-28 rounded-2xl shadow-sm animate-pulse" />
          ))}
        </div>
        <SkeletonTable columns={7} rows={6} showToolbar={false} />
      </div>
    );
  }
  if (error && !summary) {
    return <div className="bg-red-50 border border-red-100 text-red-600 p-4 rounded-xl text-sm font-medium">{error}</div>;
  }
  if (!summary) return null;

  const today = summary.today;
  const totals = summary.totals;
  const hasData = summary.employees.length > 0;
  const tracked = summary.employees.some((e) => e.totals.scheduledDays > 0);

  return (
    <div className={cn('space-y-6 transition-opacity', loading && 'opacity-60')}>
      {/* Today (live) */}
      {/* Shifts, days off and leave are set on the Schedules page. */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-brand-text">
          {t('attendance.today', 'Today')} · {formatYmdDisplay(today.date)}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Tile icon={Clock} label={t('attendance.on_shift_now', 'On shift now')} value={today.onShift.length} tone="text-brand-primary">
          {today.onShift.length > 0 && (
            <ul className="mt-2 space-y-0.5 max-h-24 overflow-y-auto">
              {today.onShift.map((p) => (
                <li key={p.employeeId} className="text-xs text-brand-text font-medium flex justify-between gap-2">
                  <button type="button" className="truncate hover:underline text-left" onClick={() => open(p)}>
                    {p.name || '—'}
                  </button>
                  <span className="text-brand-muted tabular-nums shrink-0">
                    {t('attendance.since', 'since')} {formatClock(p.since)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Tile>
        <Tile icon={UserCheck} label={t('attendance.present_today', 'Came in today')} value={today.cameIn} tone="text-green-700" />
        <Tile
          icon={AlertTriangle}
          label={t('attendance.needs_fixing_today', 'Needs fixing today')}
          value={today.needsFixing}
          tone={today.needsFixing ? 'text-orange-600' : 'text-brand-text'}
        />
      </div>

      {/* Range */}
      <p className="text-sm font-bold text-brand-text">
        {formatYmdDisplay(summary.range.start)} – {formatYmdDisplay(summary.range.end)}
      </p>
      <div className="grid grid-cols-3 gap-4">
        <Tile icon={Hourglass} label={t('attendance.hours_worked', 'Hours worked')} value={formatMinutes(totals.workedMinutes)}>
          {totals.overMinutes > 0 && (
            <p className="text-xs text-brand-muted font-medium mt-1 tabular-nums">
              {t('attendance.hours_split', {
                regular: formatMinutes(totals.regularMinutes),
                over: formatMinutes(totals.overMinutes),
                defaultValue: `${formatMinutes(totals.regularMinutes)} regular · ${formatMinutes(totals.overMinutes)} over`,
              })}
            </p>
          )}
        </Tile>
        <Tile icon={CalendarCheck} label={t('attendance.days_worked', 'Days worked')} value={totals.daysWorked}>
          <p className="text-xs text-brand-muted font-medium mt-1">{t('attendance.days_worked_hint', 'All staff combined')}</p>
        </Tile>
        <Tile
          icon={Clock}
          label={t('attendance.average_per_day', 'Average per day')}
          value={totals.daysWithHours ? formatMinutes(totals.averageMinutes) : '—'}
        />
        <Tile
          icon={AlertTriangle}
          label={t('attendance.needs_fixing', 'Needs fixing')}
          value={totals.incompleteDays}
          tone={totals.incompleteDays ? 'text-orange-600' : 'text-brand-text'}
        />
        <Tile icon={UserX} label={t('attendance.absences', 'Absences')} value={totals.absentDays} tone={totals.absentDays ? 'text-red-700' : 'text-brand-text'}>
          <p className="text-xs text-brand-muted font-medium mt-1">
            {tracked
              ? t('attendance.absences_hint_v2', 'Shifts with no punches, and recorded absences')
              : t('attendance.no_schedules_short_v2', 'No shifts in this period (set them on the Schedules page)')}
          </p>
        </Tile>
        <Tile icon={Timer} label={t('attendance.late', 'Late')} value={totals.lateDays} tone={totals.lateDays ? 'text-orange-600' : 'text-brand-text'}>
          {(totals.lateDays > 0 || totals.undertimeDays > 0) && (
            <p className="text-xs text-brand-muted font-medium mt-1 tabular-nums">
              {[
                totals.lateDays > 0
                  ? t('attendance.late_total', { time: formatMinutes(totals.lateMinutes), defaultValue: `${formatMinutes(totals.lateMinutes)} in total` })
                  : null,
                totals.undertimeDays > 0
                  ? `${t('attendance.undertime', 'Undertime')} ${totals.undertimeDays} · ${formatMinutes(totals.undertimeMinutes)}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </Tile>
      </div>

      {!hasData ? (
        <div className="bg-white rounded-2xl shadow-sm p-8 text-center text-sm text-brand-muted">
          {t('attendance.summary_empty', 'No one is registered on the device for this branch yet, and there are no punches in this range.')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-6">
            <Card
              title={t('attendance.hours_per_day', 'Hours worked per day')}
              subtitle={t('attendance.hours_per_day_hint', 'All staff combined')}
              legend={<Legend items={hoursSeries} />}
            >
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyRows} margin={{ top: 4, right: 4, left: -16, bottom: 0 }} barCategoryGap="20%">
                    <CartesianGrid vertical={false} stroke={GRID} />
                    <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={12} />
                    <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} unit="h" />
                    <Tooltip cursor={{ fill: 'rgba(79,70,229,0.06)' }} content={<ChartTooltip series={hoursSeries} />} />
                    <Bar dataKey="regular" stackId="h" fill={SERIES.main} maxBarSize={28} {...GAP} />
                    <Bar dataKey="over" stackId="h" fill={SERIES.accent} maxBarSize={28} radius={[4, 4, 0, 0]} {...GAP} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card
              title={t('attendance.people_per_day', 'People at work per day')}
              subtitle={t('attendance.people_per_day_hint', 'Days that need a punch fixed are shown separately')}
              legend={<Legend items={peopleSeries} />}
            >
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyRows} margin={{ top: 4, right: 4, left: -24, bottom: 0 }} barCategoryGap="20%">
                    <CartesianGrid vertical={false} stroke={GRID} />
                    <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={12} />
                    <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip cursor={{ fill: 'rgba(79,70,229,0.06)' }} content={<ChartTooltip series={peopleSeries} />} />
                    <Bar dataKey="people" stackId="p" fill={SERIES.main} maxBarSize={28} {...GAP} />
                    <Bar dataKey="incomplete" stackId="p" fill={SERIES.accent} maxBarSize={28} radius={[4, 4, 0, 0]} {...GAP} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <Card
            title={t('attendance.staffing_by_hour', 'Staffing by hour')}
            subtitle={t(
              'attendance.staffing_by_hour_hint_v2',
              'Average number of people at work at each hour, on the days in the range when someone worked',
            )}
          >
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourlyRows} margin={{ top: 4, right: 4, left: -24, bottom: 0 }} barCategoryGap="15%">
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} interval={1} />
                  <YAxis
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                    domain={[0, staffingMax]}
                    tickCount={Math.min(staffingMax, 5) + 1}
                  />
                  <Tooltip cursor={{ fill: 'rgba(79,70,229,0.06)' }} content={<ChartTooltip series={staffingSeries} />} />
                  <Bar dataKey="average" fill={SERIES.main} radius={[4, 4, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {summary.issues.length > 0 && (
            <Card
              title={t('attendance.needs_fixing_title', { count: summary.issues.length, defaultValue: `Needs fixing (${summary.issues.length})` })}
              subtitle={t('attendance.needs_fixing_hint_basic', "A shift with a missing or doubtful punch isn't counted until it's fixed. Open the timesheet to fix it.")}
            >
              <div className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
                {summary.issues.map((issue) => (
                  <button
                    key={`${issue.employeeId ?? issue.pin}:${issue.date}`}
                    type="button"
                    disabled={issue.employeeId == null}
                    onClick={() => open(issue, issue.date)}
                    className="w-full flex items-center justify-between gap-4 py-2.5 text-left hover:bg-gray-50 rounded-lg px-2 disabled:hover:bg-transparent"
                  >
                    <span className="text-sm">
                      <span className="font-bold text-brand-text">{issue.name || `${t('attendance.unknown_user', 'Not on device')} (${issue.pin})`}</span>
                      <span className="text-brand-muted font-medium"> · {formatYmdDisplay(issue.date)}</span>
                    </span>
                    <span className="flex items-center gap-2 text-xs font-bold text-orange-700">
                      {issue.flags.map((f) => flagLabel(t, f)).join(' · ')}
                      {issue.employeeId != null && <ChevronRight size={14} className="text-brand-muted" />}
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          )}

          <div className="space-y-3">
            <p className="text-sm font-bold text-brand-text">{t('attendance.per_employee', 'Per employee')}</p>
            <DataTable
              data={summary.employees}
              columns={columns}
              keyExtractor={(e) => (e.employeeId != null ? `e${e.employeeId}` : `u${e.deviceId}:${e.pin}`)}
              onRowClick={(e) => open(e)}
            />
          </div>
        </>
      )}
    </div>
  );
};
