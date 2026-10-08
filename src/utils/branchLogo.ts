import type { Branch } from '../components/partials/Header';

/** Default sidebar logo when "All Branches" is selected */
export const DEFAULT_ALL_BRANCHES_LOGO = '/uploads/branches/GENERAL_ALL_BRANCHES.png';

export function resolveBranchLogoUrl(logoPath: string | null | undefined): string | null {
  if (!logoPath || !String(logoPath).trim()) return null;
  const path = String(logoPath).trim();
  if (path.startsWith('http')) return path;
  return path.startsWith('/') ? path : `/${path}`;
}

/** Sidebar header image for a specific branch; null for "all" (static icon in UI) */
export function resolveSidebarBranchLogo(branch: Branch | null | undefined): string | null {
  if (!branch || String(branch.id) === 'all') {
    return null;
  }
  return resolveBranchLogoUrl(branch.logo);
}

const normalizeBranchName = (name: string) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[''`]/g, '');

export function is3coreBranch(name: string | null | undefined): boolean {
  const n = normalizeBranchName(name || '');
  return n === '3core' || n.includes('3core');
}

/** Branches hidden from All Branches sidebar grid, dashboard cards, and compare (3Core dev/testing). */
export function isExcludedFromAllBranchesView(name: string | null | undefined): boolean {
  return is3coreBranch(name);
}

/** Branch order for the sidebar grid + dashboard compare: alphabetical, 3Core hidden by default. */
export function sortBranchesBySidebarOrder<T extends { id: number | string; name: string }>(
  branches: T[],
  options?: { exclude3core?: boolean },
): T[] {
  const exclude3core = options?.exclude3core ?? true;
  const pool = exclude3core
    ? branches.filter((b) => !isExcludedFromAllBranchesView(b.name))
    : [...branches];
  return pool.sort((a, b) => normalizeBranchName(a.name).localeCompare(normalizeBranchName(b.name)));
}

export function prepareAllBranchesSidebarLogos(branches: Branch[]): Branch[] {
  return sortBranchesBySidebarOrder(branches, { exclude3core: true });
}
