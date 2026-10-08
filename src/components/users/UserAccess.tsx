import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save, Shield, Check } from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { useUser } from '../../context/UserContext';
import { Navigate } from 'react-router-dom';
import {
  SIDEBAR_FEATURE_KEYS,
  SIDEBAR_FEATURE_LABELS,
  type SidebarFeatureKey,
} from '../../constants/sidebarFeatures';
import {
  CRUD_MODULES,
  type CrudModuleKey,
  type CrudActionKey,
} from '../../constants/crudMenuItems';
import { cn } from '../../lib/utils';

const authHeaders = (): HeadersInit => {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

interface BranchOption {
  id: number | string;
  name: string;
  code?: string;
}

type AccessTab = 'branches' | 'user-role';

type RoleSummary = {
  id: string;
  name: string;
};

type RoleCrudPermissions = {
  [K in CrudModuleKey]?: {
    create?: boolean;
    update?: boolean;
    delete?: boolean;
  };
};

const areBranchPermissionsEqual = (
  a: Record<string, string[]>,
  b: Record<string, string[]>,
) => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const aList = a[key] || [];
    const bList = b[key] || [];
    if (aList.length !== bList.length) return false;
    const aSorted = [...aList].sort();
    const bSorted = [...bList].sort();
    for (let i = 0; i < aSorted.length; i += 1) {
      if (aSorted[i] !== bSorted[i]) return false;
    }
  }
  return true;
};

const areRolePermissionsEqual = (
  a: RoleCrudPermissions | null,
  b: RoleCrudPermissions | null,
) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const aMod = a[key as CrudModuleKey] || {};
    const bMod = b[key as CrudModuleKey] || {};
    const actions: CrudActionKey[] = ['create', 'update', 'delete'];
    for (const action of actions) {
      if (!!aMod[action] !== !!bMod[action]) return false;
    }
  }
  return true;
};

interface FancyCheckboxProps {
  checked: boolean;
  onChange: () => void;
}

const FancyCheckbox: React.FC<FancyCheckboxProps> = ({ checked, onChange }) => {
  return (
    <button
      type="button"
      onClick={onChange}
      role="switch"
      aria-checked={checked}
      className={cn(
        'inline-flex h-6 w-10 items-center rounded-full border transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500 cursor-pointer',
        checked
          ? 'bg-indigo-50 border-indigo-400'
          : 'bg-gray-100 border-gray-200 hover:bg-gray-200 hover:border-indigo-300',
      )}
    >
      <span
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold transition-transform shadow-sm',
          checked
            ? 'bg-indigo-500 text-white translate-x-4'
            : 'bg-white text-gray-400 translate-x-0.5',
        )}
      >
        {checked && <Check className="h-3 w-3" />}
      </span>
    </button>
  );
};

