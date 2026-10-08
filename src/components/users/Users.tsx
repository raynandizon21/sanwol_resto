import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Search, Loader2, Shield, User as UserIcon, Plus, Edit2, Trash2, Key, MapPin, Tablet } from 'lucide-react';
import { DataTable, ColumnDef } from '../ui/DataTable';
import { Modal } from '../ui/Modal';
import { Select2 } from '../ui/Select2';
import { cn } from '../../lib/utils';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { SkeletonPage, SkeletonStatCards, SkeletonPageHeader, SkeletonTable } from '../ui/Skeleton';
import { useUser } from '../../context/UserContext';
import { is3coreBranch, sortBranchesBySidebarOrder } from '../../utils/branchLogo';
import { isFloorEnabledBranch } from '../../utils/floorScope';

// Accounts protected from edit/delete in this UI (system/developer accounts).
const PROTECTED_USERNAMES = ['admin', '3coredev'];
const isProtectedUsername = (username: string) => PROTECTED_USERNAMES.includes((username || '').trim().toLowerCase());

interface UserRow {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  username: string;
  role: string;
  roleId: string | number;
  branch: string;
  branchId: string | number | null;
  tableNumber: string | number | null;
  tableId: string | number | null;
  floor: string;
  status: 'Active' | 'Inactive';
}

