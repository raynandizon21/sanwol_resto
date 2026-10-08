import { businessDayStartHour, HOUR_MS } from './businessDay';

/** Asia/Manila helpers for ENCODED_DT parsing, display, and date-range filtering. */

export const MANILA_TIMEZONE = 'Asia/Manila';
const MANILA_UTC_OFFSET_HOURS = 8;

export function parseManilaLocalDateTimeToUtcMs(value: string): number | null {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?$/);
    if (!m) return null;

    const year = Number(m[1]);
    const monthIndex = Number(m[2]) - 1;
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6]);
    const ms = m[7] ? Number(m[7].slice(1).padEnd(3, '0').slice(0, 3)) : 0;

    return Date.UTC(
        year,
        monthIndex,
        day,
        hour - MANILA_UTC_OFFSET_HOURS,
        minute,
        second,
        ms,
    );
}

export function parseEncodedDtToUtcMs(encoded: string): number | null {
    if (!encoded) return null;

    if (/[zZ]$/.test(encoded) || /[+-]\d{2}:?\d{2}$/.test(encoded)) {
        const d = new Date(encoded);
        return Number.isNaN(d.getTime()) ? null : d.getTime();
    }

    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(encoded)) {
        const manilaMs = parseManilaLocalDateTimeToUtcMs(encoded);
        if (manilaMs != null) return manilaMs;
    }

    const d = new Date(encoded.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function formatUtcMsToManilaYmd(utcMs: number): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: MANILA_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
}

export function getManilaYmdFromEncoded(encoded: string): string | null {
    const utcMs = parseEncodedDtToUtcMs(encoded);
    if (utcMs == null) return null;
    return formatUtcMsToManilaYmd(utcMs);
}

export function formatEncodedDt(encoded: string | null | undefined): string {
    if (!encoded) return '—';
    const utcMs = parseEncodedDtToUtcMs(encoded);
    if (utcMs == null) return '—';

    return new Intl.DateTimeFormat(undefined, {
        timeZone: MANILA_TIMEZONE,
        dateStyle: 'short',
        timeStyle: 'short',
    }).format(new Date(utcMs));
}

/**
 * YYYY-MM-DD business day (Asia/Manila) an ENCODED_DT belongs to for a branch. Branches without a
 * cutoff (see businessDay.ts) get exactly getManilaYmdFromEncoded().
 */
export function getBusinessYmdFromEncoded(
    encoded: string | null | undefined,
    branchId?: string | number | null,
): string | null {
    if (!encoded) return null;
    const utcMs = parseEncodedDtToUtcMs(encoded);
    if (utcMs == null) return null;
    return formatUtcMsToManilaYmd(utcMs - businessDayStartHour(branchId) * HOUR_MS);
}

/** Business "today" (YYYY-MM-DD, Asia/Manila) for a branch; plain Manila today when it has no cutoff. */
export function getBusinessTodayYmd(
    branchId?: string | number | null,
    now: Date = new Date(),
): string {
    return formatUtcMsToManilaYmd(now.getTime() - businessDayStartHour(branchId) * HOUR_MS);
}

/**
 * `branchId` is the branch the row belongs to. Cutoff-branch rows are compared by business day so a
 * 12:30AM order stays inside the previous day's range (matching the server); omit it, or pass any
 * other branch, for the unchanged calendar-day comparison.
 */
export function isEncodedDtWithinDateRange(
    encoded: string | null | undefined,
    dateRange: { start: string; end: string },
    branchId?: string | number | null,
): boolean {
    if (!encoded) return true;
    if (!dateRange.start || !dateRange.end) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRange.start) || !/^\d{4}-\d{2}-\d{2}$/.test(dateRange.end)) {
        return true;
    }

    const manilaYmd = getBusinessYmdFromEncoded(encoded, branchId);
    if (manilaYmd == null) return true;
    return manilaYmd >= dateRange.start && manilaYmd <= dateRange.end;
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar YYYY-MM-DD for "now" in Asia/Manila (not the browser's local TZ). */
export function getManilaTodayYmd(now: Date = new Date()): string {
    return formatUtcMsToManilaYmd(now.getTime());
}

/**
 * Month-to-date in Asia/Manila: 1st of Manila month → Manila today.
 * Keeps all users on the same default range regardless of PC clock/TZ.
 */
export function getManilaMonthToDateRange(now: Date = new Date()): { start: string; end: string } {
    const end = getManilaTodayYmd(now);
    const [y, m] = end.split('-');
    return { start: `${y}-${m}-01`, end };
}

/**
 * Parse YYYY-MM-DD as a local-calendar Date (noon avoided; local midnight).
 * Do NOT use `new Date('YYYY-MM-DD')` — that is UTC midnight and shifts the day in western TZs.
 */
export function parseYmdToLocalDate(ymd: string): Date | null {
    const m = YMD_RE.exec(String(ymd || '').trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const date = new Date(y, mo - 1, d);
    if (Number.isNaN(date.getTime()) || date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
        return null;
    }
    return date;
}

/** Format a DatePicker/local Date back to YYYY-MM-DD using local calendar parts. */
export function formatDateToLocalYmd(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Display YYYY-MM-DD without UTC parse shift (matches the stored calendar day). */
export function formatYmdDisplay(ymd: string, locale = 'en-US'): string {
    const d = parseYmdToLocalDate(ymd);
    if (!d) return ymd;
    return d.toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
}
