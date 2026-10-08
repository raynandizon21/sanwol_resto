const path = require('path');

const VERTEX_PROJECT_ID = 'core-api-495501';
const VERTEX_LOCATION_PRIMARY = process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_LOCATION_FALLBACK = 'global';

const MODEL_CANDIDATES = process.env.VERTEX_GEMINI_MODEL
  ? [process.env.VERTEX_GEMINI_MODEL.trim()].filter(Boolean)
  : ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite-001'];

const SERVICE_ACCOUNT_KEY_PATH = path.resolve(__dirname, '..', '..', 'core-api-495501-4096e683bc08.json');

const ORDER_NO_PATTERN = /^ORD-\d{8}-\d{6}$/;

/** Long expense receipts need a high ceiling so JSON is not cut mid-array (env override). */
function expenseMaxOutputTokens() {
  const n = Number.parseInt(String(process.env.RECEIPT_EXPENSE_MAX_OUTPUT_TOKENS ?? '12288'), 10);
  if (Number.isFinite(n) && n >= 2048) return Math.min(n, 32768);
  return 12288;
}

/** Vertex structured output for expense analyze — reduces invalid / half-escaped JSON from the model. */
function buildExpenseReceiptResponseSchema(SchemaType) {
  return {
    type: SchemaType.OBJECT,
    properties: {
      items: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            qty: { type: SchemaType.NUMBER },
            name: { type: SchemaType.STRING },
            price: { type: SchemaType.NUMBER },
            category: { type: SchemaType.STRING },
            unit: { type: SchemaType.STRING },
          },
          required: ['qty', 'name', 'price', 'category', 'unit'],
        },
      },
      receipt_grand_total: { type: SchemaType.NUMBER },
    },
    required: ['items', 'receipt_grand_total'],
  };
}

/**
 * Vertex SDK sometimes throws SyntaxError for bad JSON; map to RECEIPT_MODEL_JSON_PARSE so clients get 422.
 * @param {unknown} err
 */
function normalizeReceiptModelJsonError(err) {
  if (!err || typeof err !== 'object') return err;
  if (err.code === 'RECEIPT_MODEL_JSON_PARSE') return err;
  const msg = String(err.message ?? err ?? '');
  const looksLikeJsonParse =
    err instanceof SyntaxError ||
    /invalid json|after array element in json|expected[\s\S]{0,120}array element|expected property name|unexpected token|bad control character|unterminated string/i.test(
      msg
    ) ||
    /\bJSON\b.*\b(position|line)\b/i.test(msg);
  if (!looksLikeJsonParse) return err;
  const e = new Error(msg.startsWith('Invalid JSON') ? msg : `Invalid JSON: ${msg}`);
  e.code = 'RECEIPT_MODEL_JSON_PARSE';
  if (typeof err.rawModelText === 'string') e.rawModelText = err.rawModelText;
  return e;
}

/** @param {string} input raw base64 or data URL */
function parseImageInput(input) {
  const s = String(input ?? '').trim();
  if (!s) return { mimeType: 'image/jpeg', data: '' };
  const m = s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
  if (m) return { mimeType: m[1].toLowerCase(), data: m[2].trim() };
  return { mimeType: 'image/jpeg', data: s };
}

function extractJsonObject(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  return s.slice(first, last + 1);
}

/** First complete `{ ... }` by brace depth (ignores `{`/`}` inside strings). Safer than first-{ to last-} when extra text or two objects are concatenated. */
function extractBalancedJsonObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Strip ```json / ``` fences the model sometimes adds despite JSON mode. */
function stripMarkdownCodeFences(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/^\s*```(?:json|JSON)?\s*\r?\n?/i, '');
  s = s.replace(/\r?\n?\s*```\s*$/i, '');
  return s.trim();
}

/** First ```json ... ``` block anywhere in the text (non-greedy), if present. */
function extractFencedJson(text) {
  const m = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (!m?.[1]) return null;
  const inner = m[1].trim();
  return inner || null;
}

