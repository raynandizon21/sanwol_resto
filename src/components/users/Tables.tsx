import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Search, Loader2, Plus, Edit2, Trash2, Hash, Tablet } from 'lucide-react';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Modal } from '../ui/Modal';
import { Select2 } from '../ui/Select2';
import { cn } from '../../lib/utils';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { SkeletonPageHeader, SkeletonStatCards, SkeletonTable } from '../ui/Skeleton';
import { useUser } from '../../context/UserContext';
import { useCrudPermissions } from '../../hooks/useCrudPermissions';
import { isFloorEnabledBranch, type TableFloor } from '../../utils/floorScope';

interface TableRow {
  id: string | number;
  branchId: string | number | null;
  branchName: string;
  tableNumber: string;
  floor: TableFloor | null;
  capacity: number;
  roomCharge: number | null;
  status: number;
  encodedAt: string | null;
}

const authHeaders = (): HeadersInit => {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

export const Tables: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useUser();
  const isAdmin = user?.permissions === 1;
  const location = useLocation();

  const formatMoneyNoDecimals = useCallback((value: unknown) => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return '—';
    return Math.trunc(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }, []);

  const searchParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search]
  );
  const branchIdFromHeader = searchParams.get('branchId');
  const effectiveBranchIdForAdmin =
    isAdmin && branchIdFromHeader && branchIdFromHeader !== 'all'
      ? branchIdFromHeader
      : null;

  const [tables, setTables] = useState<TableRow[]>([]);
  const [filteredTables, setFilteredTables] = useState<TableRow[]>([]);
  const [branches, setBranches] = useState<{ value: string | number; label: string }[]>([]);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingTable, setEditingTable] = useState<TableRow | null>(null);
  const [tableToDelete, setTableToDelete] = useState<TableRow | null>(null);

  const [formData, setFormData] = useState<{
    branchId: string | number | null;
    tableNumber: string;
    floor: TableFloor | null;
    capacity: string;
    roomCharge: string;
    status: number;
  }>({
    branchId: null,
    tableNumber: '',
    floor: null,
    capacity: '',
    roomCharge: '',
    status: 1,
  });

  const { canCreate, canUpdate, canDelete } = useCrudPermissions();

  const statusLabel = useCallback(
    (status: number) => {
      switch (Number(status)) {
        case 1:
          return t('table.available');
        case 2:
          return t('table.occupied');
        case 3:
          return t('table.reserved');
        case 0:
          return t('table.not_available');
        default:
          return t('table.unknown');
      }
    },
    [t]
  );

  const statusBadge = (status: number) => {
    const label = statusLabel(status);
    let style = 'bg-gray-100 text-gray-600';
    if (status === 1) style = 'bg-green-100 text-green-600';
    else if (status === 2) style = 'bg-orange-100 text-orange-600';
    else if (status === 3) style = 'bg-blue-100 text-blue-600';
    else if (status === 0) style = 'bg-red-100 text-red-600';

    return (
      <span className={cn('text-xs font-bold px-2 py-1 rounded-lg', style)}>
        {label}
      </span>
    );
  };

  const fetchBranches = useCallback(async () => {
    try {
      const res = await fetch('/branch', { headers: authHeaders() });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `Failed to load branches (${res.status})`);
      }
      const rawData = json.data ?? json;
      const mapped = (Array.isArray(rawData) ? rawData : []).map((b: any) => ({
        value: b.IDNo,
        label: b.BRANCH_LABEL || b.BRANCH_NAME || '—',
      }));
      setBranches(mapped);
    } catch (e) {
      console.error('Failed to fetch branches for tables', e);
    }
  }, []);

  const fetchTables = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const branchQuery = effectiveBranchIdForAdmin
        ? `?branch_id=${encodeURIComponent(String(effectiveBranchIdForAdmin))}`
        : '';
      const res = await fetch(`/data-api/restaurant_tables${branchQuery}`, {
        headers: authHeaders(),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || json.message || t('table.failed_to_load_tables'));
      }
      const rawData = json.data ?? json;
      const mappedData: TableRow[] = (Array.isArray(rawData) ? rawData : []).map((rt: any) => ({
        id: rt.IDNo,
        branchId: rt.BRANCH_ID ?? null,
        branchName: rt.BRANCH_LABEL || '—',
        tableNumber: String(rt.TABLE_NUMBER ?? '—'),
        floor: rt.FLOOR === 'gf' || rt.FLOOR === '2f' ? (rt.FLOOR as TableFloor) : null,
        capacity: Number(rt.CAPACITY ?? 0),
        roomCharge:
          rt.ROOM_CHARGE != null && rt.ROOM_CHARGE !== ''
            ? Number(rt.ROOM_CHARGE)
            : null,
        status: Number(rt.STATUS ?? 0),
        encodedAt: rt.ENCODED_DT || null,
      }));
      setTables(mappedData);
    } catch (e: any) {
      console.error('Failed to fetch restaurant tables', e);
      setError(e.message || t('table.failed_to_load_tables'));
      setTables([]);
    } finally {
      setLoading(false);
    }
  }, [t, effectiveBranchIdForAdmin]);

  useEffect(() => {
    fetchTables();
    fetchBranches();
  }, [fetchTables, fetchBranches]);

  const filtered = useMemo(() => {
    const term = searchQuery.trim().toLowerCase();
    return tables.filter((tbl) => {
      const chargeStr =
        tbl.roomCharge != null && !Number.isNaN(tbl.roomCharge)
          ? String(tbl.roomCharge)
          : '';
      const matchesSearch =
        !term ||
        tbl.tableNumber.toLowerCase().includes(term) ||
        tbl.branchName.toLowerCase().includes(term) ||
        String(tbl.capacity).includes(term) ||
        chargeStr.includes(term);
      const matchesStatus =
        statusFilter === 'all' || String(tbl.status) === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [tables, searchQuery, statusFilter]);

  useEffect(() => {
    setFilteredTables(filtered);
  }, [filtered]);

  const handleOpenAddModal = () => {
    setEditingTable(null);
    setFormData({
      branchId: isAdmin ? null : user?.branch_id || null,
      tableNumber: '',
      floor: null,
      capacity: '',
      roomCharge: '',
      status: 1,
    });
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (table: TableRow) => {
    setEditingTable(table);
    setFormData({
      branchId: table.branchId,
      tableNumber: table.tableNumber === '—' ? '' : table.tableNumber,
      floor: table.floor,
      capacity: table.capacity ? String(table.capacity) : '',
      roomCharge:
        table.roomCharge != null && !Number.isNaN(table.roomCharge)
          ? String(table.roomCharge)
          : '',
      status: table.status ?? 1,
    });
    setIsModalOpen(true);
  };

  const handleOpenDeleteModal = (table: TableRow) => {
    setTableToDelete(table);
    setIsDeleteModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.tableNumber.trim()) {
      toast.error(t('table.table_number') + ' ' + (t('branch.required') ?? ''));
      return;
    }

    if (!isAdmin && !user?.branch_id) {
      toast.error(t('table.failed_to_create_table'));
      return;
    }

    setIsSubmitting(true);
    try {
      const payload: any = {
        TABLE_NUMBER: formData.tableNumber.trim(),
        FLOOR: isFloorEnabledBranch(formData.branchId) ? formData.floor : null,
        CAPACITY: formData.capacity || '0',
        ROOM_CHARGE: formData.roomCharge.trim(),
        STATUS: formData.status,
      };
      if (isAdmin && formData.branchId) {
        payload.BRANCH_ID = formData.branchId;
      }

      const url = editingTable
        ? `/data-api/restaurant_table/${editingTable.id}`
        : '/data-api/restaurant_table';
      const method = editingTable ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });

      let data: any = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }

      if (!res.ok || data?.success === false) {
        throw new Error(
          data?.error ||
            data?.message ||
            (editingTable
              ? t('table.failed_to_update_table')
              : t('table.failed_to_create_table'))
        );
      }

      toast.success(
        editingTable
          ? t('table.table_updated_successfully')
          : t('table.table_created_successfully')
      );
      setIsModalOpen(false);
      fetchTables();
    } catch (e: any) {
      toast.error(
        e?.message ||
          (editingTable
            ? t('table.failed_to_update_table')
            : t('table.failed_to_create_table'))
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!tableToDelete) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/data-api/restaurant_table/${tableToDelete.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      let data: any = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (!res.ok || data?.success === false) {
        throw new Error(
          data?.error ||
            data?.message ||
            t('table.failed_to_delete_table')
        );
      }
      toast.success(t('table.table_deleted_successfully'));
      setIsDeleteModalOpen(false);
      fetchTables();
    } catch (e: any) {
      toast.error(e?.message || t('table.failed_to_delete_table'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const columns: ColumnDef<TableRow>[] = [
    {
      header: t('table.branch'),
      render: (tbl) => (
        <span className="text-sm font-medium">{tbl.branchName}</span>
      ),
    },
    {
      header: t('table.table_number'),
      render: (tbl) => (
        <span className="text-sm font-bold text-brand-text flex items-center gap-2">
          <Hash size={16} className="text-brand-muted" />
          {tbl.tableNumber}
        </span>
      ),
    },
    {
      header: t('table.capacity'),
      render: (tbl) => (
        <span className="text-sm font-medium">{tbl.capacity}</span>
      ),
    },
    {
      header: t('table.room_charge'),
      render: (tbl) => (
        <span className="text-sm font-medium tabular-nums">
          {tbl.roomCharge != null ? formatMoneyNoDecimals(tbl.roomCharge) : '—'}
        </span>
      ),
    },
    {
      header: t('table.status'),
      render: (tbl) => statusBadge(tbl.status),
    },
    {
      header: t('table.actions'),
      className: 'text-right',
      render: (tbl) => (
        <div className="flex justify-end items-center gap-2">
          {canUpdate('table_settings') && (
            <button
              onClick={() => handleOpenEditModal(tbl)}
              className="p-2 text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors rounded-lg"
              title={t('table.table_number')}
            >
              <Edit2 size={16} />
            </button>
          )}
          {canDelete('table_settings') && (
            <button
              onClick={() => handleOpenDeleteModal(tbl)}
              className="p-2 text-brand-muted hover:text-red-500 hover:bg-red-50 transition-colors rounded-lg"
              title={t('table.delete_confirmation_title')}
            >
              <Trash2 size={16} />
            </button>
          )}
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
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="space-y-8"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <Search
                    size={18}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted"
                  />
                  <input
                    type="text"
                    placeholder={t(
                      'table.pagination.search_placeholder'
                    )}
                    className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-80 shadow-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <Select2
                  options={[
                    { value: 'all', label: t('table.all') },
                    { value: '1', label: t('table.available') },
                    { value: '2', label: t('table.occupied') },
                    { value: '3', label: t('table.reserved') },
                    { value: '0', label: t('table.not_available') },
                  ]}
                  value={statusFilter}
                  onChange={(v) => setStatusFilter((v as string) || 'all')}
                  placeholder={t('table.status')}
                  className="w-48"
                />
              </div>
              {canCreate('table_settings') && (
                <button
                  onClick={handleOpenAddModal}
                  className="bg-brand-primary text-white px-6 py-2.5 rounded-xl text-base font-bold flex items-center gap-2 shadow-lg shadow-brand-primary/20 hover:bg-brand-primary/90 transition-all"
                >
                  <Plus size={18} />
                  {t('table.new_table')}
                </button>
              )}
            </div>

            <div className="grid grid-cols-3 gap-6">
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">
                  {t('table.manage_restaurant_tables')}
                </p>
                <h3 className="text-3xl font-bold">{tables.length}</h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">
                  {t('table.available')}
                </p>
                <h3 className="text-3xl font-bold text-green-600">
                  {tables.filter((tbl) => tbl.status === 1).length}
                </h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">
                  {t('table.occupied')}
                </p>
                <h3 className="text-3xl font-bold text-orange-500">
                  {tables.filter((tbl) => tbl.status === 2).length}
                </h3>
              </div>
            </div>

            <DataTable
              data={filteredTables}
              columns={columns}
              keyExtractor={(item) => String(item.id)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Add/Edit Table Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          if (!isSubmitting) {
            setIsModalOpen(false);
            setFormData({
              branchId: isAdmin ? null : user?.branch_id || null,
              tableNumber: '',
              floor: null,
              capacity: '',
              roomCharge: '',
              status: 1,
            });
          }
        }}
        title={
          editingTable
            ? t('table.table_number') + ' - ' + t('table.status')
            : t('table.new_table')
        }
        maxWidth="lg"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => setIsModalOpen(false)}
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {t('manage_branches.cancel')}
            </button>
            <button
              onClick={handleSubmit}
              disabled={
                isSubmitting ||
                !formData.tableNumber.trim() ||
                (!isAdmin && !user?.branch_id) ||
                (isAdmin && !editingTable && !formData.branchId)
              }
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-brand-primary shadow-lg shadow-brand-primary/30 hover:bg-brand-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting && (
                <Loader2 size={16} className="animate-spin" />
              )}
              {editingTable ? 'Update' : 'Add'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('table.branch')}
              </label>
              <Select2
                options={branches}
                value={formData.branchId}
                onChange={(val) =>
                  setFormData((prev) => ({
                    ...prev,
                    branchId: val as string | number | null,
                    floor: isFloorEnabledBranch(val as string | number | null) ? prev.floor : null,
                  }))
                }
                placeholder={t('branch.select_branch') ?? 'Select branch'}
                disabled={!isAdmin}
              />
            </div>
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('table.status')}
              </label>
              <Select2
                options={[
                  { value: 1, label: t('table.available') },
                  { value: 2, label: t('table.occupied') },
                  { value: 3, label: t('table.reserved') },
                  { value: 0, label: t('table.not_available') },
                ]}
                value={formData.status}
                onChange={(val) =>
                  setFormData((prev) => ({
                    ...prev,
                    status: Number(val ?? 1),
                  }))
                }
                placeholder={t('table.status')}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('table.table_number')}
              </label>
              <div className="relative">
                <Hash
                  size={16}
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted"
                />
                <input
                  type="text"
                  placeholder={t('table.table_number')}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-10 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                  value={formData.tableNumber}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      tableNumber: e.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('table.capacity')}
              </label>
              <input
                type="number"
                min={0}
                placeholder={t('table.capacity')}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                value={formData.capacity}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    capacity: e.target.value,
                  }))
                }
              />
            </div>
          </div>

          {isFloorEnabledBranch(formData.branchId) && (
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('table.floor')}
              </label>
              <Select2
                options={[
                  { value: 'gf', label: t('table.ground_floor') },
                  { value: '2f', label: t('table.second_floor') },
                ]}
                value={formData.floor}
                onChange={(val) =>
                  setFormData((prev) => ({
                    ...prev,
                    floor: (val as TableFloor) || null,
                  }))
                }
                placeholder={t('table.select_floor')}
                clearable
              />
            </div>
          )}

          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
              {t('table.room_charge')}
            </label>
            <input
              type="number"
              min={0}
              step="0.01"
              placeholder={t('table.room_charge_placeholder')}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
              value={formData.roomCharge}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  roomCharge: e.target.value,
                }))
              }
            />
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => !isSubmitting && setIsDeleteModalOpen(false)}
        title={t('table.delete_confirmation_title')}
        maxWidth="sm"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => setIsDeleteModalOpen(false)}
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {t('manage_branches.cancel')}
            </button>
            <button
              onClick={confirmDelete}
              disabled={isSubmitting}
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-red-500 shadow-lg shadow-red-500/30 hover:bg-red-600 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting && (
                <Loader2 size={16} className="animate-spin" />
              )}
              {t('table.delete_confirm_button')}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Trash2 size={32} />
          </div>
          <p className="text-center font-bold text-brand-text text-lg">
            {t('table.delete_confirmation_title')}
          </p>
          <p className="text-center text-brand-muted text-sm px-4">
            {t('table.delete_confirmation_text')}
          </p>
        </div>
      </Modal>
    </div>
  );
};

