// Periods for the Timesheet tab's buttons: the branch's cutoff (semi-monthly, monthly, weekly or
// bi-weekly; set in Attendance rules), a week (Monday to Sunday) and a month. Pure; no timezone.

import type { CutoffRule } from '../../services/attendanceService';
import { addDaysYmd, monthBounds, shiftMonth, weekdayOf } from './attendanceShared';

export type Range = { start: string; end: string };

export type PeriodKind = 'cutoff' | 'week' | 'month';

export const DEFAULT_CUTOFF: CutoffRule = { type: 'semi_monthly', day1: 1, day2: 16, weekday: 1, anchor: null };

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** "2026-11" + day -> "2026-11-05" */
const onDay = (ymd: string, day: number) => `${ymd.slice(0, 8)}${String(day).padStart(2, '0')}`;

/** The cutoff period that contains `ymd` (not capped at today). */
export const cutoffPeriodOf = (cutoff: CutoffRule, ymd: string): Range => {
  const day = Number(ymd.slice(8));
  switch (cutoff.type) {
    case 'weekly': {
      const start = addDaysYmd(ymd, -((weekdayOf(ymd) - cutoff.weekday + 7) % 7));
      return { start, end: addDaysYmd(start, 6) };
    }
    case 'biweekly': {
      const anchor = cutoff.anchor || '2026-01-05';
      const start = addDaysYmd(anchor, Math.floor(daysBetween(anchor, ymd) / 14) * 14);
      return { start, end: addDaysYmd(start, 13) };
    }
    case 'monthly': {
      const start = day >= cutoff.day1 ? onDay(ymd, cutoff.day1) : onDay(shiftMonth(ymd, -1), cutoff.day1);
      return { start, end: addDaysYmd(onDay(shiftMonth(start, 1), cutoff.day1), -1) };
    }
    default: {
      // Two a month: day1 → day2 - 1, then day2 → next month's day1 - 1.
      if (day >= cutoff.day2) return { start: onDay(ymd, cutoff.day2), end: addDaysYmd(onDay(shiftMonth(ymd, 1), cutoff.day1), -1) };
      if (day >= cutoff.day1) return { start: onDay(ymd, cutoff.day1), end: onDay(ymd, cutoff.day2 - 1) };
      return { start: onDay(shiftMonth(ymd, -1), cutoff.day2), end: addDaysYmd(onDay(ymd, cutoff.day1), -1) };
    }
  }
};

/** The whole period of `kind` that contains `ymd` (not capped at today). */
export const periodOf = (kind: PeriodKind, ymd: string, cutoff: CutoffRule = DEFAULT_CUTOFF): Range => {
  if (kind === 'cutoff') return cutoffPeriodOf(cutoff, ymd);
  if (kind === 'week') {
    const start = addDaysYmd(ymd, -((weekdayOf(ymd) + 6) % 7));
    return { start, end: addDaysYmd(start, 6) };
  }
  return monthBounds(ymd);
};

/** The header never goes past today, so neither do the periods. */
export const capAtToday = (range: Range, today: string): Range => ({ start: range.start, end: range.end > today ? today : range.end });

/** Which period the range is (one that is still running ends today), if any. Cutoff first. */
export const kindOf = (range: Range, today: string, cutoff: CutoffRule = DEFAULT_CUTOFF): PeriodKind | null => {
  for (const kind of ['cutoff', 'month', 'week'] as PeriodKind[]) {
    const p = capAtToday(periodOf(kind, range.start, cutoff), today);
    if (p.start === range.start && p.end === range.end) return kind;
  }
  return null;
};

/** The period of the same kind just before (-1) or after (+1) the range. */
export const stepPeriod = (kind: PeriodKind, range: Range, dir: -1 | 1, cutoff: CutoffRule = DEFAULT_CUTOFF): Range => {
  const whole = periodOf(kind, range.start, cutoff);
  return periodOf(kind, dir > 0 ? addDaysYmd(whole.end, 1) : addDaysYmd(whole.start, -1), cutoff);
};

/** "1–15" / "16–end" style label of the cutoff kind, for the button: "Nov 1 – 15". */
export const shortRangeLabel = (range: Range) => {
  const fmt = (ymd: string, withMonth: boolean) =>
    new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', withMonth ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { day: 'numeric', timeZone: 'UTC' });
  const sameMonth = range.start.slice(0, 7) === range.end.slice(0, 7);
  return `${fmt(range.start, true)} – ${fmt(range.end, !sameMonth)}`;
};

export const dayCount = (range: Range) => daysBetween(range.start, range.end) + 1;

export const datesOf = (range: Range): string[] => {
  const out: string[] = [];
  for (let d = range.start; d <= range.end; d = addDaysYmd(d, 1)) out.push(d);
  return out;
};
