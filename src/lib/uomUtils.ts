/**
 * UOM (Unit of Measure) utilities for ingredients and expenses.
 * Qty may be fractional for any unit (e.g. 0.4 case, 0.7 kg) — aligned with DB DECIMAL(12,3).
 */

/** Legacy: weight/volume units often entered with decimals (display hints only). */
const DECIMAL_UNITS = new Set(['kg', 'g', 'l', 'ml']);

/** Legacy: count-style units (qty may still be fractional on insert). */
const WHOLE_NUMBER_UNITS = new Set([
  'pcs', 'case', 'box', 'pack', 'bottle', 'jar', 'can', 'bag', 'head', 'bunch', 'cup',
]);

/** Max fractional digits for qty entry/display (expenses/inventory EXP_QTY & STOCK_QTY). */
export const QTY_DECIMAL_PLACES = 3;

/** Priority units shown first in all UOM dropdowns */
export const UOM_PRIORITY = ['pcs', 'kg', 'g', 'L', 'mL'] as const;

const UOM_OTHERS = [
  'case', 'box', 'pack', 'bottle', 'jar', 'can', 'bag', 'head', 'bunch', 'cup',
] as const;

/** All UOM options for selection — priority units first, then the rest */
export const UOM_OPTIONS = [...UOM_PRIORITY, ...UOM_OTHERS] as const;

/** Normalize unit for comparison (lowercase, trimmed) */
function normalizeUnit(unit: string): string {
  return String(unit || 'pcs').toLowerCase().trim();
}

/** Human-readable unit label (volume uses L / mL to avoid ambiguous lowercase "l"). */
const UNIT_DISPLAY: Record<string, string> = {
  l: 'L',
  ml: 'mL',
};

/** Display label for unit — storage/normalization stays lowercase; UI shows L and mL. */
export function getUnitLabel(unit: string): string {
  const u = normalizeUnit(unit);
  if (!u) return 'pcs';
  return UNIT_DISPLAY[u] ?? u;
}

export function isDecimalUnit(unit: string): boolean {
  return DECIMAL_UNITS.has(normalizeUnit(unit));
}

export function isWholeNumberUnit(unit: string): boolean {
  const u = normalizeUnit(unit);
  return WHOLE_NUMBER_UNITS.has(u) || !DECIMAL_UNITS.has(u);
}

/** Input step for qty fields — any UOM may use fractional values. */
export function getQtyInputStep(_unit?: string): string {
  return 'any';
}

/** Fractional digits for qty display (same for all UOM). */
export function getQtyDecimalPlaces(_unit?: string): number {
  return QTY_DECIMAL_PLACES;
}

/** Format quantity for display; strips trailing zeros (e.g. 0.5, 1.25). */
export function formatQty(value: number | null | undefined, _unit?: string): string {
  const n = Number.isFinite(value) ? Number(value) : 0;
  return parseFloat(n.toFixed(QTY_DECIMAL_PLACES)).toString();
}

/** Valid unit values for backend validation (lowercase) */
export const VALID_UNITS = [...WHOLE_NUMBER_UNITS, ...DECIMAL_UNITS];

/**
 * Map a stored/API unit string to the canonical option value in {@link UOM_OPTIONS} (for Select2 value match).
 */
export function canonicalUomValue(raw: string | null | undefined): string {
  const s = String(raw ?? 'pcs').trim();
  if (!s) return 'pcs';
  const lower = s.toLowerCase();
  const aliases: Record<string, (typeof UOM_OPTIONS)[number]> = { l: 'L', ml: 'mL' };
  if (aliases[lower]) return aliases[lower];
  const found = UOM_OPTIONS.find((u) => u.toLowerCase() === lower);
  return found ?? s;
}
