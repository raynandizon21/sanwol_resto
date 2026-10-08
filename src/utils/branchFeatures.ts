// Per-branch display/billing options, keyed by branch IDNo. Both sets are
// empty by default: every branch shows whole pesos and has no automatic
// service charge. Add a branch's IDNo to turn the option on for it.

/** Branches whose money is shown with cents (e.g. ₱125.50) instead of whole pesos. */
export const MONEY_CENTS_BRANCH_IDS = new Set<string>([]);

/** Branches that add a 10% service charge to dine-in orders. */
export const DINE_IN_SERVICE_CHARGE_BRANCH_IDS = new Set<string>([]);

const normalizeBranchId = (branchId: string | number | null | undefined) => String(branchId ?? '').trim();

export const showsMoneyCents = (branchId: string | number | null | undefined): boolean =>
  MONEY_CENTS_BRANCH_IDS.has(normalizeBranchId(branchId));

export const hasDineInServiceCharge = (branchId: string | number | null | undefined): boolean =>
  DINE_IN_SERVICE_CHARGE_BRANCH_IDS.has(normalizeBranchId(branchId));

/** 10% service charge on a dine-in subtotal, rounded to cents. */
export const tenPercentServiceCharge = (subtotal: number): number =>
  Number(((Number(subtotal) || 0) * 0.1).toFixed(2));
