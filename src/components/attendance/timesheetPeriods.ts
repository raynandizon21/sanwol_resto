// Periods for the Timesheet tab's buttons and the Schedules page's Print / PDF: the cutoff (fixed
// since 2026-11-06: the 1st–15th and the 16th–end of the month), a week (Monday to Sunday) and a
// month. Pure; no timezone.

import { addDaysYmd, monthBounds, weekdayOf } from './attendanceShared';

export type Range = { start: string; end: string };

export type PeriodKind = 'cutoff' | 'week' | 'month';

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The cutoff that contains `ymd`: the 1st–15th or the 16th–end of its month (not capped at today). */
export const cutoffPeriodOf = (ymd: string): Range => {
  const month = monthBounds(ymd);
  return Number(ymd.slice(8)) <= 15
    ? { start: month.start, end: `${ymd.slice(0, 8)}15` }
    : { start: `${ymd.slice(0, 8)}16`, end: month.end };
};

/** The cutoffs that overlap a range, in order (a month has two; a week one or two). */
export const cutoffsIn = (range: Range): Range[] => {
  const out: Range[] = [];
  for (let p = cutoffPeriodOf(range.start); p.start <= range.end; p = cutoffPeriodOf(addDaysYmd(p.end, 1))) out.push(p);
  return out;
};

/** The whole period of `kind` that contains `ymd` (not capped at today). */
export const periodOf = (kind: PeriodKind, ymd: string): Range => {
  if (kind === 'cutoff') return cutoffPeriodOf(ymd);
  if (kind === 'week') {
    const start = addDaysYmd(ymd, -((weekdayOf(ymd) + 6) % 7));
    return { start, end: addDaysYmd(start, 6) };
  }
  return monthBounds(ymd);
};

/** The header never goes past today, so neither do the periods. */
export const capAtToday = (range: Range, today: string): Range => ({ start: range.start, end: range.end > today ? today : range.end });

/** Which period the range is (one that is still running ends today), if any. Cutoff first. */
export const kindOf = (range: Range, today: string): PeriodKind | null => {
  for (const kind of ['cutoff', 'month', 'week'] as PeriodKind[]) {
    const p = capAtToday(periodOf(kind, range.start), today);
    if (p.start === range.start && p.end === range.end) return kind;
  }
  return null;
};

/** The period of the same kind just before (-1) or after (+1) the range. */
export const stepPeriod = (kind: PeriodKind, range: Range, dir: -1 | 1): Range => {
  const whole = periodOf(kind, range.start);
  return periodOf(kind, dir > 0 ? addDaysYmd(whole.end, 1) : addDaysYmd(whole.start, -1));
};

/** A short label for a period, for the buttons: "Nov 1 – 15", "Oct 27 – Nov 2". */
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
