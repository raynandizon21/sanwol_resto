/**
 * Sidebar feature registry used for:
 * - rendering the sidebar
 * - branch sidebar permissions (User Access → Branches tab)
 *
 * NOTE: Feature keys must match the server-side allowlist for branch sidebar permissions
 * (see branchSidebarPermissionModel.js / ALL_FEATURES).
 */

export type SidebarFeatureKind = 'item' | 'group' | 'admin-only';

/** Sidebar section headings, in display order. Items render under their section. */
export const SIDEBAR_SECTIONS = [
  { key: 'overview', label: 'Overview', i18nKey: 'sidebar.section_overview' },
  { key: 'operations', label: 'Operations', i18nKey: 'sidebar.section_operations' },
  { key: 'menu_stock', label: 'Menu & Stock', i18nKey: 'sidebar.section_menu_stock' },
  { key: 'staff', label: 'Staff', i18nKey: 'sidebar.section_staff' },
] as const;

export type SidebarSectionKey = (typeof SIDEBAR_SECTIONS)[number]['key'];

export type SidebarFeatureConfig = {
  /**
   * Stable key for permission + filtering. For `group`/`admin-only` it is used
   * only for internal identification (not stored as a permission key).
   */
  key: string;
  kind: SidebarFeatureKind;
  /** Top-level items only: which sidebar section heading they sit under. */
  section?: SidebarSectionKey;
  /** Human label for tables; Sidebar can use i18n keys separately. */
  label: string;
  /** Sidebar label translation key (optional). */
  i18nKey?: string;
  /** Sidebar navigation tab name used by `onTabChange` (optional for non-nav groups). */
  tab?: string;
  /** Icon identifier used by the Sidebar. */
  icon?: string;
  /**
   * If true, the sidebar item only appears when a specific branch is selected.
   * (Mirrors existing behavior in `Sidebar.tsx`.)
   */
  requiresSpecificBranch?: boolean;
  /**
   * Children are only relevant for groups (e.g. Sales Report).
   * Children must be `item` kinds.
   */
  children?: SidebarFeatureConfig[];
};

/** AI Sales Assistant (admin, All Branches). Hidden for now; set to true to show it again. */
export const SHOW_AI_SALES_ASSISTANT = false;

export const SIDEBAR_FEATURES: SidebarFeatureConfig[] = [
  {
    key: 'dashboard',
    section: 'overview',
    kind: 'item',
    label: 'Dashboard',
    i18nKey: 'sidebar.dashboard',
    tab: 'Dashboard',
    icon: 'LayoutDashboard',
  },
  {
    key: 'sales_report',
    section: 'overview',
    kind: 'group',
    label: 'Sales Report',
    i18nKey: 'sidebar.sales_report',
    tab: 'Sales Report',
    icon: 'BarChart3',
    children: [
      {
        key: 'sales_analytics',
        kind: 'item',
        label: 'Sales Analytics',
        i18nKey: 'sidebar.sales_analytics',
        tab: 'Sales Analytics',
      },
      { key: 'menu', kind: 'item', label: 'Menu (Report)', i18nKey: 'sidebar.menu', tab: 'Menu' },
      {
        key: 'category',
        kind: 'item',
        label: 'Category',
        i18nKey: 'sidebar.category',
        tab: 'Category',
      },
      {
        key: 'payment_type',
        kind: 'item',
        label: 'Payment type',
        i18nKey: 'sidebar.payment_type',
        tab: 'Payment type',
      },
      {
        key: 'receipt',
        kind: 'item',
        label: 'Receipt',
        i18nKey: 'sidebar.receipt',
        tab: 'Receipt',
      },
    ],
  },
  {
    key: 'expenses',
    section: 'overview',
    kind: 'item',
    label: 'Expenses',
    i18nKey: 'sidebar.expenses',
    tab: 'Expenses',
    icon: 'DollarSign',
    requiresSpecificBranch: true,
  },
  {
    key: 'orders',
    section: 'operations',
    kind: 'item',
    label: 'Orders',
    i18nKey: 'sidebar.orders',
    tab: 'Orders',
    icon: 'ClipboardList',
    requiresSpecificBranch: true,
  },
  {
    key: 'billing',
    section: 'operations',
    kind: 'item',
    label: 'Billing',
    i18nKey: 'sidebar.billing',
    tab: 'Billing',
    icon: 'CreditCard',
    requiresSpecificBranch: true,
  },
  {
    key: 'table_settings',
    section: 'operations',
    kind: 'item',
    label: 'Table Settings',
    i18nKey: 'sidebar.table_settings',
    tab: 'Tables',
    icon: 'Armchair',
  },
  {
    key: 'menu_management',
    section: 'menu_stock',
    kind: 'item',
    label: 'Menu Management',
    i18nKey: 'sidebar.menu_management',
    tab: 'Menu Management',
    icon: 'UtensilsCrossed',
    requiresSpecificBranch: true,
  },
  {
    key: 'ingredients',
    section: 'menu_stock',
    kind: 'item',
    label: 'Ingredients',
    i18nKey: 'sidebar.ingredients',
    tab: 'Ingredients',
    icon: 'FlaskConical',
    requiresSpecificBranch: true,
  },
  {
    key: 'inventory',
    section: 'menu_stock',
    kind: 'item',
    label: 'Inventory',
    i18nKey: 'sidebar.inventory',
    tab: 'Inventory',
    icon: 'Package',
    requiresSpecificBranch: true,
  },
  {
    // The MB160's users plus app-only profiles (replaced the separate Device Users page).
    key: 'employee',
    section: 'staff',
    kind: 'item',
    label: 'Employees',
    i18nKey: 'sidebar.employee',
    tab: 'Employee',
    icon: 'IdCard',
  },
  {
    // Per-employee, per-day work schedules (shift types, days off, leave). Shift types are per
    // branch.
    key: 'schedules',
    section: 'staff',
    kind: 'item',
    label: 'Schedules',
    i18nKey: 'sidebar.schedules',
    tab: 'Schedules',
    icon: 'CalendarDays',
    requiresSpecificBranch: true,
  },
  {
    key: 'attendance_logs',
    section: 'staff',
    kind: 'item',
    label: 'Attendance Logs',
    i18nKey: 'sidebar.attendance_logs',
    tab: 'Attendance Logs',
    icon: 'Clock',
  },
  {
    key: 'user_management',
    kind: 'admin-only',
    label: 'User Management',
    i18nKey: 'sidebar.user_management',
    tab: 'User Management',
    icon: 'Users',
  },
] as const;

