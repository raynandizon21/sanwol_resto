/**
 * Per-branch "business day" cutoff (Manila hour a business day starts).
 *
 * A branch whose shift crosses midnight (e.g. trades 3PM -> 6AM) would otherwise
 * have an order taken at 12:30AM reported under the *next* calendar date. With
 * `{ <branchId>: 7 }` the business day of 2026-10-06 runs 2026-10-06 07:00 ->
 * 2026-10-07 06:59:59 (PH). Stored timestamps are never altered — only how
 * rows are bucketed into days. Every other branch keeps the calendar day.
 * Empty = no branch has a cutoff.
 *
 * Keep in sync with server/utils/businessDay.js and pyserver/business_day.py.
 *
 * Pure data + lookup only (no imports) so manilaDateTime.ts can depend on it;
 * the date helpers that need Manila formatting live in manilaDateTime.ts
 * (getBusinessTodayYmd, getBusinessYmdFromEncoded).
 */
export const BUSINESS_DAY_START_HOURS: Readonly<Record<number, number>> = {};

export const HOUR_MS = 60 * 60 * 1000;

/** Hour the business day starts for a branch; 0 (plain calendar day) for everyone else, incl. 'all'. */
export function businessDayStartHour(branchId: string | number | null | undefined): number {
  if (branchId == null || branchId === '' || branchId === 'all') return 0;
  const hour = BUSINESS_DAY_START_HOURS[Number(branchId)];
  return Number.isInteger(hour) ? hour : 0;
}