export const UserAccess: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useUser();
  const isAdmin = user?.permissions === 1;

  const [activeTab, setActiveTab] = useState<AccessTab>('branches');

  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [permissions, setPermissions] = useState<Record<string, string[]>>({});
  const [initialPermissions, setInitialPermissions] = useState<Record<string, string[]>>({});
  const [selectedBranchId, setSelectedBranchId] = useState<string | number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // User-role CRUD permissions
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [rolePermissions, setRolePermissions] = useState<RoleCrudPermissions | null>(null);
  const [originalRolePermissions, setOriginalRolePermissions] =
    useState<RoleCrudPermissions | null>(null);
  const [rolePermissionsCache, setRolePermissionsCache] = useState<
    Record<string, RoleCrudPermissions>
  >({});
  const [rolePermSaving, setRolePermSaving] = useState(false);

  const fetchData = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/branch/sidebar-permissions/all', { headers: authHeaders() });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message || json.error || `Failed to load (${res.status})`);
      }
      const data = json.data || json;
      const branchList: BranchOption[] = (data.branches || []).map((b: any) => ({
        id: b.IDNo,
        name: b.BRANCH_NAME || '—',
        code: b.BRANCH_CODE,
      }));
      setBranches(branchList);
      const perms = data.permissions || {};
      setPermissions(perms);
      setInitialPermissions(perms);
    } catch (e: any) {
      console.error('Failed to fetch sidebar permissions', e);
      setError(e.message || t('user_access.failed_to_load', 'Failed to load permissions'));
    }
  }, [t]);

  const authHeadersWithToken = () => {
    const token = localStorage.getItem('token');
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } as HeadersInit;
  };

  const fetchRolePermissions = useCallback(
    async (roleId: string) => {
      try {
        const res = await fetch(`/api/user-management/roles/${roleId}/crud-permissions`, {
          headers: authHeadersWithToken(),
        });
        const json = await res.json();
        if (!res.ok) {
          throw new Error(
            json.message || json.error || `Failed to load role permissions (${res.status})`,
          );
        }
        const data = (json.data || json.permissions || {}) as RoleCrudPermissions;
        setRolePermissions(data);
        setOriginalRolePermissions(data);
        setRolePermissionsCache((prev) => ({
          ...prev,
          [roleId]: data,
        }));
      } catch (e: any) {
        console.error('Failed to fetch role CRUD permissions', e);
        toast.error(
          e.message ||
            t('user_access.failed_to_load_role_permissions', 'Failed to load role permissions'),
        );
        // keep existing permissions visible on error
      } finally {
        // no-op: we no longer show a loading state for role changes
      }
    },
    [t],
  );

  const fetchRoles = useCallback(async () => {
    try {
      const res = await fetch('/api/user-management/roles', {
        headers: authHeadersWithToken(),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message || json.error || `Failed to load roles (${res.status})`);
      }
      const data = json.data || json;
      const mapped: RoleSummary[] = (Array.isArray(data) ? data : []).map((r: any) => ({
        id: String(r.IDNo ?? r.id ?? r.ID ?? r.role_id),
        name: r.ROLE || r.role || '—',
      }));
      // Exclude Administrator / super admin role from CRUD matrix,
      // since that role should always have full access and controls others.
      const filtered = mapped.filter((role) => {
        const name = role.name?.toLowerCase().trim();
        const id = String(role.id).trim();
        if (!name) return true;
        if (name === 'administrator' || name === 'admin') return false;
        if (id === '1') return false;
        return true;
      });
      setRoles(filtered);
      if (!selectedRoleId && filtered.length > 0) {
        const firstId = String(filtered[0].id);
        setSelectedRoleId(firstId);
        const cached = rolePermissionsCache[firstId];
        if (cached) {
          setRolePermissions(cached);
          setOriginalRolePermissions(cached);
        } else {
          fetchRolePermissions(firstId);
        }
      }
    } catch (e: any) {
      console.error('Failed to fetch roles for User Access', e);
      toast.error(e.message || t('user_access.failed_to_load_roles', 'Failed to load roles'));
    }
  }, [selectedRoleId, t, fetchRolePermissions, rolePermissionsCache]);

  useEffect(() => {
    if (isAdmin) {
      fetchData();
      fetchRoles();
    }
  }, [isAdmin, fetchData, fetchRoles]);

  // We fetch role CRUD permissions explicitly when:
  // - roles first load (default role), and
  // - user clicks on a role in the list (with cache check in the click handler).

  const selectedBranch = branches.find((b) => String(b.id) === String(selectedBranchId)) ?? null;

  const isChecked = (branchId: string | number, featureKey: string) => {
    const list = permissions[String(branchId)];
    if (!list || list.length === 0) return true; // default: all enabled
    return list.includes(featureKey);
  };

  const togglePermission = (branchId: string | number, featureKey: SidebarFeatureKey) => {
    const id = String(branchId);
    const current = permissions[id] || [];
    const hasFeature = current.includes(featureKey);
    let next: string[];
    if (current.length === 0) {
      next = SIDEBAR_FEATURE_KEYS.filter((k) => k !== featureKey);
    } else if (hasFeature) {
      next = current.filter((k) => k !== featureKey);
    } else {
      next = [...current, featureKey];
    }
    setPermissions((prev) => ({ ...prev, [id]: next }));
  };

  const getEnabledCount = (branchId: string | number) => {
    const list = permissions[String(branchId)];
    if (!list || list.length === 0) return SIDEBAR_FEATURE_KEYS.length;
    return list.length;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/branch/sidebar-permissions', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ permissions }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message || json.error || 'Failed to save');
      }
      toast.success(t('user_access.saved', 'Sidebar permissions updated.'));
      fetchData();
    } catch (e: any) {
      toast.error(e.message || t('user_access.save_failed', 'Failed to save permissions'));
    } finally {
      setSaving(false);
    }
  };

  const toggleRolePermission = (
    moduleKey: CrudModuleKey,
    action: CrudActionKey,
  ) => {
    setRolePermissions((prev) => {
      const base = prev || {};
      const currentForModule = base[moduleKey] || {};
      const nextValue = !currentForModule[action];
      return {
        ...base,
        [moduleKey]: {
          ...currentForModule,
          [action]: nextValue,
        },
      };
    });
  };

  const handleSaveRolePermissions = async () => {
    if (!selectedRoleId) return;
    setRolePermSaving(true);
    try {
      const res = await fetch(
        `/api/user-management/roles/${selectedRoleId}/crud-permissions`,
        {
          method: 'PUT',
          headers: authHeadersWithToken(),
          body: JSON.stringify({ permissions: rolePermissions || {} }),
        },
      );
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        throw new Error(json.message || json.error || 'Failed to save role permissions');
      }
      toast.success(
        t('user_access.role_permissions_saved', 'Role permissions updated.'),
      );
      setOriginalRolePermissions(rolePermissions || {});
      if (selectedRoleId) {
        fetchRolePermissions(selectedRoleId);
      }
      // Notify other parts of the app (e.g. useCrudPermissions hook) to reload
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('crud-permissions-updated'));
      }
    } catch (e: any) {
      toast.error(
        e.message ||
          t('user_access.role_permissions_save_failed', 'Failed to save role permissions'),
      );
    } finally {
      setRolePermSaving(false);
    }
  };

  if (!isAdmin) {
    return <Navigate to="/users/info" replace />;
  }

  if (error) {
    return (
      <div className="rounded-xl bg-red-50 border border-red-200 p-6 text-red-700">
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="pt-6 space-y-6 overflow-x-hidden">
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-bold text-brand-text">
            {t('user_access.title', 'User Access')}
          </h2>
          <p className="text-sm text-brand-muted mt-1">
            {t(
              'user_access.subtitle',
              'Manage sidebar and role-based access. Only admin can change these.',
            )}
          </p>
        </div>

        {/* Tabs styled like ExpensesMock summary cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => setActiveTab('branches')}
            className={cn(
              'text-left bg-white rounded-2xl shadow-sm border px-6 py-5 transition-all cursor-pointer',
              activeTab === 'branches'
                ? 'border-brand-primary/40 shadow-brand-primary/20 shadow-lg'
                : 'border-gray-100 hover:border-brand-primary/20 hover:shadow-sm',
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[12px] font-black tracking-wide text-brand-muted uppercase">
                  Branches
                </div>
                <div className="text-2xl font-black tracking-tight text-brand-text mt-1">
                  {branches.length}
                </div>
                <div className="text-xs text-brand-muted mt-1">
                  Manage which sidebar items each branch can see.
                </div>
              </div>
              <div className="h-11 w-11 rounded-2xl bg-brand-primary/10 border border-brand-primary/10 flex items-center justify-center">
                <div className="h-5 w-5 rounded-full bg-brand-primary/70" />
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('user-role')}
            className={cn(
              'text-left bg-white rounded-2xl shadow-sm border px-6 py-5 transition-all cursor-pointer',
              activeTab === 'user-role'
                ? 'border-brand-orange/40 shadow-brand-orange/20 shadow-lg'
                : 'border-gray-100 hover:border-brand-orange/20 hover:shadow-sm',
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[12px] font-black tracking-wide text-brand-muted uppercase">
                  User Role
                </div>
                <div className="text-2xl font-black tracking-tight text-brand-text mt-1">
                  {roles.length || '—'}
                </div>
                <div className="text-xs text-brand-muted mt-1">
                  Configure add, edit, and delete permissions per role.
                </div>
              </div>
              <div className="h-11 w-11 rounded-2xl bg-brand-orange/10 border border-brand-orange/10 flex items-center justify-center">
                <div className="h-5 w-5 rounded-full bg-brand-orange/70" />
              </div>
            </div>
          </button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'branches' && (
          <motion.div
            key="branches-tab"
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
          {/* Layout similar to ExpensesMock: left list + right table */}
          <div className="flex gap-6 items-stretch min-h-[560px]">
            {/* Left: Branches (like Sub Category) */}
            <section className="w-[360px] shrink-0 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
              <div className="px-5 py-4 border-b border-gray-100">
                <div>
                  <div className="text-sm font-black tracking-wide text-brand-text uppercase">
                    Branches
                  </div>
                  <div className="text-xs text-brand-muted mt-1">
                    Select a branch to show its menu items.
                  </div>
                </div>
              </div>

              <div className="p-2 flex-1 min-h-0 overflow-auto overflow-x-hidden custom-scrollbar relative">
                <AnimatePresence mode="wait">
                  <motion.div
                    key="branches-list"
                    initial={{ opacity: 0, x: 32 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -32 }}
                    transition={{ duration: 0.22, ease: 'easeOut' }}
                    className="space-y-1"
                  >
                    {branches.length === 0 ? (
                      <div className="px-4 py-6 text-sm text-brand-muted">No branches.</div>
                    ) : (
                      branches.map((b) => {
                        const active = String(b.id) === String(selectedBranchId);
                        const count = getEnabledCount(b.id);
                        return (
                          <div
                            key={b.id}
                            className={cn(
                              'group flex items-center rounded-xl transition-colors relative',
                              active ? 'bg-brand-orange/10' : 'hover:bg-brand-bg',
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => setSelectedBranchId(b.id)}
                              className={cn(
                                'flex-1 text-left px-4 py-3 min-w-0 cursor-pointer',
                                active ? 'text-brand-utilities' : 'text-brand-text',
                              )}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <span
                                  className={cn(
                                    'flex-1 break-words',
                                    active ? 'font-semibold' : 'font-normal',
                                  )}
                                >
                                  {b.name}
                                </span>
                                <span
                                  className={cn(
                                    'text-[11px] px-2 py-0.5 rounded-full shrink-0',
                                    active
                                      ? 'bg-brand-orange/15 text-brand-utilities'
                                      : 'bg-gray-100 text-brand-muted',
                                  )}
                                  title={`${count} menu items visible`}
                                >
                                  {count}
                                </span>
                              </div>
                              {b.code && (
                                <div className="text-[11px] text-brand-muted mt-0.5">
                                  {b.code}
                                </div>
                              )}
                            </button>
                          </div>
                        );
                      })
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </section>

            {/* Right: Menu items (like Table Items) */}
            <section className="flex-1 min-w-0">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden h-full flex flex-col">
                <div className="px-6 py-5 border-b border-gray-100">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <div className="text-sm font-black tracking-wide text-brand-text uppercase">
                        Menu Items
                      </div>
                      <div className="text-xs text-brand-muted mt-1">
                        {selectedBranch ? (
                          <>
                            Showing sidebar menu for{' '}
                            <span className="font-bold text-brand-text">
                              {selectedBranch.name}
                            </span>
                            . Check the items this branch can see in the sidebar.
                          </>
                        ) : (
                          'Select a branch to display menu items.'
                        )}
                      </div>
                    </div>
                    {selectedBranchId != null && (
                      <button
                        type="button"
                        onClick={handleSave}
                        disabled={
                          saving ||
                          areBranchPermissionsEqual(permissions, initialPermissions)
                        }
                        className="bg-brand-primary text-white px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-brand-primary/20 hover:bg-brand-primary/90 disabled:opacity-70 transition-all cursor-pointer disabled:cursor-not-allowed"
                      >
                        {saving ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Save className="w-4 h-4" />
                        )}
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-hidden">
                  <div className="h-full overflow-auto overflow-x-hidden custom-scrollbar">
                    <AnimatePresence mode="wait">
                      {selectedBranchId == null ? (
                        <motion.div
                          key="table-empty"
                          initial={{ opacity: 0, x: 24 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -24 }}
                          transition={{ duration: 0.18, ease: 'easeOut' }}
                          className="px-6 py-10 text-sm text-brand-muted"
                        >
                          Choose a branch to load menu items.
                        </motion.div>
                      ) : (
                        <motion.div
                          key={`table-${selectedBranchId}`}
                          initial={{ opacity: 0, x: 40 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -40 }}
                          transition={{ duration: 0.24, ease: 'easeOut' }}
                          className="p-0"
                        >
                          <div className="w-full">
                            <div className="overflow-x-auto">
                              <table className="w-full text-left">
                                <thead>
                                  <tr className="bg-white border-b border-gray-100">
                                    <th className="px-6 py-4 text-[13px] font-medium whitespace-nowrap bg-violet-50 text-brand-text uppercase tracking-wider border-r-[3px] border-white">
                                      Menu Item
                                    </th>
                                    <th className="px-6 py-4 text-[13px] font-medium whitespace-nowrap text-brand-muted uppercase tracking-wider w-24 text-center">
                                      Visible
                                    </th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50">
                                  {SIDEBAR_FEATURE_KEYS.map((featureKey) => (
                                    <tr
                                      key={featureKey}
                                      className="group transition-colors"
                                    >
                                      <td className="px-4 py-3 text-[13px] text-brand-text bg-violet-50 font-medium group-hover:bg-violet-100 border-r-[3px] border-white">
                                        {SIDEBAR_FEATURE_LABELS[featureKey] ?? featureKey}
                                      </td>
                                      <td className="px-4 py-3 bg-white group-hover:bg-brand-bg/50 text-center">
                                        <FancyCheckbox
                                          checked={isChecked(
                                            selectedBranchId,
                                            featureKey,
                                          )}
                                          onChange={() =>
                                            togglePermission(
                                              selectedBranchId,
                                              featureKey,
                                            )
                                          }
                                        />
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </div>
            </section>
          </div>
          </motion.div>
        )}

        {activeTab === 'user-role' && (
          <motion.div
            key="user-role-tab"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="flex gap-6 items-stretch min-h-[560px]"
          >
          {/* Left: Roles */}
          <section className="w-[320px] shrink-0 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-gray-100">
              <div className="text-sm font-black tracking-wide text-brand-text uppercase">
                Roles
              </div>
              <div className="text-xs text-brand-muted mt-1">
                Select a role to configure its CRUD access.
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto custom-scrollbar p-2 space-y-1">
              {roles.length === 0 ? (
                <div className="px-4 py-6 text-sm text-brand-muted">
                  No roles found.
                </div>
              ) : (
                roles.map((role) => {
                  const active = String(role.id) === String(selectedRoleId);
                  return (
                    <button
                      key={role.id}
                      type="button"
                      onClick={() => {
                        const id = String(role.id);
                        setSelectedRoleId(id);
                        const cached = rolePermissionsCache[id];
                        if (cached) {
                          setRolePermissions(cached);
                          setOriginalRolePermissions(cached);
                        } else {
                          fetchRolePermissions(id);
                        }
                      }}
                      className={cn(
                        'w-full text-left px-4 py-3 rounded-xl flex items-center justify-between cursor-pointer transition-colors',
                        active
                          ? 'bg-brand-primary/10 text-brand-primary'
                          : 'hover:bg-brand-bg text-brand-text',
                      )}
                    >
                      <span className={cn('font-medium truncate', active && 'font-semibold')}>
                        {role.name}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {/* Right: CRUD matrix (match branches layout to avoid scroll flicker) */}
          <section className="flex-1 min-w-0">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden h-full flex flex-col">
              <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <div className="text-sm font-black tracking-wide text-brand-text uppercase">
                    Role Permissions
                  </div>
                  <div className="text-xs text-brand-muted mt-1">
                    {selectedRoleId
                      ? 'Toggle which modules this role can Add, Edit, or Delete.'
                      : 'Select a role to edit its permissions.'}
                  </div>
                </div>
                {selectedRoleId && (
                  <button
                    type="button"
                    onClick={handleSaveRolePermissions}
                    disabled={
                      rolePermSaving ||
                      areRolePermissionsEqual(rolePermissions, originalRolePermissions)
                    }
                    className="bg-brand-primary text-white px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-brand-primary/20 hover:bg-brand-primary/90 disabled:opacity-70 disabled:cursor-not-allowed transition-all"
                  >
                    {rolePermSaving ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    {rolePermSaving ? 'Saving...' : 'Save'}
                  </button>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-hidden">
                <div className="h-full overflow-auto overflow-x-hidden custom-scrollbar">
                  <AnimatePresence mode="wait">
                    {!selectedRoleId ? (
                      <motion.div
                        key="role-empty"
                        initial={{ opacity: 0, x: 24 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -24 }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                        className="px-6 py-10 text-sm text-brand-muted"
                      >
                        Choose a role on the left to configure its CRUD permissions.
                      </motion.div>
                    ) : (
                      <motion.div
                        key={`role-${selectedRoleId}`}
                        initial={{ opacity: 0, x: 40 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -40 }}
                        transition={{ duration: 0.24, ease: 'easeOut' }}
                        className="p-0"
                      >
                        <div className="w-full">
                          <div className="overflow-x-auto">
                            <table className="w-full text-left">
                              <thead>
                                <tr className="bg-white border-b border-gray-100">
                                  <th className="px-6 py-4 text-[13px] font-medium whitespace-nowrap bg-violet-50 text-brand-text uppercase tracking-wider border-r-[3px] border-white">
                                    Module
                                  </th>
                                  <th className="px-6 py-4 text-[13px] font-medium whitespace-nowrap text-brand-muted uppercase tracking-wider w-24 text-center">
                                    Add
                                  </th>
                                  <th className="px-6 py-4 text-[13px] font-medium whitespace-nowrap text-brand-muted uppercase tracking-wider w-24 text-center">
                                    Edit
                                  </th>
                                  <th className="px-6 py-4 text-[13px] font-medium whitespace-nowrap text-brand-muted uppercase tracking-wider w-24 text-center">
                                    Delete
                                  </th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-50">
                                {CRUD_MODULES.map((mod) => {
                                  const perms = (rolePermissions || {})[mod.key] || {};
                                  return (
                                    <tr key={mod.key} className="group transition-colors">
                                      <td className="px-4 py-3 text-[13px] text-brand-text bg-violet-50 font-medium group-hover:bg-violet-100 border-r-[3px] border-white align-top">
                                        <div className="font-medium text-brand-text">
                                          {mod.label}
                                        </div>
                                        <div className="text-xs text-brand-muted mt-0.5">
                                          {mod.description}
                                        </div>
                                      </td>
                                      {(['create', 'update', 'delete'] as CrudActionKey[]).map(
                                        (action) => (
                                          <td
                                            key={action}
                                            className="px-4 py-3 bg-white group-hover:bg-brand-bg/50 text-center align-middle"
                                          >
                                            <FancyCheckbox
                                              checked={!!perms[action]}
                                              onChange={() =>
                                                toggleRolePermission(mod.key, action)
                                              }
                                            />
                                          </td>
                                        ),
                                      )}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                        <p className="text-[11px] text-brand-muted mt-3 px-6 pb-4">
                          Unchecking an action will hide the corresponding Add / Edit / Delete
                          controls for this role in that module.
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </section>
          </motion.div>
        )}
      </AnimatePresence>

      <p className="text-xs text-brand-muted flex items-center gap-1.5">
        <Shield className="w-3.5 h-3.5" />
        {t('user_access.admin_only', 'Only administrators can view and edit these permissions.')}
      </p>
    </div>
  );
};
