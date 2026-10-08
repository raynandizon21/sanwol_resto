import type { MenuRecord } from './menuService';

export type MenuMatchOptions = {
    /** Unit price from receipt (line_total / qty) — boosts match when menu price aligns */
    unitPrice?: number;
};

function normalize(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s/]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Remove spaces/hyphens so "high ball" and "highball" compare equal */
function compact(s: string): string {
    return normalize(s).replace(/[\s\-–—/]+/g, '');
}

/** Strip qty prefixes and embedded unit/line prices from OCR item names before matching */
function stripEmbeddedPricesFromName(name: string): string {
    return String(name ?? '')
        .replace(/^\d+\s*[x×]\s*/i, '')
        .replace(/\b\d{2,5}(?:\.\d{1,2})?\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = a.length;
    const n = b.length;
    const dp = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = dp[0]!;
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const temp = dp[j]!;
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
            prev = temp;
        }
    }
    return dp[n]!;
}

function wordsSimilar(a: string, b: string): boolean {
    if (a === b) return true;
    if (a.length < 3 || b.length < 3) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const maxLen = Math.max(a.length, b.length);
    const dist = levenshtein(a, b);
    if (maxLen <= 5) return dist <= 1;
    if (maxLen <= 8) return dist <= 2;
    return dist / maxLen <= 0.22;
}

/** Recover cocktail/drink tokens split by OCR (e.g. "ma" + "rgarita" → margarita) */
function expandOcrNameTokens(tokens: string[]): string[] {
    const out = new Set(tokens.filter((t) => t.length > 1 && !/^\d+$/.test(t)));
    const joined = [...out].join('');

    const looksLikeMargarita =
        /margar|garita|rgarita/i.test(joined) ||
        (out.has('ma') && /rgarita|garita/i.test(joined)) ||
        (out.has('strawberry') && out.has('ma'));

    if (looksLikeMargarita) {
        out.add('margarita');
        out.delete('ma');
        for (const t of [...out]) {
            if (/rgarita|garita/i.test(t) && t !== 'margarita') out.delete(t);
        }
    }
    if (/smooth/i.test(joined)) out.add('smoothie');
    if (/espresso|capuccino|cappucino/i.test(joined)) out.add('coffee');

    return [...out];
}

/** Unit price hint from line total/qty, or from price printed inside OCR item text (e.g. "MA 490 RGARITA") */
export function resolveReceiptUnitPrice(extractedName: string, lineTotal: number, qty: number): number | undefined {
    const q = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const fromLine = Number(lineTotal);
    const unitFromLine = Number.isFinite(fromLine) && fromLine > 0 ? fromLine / q : 0;

    const embeddedMatch = String(extractedName ?? '').match(/\b(\d{2,5})(?:\.\d{1,2})?\b/);
    const fromName = embeddedMatch ? Number(embeddedMatch[1]) : 0;

    if (unitFromLine > 0 && fromName > 0) {
        const rel = Math.abs(unitFromLine - fromName) / Math.max(fromName, 1);
        if (rel > 0.12) return fromName;
        return unitFromLine;
    }
    if (unitFromLine > 0) return unitFromLine;
    if (fromName > 0) return fromName;
    return undefined;
}

function receiptTokens(extracted: string): string[] {
    const cleaned = stripEmbeddedPricesFromName(extracted);
    const words = normalize(cleaned)
        .split(' ')
        .filter((w) => w.length > 1 && !/^\d+$/.test(w));
    return expandOcrNameTokens(words);
}

function fuzzyCompactScore(extracted: string, menuName: string): number {
    const ca = compact(stripEmbeddedPricesFromName(extracted));
    const cb = compact(menuName);
    if (!ca || !cb) return 0;
    if (ca === cb) return 950;
    if (ca.includes(cb) || cb.includes(ca)) {
        const shorter = Math.min(ca.length, cb.length);
        const longer = Math.max(ca.length, cb.length);
        return 700 + Math.round((shorter / longer) * 150);
    }
    const maxLen = Math.max(ca.length, cb.length);
    if (maxLen < 4) return 0;
    const dist = levenshtein(ca, cb);
    const ratio = 1 - dist / maxLen;
    if (ratio >= 0.88) return Math.round(620 + ratio * 180);
    if (ratio >= 0.75) return Math.round(420 + ratio * 120);
    return 0;
}

function priceMatchBoost(unitPrice: number, menuPrice: number): number {
    if (!Number.isFinite(unitPrice) || unitPrice <= 0 || !Number.isFinite(menuPrice) || menuPrice <= 0) return 0;
    const diff = Math.abs(unitPrice - menuPrice);
    if (diff < 0.01) return 280;
    if (diff <= 1) return 200;
    if (diff / menuPrice <= 0.03) return 150;
    if (diff / menuPrice <= 0.08) return 80;
    return 0;
}

/** Penalize menu rows whose price is far from the receipt unit price */
function priceMismatchPenalty(unitPrice: number, menuPrice: number): number {
    if (!Number.isFinite(unitPrice) || unitPrice <= 0 || !Number.isFinite(menuPrice) || menuPrice <= 0) return 0;
    const diff = Math.abs(unitPrice - menuPrice);
    if (diff < 0.01) return 0;
    const ratio = diff / Math.max(unitPrice, menuPrice);
    if (ratio >= 0.35) return 220;
    if (ratio >= 0.2) return 120;
    if (ratio >= 0.12) return 60;
    return 0;
}

