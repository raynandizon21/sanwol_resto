const authHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
};

export type ReceiptOrderItemNormalized = {
    item_name: string;
    quantity: number;
    menu_selection: string;
    line_price: number;
    order_id: number;
};

export type ReceiptOrderGroup = {
    order_id: number;
    order_no: string;
    order_type: 'DINE_IN' | 'TAKE_OUT' | 'DELIVERY';
    table_no?: string;
    order_total_amount: number;
    items: {
        item_name: string;
        quantity: number;
        menu_selection: string;
        line_price: number;
    }[];
};

export type ReceiptOrderExtractionResult = {
    orders: ReceiptOrderGroup[];
    items: ReceiptOrderItemNormalized[];
    receipt_grand_total: number;
    extracted_items_sum: number;
    math_match: boolean;
};

function cleanExtractedOrderName(input: string): string {
    const raw = String(input ?? '')
        .replace(/^[\s\-–—*#\[\](){}|]+/, '')
        .replace(/^\d+\s+/, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';
    return raw.replace(/[^\p{L}\p{N}\s/&.+-]/gu, '').replace(/\s+/g, ' ').trim();
}

function cleanMenuSelection(input: string): string {
    const t = String(input ?? '').trim();
    if (!t) return '';
    return t.replace(/\s+/g, ' ').trim();
}

function isJunkLineName(n: string): boolean {
    const lower = n.toLowerCase();
    if (!lower) return true;
    if (
        lower.includes('total amount') ||
        lower.includes('vatable') ||
        lower.includes('vat amount') ||
        lower.includes('vat exempt') ||
        lower.includes('zero-rated') ||
        lower.includes('balance due') ||
        lower.includes('cashier') ||
        lower.includes('transaction') ||
        lower.includes('sold to') ||
        lower === 'cash' ||
        lower === 'change'
    ) {
        return true;
    }
    return false;
}

function cleanTableNoFromReceipt(input: string): string {
    let s = String(input ?? '').trim();
    if (!s) return '';
    const m = s.match(/^table\s*:\s*(.+)$/i);
    if (m) s = m[1].trim();
    return s.replace(/\s+/g, ' ').trim();
}

function parseLocalYmd(ymd: string | undefined): { y: number; m: number; d: number } | null {
    const s = String(ymd ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map((x) => Number(x));
    if (!Number.isFinite(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { y, m, d };
}

/** ORD-YYYYMMDD-HHMMSS: date from user-selected order day (or today); time from scan moment (staggered per block). Ignores receipt-printed numbers so old years (e.g. 2014) never appear. */
function buildSystemOrderNumbers(count: number, orderDateYmd: string | undefined): string[] {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const parsed = parseLocalYmd(orderDateYmd);
    const now = new Date();
    const y = parsed?.y ?? now.getFullYear();
    const mo = parsed?.m ?? now.getMonth() + 1;
    const d = parsed?.d ?? now.getDate();
    const out: string[] = [];
    const used = new Set<string>();
    let offset = 0;
    for (let i = 0; i < count; i++) {
        let t = new Date(now.getTime() + offset * 1000);
        let no = `ORD-${y}${pad2(mo)}${pad2(d)}-${pad2(t.getHours())}${pad2(t.getMinutes())}${pad2(t.getSeconds())}`;
        while (used.has(no)) {
            offset += 1;
            t = new Date(now.getTime() + offset * 1000);
            no = `ORD-${y}${pad2(mo)}${pad2(d)}-${pad2(t.getHours())}${pad2(t.getMinutes())}${pad2(t.getSeconds())}`;
        }
        used.add(no);
        out.push(no);
        offset += 1;
    }
    return out;
}

function normalizeOrderType(input: string): 'DINE_IN' | 'TAKE_OUT' | 'DELIVERY' {
    const t = String(input ?? '')
        .trim()
        .toUpperCase();
    if (!t) return 'DINE_IN';
    if (t.includes('DELIVER')) return 'DELIVERY';
    if (t.includes('TAKE') || t.includes('TO GO') || t.includes('TO-GO') || t.includes('PICKUP')) return 'TAKE_OUT';
    if (t === 'DELIVERY' || t === 'TAKE_OUT' || t === 'DINE_IN') return t as 'DINE_IN' | 'TAKE_OUT' | 'DELIVERY';
    if (t.includes('DINE')) return 'DINE_IN';
    return 'DINE_IN';
}

/**
 * Extract sold line items from a customer / POS receipt image (orders flow).
 * Returns grouped `orders` plus flattened `items` for mapping UI.
 */
export type ExtractOrderLinesFromReceiptOptions = {
    /** YYYY-MM-DD from the order form; drives the date segment of ORD-YYYYMMDD-HHMMSS. */
    orderDateYmd?: string;
};

export async function extractOrderLinesFromReceiptImage(
    imageDataUrl: string,
    /** Kept for backwards compatibility; server-side analyzer does not need this. */
    apiKey?: string,
    options?: ExtractOrderLinesFromReceiptOptions
): Promise<ReceiptOrderExtractionResult> {
    const base64 = String(imageDataUrl ?? '').trim();
    if (!base64) throw new Error('Invalid image data');

    const prompt = `You extract restaurant or retail POS receipts into JSON for order entry.

The image may be one long stitched receipt (multiple photos). Read top to bottom completely.

GROUPED ORDERS (critical):
- Identify distinct order sessions or logical groups: repeated headers, dashed dividers, separate "Total Amount" / transaction blocks, timestamps, table or ticket changes, or natural blank gaps.
- Output an array called "orders". Each element is ONE order block in reading order.
- order_id must be 1, 2, 3, ... in the order they appear on the receipt.
- Do not merge lines from different order blocks.

Each order object must have:
- order_id (integer, 1-based, in appearance order)
- order_no (string): receipt order number if found; if missing, generate with format ORD-YYYYMMDD-HHMMSS. If one scan has multiple blocks, make each order_no unique.
- order_type (string): "Dine in", "Take out", or "Delivery". Default to "Dine in" if unclear.
- table_no (string, optional): table number/label if shown (value only, e.g. "12", "VIP-2", "Take out_1"). If missing, output empty string.
- items: array of line items belonging only to that order
- order_total_amount: sum of that block's line_price values (decimals only). Compute this yourself.

Each line item must have:
- item_name: text AS PRINTED in the item column (do not translate or rename). If a name is split across two lines on the receipt, combine into one item_name.
- quantity: number (if not shown, use 1)
- menu_selection: modifiers printed on the receipt for that line — size, set meal choice, add-ons, variant, or empty string "" if none
- line_price: final extended price for that line only (number, no currency symbols)

Global rules:
- Include EVERY food, drink, and merchandise line in each order block. Do not skip or merge distinct items.
- Include food, drinks, and packaged goods sold. Exclude store boilerplate, TIN, cashier-only lines, payment/change lines, and standalone tax-only lines unless they are a real product line.
- Numbers: decimals only; no "P", "Php", "₱", or letters in numeric fields.
- receipt_grand_total: if the receipt shows one overall total, use it; if multiple separate transactions with separate totals, use the sum of those transaction totals (or sum of order_total_amount if that matches the print).
- extracted_items_sum: sum of every line_price across all orders.
- math_match: true if extracted_items_sum equals receipt_grand_total within 2 (rounding).

Extract only from merchandise line rows (typically between ITEM/QTY/PRICE column headers and the block's subtotal/total lines).`;
    // Use backend Vertex AI analyzer (prevents Gemini 429 client-side).
    const res = await fetch(`${window.location.origin}/data-api/api/receiptscanner/analyze-orders`, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
        },
        body: JSON.stringify({
            base64,
            // prompt is generated server-side today; keep here for possible future extension
            prompt,
            orderDateYmd: options?.orderDateYmd,
        }),
    });
    const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { orders?: unknown; receipt_grand_total?: number; extracted_items_sum?: number; math_match?: boolean };
        error?: string;
    };
    if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error || 'Failed to analyze receipt for orders');
    }
    const parsed = json.data;

    if (!Array.isArray(parsed.orders) || parsed.orders.length === 0) {
        throw new Error('Invalid extraction result: no orders.');
    }

    const normalizedOrders: ReceiptOrderGroup[] = [];
    for (const rawOrder of parsed.orders) {
        const ro = rawOrder as {
            order_id?: number;
            order_no?: string;
            order_type?: string;
            table_no?: string;
            items?: unknown;
            order_total_amount?: number;
        };

        const rawItems = Array.isArray(ro.items) ? ro.items : [];
        const cleanedItems: ReceiptOrderGroup['items'] = [];
        for (const raw of rawItems) {
            const it = raw as {
                item_name?: string;
                quantity?: number;
                menu_selection?: string;
                line_price?: number;
            };
            const item_name = cleanExtractedOrderName(String(it.item_name ?? '')) || String(it.item_name ?? '').trim();
            if (!item_name || isJunkLineName(item_name)) continue;
            const quantity = Number(it.quantity);
            const q = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
            const line_price = Number(it.line_price);
            const lp = Number.isFinite(line_price) ? line_price : 0;
            cleanedItems.push({
                item_name,
                quantity: q,
                menu_selection: cleanMenuSelection(String(it.menu_selection ?? '')),
                line_price: lp,
            });
        }
        if (cleanedItems.length === 0) continue;

        normalizedOrders.push({
            order_id: 0,
            order_no: String(ro.order_no ?? '').trim(),
            order_type: normalizeOrderType(String(ro.order_type ?? 'DINE_IN')),
            table_no: cleanTableNoFromReceipt(String(ro.table_no ?? '')),
            items: cleanedItems,
            order_total_amount: 0,
        });
    }

    if (normalizedOrders.length === 0) {
        throw new Error('Invalid extraction result: no line items.');
    }

    const systemOrderNos = buildSystemOrderNumbers(normalizedOrders.length, options?.orderDateYmd);
    const renumbered = normalizedOrders.map((o, idx) => {
        const orderNo = systemOrderNos[idx]!;
        const sumLines = o.items.reduce((s, x) => s + x.line_price, 0);
        return {
            order_id: idx + 1,
            order_no: orderNo,
            order_type: o.order_type,
            table_no: o.table_no || '',
            items: o.items.map((it) => ({ ...it })),
            order_total_amount: sumLines,
        };
    });

    const flat: ReceiptOrderItemNormalized[] = [];
    for (const o of renumbered) {
        for (const it of o.items) {
            flat.push({
                item_name: it.item_name,
                quantity: it.quantity,
                menu_selection: it.menu_selection,
                line_price: it.line_price,
                order_id: o.order_id,
            });
        }
    }

    const recomputedSum = flat.reduce((s, i) => s + i.line_price, 0);
    const receiptGrand = Number(parsed.receipt_grand_total);
    let receipt_grand_total = Number.isFinite(receiptGrand) && receiptGrand > 0 ? receiptGrand : recomputedSum;
    if (renumbered.length > 1) {
        receipt_grand_total = recomputedSum;
    }
    const extracted_items_sum = recomputedSum;
    const math_match = Math.abs(receipt_grand_total - extracted_items_sum) <= 2;

    return {
        orders: renumbered,
        items: flat,
        receipt_grand_total,
        extracted_items_sum,
        math_match,
    };
}
