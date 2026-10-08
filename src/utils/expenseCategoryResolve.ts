import type { InventoryCategory } from '../services/inventoryService';

export type OpStateById = Map<string, number> | Record<string, number>;

function normalizeCategoryLabel(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[,，、]/g, ' ')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingNumber(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^\d+\.?\s*/, '')
    .trim();
}

function hasLeadingNumber(value: string): boolean {
  return /^\d+\.?\s/.test(String(value || '').trim());
}

/** Collapse numbered/unnumbered + punctuation variants into one key. */
function canonicalCategoryKey(value: string): string {
  const parts = String(value || '')
    .split('/')
    .map((p) => stripLeadingNumber(p.trim()))
    .filter(Boolean);
  return normalizeCategoryLabel(parts.join(' / ') || stripLeadingNumber(value));
}

function englishTail(value: string): string {
  const parts = String(value || '')
    .split('/')
    .map((p) => stripLeadingNumber(p.trim()))
    .filter(Boolean);
  return normalizeCategoryLabel(parts[parts.length - 1] || value);
}

function tokenSet(value: string): Set<string> {
  return new Set(
    canonicalCategoryKey(value)
      .split(/[\s/]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1),
  );
}

function categoryMatchScore(extracted: string, candidate: string): number {
  const aKey = canonicalCategoryKey(extracted);
  const bKey = canonicalCategoryKey(candidate);
  if (!aKey || !bKey) return 0;
  if (aKey === bKey) return 100;

  const a = normalizeCategoryLabel(extracted);
  const b = normalizeCategoryLabel(candidate);
  if (a && b && a === b) return 100;

  const engA = englishTail(extracted);
  const engB = englishTail(candidate);
  if (engA && engB && engA === engB) return 95;
  if (engA && engB && (engA.includes(engB) || engB.includes(engA))) return 85;

  if (a.includes(b) || b.includes(a) || aKey.includes(bKey) || bKey.includes(aKey)) return 80;

  const tokensA = tokenSet(extracted);
  const tokensB = tokenSet(candidate);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  tokensA.forEach((t) => {
    if (tokensB.has(t)) overlap += 1;
  });
  const ratio = overlap / Math.max(tokensA.size, tokensB.size);
  return Math.round(ratio * 70);
}

function labelOf(cat: InventoryCategory): string {
  return String(cat.categoryType || cat.name || '').trim();
}

function isOfficialLabel(label: string): boolean {
  return hasLeadingNumber(label);
}

function getOpState(opCategoryId: string | null | undefined, opStateById?: OpStateById): number | undefined {
  if (opCategoryId == null || opCategoryId === '' || !opStateById) return undefined;
  const key = String(opCategoryId);
  if (opStateById instanceof Map) return opStateById.get(key);
  return opStateById[key];
}

/** Inventory-linked main categories (STATE=1), typically 식자재 / Food Supplies. */
function isInventoryOp(opCategoryId: string | null | undefined, opStateById?: OpStateById): boolean {
  return getOpState(opCategoryId, opStateById) === 1;
}

/**
 * Operating-expense style subs that belong under 매장운영 / Operation (STATE=0),
 * not under Food Supplies — even if a scanner leftover duplicate exists there.
 */
const OPS_LIKE_TAILS = new Set([
  'supplies',
  'indirect',
  'indirect expenses',
  'indirect expense',
  'utilities',
  'utilities / bills',
  'bills',
  'labor',
  'benefits',
  'labor, benefits',
  'vehicle',
  'gas',
  'vehicle & gas',
  'fixed costs',
  'fixed costs, tax',
  'tax',
  'rent',
]);

const FOOD_LIKE_TAILS = new Set([
  'meat',
  'poultry',
  'meat & poultry',
  'seafood',
  'produce',
  'vegetables',
  'fruits',
  'vegetables & fruits',
  'rice',
  'grains',
  'rice & grains',
  'beverages',
  'liquor',
  'beverages & liquor',
  'dairy',
  'fresh food',
  'dry goods',
  'groceries',
  'condiments',
  'groceries & condiments',
  'oil',
  'sauce',
  'seasoning',
  'oil, sauce, seasoning',
]);