function nameVariants(extractedName: string): string[] {
    const t = extractedName.trim();
    if (!t) return [];
    const stripped = stripEmbeddedPricesFromName(t);
    const parts = stripped
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean);
    const base = parts.length ? parts : [stripped || t];
    const out = new Set<string>(base);
    for (const v of base) {
        const noLeadingQty = v.replace(/^\d+\s*[x×]\s*/i, '').trim();
        if (noLeadingQty) out.add(stripEmbeddedPricesFromName(noLeadingQty));
        const hyphenAsSpace = v.replace(/\s*[-–—]\s*/g, ' ').replace(/\s+/g, ' ').trim();
        if (hyphenAsSpace) out.add(stripEmbeddedPricesFromName(hyphenAsSpace));
    }
    return [...out];
}

function tokenMatchesMenuWord(token: string, menuWord: string): boolean {
    return wordsSimilar(token, menuWord);
}

function scoreMatch(extracted: string, menuName: string, menuPrice: number, unitPrice?: number): number {
    const a = normalize(stripEmbeddedPricesFromName(extracted));
    const b = normalize(menuName);
    if (!a || !b) return 0;

    const priceBoost = unitPrice ? priceMatchBoost(unitPrice, menuPrice) : 0;
    const pricePenalty = unitPrice ? priceMismatchPenalty(unitPrice, menuPrice) : 0;

    if (a === b) return 1000 + priceBoost - pricePenalty;

    const wa = receiptTokens(extracted);
    const wbList = b.split(' ').filter((w) => w.length > 1);
    const wb = new Set(wbList);

    const matchedExtracted = wa.filter((t) => wbList.some((mw) => tokenMatchesMenuWord(t, mw)));
    const hasAllExtractedWords = wa.length > 0 && matchedExtracted.length === wa.length;
    if (hasAllExtractedWords) {
        const extraWordCount = Math.max(0, wbList.length - wa.length);
        const extraMenuWords = wbList.filter((mw) => !wa.some((t) => tokenMatchesMenuWord(t, mw)));
        const extraAsciiWordCount = extraMenuWords.filter((w) => /^[a-z0-9]+$/i.test(w)).length;
        const startsWithExact = b.startsWith(`${a} `) ? 1 : 0;
        let score = 820 + startsWithExact * 20 - extraWordCount * 15 - extraAsciiWordCount * 35;
        score += priceBoost - pricePenalty;
        return score;
    }

    const compactScore = fuzzyCompactScore(extracted, menuName);
    if (compactScore >= 650) {
        return compactScore + priceBoost - pricePenalty;
    }

    if (a.includes(b) || b.includes(a)) {
        return 500 + priceBoost - pricePenalty;
    }

    let overlap = 0;
    for (const t of wa) {
        if (wbList.some((mw) => tokenMatchesMenuWord(t, mw))) overlap += 1;
    }
    let score = overlap * 100;
    if (compactScore > score) score = compactScore;
    score += priceBoost - pricePenalty;
    return score;
}

/** Pick best menu row for a receipt line; returns null if no decent match. */
export function bestMenuMatchForReceiptLine(
    extractedName: string,
    menus: MenuRecord[],
    options?: MenuMatchOptions
): MenuRecord | null {
    const unitPrice =
        options?.unitPrice ??
        resolveReceiptUnitPrice(extractedName, 0, 1);

    const variants = nameVariants(extractedName);
    let best: MenuRecord | null = null;
    let bestScore = 0;
    let bestNameScore = 0;
    for (const m of menus) {
        if (!m.active || !(m.effectiveAvailable ?? m.isAvailable)) continue;
        for (const part of variants) {
            const nameScore = scoreMatch(part, m.name, Number(m.price) || 0);
            const fullScore = scoreMatch(part, m.name, Number(m.price) || 0, unitPrice);
            if (fullScore > bestScore) {
                bestScore = fullScore;
                bestNameScore = Math.max(bestNameScore, nameScore);
                best = m;
            }
        }
    }
    // Require name similarity — receipt price alone must not pick an unrelated menu row.
    if (bestNameScore >= 80) return best;
    if (bestNameScore >= 35 && unitPrice && unitPrice > 0 && bestScore >= 45) return best;
    return null;
}

/** True when menuId is the same match the auto-mapper would choose for this line. */
export function isReceiptLineMappedToMenu(
    extractedName: string,
    lineTotal: number,
    qty: number,
    menuId: string | null,
    menus: MenuRecord[]
): boolean {
    if (!menuId) return false;
    const match = matchReceiptLineToMenu(extractedName, lineTotal, qty, menus);
    return match != null && String(match.id) === String(menuId);
}

/** Re-score all receipt rows after menus load or when OCR names differ per batch */
export function matchReceiptLineToMenu(
    extractedName: string,
    lineTotal: number,
    qty: number,
    menus: MenuRecord[]
): MenuRecord | null {
    const unitPrice = resolveReceiptUnitPrice(extractedName, lineTotal, qty);
    return bestMenuMatchForReceiptLine(extractedName, menus, { unitPrice });
}
