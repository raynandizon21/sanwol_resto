import React from 'react';
import type { TFunction } from 'i18next';
import { AlertTriangle, CalendarOff, CheckCircle2, Clock, Flag, Moon, UserX } from 'lucide-react';
import type { DayFlag, DayStatus, ExcuseType } from '../../services/attendanceService';
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
  rest_day: { key: 'attendance.day_rest', label: 'Rest day', chip: 'bg-gray-100 text-gray-600', cell: 'bg-gray-100 text-gray-500', icon: Moon },
  holiday: { key: 'attendance.day_holiday', label: 'Holiday', chip: 'bg-sky-50 text-sky-700', cell: 'bg-sky-100 text-sky-800', icon: Flag },
  excused: { key: 'attendance.day_excused', label: 'Excused', chip: 'bg-violet-50 text-violet-700', cell: 'bg-violet-100 text-violet-800', icon: CalendarOff },
};

const EXCUSE_TEXT: Record<ExcuseType, [string, string]> = {
  leave: ['attendance.excuse_leave', 'Leave'],
  day_off: ['attendance.excuse_day_off', 'Day off'],
  holiday: ['attendance.excuse_holiday', 'Holiday'],
};

export const EXCUSE_TYPES: ExcuseType[] = ['leave', 'day_off', 'holiday'];

export const excuseLabel = (t: TFunction, type: ExcuseType) => {
  const entry = EXCUSE_TEXT[type];
  return entry ? t(entry[0], entry[1]) : type;
};

/**
 * The short word for a day without punches, for grid cells: "Absent", "Rest day", the holiday's
 * name, or the excuse ("Leave"). Null for other days.
 */
export const dayMarkLabel = (t: TFunction, day: { status: DayStatus; holiday: string | null; excuse: { type: ExcuseType } | null }) => {
  if (day.status === 'excused' && day.excuse) return excuseLabel(t, day.excuse.type);
  if (day.status === 'holiday') return day.holiday || dayStatusLabel(t, 'holiday');
  if (day.status === 'absent' || day.status === 'rest_day') return dayStatusLabel(t, day.status);
  return null;
};

/** Weekday names in order (0 = Sunday), for schedules. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** "Mon, Tue" for rest days / closed days; "—" for none. */
export const weekdayList = (t: TFunction, days: number[]) => (days.length ? days.map((d) => weekdayShort(t, d)).join(', ') : '—');

/** "10:00 AM – 7:00 PM" or "10:00 AM" (no end time). */
export const scheduleHours = (start: string | null, end: string | null) =>
  start ? (end ? `${formatClock(start)} – ${formatClock(end)}` : formatClock(start)) : '—';

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