function isOpsLikeLabel(label: string): boolean {
  const eng = englishTail(label);
  const key = canonicalCategoryKey(label);
  if (OPS_LIKE_TAILS.has(eng) || OPS_LIKE_TAILS.has(key)) return true;
  return /(supply|supplies|indirect|utilit|labor|benefit|vehicle|\bgas\b|fixed cost|\btax\b|\brent\b)/i.test(
    eng || key,
  );
}

function isFoodLikeLabel(label: string): boolean {
  const eng = englishTail(label);
  const key = canonicalCategoryKey(label);
  if (FOOD_LIKE_TAILS.has(eng) || FOOD_LIKE_TAILS.has(key)) return true;
  return /(meat|poultry|seafood|produce|vegetable|fruit|rice|grain|beverage|liquor|dairy|fresh food|dry goods|grocer|condiment|seasoning|\boil\b|\bsauce\b)/i.test(
    eng || key,
  );
}

/**
 * Prefer numbered official labels. When the same sub exists under both inventory
 * (Food Supplies) and non-inventory (Operation), pick Operation for ops-like
 * categories and Food Supplies for food-like ones — so receipt upload does not keep
 * attaching Supplies/Indirect to Food Supplies leftovers.
 */
function preferBestCategory(
  pool: InventoryCategory[],
  preferredOpCategoryId: string | null,
  opStateById?: OpStateById,
): InventoryCategory | undefined {
  if (pool.length === 0) return undefined;
  if (pool.length === 1) return pool[0];

  const numbered = pool.filter((cat) => isOfficialLabel(labelOf(cat)) || isOfficialLabel(cat.name || ''));
  let candidates = numbered.length > 0 ? numbered : pool;

  if (opStateById && candidates.length > 1) {
    const inventory = candidates.filter((cat) => isInventoryOp(cat.opCategoryId, opStateById));
    const nonInventory = candidates.filter((cat) => !isInventoryOp(cat.opCategoryId, opStateById));
    if (inventory.length > 0 && nonInventory.length > 0) {
      const sample = labelOf(candidates[0]) || candidates[0].name || '';
      if (isOpsLikeLabel(sample)) {
        candidates = nonInventory;
      } else if (isFoodLikeLabel(sample)) {
        candidates = inventory;
      } else {
        candidates = nonInventory;
      }
    }
  }

  if (preferredOpCategoryId) {
    const preferred = candidates.filter((cat) => String(cat.opCategoryId) === String(preferredOpCategoryId));
    if (preferred.length > 0) return preferred[0];
  }

  return candidates[0];
}

/** Prefer numbered official labels over unnumbered scanner leftovers. */
function preferOfficialCategory(pool: InventoryCategory[]): InventoryCategory | undefined {
  if (pool.length === 0) return undefined;
  const numbered = pool.filter((cat) => isOfficialLabel(labelOf(cat)) || isOfficialLabel(cat.name || ''));
  return numbered[0] ?? pool[0];
}

/**
 * Unique subcategory labels for AI extraction / matching.
 * Collapses numbered + unnumbered duplicates onto the official numbered label when present.
 * Also collapses variants that share the same English tail (e.g. 기타경비 vs 간접비 / Indirect*).
 * When the same English tail exists under inventory + Operation, prefer Operation for ops-like labels.
 */