/**
 * Parse model text as JSON: trim, strip fences, prefer substring from first "{" to last "}".
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function parseModelJsonResponse(rawText) {
  const raw = String(rawText ?? '').trim();
  let s = extractFencedJson(raw) || stripMarkdownCodeFences(raw);
  if (!s) s = raw;
  if (!s) {
    return { ok: false, error: 'Empty model response' };
  }
  const objectSlice = extractBalancedJsonObject(s) || extractJsonObject(s) || s;
  try {
    return { ok: true, value: JSON.parse(objectSlice) };
  } catch (e1) {
    if (objectSlice !== s) {
      try {
        return { ok: true, value: JSON.parse(s) };
      } catch (e2) {
        return {
          ok: false,
          error: `Invalid JSON: ${e2?.message || e1?.message || 'parse failed'}`,
        };
      }
    }
    return { ok: false, error: `Invalid JSON: ${e1?.message || 'parse failed'}` };
  }
}

/**
 * @param {{ ok: false, error: string }} parseResult
 * @param {string} [rawText]
 * @param {string} [extraHint]
 */
function throwInvalidModelJson(parseResult, rawText = '', extraHint = '') {
  const base = parseResult.error || 'Model returned invalid JSON';
  const msg = [base, extraHint].filter(Boolean).join(' ').trim();
  const e = new Error(msg);
  e.code = 'RECEIPT_MODEL_JSON_PARSE';
  e.rawModelText = typeof rawText === 'string' ? rawText : '';
  throw e;
}

function isVertexNotFound(err) {
  const msg = String(err?.message ?? err ?? '');
  return /404|NOT_FOUND|not found|Publisher Model/i.test(msg);
}

function wrapVertexClientError(err) {
  const msg = String(err?.message ?? err ?? '');
  if (
    /billing|quota|exceed|permission|denied|unauth|not enabled|RESOURCE_EXHAUSTED|PERMISSION_DENIED|UNAUTHENTICATED|credits are depleted/i.test(
      msg
    )
  ) {
    const e = new Error(`Vertex AI request failed: ${msg}`);
    e.code = 'VERTEX_AUTH_BILLING';
    throw e;
  }
  throw err;
}

/**
 * @param {{ mimeType: string, data: string }} image
 * @param {string} prompt
 * @param {{ maxOutputTokens?: number, expenseStructuredJson?: boolean }} [opts]
 * @returns {Promise<{ text: string, finishReason: string }>}
 */
async function vertexGenerateTextFromImage(image, prompt, opts = {}) {
  const maxOutputTokens = opts.maxOutputTokens ?? 4096;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT_KEY_PATH;
  }

  const { VertexAI, SchemaType } = await import('@google-cloud/vertexai');

  const locationOrder =
    process.env.VERTEX_LOCATION && String(process.env.VERTEX_LOCATION).trim()
      ? [String(process.env.VERTEX_LOCATION).trim()]
      : [VERTEX_LOCATION_PRIMARY, VERTEX_LOCATION_FALLBACK].filter((loc, i, arr) => arr.indexOf(loc) === i);

  let lastErr = null;
  for (const location of locationOrder) {
    const vertex = new VertexAI({ project: VERTEX_PROJECT_ID, location });
    for (const modelId of MODEL_CANDIDATES) {
      try {
        const generationConfig = {
          temperature: opts.expenseStructuredJson ? 0 : 0.2,
          maxOutputTokens,
          responseMimeType: 'application/json',
          ...(opts.expenseStructuredJson ? { responseSchema: buildExpenseReceiptResponseSchema(SchemaType) } : {}),
        };

        const model = vertex.getGenerativeModel({
          model: modelId,
          generationConfig,
        });

        const resp = await model.generateContent({
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                { inlineData: { mimeType: image.mimeType, data: image.data } },
              ],
            },
          ],
        });

        const candidate = resp?.response?.candidates?.[0];
        const finishReason = String(candidate?.finishReason ?? '');
        const text =
          candidate?.content?.parts
            ?.map((p) => p?.text)
            .filter(Boolean)
            .join('\n') ?? '';

        if (!text) throw new Error('No text response from Vertex model');
        return { text, finishReason };
      } catch (e) {
        lastErr = e;
        if (isVertexNotFound(e)) continue;
        wrapVertexClientError(e);
      }
    }
  }

  if (lastErr) {
    const hint =
      'No Vertex publisher model matched. Set VERTEX_LOCATION=global or VERTEX_GEMINI_MODEL to an id from Model Garden (e.g. gemini-2.5-flash).';
    const wrapped = new Error(`${String(lastErr?.message ?? lastErr)}\n${hint}`);
    wrapped.code = 'VERTEX_MODEL_NOT_FOUND';
    throw wrapped;
  }
  throw new Error('Vertex generation failed with no response');
}

