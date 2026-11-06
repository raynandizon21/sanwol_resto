import React from 'react';
import type { TFunction } from 'i18next';
import { AlertTriangle, CalendarOff, CheckCircle2, Clock, Moon, UserX } from 'lucide-react';
import type { DayFlag, DayShift, DayStatus, OffDutyType } from '../../services/attendanceService';
import { cn } from '../../lib/utils';

/** 510 -> "8h 30m", 45 -> "45m", 0 -> "0h". */
export const formatMinutes = (minutes: number | null | undefined): string => {
  const m = Math.round(Number(minutes) || 0);
  if (m === 0) return '0h';
  const h = Math.floor(Math.abs(m) / 60);
  const rest = Math.abs(m) % 60;
  const sign = m < 0 ? '-' : '';
  if (!h) return `${sign}${rest}m`;
  return rest ? `${sign}${h}h ${rest}m` : `${sign}${h}h`;
};

/** Minutes -> hours with one decimal, for chart axes ("7.5"). */
export const toHours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

/** "HH:MM" or "YYYY-MM-DD HH:MM[:SS]" -> "8:05 AM" (wall clock, no timezone conversion). */
export const formatClock = (value: string | null | undefined): string => {
  const m = String(value ?? '').match(/(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!m) return '—';
  const hour = Number(m[1]);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${m[2]} ${hour < 12 ? 'AM' : 'PM'}`;
};

/** Short weekday names, 0 = Sunday. */
export const weekdayShort = (t: TFunction, day: number): string =>
  t(`attendance.weekday_short_${day}`, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]);

/** Weekdays in the order weeks run here (Monday to Sunday). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * The weekdays a shift is for: "Every day", "Fri–Sun" (three or more in a row), or "Mon, Wed".
 * `sep` joins a run ("-" for jsPDF, whose fonts have no en dash).
 */
export const weekdaysLabel = (t: TFunction, weekdays: number[], sep = '–'): string => {
  const set = new Set(weekdays);
  if (set.size >= 7) return t('attendance.every_day', 'Every day');
  const runs: number[][] = [];
  for (const d of WEEK_ORDER.filter((x) => set.has(x))) {
    const last = runs[runs.length - 1];
    if (last && WEEK_ORDER.indexOf(d) === WEEK_ORDER.indexOf(last[last.length - 1]) + 1) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) => (r.length > 2 ? `${weekdayShort(t, r[0])}${sep}${weekdayShort(t, r[r.length - 1])}` : r.map((d) => weekdayShort(t, d)).join(', ')))
    .join(', ');
};

// Status colors are reserved for state and always shown with a label or icon, never color alone.
export const STATUS_COLORS = {
  good: '#0ca30c',
  serious: '#ec835a',
} as const;

type StatusMeta = { key: string; label: string; chip: string; cell: string; icon: React.ElementType | null };

const DAY_STATUS_META: Record<DayStatus, StatusMeta> = {
  worked: { key: 'attendance.day_worked', label: 'Worked', chip: 'bg-green-50 text-green-700', cell: 'bg-green-100 text-green-800', icon: CheckCircle2 },
  incomplete: { key: 'attendance.day_incomplete', label: 'Needs fixing', chip: 'bg-orange-50 text-orange-700', cell: 'bg-orange-100 text-orange-800', icon: AlertTriangle },
  on_shift: { key: 'attendance.day_on_shift', label: 'On shift', chip: 'bg-brand-primary/10 text-brand-primary', cell: 'bg-brand-primary/15 text-brand-primary', icon: Clock },
  off: { key: 'attendance.day_no_punches', label: 'No punches', chip: 'bg-gray-50 text-brand-muted', cell: 'bg-white text-brand-muted', icon: null },
  upcoming: { key: 'attendance.day_upcoming', label: 'Upcoming', chip: 'bg-gray-50 text-brand-muted', cell: 'bg-white text-gray-300', icon: null },
  absent: { key: 'attendance.day_absent', label: 'Absent', chip: 'bg-red-50 text-red-700', cell: 'bg-red-100 text-red-800', icon: UserX },
  rest_day: { key: 'attendance.day_rest', label: 'Day off', chip: 'bg-gray-100 text-gray-600', cell: 'bg-gray-100 text-gray-500', icon: Moon },
  excused: { key: 'attendance.day_excused', label: 'Leave', chip: 'bg-violet-50 text-violet-700', cell: 'bg-violet-100 text-violet-800', icon: CalendarOff },
};

const OFF_DUTY_TEXT: Record<OffDutyType, [string, string]> = {
  day_off: ['attendance.off_day_off', 'Day off'],
  leave: ['attendance.off_leave', 'Leave'],
  absent: ['attendance.off_absent', 'Absent'],
};

export const OFF_DUTY_TYPES: OffDutyType[] = ['day_off', 'leave', 'absent'];

export const offDutyLabel = (t: TFunction, type: OffDutyType) => {
  const entry = OFF_DUTY_TEXT[type];
  return entry ? t(entry[0], entry[1]) : type;
};

/** The short word for a day without punches, for grid cells: "Absent", "Day off" or "Leave". Null for other days. */
export const dayMarkLabel = (t: TFunction, day: { status: DayStatus }) => {
  if (day.status === 'absent' || day.status === 'rest_day' || day.status === 'excused') return dayStatusLabel(t, day.status);
  return null;
};

/** "10:00 AM – 7:00 PM". */
export const scheduleHours = (start: string | null, end: string | null) =>
  start ? (end ? `${formatClock(start)} – ${formatClock(end)}` : formatClock(start)) : '—';

/** "10a", "2:30p": compact times for grid cells. */
export const shortClock = (hhmm: string) => {
  const m = hhmm.match(/^(\d{2}):(\d{2})/);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m[2] === '00' ? '' : `:${m[2]}`}${h < 12 ? 'a' : 'p'}`;
};

/** A day's shift as text: "Opening (10:00 AM – 7:00 PM)", or just the times for custom ones. */
export const shiftText = (shift: DayShift | null) =>
  shift ? (shift.name ? `${shift.name} (${scheduleHours(shift.start, shift.end)})` : scheduleHours(shift.start, shift.end)) : '';

/** Black or white, whichever reads better on `hex` (a shift type's color). */
export const textOn = (hex: string | null | undefined) => {
  const m = String(hex ?? '').match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return '#111827';
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? '#111827' : '#FFFFFF';
};

export const dayStatusMeta = (status: DayStatus) => DAY_STATUS_META[status] ?? DAY_STATUS_META.off;

export const dayStatusLabel = (t: TFunction, status: DayStatus) => {
  const meta = dayStatusMeta(status);
  return t(meta.key, meta.label);
};

export const DayStatusChip: React.FC<{ status: DayStatus; t: TFunction; className?: string }> = ({ status, t, className }) => {
  const meta = dayStatusMeta(status);
  const Icon = meta.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap', meta.chip, className)}>
      {Icon && <Icon size={12} />}
      {dayStatusLabel(t, status)}
    </span>
  );
};

