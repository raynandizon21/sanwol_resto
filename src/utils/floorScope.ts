// Branches (IDNo) with a ground/2nd-floor table split. Only 3Core (4, testing)
// today; add a branch's IDNo here if it becomes multi-floor. Every other branch
// has a single floor, so the floor pickers in Table Settings / Orders stay
// hidden for them and their tables' FLOOR column is left null.
export const FLOOR_ENABLED_BRANCH_IDS = new Set(['4']);

export const isFloorEnabledBranch = (
  branchId: string | number | null | undefined
): boolean => branchId != null && FLOOR_ENABLED_BRANCH_IDS.has(String(branchId));

export type TableFloor = 'gf' | '2f';