// ---- Expense-style receipt (merchant / items / total / tax) ----

/**
 * @param {string} base64 base64 string (raw or data URL)
 */
async function analyzeReceipt(base64, categories) {
  const image = parseImageInput(base64);
  const empty = { items: [], receipt_grand_total: 0, extracted_items_sum: 0, math_match: true };
  if (!image.data) return empty;

  try {
    const safeCats = Array.isArray(categories) ? categories.map((c) => String(c).trim()).filter(Boolean) : [];
    const catList = safeCats.length ? safeCats.join(', ') : 'Others';
    const prompt = `Extract items from the receipt. Output ONLY valid raw JSON.
Do not include markdown tags, comments, or explanations.
Ensure all strings are properly escaped, especially if they contain special characters or currency symbols like ₱.
If a value is uncertain, provide a best guess based on the visual data but maintain JSON structure.
The receipt may be long. Ensure the JSON is complete and all brackets are closed.
Do not include any text before or after the JSON object.
If an item name has special characters or quotes, escape them properly for JSON strings.

JSON schema:
{
  "items": [{"qty": number, "name": string, "price": number, "category": string, "unit": string}],
  "receipt_grand_total": number
}

Rules:
- "price" is the final extended line price for that item (not unit price).
- If qty is missing, use 1.
- "unit": use short code like PCS, KG, G, ML, L, BOX, PACK, CAN, BTL. If unknown, use PCS.
- "category" MUST be exactly one of: ${catList}
- Numbers must be plain decimals (no currency symbols in numeric fields; put currency only inside string fields like "name" if needed).`;

    const { text, finishReason } = await vertexGenerateTextFromImage(image, prompt, {
      maxOutputTokens: expenseMaxOutputTokens(),
      expenseStructuredJson: true,
    });
    const parsedResult = parseModelJsonResponse(text);
    const truncated = String(finishReason || '').toUpperCase() === 'MAX_TOKENS';
    const truncationHint = truncated
      ? 'The model output may have been cut off (output limit). Try a shorter receipt image or scan in sections.'
      : '';
    if (!parsedResult.ok) throwInvalidModelJson(parsedResult, text, truncationHint);
    const parsed = parsedResult.value;

    const items = Array.isArray(parsed?.items)
      ? parsed.items
          .map((it) => ({
            qty: Number.isFinite(Number(it?.qty)) && Number(it?.qty) > 0 ? Number(it?.qty) : 1,
            name: String(it?.name ?? '').trim(),
            price: Number.isFinite(Number(it?.price)) ? Number(it?.price) : 0,
            category: String(it?.category ?? '').trim() || 'Others',
            unit: String(it?.unit ?? '').trim() || 'PCS',
          }))
          .filter((x) => x.name)
      : [];
    const extracted_items_sum = items.reduce((s, i) => s + (Number.isFinite(i.price) ? i.price : 0), 0);
    const receipt_grand_total = Number.isFinite(Number(parsed?.receipt_grand_total))
      ? Number(parsed.receipt_grand_total)
      : extracted_items_sum;
    const math_match = Math.abs(receipt_grand_total - extracted_items_sum) <= 2;

    return { items, receipt_grand_total, extracted_items_sum, math_match };
  } catch (err) {
    wrapVertexClientError(normalizeReceiptModelJsonError(err));
  }
}

// ---- Order receipt extraction (grouped orders) — same logic as receiptlens-ai orderReceiptHelpers.ts ----