type ExtractItemKeys<T> = T extends { kind: 'item'; key: infer K }
  ? K
  : T extends { children: readonly (infer C)[] }
    ? ExtractItemKeys<C>
    : never;

export type SidebarFeatureKey = ExtractItemKeys<(typeof SIDEBAR_FEATURES)[number]> & string;

const flattenFeatureKeys = (
  items: readonly SidebarFeatureConfig[],
): SidebarFeatureKey[] => {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === 'item') out.push(item.key);
    if (item.children && item.children.length > 0) {
      out.push(...flattenFeatureKeys(item.children));
    }
  }
  return out as SidebarFeatureKey[];
};

export const SIDEBAR_FEATURE_KEYS = flattenFeatureKeys(SIDEBAR_FEATURES) as readonly SidebarFeatureKey[];

/** The pages each feature opens; the first one is where that feature lands. */
const FEATURE_PATHS: Record<string, string[]> = {
  dashboard: ['/dashboard'],
  sales_analytics: ['/sales-report/sales-analytics'],
  menu: ['/sales-report/menu'],
  category: ['/sales-report/category'],
  payment_type: ['/sales-report/payment-type'],
  receipt: ['/sales-report/receipt'],
  expenses: ['/expenses', '/expenses-mock'],
  orders: ['/orders'],
  billing: ['/billing'],
  table_settings: ['/users/tables'],
  menu_management: ['/menu-management', '/menu'],
  ingredients: ['/ingredients'],
  inventory: ['/inventory'],
  employee: ['/employee', '/device-users'],
  schedules: ['/schedules'],
  attendance_logs: ['/attendance-logs'],
};

const isUnder = (pathname: string, path: string) => pathname === path || pathname.startsWith(`${path}/`);

const featureForPath = (pathname: string) =>
  Object.keys(FEATURE_PATHS).find((key) => FEATURE_PATHS[key].some((path) => isUnder(pathname, path))) ?? null;

/** True when the branch's list leaves out at least one sidebar page. */
export const hidesSomeFeature = (allowed: readonly string[]) =>
  SIDEBAR_FEATURE_KEYS.some((key) => !allowed.includes(key));

/** Where someone goes when a page is hidden: the first allowed page in sidebar order. */
export const firstAllowedPath = (allowed: readonly string[]) => {
  const key = SIDEBAR_FEATURE_KEYS.find((k) => allowed.includes(k) && FEATURE_PATHS[k]);
  return key ? FEATURE_PATHS[key][0] : null;
};

/**
 * Whether a page may open under the branch's list. Pages outside the sidebar are closed too, except
 * User Management for admins (the Control Panel that turns these pages back on is there).
 */
export const isPathAllowed = (pathname: string, allowed: readonly string[], isAdmin: boolean) => {
  const key = featureForPath(pathname);
  return key ? allowed.includes(key) : isAdmin && isUnder(pathname, '/users');
};

/** True when the branch shows only the Staff section (the presentation setup: see README). */
export const isStaffOnly = (allowed: readonly string[]) => {
  const staffKeys = SIDEBAR_FEATURES.filter((f) => f.section === 'staff').map((f) => f.key);
  return allowed.length > 0 && allowed.every((key) => staffKeys.includes(key));
};

/** Display labels for User Access matrix (can use i18n keys later) */
export const SIDEBAR_FEATURE_LABELS: Record<string, string> = Object.fromEntries(
  flattenFeatureKeys(SIDEBAR_FEATURES).map((key) => {
    const findLabel = (items: readonly SidebarFeatureConfig[]): string | undefined => {
      for (const item of items) {
        if (item.key === key) return item.label;
        if (item.children) {
          const childLabel = findLabel(item.children);
          if (childLabel) return childLabel;
        }
      }
      return undefined;
    };
    return [key, findLabel(SIDEBAR_FEATURES) ?? key];
  }),
);

/** i18n keys for the same items (only those that define one) */
export const SIDEBAR_FEATURE_I18N_KEYS: Record<string, string> = {};
const collectI18nKeys = (items: readonly SidebarFeatureConfig[]) => {
  for (const item of items) {
    if (item.i18nKey) SIDEBAR_FEATURE_I18N_KEYS[item.key] = item.i18nKey;
    if (item.children) collectI18nKeys(item.children);
  }
};
collectI18nKeys(SIDEBAR_FEATURES);
