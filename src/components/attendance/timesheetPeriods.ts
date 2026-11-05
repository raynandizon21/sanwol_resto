// Periods for the Timesheet tab's cutoff buttons (pure; no timezone involved).

import { addDaysYmd, monthBounds, shiftMonth, weekdayOf } from './attendanceShared';

export type Range = { start: string; end: string };

/** A week runs Monday to Sunday; 1–15 and 16–end are the usual semi-monthly cutoffs. */
export type PeriodKind = 'week' | 'first_half' | 'second_half' | 'month';

/** The whole period of `kind` that contains `ymd` (not capped at today). */
export const periodOf = (kind: PeriodKind, ymd: string): Range => {
  const month = monthBounds(ymd);
  switch (kind) {
    case 'week': {
      const start = addDaysYmd(ymd, -((weekdayOf(ymd) + 6) % 7));
      return { start, end: addDaysYmd(start, 6) };
    }
    case 'first_half':
      return { start: month.start, end: `${ymd.slice(0, 8)}15` };
    case 'second_half':
      return { start: `${ymd.slice(0, 8)}16`, end: month.end };
    default:
      return month;
  }
};

/** The header never goes past today, so neither do the periods. */
export const capAtToday = (range: Range, today: string): Range => ({ start: range.start, end: range.end > today ? today : range.end });

/** Which period the range is (a period that is still running ends today), if any. */
export const kindOf = (range: Range, today: string): PeriodKind | null => {
  for (const kind of ['first_half', 'second_half', 'month', 'week'] as PeriodKind[]) {
    const p = capAtToday(periodOf(kind, range.start), today);
    if (p.start === range.start && p.end === range.end) return kind;
  }
  return null;
};

/** The period before (-1) or after (+1): halves step through 1–15, 16–end, next 1–15… */
export const stepPeriod = (kind: PeriodKind, range: Range, dir: -1 | 1): Range => {
  switch (kind) {
    case 'week':
      return periodOf('week', addDaysYmd(range.start, 7 * dir));
    case 'first_half':
      return dir > 0 ? periodOf('second_half', range.start) : periodOf('second_half', shiftMonth(range.start, -1));
    case 'second_half':
      return dir > 0 ? periodOf('first_half', shiftMonth(range.start, 1)) : periodOf('first_half', range.start);
    default:
      return periodOf('month', shiftMonth(range.start, dir));
  }
};

export const dayCount = (range: Range) =>
  Math.round((Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000) + 1;

export const datesOf = (range: Range): string[] => {
  const out: string[] = [];
  for (let d = range.start; d <= range.end; d = addDaysYmd(d, 1)) out.push(d);
  return out;
};