function cleanExtractedOrderName(input) {
  const raw = String(input ?? '')
    .replace(/^[\s\-–—*#\[\](){}|]+/, '')
    .replace(/^\d+\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  return raw.replace(/[^\p{L}\p{N}\s/&.+-]/gu, '').replace(/\s+/g, ' ').trim();
}

function cleanMenuSelection(input) {
  const t = String(input ?? '').trim();
  if (!t) return '';
  return t.replace(/\s+/g, ' ').trim();
}

function cleanTableNoFromReceipt(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  const m = s.match(/^table\s*:\s*(.+)$/i);
  if (m) s = m[1].trim();
  return s.replace(/\s+/g, ' ').trim();
}

function isJunkLineName(n) {
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

function formatOrderNoWithDate(base) {
  const pad2 = (n) => String(n).padStart(2, '0');
  return `ORD-${base.getFullYear()}${pad2(base.getMonth() + 1)}${pad2(base.getDate())}-${pad2(base.getHours())}${pad2(
    base.getMinutes()
  )}${pad2(base.getSeconds())}`;
}

function normalizeOrderType(input) {
  const t = String(input ?? '')
    .trim()
    .toUpperCase();
  if (!t) return 'DINE_IN';
  if (t.includes('DELIVER')) return 'DELIVERY';
  if (t.includes('TAKE') || t.includes('TO GO') || t.includes('TO-GO') || t.includes('PICKUP')) return 'TAKE_OUT';
  if (t === 'DELIVERY' || t === 'TAKE_OUT' || t === 'DINE_IN') return t;
  return 'DINE_IN';
}

function normalizeOrderExtractionFromParsed(parsed) {
  if (!Array.isArray(parsed.orders) || parsed.orders.length === 0) {
    throw new Error('Invalid extraction result: no orders.');
  }

  const normalizedOrders = [];
  for (const rawOrder of parsed.orders) {
    const ro = rawOrder;
    const rawItems = Array.isArray(ro.items) ? ro.items : [];
    const cleanedItems = [];
    for (const raw of rawItems) {
      const it = raw;
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
      order_type: normalizeOrderType(String(ro.order_type ?? '')),
      table_no: cleanTableNoFromReceipt(String(ro.table_no ?? '')) || undefined,
      items: cleanedItems,
      order_total_amount: 0,
    });
  }

  if (normalizedOrders.length === 0) {
    throw new Error('Invalid extraction result: no line items.');
  }

  const extractionBase = new Date();
  const usedNos = new Set();
  const renumbered = normalizedOrders.map((o, idx) => {
    const sumLines = o.items.reduce((s, x) => s + x.line_price, 0);
    let orderNo = o.order_no;
    if (!ORDER_NO_PATTERN.test(orderNo)) {
      orderNo = '';
    }
    if (!orderNo) {
      const dt = new Date(extractionBase.getTime() + idx * 1000);
      orderNo = formatOrderNoWithDate(dt);
    }
    while (usedNos.has(orderNo)) {
      const dt = new Date(extractionBase.getTime() + (idx + usedNos.size + 1) * 1000);
      orderNo = formatOrderNoWithDate(dt);
    }
    usedNos.add(orderNo);
    return {
      order_id: idx + 1,
      order_no: orderNo,
      order_type: o.order_type,
      table_no: o.table_no,
      items: o.items.map((it) => ({ ...it })),
      order_total_amount: sumLines,
    };
  });

  const flat = [];
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

/**
 * Receipt → orders blocks (ReceiptLens orders tab). Uses Vertex AI (not AI Studio API key).
 * @param {string} base64
 */
async function extractOrderLinesFromReceipt(base64) {
  const image = parseImageInput(base64);
  if (!image.data) throw new Error('Invalid image data');

  const prompt = `Extract items from the receipt. Output ONLY valid raw JSON.
Do not include markdown tags, comments, or explanations.
Ensure all strings are properly escaped, especially if they contain special characters or currency symbols like ₱.
If a value is uncertain, provide a best guess based on the visual data but maintain JSON structure.
The receipt may be long. Ensure the JSON is complete and all brackets are closed.
Do not include any text before or after the JSON object.
If an item name has special characters or quotes, escape them properly for JSON strings.

You extract restaurant or retail POS receipts into JSON for order entry.

The image may be one long stitched receipt (multiple photos). Read top to bottom completely.

GROUPED ORDERS (critical):
- Identify distinct order sessions or logical groups: repeated headers, dashed dividers, separate "Total Amount" / transaction blocks, timestamps, table or ticket changes, or natural blank gaps.
- Output an array called "orders". Each element is ONE order block in reading order.
- order_id must be 1, 2, 3, ... in the order they appear on the receipt.
- Do not merge lines from different order blocks.

Each order object must have:
- order_id (integer, 1-based, in appearance order)
- order_no (string): receipt order number if found; if missing, generate with format ORD-YYYYMMDD-HHMMSS. If one scan has multiple blocks, make each order_no unique by incrementing the last timestamp seconds/digits.
- order_type (string): "Dine in", "Take out", or "Delivery". Default to "Dine in" if unclear.
- table_no (string, optional): table number or label if shown. Many PH POS receipts print a line like "TABLE : Take out_1" or "TABLE: 12" — put ONLY the value after "TABLE" (e.g. "Take out_1", "12", "T-12", "VIP-2"), not the word TABLE. If there is no table line, use empty string.
- items: array of line items belonging only to that order
- order_total_amount: sum of that block's line_price values (decimals only). Compute this yourself.

Each line item must have:
- item_name: text AS PRINTED in the item column (do not translate or rename). If a name is split across two lines on the receipt (e.g. "OLD - FASHI" then "ONED"), combine into one item_name (e.g. "OLD FASHIONED").
- quantity: number (if not shown, use 1)
- menu_selection: modifiers printed on the receipt for that line — size, set meal choice, add-ons, variant, or empty string "" if none
- line_price: final extended price for that line only (number, no currency symbols)

Global rules:
- Include EVERY food, drink, and merchandise line in each order block. Do not skip or merge distinct items (e.g. if the receipt lists Margarita, Highball, and Old Fashioned, output three separate line items).
- Include food, drinks, and packaged goods sold. Exclude store boilerplate, TIN, cashier-only lines, payment/change lines, and standalone tax-only lines unless they are a real product line.
- Exclude service charges / tips / gratuity lines from items (e.g. "Service Charge", "SVC CHG", "Room charge", "Gratuity", "Tip"). These are NOT merchandise lines.
- Numbers: decimals only; no "P", "Php", "₱", or letters in numeric fields.
- receipt_grand_total: if the receipt shows one overall total, use it; if multiple separate transactions with separate totals, use the sum of those transaction totals (or sum of order_total_amount if that matches the print).
- extracted_items_sum: sum of every line_price across all orders.
- math_match: true if extracted_items_sum equals receipt_grand_total within 2 (rounding).

Extract only from merchandise line rows (typically between ITEM/QTY/PRICE column headers and the block's subtotal/total lines).

Output ONLY strict JSON (no markdown) with this shape:
{
  "orders": [
    {
      "order_id": number,
      "order_no": string,
      "order_type": string,
      "table_no": string,
      "order_total_amount": number,
      "items": [
        { "item_name": string, "quantity": number, "menu_selection": string, "line_price": number }
      ]
    }
  ],
  "receipt_grand_total": number,
  "extracted_items_sum": number,
  "math_match": boolean
}`;

  try {
    const { text, finishReason } = await vertexGenerateTextFromImage(image, prompt, { maxOutputTokens: 8192 });
    const parsedResult = parseModelJsonResponse(text);
    const truncated = String(finishReason || '').toUpperCase() === 'MAX_TOKENS';
    const truncationHint = truncated
      ? 'The model output may have been cut off (output limit). Try a shorter receipt image or scan in sections.'
      : '';
    if (!parsedResult.ok) throwInvalidModelJson(parsedResult, text, truncationHint);
    return normalizeOrderExtractionFromParsed(parsedResult.value);
  } catch (err) {
    wrapVertexClientError(normalizeReceiptModelJsonError(err));
  }
}

module.exports = { analyzeReceipt, extractOrderLinesFromReceipt };