const FLAG_TEXT: Record<DayFlag, [string, string]> = {
  missing_in: ['attendance.flag_missing_in', 'No time-in'],
  missing_out: ['attendance.flag_missing_out', 'No time-out'],
  long_shift: ['attendance.flag_long_shift', 'Shift over 16 hours (time-out likely forgotten)'],
  inferred: ['attendance.flag_inferred', 'Time-in/out guessed from punches with no type'],
  marked_absent: ['attendance.flag_marked_absent', 'Marked absent on the schedule, but punched in'],
};

export const flagLabel = (t: TFunction, flag: DayFlag) => {
  const entry = FLAG_TEXT[flag];
  return entry ? t(entry[0], entry[1]) : flag;
};

/** First and last day of the month containing `ymd`. */
export const monthBounds = (ymd: string): { start: string; end: string } => {
  const [y, m] = ymd.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, '0')}` };
};

/** `ymd` moved by whole months, as the first of that month. */
export const shiftMonth = (ymd: string, delta: number): string => {
  const [y, m] = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
};

/** `ymd` moved by whole days, no timezone involved. */
export const addDaysYmd = (ymd: string, delta: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
};

/** Weekday of a "YYYY-MM-DD" (0 = Sunday), no timezone involved. */
export const weekdayOf = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