export function preferredSubCategoryLabels(
  categories: InventoryCategory[],
  opStateById?: OpStateById,
): string[] {
  const byCanonical = new Map<string, InventoryCategory>();

  for (const cat of categories) {
    if (cat.active === false) continue;
    const label = labelOf(cat);
    if (!label) continue;
    const key = canonicalCategoryKey(label);
    if (!key) continue;
    const existing = byCanonical.get(key);
    if (!existing) {
      byCanonical.set(key, cat);
      continue;
    }
    const picked = preferBestCategory([existing, cat], null, opStateById);
    if (picked) byCanonical.set(key, picked);
  }

  const byEnglish = new Map<string, InventoryCategory>();
  for (const cat of byCanonical.values()) {
    const label = labelOf(cat);
    const eng = englishTail(label);
    const collapseKey = eng || canonicalCategoryKey(label);
    const existing = byEnglish.get(collapseKey);
    if (!existing) {
      byEnglish.set(collapseKey, cat);
      continue;
    }
    const picked = preferBestCategory([existing, cat], null, opStateById);
    if (picked) byEnglish.set(collapseKey, picked);
  }

  return Array.from(byEnglish.values())
    .map((cat) => labelOf(cat))
    .filter(Boolean)
    .sort((a, b) => {
      const numA = /^(\d+)\.?\s/.exec(a);
      const numB = /^(\d+)\.?\s/.exec(b);
      if (numA && numB) {
        const nA = parseInt(numA[1], 10);
        const nB = parseInt(numB[1], 10);
        if (nA !== nB) return nA - nB;
      }
      if (numA && !numB) return -1;
      if (!numA && numB) return 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
}

function pickMasterCategoryForSubCategory(
  categories: InventoryCategory[],
  subCategoryLabel: string,
  preferredOpCategoryId: string | null,
  opStateById?: OpStateById,
): InventoryCategory | undefined {
  const targetKey = canonicalCategoryKey(subCategoryLabel);
  const matches = categories.filter((cat) => {
    const typeKey = canonicalCategoryKey(cat.categoryType || '');
    const nameKey = canonicalCategoryKey(cat.name || '');
    return typeKey === targetKey || nameKey === targetKey;
  });
  if (matches.length === 0) return undefined;

  return preferBestCategory(matches, preferredOpCategoryId, opStateById);
}

function findFallbackMasterCategory(
  categories: InventoryCategory[],
  preferredOpCategoryId: string | null,
): InventoryCategory | undefined {
  const othersPool = categories.filter(
    (cat) =>
      canonicalCategoryKey(cat.categoryType) === 'others' ||
      canonicalCategoryKey(cat.name) === 'others',
  );
  const others = preferOfficialCategory(othersPool);
  if (others) return others;

  if (preferredOpCategoryId) {
    const opMatches = categories.filter((cat) => cat.opCategoryId === preferredOpCategoryId);
    const opPick = preferOfficialCategory(opMatches);
    if (opPick) return opPick;
  }

  return preferOfficialCategory(categories) ?? categories[0];
}

/**
 * Map an extracted receipt category to an existing master category id.
 * Never creates new sub categories — only uses rows already in RestoAdmin.
 * Prefers numbered official rows; when Supplies/Indirect exist under both Food
 * Supplies and Operation, prefers Operation.
 */
export function resolveExistingMasterCategoryId(
  categories: InventoryCategory[],
  extractedCategory: string,
  preferredOpCategoryId: string | null,
  opStateById?: OpStateById,
): string {
  const active = categories.filter((c) => c.active);
  if (!active.length) {
    throw new Error('No expense categories found for this branch. Add sub categories in Expenses first.');
  }

  const raw = String(extractedCategory || '').trim();

  if (raw) {
    const rawKey = canonicalCategoryKey(raw);
    const rawEng = englishTail(raw);

    // Strong matches: same canonical key OR same English tail (handles
    // "기타경비 / Indirect Expenses" vs "8. 간접비 / Indirect expenses").
    const strongMatches = active.filter((cat) => {
      const type = cat.categoryType || '';
      const name = cat.name || '';
      const typeKey = canonicalCategoryKey(type);
      const nameKey = canonicalCategoryKey(name);
      if (typeKey === rawKey || nameKey === rawKey) return true;
      if (!rawEng) return false;
      return englishTail(type) === rawEng || englishTail(name) === rawEng;
    });

    if (strongMatches.length > 0) {
      const picked = preferBestCategory(strongMatches, preferredOpCategoryId, opStateById);
      if (picked) return picked.id;
    }

    let bestLabel = '';
    let bestScore = 0;
    for (const label of preferredSubCategoryLabels(active, opStateById)) {
      const score = categoryMatchScore(raw, label);
      if (score > bestScore) {
        bestScore = score;
        bestLabel = label;
      }
    }

    if (bestScore >= 60 && bestLabel) {
      const matched = pickMasterCategoryForSubCategory(
        active,
        bestLabel,
        preferredOpCategoryId,
        opStateById,
      );
      if (matched) return matched.id;
    }
  }

  const fallback = findFallbackMasterCategory(active, preferredOpCategoryId);
  if (fallback) return fallback.id;

  throw new Error('No matching expense sub category found. Add sub categories in Expenses first.');
}