export const Users: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useUser();
  const location = useLocation();

  const isAdmin = user?.permissions === 1;
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const branchIdFromHeader = searchParams.get('branchId');
  const effectiveBranchId = isAdmin
    ? null
    : (branchIdFromHeader && branchIdFromHeader !== 'all' ? branchIdFromHeader : (user?.branch_id ?? null));

  const [users, setUsers] = useState<UserRow[]>([]);
  const [filteredUsers, setFilteredUsers] = useState<UserRow[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  /** Branch tab key (`all` or a branch label); admin-only grouping of the user table. */
  const [activeBranchTab, setActiveBranchTab] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [userToDelete, setUserToDelete] = useState<UserRow | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Form State
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    username: '',
    password: '',
    confirmPassword: '',
    roleId: '' as string | number,
    branchId: '' as string | number | null,
    tableId: '' as string | number | null,
    floor: '' as string,
  });

  // Options State
  const [roles, setRoles] = useState<{ value: string | number, label: string }[]>([]);
  const [branches, setBranches] = useState<{ value: string | number, label: string }[]>([]);
  const [tables, setTables] = useState<{ value: string | number, label: string }[]>([]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/user-management/users', {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) {
        throw new Error(`Failed to load users (${res.status})`);
      }
      const json = await res.json();
      const rawData = json.data ?? json;
      const mappedData: UserRow[] = (Array.isArray(rawData) ? rawData : []).map((u: any) => ({
        id: u.user_id || u.IDNo,
        firstName: u.FIRSTNAME || '',
        lastName: u.LASTNAME || '',
        fullName: `${u.FIRSTNAME || ''} ${u.LASTNAME || ''}`.trim(),
        username: u.USERNAME || '',
        role: u.role || u.ROLE || '',
        roleId: u.PERMISSIONS || u.ROLE_ID || '',
        branch: u.BRANCH_LABEL || u.BRANCH_NAME || '—',
        branchId: u.BRANCH_ID || null,
        tableNumber: u.TABLE_NUMBER || '—',
        tableId: u.TABLE_ID || null,
        floor: u.FLOOR || '',
        status: u.ACTIVE === 1 ? 'Active' : 'Inactive'
      }));
      setUsers(mappedData);
    } catch (e: any) {
      console.error('Failed to fetch users', e);
      setError(e.message || t('manage_users.failed_to_load'));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchOptions = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      const processResponse = async (res: Response, name: string) => {
        if (!res.ok) {
          console.error(`Failed to fetch ${name}. Status: ${res.status}`);
          const text = await res.text();
          console.error(`Raw error response for ${name}:`, text);
          return null;
        }

        const text = await res.text();
        try {
          const json = JSON.parse(text);
          return json.data ?? json;
        } catch (e) {
          console.error(`Error parsing JSON for ${name}:`, e);
          console.error(`Raw response for ${name}:`, text);
          return null;
        }
      };

      const [rolesRes, branchesRes, tablesRes] = await Promise.all([
        fetch('/api/user-management/roles', { headers }),
        fetch('/branch', { headers }),
        fetch('/api/tables', { headers })
      ]);

      const rolesData = await processResponse(rolesRes, 'roles');
      if (rolesData) {
        setRoles(rolesData.map((r: any) => ({ value: r.IDNo, label: r.ROLE })));
      }

      const branchesData = await processResponse(branchesRes, 'branches');
      if (branchesData) {
        setBranches(branchesData.map((b: any) => ({ value: b.IDNo, label: b.BRANCH_LABEL || b.BRANCH_NAME })));
      }

      const tablesData = await processResponse(tablesRes, 'tables');
      if (tablesData) {
        setTables(tablesData.map((t: any) => ({ value: t.IDNo, label: `Table ${t.TABLE_NUMBER}` })));
      }

    } catch (e) {
      console.error('Failed to fetch options', e);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
    fetchOptions();
  }, [fetchUsers, fetchOptions]);

  const branchFilteredUsers = useMemo(() => {
    if (isAdmin) return users;
    if (effectiveBranchId == null) return [];
    return users.filter((u) => String(u.branchId) === String(effectiveBranchId));
  }, [users, isAdmin, effectiveBranchId]);

  const branchTabKey = (u: UserRow) => (u.branch || '').trim() || '—';

  const searchedUsers = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return branchFilteredUsers.filter((u) =>
      (u.fullName || '').toLowerCase().includes(q) ||
      (u.username || '').toLowerCase().includes(q) ||
      (u.role || '').toLowerCase().includes(q) ||
      (u.branch || '').toLowerCase().includes(q) ||
      floorLabel(u).toLowerCase().includes(q)
    );
  }, [searchQuery, branchFilteredUsers]);

  /**
   * Tabs = every branch with users (sidebar order) + 3Core last. Counts follow the search box.
   */
  const branchTabs = useMemo(() => {
    const present = new Map<string, { id: string; name: string }>();
    for (const u of branchFilteredUsers) {
      const key = branchTabKey(u);
      if (!present.has(key)) present.set(key, { id: key, name: key });
    }
    const candidates = Array.from(present.values());
    const ordered = [
      ...sortBranchesBySidebarOrder(candidates, { exclude3core: true }),
      ...candidates.filter((b) => is3coreBranch(b.name)),
    ];
    return ordered.map((b) => ({
      key: b.name,
      count: searchedUsers.filter((u) => branchTabKey(u) === b.name).length,
    }));
  }, [branchFilteredUsers, searchedUsers]);

  const showBranchTabs = branchTabs.length > 1;

  useEffect(() => {
    if (activeBranchTab !== 'all' && !branchTabs.some((tab) => tab.key === activeBranchTab)) {
      setActiveBranchTab('all');
    }
  }, [activeBranchTab, branchTabs]);

  useEffect(() => {
    setFilteredUsers(
      showBranchTabs && activeBranchTab !== 'all'
        ? searchedUsers.filter((u) => branchTabKey(u) === activeBranchTab)
        : searchedUsers,
    );
  }, [searchedUsers, showBranchTabs, activeBranchTab]);

  useEffect(() => {
    if (formData.confirmPassword && formData.password !== formData.confirmPassword) {
      setPasswordError(t('manage_users.passwords_do_not_match'));
    } else {
      setPasswordError(null);
    }
  }, [formData.password, formData.confirmPassword]);

  const handleOpenAddModal = () => {
    setEditingUser(null);
    setFormData({
      firstName: '',
      lastName: '',
      username: '',
      password: '',
      confirmPassword: '',
      roleId: '',
      branchId: null,
      tableId: null,
      floor: '',
    });
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (user: UserRow) => {
    setEditingUser(user);
    setFormData({
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      password: '',
      confirmPassword: '',
      roleId: user.roleId,
      branchId: user.branchId,
      tableId: user.tableId,
      floor: user.floor,
    });
    setIsModalOpen(true);
  };

  const handleOpenDeleteModal = (user: UserRow) => {
    setUserToDelete(user);
    setIsDeleteModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordError) {
      return;
    }

    setIsSubmitting(true);
    try {
      const token = localStorage.getItem('token');
      const url = editingUser
        ? `/api/user-management/users/${editingUser.id}`
        : '/api/user-management/users';
      const method = editingUser ? 'PUT' : 'POST';

      const payload = {
        txtFirstName: formData.firstName,
        txtLastName: formData.lastName,
        txtUserName: formData.username,
        txtPassword: formData.password,
        txtPassword2: formData.confirmPassword,
        user_role: formData.roleId,
        branch_id: formData.branchId,
        table_id: formData.tableId,
        floor: formData.floor || null,
      };

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        console.error("Failed to parse server response as JSON. Raw response:", text);
        throw new Error("Server returned an invalid response. Check console for details.");
      }

      if (!res.ok) {
        throw new Error(json.error || `Failed to ${editingUser ? 'update' : 'create'} user`);
      }

      toast.success(editingUser ? t('manage_users.toast.updated_success') : t('manage_users.toast.created_success'));
      setIsModalOpen(false);
      fetchUsers();
    } catch (e: any) {
      toast.error(e.message || t('manage_users.toast.save_error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!userToDelete) return;

    setIsSubmitting(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/user-management/users/${userToDelete.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (!res.ok) throw new Error(t('manage_users.toast.delete_failed'));

      toast.success(t('manage_users.toast.deleted_success', { name: userToDelete?.fullName }));
      setIsDeleteModalOpen(false);
      fetchUsers();
    } catch (e: any) {
      toast.error(e.message || t('manage_users.toast.delete_error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Floor shown in the list: the account's own floor when set; "All Floors" for a
  // waiter/cashier at a multi-floor branch with no floor (sees every floor); blank
  // for everyone else, where a floor doesn't apply.
  const floorLabel = (u: UserRow): string => {
    if (u.floor === 'gf') return t('table.ground_floor');
    if (u.floor === '2f') return t('table.second_floor');
    if (/waiter|cashier/i.test(u.role) && isFloorEnabledBranch(u.branchId)) {
      return t('manage_users.all_floors');
    }
    return '';
  };

  const columns: ColumnDef<UserRow>[] = [
    {
      header: t('manage_users.name'),
      render: (user) => <span className="text-sm font-bold">{user.fullName}</span>,
    },
    {
      header: t('manage_users.username'),
      render: (user) => <span className="text-sm font-bold text-brand-muted">{user.username}</span>,
    },
    {
      header: t('manage_users.role'),
      render: (user) => <span className="text-xs font-bold bg-gray-100 px-2 py-1 rounded-lg">{user.role}</span>,
    },
    {
      header: t('manage_users.branch'),
      render: (user) => <span className="text-sm font-medium">{user.branch}</span>,
    },
    {
      header: t('table.floor'),
      render: (user) => {
        const label = floorLabel(user);
        if (!label) return <span className="text-sm font-medium text-brand-muted">—</span>;
        return (
          <span
            className={cn(
              "text-xs font-bold px-2 py-1 rounded-lg whitespace-nowrap",
              user.floor === 'gf' && "bg-amber-100 text-amber-700",
              user.floor === '2f' && "bg-indigo-100 text-indigo-700",
              !user.floor && "bg-gray-100 text-brand-muted"
            )}
          >
            {label}
          </span>
        );
      },
    },
    {
      header: t('manage_users.table_no'),
      render: (user) => <span className="text-sm font-medium">{user.tableNumber}</span>,
    },
    {
      header: t('manage_users.status'),
      render: (user) => (
        <span
          className={cn(
            "text-xs font-bold px-2 py-1 rounded-lg",
            user.status === 'Active' ? "bg-green-100 text-green-600" : "bg-red-100 text-red-600"
          )}
        >
          {user.status === 'Active' ? t('manage_users.active') : t('manage_users.inactive')}
        </span>
      ),
    },
    {
      header: t('manage_users.action'),
      className: 'text-right',
      render: (user) =>
        isProtectedUsername(user.username) ? (
          <div className="flex justify-end items-center gap-2">
            <span className="text-xs font-medium text-brand-muted">—</span>
          </div>
        ) : (
          <div className="flex justify-end items-center gap-2">
            <button
              onClick={() => handleOpenEditModal(user)}
              className="p-2 text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors rounded-lg"
              title={t('manage_users.edit_user')}
            >
              <Edit2 size={16} />
            </button>
            <button
              onClick={() => handleOpenDeleteModal(user)}
              className="p-2 text-brand-muted hover:text-red-500 hover:bg-red-50 transition-colors rounded-lg"
              title={t('manage_users.delete_user')}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ),
    },
  ];

  return (
    <div className="space-y-8 pt-6">
      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div
            key="skeleton"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="space-y-8"
          >
            <SkeletonPageHeader />
            <SkeletonStatCards />
            <div className="bg-white rounded-2xl shadow-sm p-6">
              <SkeletonTable columns={7} rows={10} />
            </div>
          </motion.div>
        ) : error ? (
          <motion.div
            key="error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex items-center justify-center min-h-[500px]"
          >
            <p className="text-red-500 text-lg">{error}</p>
          </motion.div>
        ) : (
          <motion.div
            key="content"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="space-y-8"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                  <input
                    type="text"
                    placeholder={t('manage_users.search_placeholder')}
                    className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-80 shadow-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>
              <button
                onClick={handleOpenAddModal}
                className="bg-brand-primary text-white px-6 py-2.5 rounded-xl text-base font-bold flex items-center gap-2 shadow-lg shadow-brand-primary/20 hover:bg-brand-primary/90 transition-all"
              >
                <Plus size={18} />
                {t('manage_users.add_new_user')}
              </button>
            </div>

            <div className="grid grid-cols-4 gap-6">
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('manage_users.total_users')}</p>
                <h3 className="text-3xl font-bold">{branchFilteredUsers.length}</h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('manage_users.active_users')}</p>
                <h3 className="text-3xl font-bold text-green-600">{branchFilteredUsers.filter(u => u.status === 'Active').length}</h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('manage_users.inactive_users')}</p>
                <h3 className="text-3xl font-bold text-red-500">{branchFilteredUsers.filter(u => u.status === 'Inactive').length}</h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('manage_users.user_roles_count')}</p>
                <h3 className="text-3xl font-bold">{new Set(branchFilteredUsers.map(u => u.role)).size}</h3>
              </div>
            </div>

            {showBranchTabs && (
              <div className="flex items-center gap-1 overflow-x-auto rounded-2xl bg-white p-1.5 shadow-sm">
                {[{ key: 'all', count: searchedUsers.length }, ...branchTabs].map((tab) => {
                  const isActive = activeBranchTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => setActiveBranchTab(tab.key)}
                      className={cn(
                        'flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold whitespace-nowrap transition-colors',
                        isActive
                          ? 'bg-brand-primary text-white shadow-sm'
                          : 'text-brand-muted hover:bg-brand-primary/10 hover:text-brand-primary',
                      )}
                    >
                      {tab.key === 'all' ? t('table.all') : tab.key}
                      <span
                        className={cn(
                          'rounded-lg px-1.5 py-0.5 text-xs font-bold',
                          isActive ? 'bg-white/20 text-white' : 'bg-gray-100 text-brand-muted',
                        )}
                      >
                        {tab.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <DataTable
              data={filteredUsers}
              columns={columns}
              keyExtractor={(item) => item.id}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Add/Edit User Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          if (!isSubmitting) {
            setIsModalOpen(false);
            setFormData({
              firstName: '',
              lastName: '',
              username: '',
              password: '',
              confirmPassword: '',
              roleId: '',
              branchId: null,
              tableId: null,
              floor: '',
            });
          }
        }}
        title={editingUser ? t('manage_users.edit_user') : t('manage_users.add_new_user')}
        maxWidth="lg"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => setIsModalOpen(false)}
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {t('manage_users.cancel')}
            </button>
            <button
              onClick={handleSubmit}
              disabled={
                isSubmitting ||
                !formData.roleId ||
                (!editingUser && (!formData.username.trim() || !formData.password || !formData.confirmPassword)) ||
                (!!formData.password && formData.password !== formData.confirmPassword)
              }
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-brand-primary shadow-lg shadow-brand-primary/30 hover:bg-brand-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting && <Loader2 size={16} className="animate-spin" />}
              {editingUser ? t('manage_users.update_user') : t('manage_users.save_user')}
            </button>
          </div>
        }
      >
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">{t('manage_users.user_role')}</label>
              <Select2
                options={roles}
                value={formData.roleId}
                onChange={(val) => {
                  const selectedLabel = roles.find((r) => String(r.value) === String(val))?.label || '';
                  const isFloorRole = /waiter|cashier/i.test(selectedLabel);
                  setFormData({
                    ...formData,
                    roleId: val as string | number,
                    tableId: val === 2 ? formData.tableId : null,
                    floor: isFloorRole ? formData.floor : '',
                  });
                }}
                placeholder={t('manage_users.select_role')}
              />
            </div>

            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">{t('manage_users.branch')}</label>
              <Select2
                options={branches}
                value={formData.branchId}
                onChange={(val) => setFormData({
                  ...formData,
                  branchId: val as string | number | null,
                  floor: isFloorEnabledBranch(val as string | number | null) ? formData.floor : '',
                })}
                placeholder={t('manage_users.select_branch')}
                disabled={formData.roleId === 1}
              />
            </div>

            {Number(formData.roleId) === 2 && (
              <div className="space-y-2 col-span-2">
                <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">{t('manage_users.assigned_table')}</label>
                <Select2
                  options={tables}
                  value={formData.tableId}
                  onChange={(val) => setFormData({ ...formData, tableId: val as string | number | null })}
                  placeholder={t('manage_users.select_table')}
                />
              </div>
            )}

            {/waiter|cashier/i.test(roles.find((r) => String(r.value) === String(formData.roleId))?.label || '') && isFloorEnabledBranch(formData.branchId) && (
              <div className="space-y-2 col-span-2">
                <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">Floor</label>
                <Select2
                  options={[
                    { value: '', label: 'All Floors' },
                    { value: 'gf', label: 'Ground Floor' },
                    { value: '2f', label: '2nd Floor' },
                  ]}
                  value={formData.floor}
                  onChange={(val) => setFormData({ ...formData, floor: (val as string) || '' })}
                  placeholder="Select floor"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">{t('manage_users.first_name')}</label>
              <div className="relative">
                <input
                  type="text"
                  placeholder={t('manage_users.enter_first_name')}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                  value={formData.firstName}
                  onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">{t('manage_users.last_name')}</label>
              <div className="relative">
                <input
                  type="text"
                  placeholder={t('manage_users.enter_last_name')}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                  value={formData.lastName}
                  onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                  autoComplete="off"
                />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">{t('manage_users.username')}</label>
            <div className="relative">
              <input
                type="text"
                required={!editingUser}
                placeholder={t('manage_users.enter_username')}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {editingUser ? t('manage_users.new_password_optional') : t('manage_users.password')}
              </label>
              <div className="relative">
                <input
                  type="password"
                  required={!editingUser}
                  placeholder="••••••••"
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">{t('manage_users.confirm_password')}</label>
              <div className="relative">
                <input
                  type="password"
                  required={!editingUser || !!formData.password}
                  placeholder="••••••••"
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                  value={formData.confirmPassword}
                  onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                  autoComplete="new-password"
                />
              </div>
              {passwordError && <p className="text-red-500 text-xs mt-1.5">{passwordError}</p>}
            </div>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => !isSubmitting && setIsDeleteModalOpen(false)}
        title={t('manage_users.delete_user')}
        maxWidth="sm"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => setIsDeleteModalOpen(false)}
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {t('manage_users.cancel')}
            </button>
            <button
              onClick={confirmDelete}
              disabled={isSubmitting}
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-red-500 shadow-lg shadow-red-500/30 hover:bg-red-600 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting && <Loader2 size={16} className="animate-spin" />}
              {t('manage_users.delete_user')}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Trash2 size={32} />
          </div>
          <p className="text-center font-bold text-brand-text text-lg">{t('manage_users.delete_confirm_title')}</p>
          <p className="text-center text-brand-muted text-sm px-4">
            {t('manage_users.delete_confirm_text_prefix')} <span className="font-bold text-brand-text">{userToDelete?.fullName}</span>{t('manage_users.delete_confirm_text_suffix')}
          </p>
        </div>
      </Modal>
    </div>
  );
};
