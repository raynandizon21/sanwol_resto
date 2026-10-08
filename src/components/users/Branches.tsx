import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Loader2, Plus, Edit2, Trash2, MapPin, Building2, Hash, Layers, ImageIcon } from 'lucide-react';
import { DataTable, ColumnDef } from '../ui/DataTable';
import { Modal } from '../ui/Modal';
import { SidePanel } from '../ui/SidePanel';
import { cn } from '../../lib/utils';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { SkeletonPage, SkeletonStatCards, SkeletonPageHeader, SkeletonTable } from '../ui/Skeleton';
import { useUser } from '../../context/UserContext';

interface BranchRow {
  id: string | number;
  code: string;
  name: string;
  address: string;
  phone: string;
  logo: string | null;
  /** 1 = main category only; 2 = main + subcategory */
  categoryLevel: 1 | 2;
  status: 'Active' | 'Inactive';
}

const authHeaders = (json = true): HeadersInit => {
  const token = localStorage.getItem('token');
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

const resolveLogoUrl = (logoPath: string | null | undefined): string | null => {
  if (!logoPath || logoPath === '—') return null;
  if (logoPath.startsWith('http')) return logoPath;
  return logoPath.startsWith('/') ? logoPath : `/${logoPath}`;
};

export const Branches: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useUser();
  const isAdmin = user?.permissions === 1;

  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [filteredBranches, setFilteredBranches] = useState<BranchRow[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingBranch, setEditingBranch] = useState<BranchRow | null>(null);
  const [branchToDelete, setBranchToDelete] = useState<BranchRow | null>(null);

  const [formData, setFormData] = useState({
    code: '',
    name: '',
    address: '',
    phone: '',
    categoryLevel: 1 as 1 | 2,
  });
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [existingLogo, setExistingLogo] = useState<string | null>(null);

  const resetLogoState = () => {
    setLogoFile(null);
    setLogoPreview(null);
    setExistingLogo(null);
  };

  const fetchBranches = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/branch', { headers: authHeaders() });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `Failed to load branches (${res.status})`);
      }
      const rawData = json.data ?? json;
      const mappedData: BranchRow[] = (Array.isArray(rawData) ? rawData : []).map((b: any) => ({
        id: b.IDNo,
        code: b.BRANCH_CODE || '—',
        name: b.BRANCH_NAME || '—',
        address: b.ADDRESS || '—',
        phone: b.PHONE || '—',
        logo: b.BRANCH_LOGO || null,
        categoryLevel: Number(b.MENU_CATEGORY_LEVEL) === 2 ? 2 : 1,
        status: b.ACTIVE === 1 ? 'Active' : 'Inactive',
      }));
      setBranches(mappedData);
      setFilteredBranches(mappedData);
    } catch (e: any) {
      console.error('Failed to fetch branches', e);
      setError(e.message || t('manage_branches.failed_to_load'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchBranches();
  }, [fetchBranches]);

  useEffect(() => {
    const filtered = branches.filter(
      (b) =>
        (b.code || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (b.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (b.address || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (b.phone || '').toLowerCase().includes(searchQuery.toLowerCase())
    );
    setFilteredBranches(filtered);
  }, [searchQuery, branches]);

  const handleOpenAddPanel = () => {
    setEditingBranch(null);
    setFormData({ code: '', name: '', address: '', phone: '', categoryLevel: 1 });
    resetLogoState();
    setIsPanelOpen(true);
  };

  const handleOpenEditPanel = (branch: BranchRow) => {
    setEditingBranch(branch);
    setFormData({
      code: branch.code,
      name: branch.name,
      address: branch.address === '—' ? '' : branch.address,
      phone: branch.phone === '—' ? '' : branch.phone,
      categoryLevel: branch.categoryLevel,
    });
    setLogoFile(null);
    setExistingLogo(branch.logo);
    setLogoPreview(resolveLogoUrl(branch.logo));
    setIsPanelOpen(true);
  };

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setLogoFile(file);
    if (file) {
      const reader = new FileReader();
      reader.onload = () => setLogoPreview(reader.result as string);
      reader.readAsDataURL(file);
    } else if (existingLogo) {
      setLogoPreview(resolveLogoUrl(existingLogo));
    } else {
      setLogoPreview(null);
    }
  };

  const handleOpenDeleteModal = (branch: BranchRow) => {
    setBranchToDelete(branch);
    setIsDeleteModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.code.trim() || !formData.name.trim()) {
      toast.error(t('manage_branches.code_and_name_required'));
      return;
    }
    setIsSubmitting(true);
    try {
      const form = new FormData();
      form.append('BRANCH_CODE', formData.code.trim());
      form.append('BRANCH_NAME', formData.name.trim());
      if (formData.address.trim()) form.append('ADDRESS', formData.address.trim());
      if (formData.phone.trim()) form.append('PHONE', formData.phone.trim());
      form.append('MENU_CATEGORY_LEVEL', String(formData.categoryLevel));
      if (logoFile) {
        form.append('BRANCH_LOGO', logoFile);
      } else if (editingBranch && existingLogo) {
        form.append('BRANCH_LOGO', existingLogo);
      }
      const url = editingBranch ? `/branch/${editingBranch.id}` : '/branch';
      const method = editingBranch ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: authHeaders(false),
        body: form,
      });
      let data: { success?: boolean; error?: string; message?: string };
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (!res.ok) {
        throw new Error(data?.error || data?.message || `Failed to ${editingBranch ? 'update' : 'create'} branch (${res.status})`);
      }
      toast.success(editingBranch ? t('manage_branches.toast.updated_success') : t('manage_branches.toast.created_success'));
      setIsPanelOpen(false);
      fetchBranches();
    } catch (e: any) {
      toast.error(e?.message || t('manage_branches.toast.save_error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!branchToDelete) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/branch/${branchToDelete.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.message || t('manage_branches.toast.delete_failed'));
      }
      toast.success(t('manage_branches.toast.deleted_success', { name: branchToDelete.name }));
      setIsDeleteModalOpen(false);
      fetchBranches();
    } catch (e: any) {
      toast.error(e.message || t('manage_branches.toast.delete_error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const columns: ColumnDef<BranchRow>[] = [
    {
      header: t('manage_branches.code'),
      render: (b) => (
        <span className="text-sm font-bold text-brand-muted">{b.code}</span>
      ),
    },
    {
      header: t('manage_branches.name'),
      render: (b) => (
        <motion.div layout className="flex items-center gap-3">
          <motion.div
            layout
            className="w-9 h-9 rounded-lg bg-gray-100 border border-gray-200 overflow-hidden shrink-0 flex items-center justify-center"
          >
            {b.logo ? (
              <img src={resolveLogoUrl(b.logo) || ''} alt="" className="w-full h-full object-cover" />
            ) : (
              <Building2 size={16} className="text-brand-muted" />
            )}
          </motion.div>
          <span className="text-sm font-bold">{b.name}</span>
        </motion.div>
      ),
    },
    {
      header: t('manage_branches.menu_category_level_column'),
      render: (b) => (
        <span
          className={cn(
            'text-xs font-bold px-2 py-1 rounded-lg',
            b.categoryLevel === 2 ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600'
          )}
        >
          {b.categoryLevel === 2 ? t('manage_branches.summary_main_sub') : t('manage_branches.summary_main_only')}
        </span>
      ),
    },
    {
      header: t('manage_branches.address'),
      render: (b) => <span className="text-sm font-medium">{b.address}</span>,
    },
    {
      header: t('manage_branches.phone'),
      render: (b) => <span className="text-sm font-medium">{b.phone}</span>,
    },
    {
      header: t('manage_branches.status'),
      render: (b) => (
        <span
          className={cn(
            'text-xs font-bold px-2 py-1 rounded-lg',
            b.status === 'Active' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'
          )}
        >
          {b.status === 'Active' ? t('manage_branches.active') : t('manage_branches.inactive')}
        </span>
      ),
    },
    {
      header: t('manage_branches.action'),
      className: 'text-right',
      render: (b) => (
        <div className="flex justify-end items-center gap-2">
          <button
            onClick={() => handleOpenEditPanel(b)}
            className="p-2 text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors rounded-lg"
            title={t('manage_branches.edit_branch')}
          >
            <Edit2 size={16} />
          </button>
          <button
            onClick={() => handleOpenDeleteModal(b)}
            className="p-2 text-brand-muted hover:text-red-500 hover:bg-red-50 transition-colors rounded-lg"
            title={t('manage_branches.delete_branch')}
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  if (!isAdmin) {
    return (
      <div className="space-y-8 pt-6">
        <div className="flex items-center justify-center min-h-[400px]">
          <p className="text-brand-muted font-medium">{t('manage_branches.admin_only')}</p>
        </div>
      </div>
    );
  }

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
              <div className="relative">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                <input
                  type="text"
                  placeholder={t('manage_branches.search_placeholder')}
                  className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-80 shadow-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <button
                onClick={handleOpenAddPanel}
                className="bg-brand-primary text-white px-6 py-2.5 rounded-xl text-base font-bold flex items-center gap-2 shadow-lg shadow-brand-primary/20 hover:bg-brand-primary/90 transition-all"
              >
                <Plus size={18} />
                {t('manage_branches.add_new_branch')}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('manage_branches.total_branches')}</p>
                <h3 className="text-3xl font-bold">{branches.length}</h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('manage_branches.active_branches')}</p>
                <h3 className="text-3xl font-bold text-green-600">{branches.filter((b) => b.status === 'Active').length}</h3>
              </div>
            </div>

            <DataTable
              data={filteredBranches}
              columns={columns}
              keyExtractor={(item) => String(item.id)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <SidePanel
        isOpen={isPanelOpen}
        onClose={() => {
          if (!isSubmitting) {
            setIsPanelOpen(false);
            setFormData({ code: '', name: '', address: '', phone: '', categoryLevel: 1 });
            resetLogoState();
          }
        }}
        title={editingBranch ? t('manage_branches.edit_branch') : t('manage_branches.add_new_branch')}
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => setIsPanelOpen(false)}
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {t('manage_branches.cancel')}
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !formData.code.trim() || !formData.name.trim()}
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-brand-primary shadow-lg shadow-brand-primary/30 hover:bg-brand-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting && <Loader2 size={16} className="animate-spin" />}
              {editingBranch ? t('manage_branches.update_branch') : t('manage_branches.save_branch')}
            </button>
          </div>
        }
      >
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-5">
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('manage_branches.code')} *
              </label>
              <div className="relative">
                <Hash size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted" />
                <input
                  type="text"
                  required
                  placeholder={t('manage_branches.enter_code')}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('manage_branches.name')} *
              </label>
              <div className="relative">
                <Building2 size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted" />
                <input
                  type="text"
                  required
                  placeholder={t('manage_branches.enter_name')}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  autoComplete="off"
                />
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
              {t('manage_branches.address')}
            </label>
            <div className="relative">
              <MapPin size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted" />
              <input
                type="text"
                placeholder={t('manage_branches.enter_address')}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                autoComplete="off"
              />
            </div>
          </div>
            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('manage_branches.phone')}
              </label>
              <input
                type="text"
                placeholder={t('manage_branches.enter_phone')}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                autoComplete="off"
              />
            </div>

            <div className="space-y-3">
              <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
                {t('manage_branches.logo')}
              </label>
              <div className="flex items-center gap-4">
                <div className="w-20 h-20 rounded-xl bg-gray-100 flex items-center justify-center overflow-hidden border-2 border-dashed border-gray-200 shrink-0">
                  {logoPreview ? (
                    <img src={logoPreview} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon size={24} className="text-brand-muted" />
                  )}
                </div>
                <div>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleLogoChange}
                    className="text-sm text-brand-muted file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-bold file:bg-brand-primary/10 file:text-brand-primary hover:file:bg-brand-primary/20 file:cursor-pointer cursor-pointer"
                  />
                  <p className="text-[10px] text-brand-muted mt-1">{t('manage_branches.logo_hint')}</p>
                </div>
              </div>
            </div>

            <div className="space-y-3" role="radiogroup" aria-labelledby="branch-menu-category-level-label">
              <label
                id="branch-menu-category-level-label"
                className="text-xs font-bold text-brand-text uppercase tracking-wider block flex items-center gap-2"
              >
                <Layers size={14} className="text-brand-muted" />
                {t('manage_branches.menu_category_level')}
              </label>
              <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50/80 p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="radio"
                    name="menuCategoryLevel"
                    className="mt-1 h-4 w-4 shrink-0 accent-brand-primary"
                    checked={formData.categoryLevel === 1}
                    onChange={() => setFormData((prev) => ({ ...prev, categoryLevel: 1 }))}
                  />
                  <span>
                    <span className="block text-sm font-bold text-brand-text">{t('manage_branches.menu_category_level_1_title')}</span>
                    <span className="mt-0.5 block text-xs text-brand-muted">{t('manage_branches.menu_category_level_1_desc')}</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="radio"
                    name="menuCategoryLevel"
                    className="mt-1 h-4 w-4 shrink-0 accent-brand-primary"
                    checked={formData.categoryLevel === 2}
                    onChange={() => setFormData((prev) => ({ ...prev, categoryLevel: 2 }))}
                  />
                  <span>
                    <span className="block text-sm font-bold text-brand-text">{t('manage_branches.menu_category_level_2_title')}</span>
                    <span className="mt-0.5 block text-xs text-brand-muted">{t('manage_branches.menu_category_level_2_desc')}</span>
                  </span>
                </label>
              </div>
            </div>
        </form>
      </SidePanel>

      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => !isSubmitting && setIsDeleteModalOpen(false)}
        title={t('manage_branches.delete_branch')}
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
              {isSubmitting && <Loader2 size={16} className="animate-spin" />}
              {t('manage_branches.delete_branch')}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Trash2 size={32} />
          </div>
          <p className="text-center font-bold text-brand-text text-lg">{t('manage_branches.delete_confirm_title')}</p>
          <p className="text-center text-brand-muted text-sm px-4">
            {t('manage_branches.delete_confirm_text_prefix')}{' '}
            <span className="font-bold text-brand-text">{branchToDelete?.name}</span>{' '}
            {t('manage_branches.delete_confirm_text_suffix')}
          </p>
        </div>
      </Modal>
    </div>
  );
};
