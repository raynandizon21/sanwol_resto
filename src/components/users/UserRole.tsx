import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Loader2, Plus, Edit2, Trash2, Shield, User as UserIcon, MoreVertical } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { SkeletonPageHeader, Skeleton } from '../ui/Skeleton';
import { cn } from '../../lib/utils';

interface UserRoleRow {
  id: string;
  role: string;
  description: string;
  status: 'Active' | 'Inactive';
}

export const UserRole: React.FC = () => {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<UserRoleRow[]>([]);
  const [filteredRoles, setFilteredRoles] = useState<UserRoleRow[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<UserRoleRow | null>(null);
  const [formData, setFormData] = useState({ role: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [roleToDelete, setRoleToDelete] = useState<UserRoleRow | null>(null);

  const fetchRoles = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/user-management/roles', {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) {
        throw new Error(`Failed to load roles (${res.status})`);
      }
      const json = await res.json();
      const rawData = json.data ?? json;
      const mappedData: UserRoleRow[] = (Array.isArray(rawData) ? rawData : []).map((r: any) => ({
        id: r.IDNo.toString(),
        role: r.ROLE || '',
        description: r.DESCRIPTION || '',
        status: r.ACTIVE ? 'Active' : 'Inactive',
      }));
      setRoles(mappedData);
      setFilteredRoles(mappedData);
    } catch (e: any) {
      console.error('Failed to fetch roles', e);
      setError(e.message || t('user_roles.failed_to_load'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRoles();
  }, []);

  const handleOpenAddModal = () => {
    setEditingRole(null);
    setFormData({ role: '' });
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (role: UserRoleRow) => {
    setEditingRole(role);
    setFormData({ role: role.role });
    setIsModalOpen(true);
  };

  const handleOpenDeleteModal = (role: UserRoleRow) => {
    setRoleToDelete(role);
    setIsDeleteModalOpen(true);
  };

  const confirmDelete = async () => {
    if (!roleToDelete) return;

    setIsSubmitting(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/user-management/roles/${roleToDelete.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (!res.ok) throw new Error(t('user_roles.toast.delete_failed'));

      toast.success(t('user_roles.toast.deleted_success', { role: roleToDelete?.role }));
      setIsDeleteModalOpen(false);
      fetchRoles();
    } catch (e: any) {
      toast.error(e.message || t('user_roles.toast.delete_error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.role.trim()) return;

    setIsSubmitting(true);
    try {
      const token = localStorage.getItem('token');
      const url = editingRole
        ? `/api/user-management/roles/${editingRole.id}`
        : '/api/user-management/roles';
      const method = editingRole ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(formData),
      });

      if (!res.ok) throw new Error(editingRole ? t('user_roles.toast.update_failed') : t('user_roles.toast.create_failed'));

      toast.success(editingRole ? t('user_roles.toast.updated_success') : t('user_roles.toast.created_success'));
      setIsModalOpen(false);
      fetchRoles();
    } catch (e: any) {
      toast.error(e.message || t('user_roles.toast.save_error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    const filtered = roles.filter(role =>
      (role.role || '').toLowerCase().includes(searchQuery.toLowerCase())
    );
    setFilteredRoles(filtered);
  }, [searchQuery, roles]);

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
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-5">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
                  <div className="flex items-center justify-between">
                    <Skeleton className="w-12 h-12 rounded-xl" />
                    <Skeleton className="w-20 h-8 rounded-xl" />
                  </div>
                  <div className="space-y-1">
                    <Skeleton className="h-5 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                  <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                    <Skeleton className="h-6 w-24" />
                    <Skeleton className="h-6 w-16" />
                  </div>
                </div>
              ))}
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
                    placeholder={t('user_roles.search_placeholder')}
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
                {t('user_roles.add_new_role')}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-5">
              {filteredRoles.map((role) => (
                <div
                  key={role.id}
                  className="group relative bg-white rounded-2xl p-1 shadow-sm hover:shadow-xl hover:shadow-brand-text/5 transition-all duration-500 border border-gray-100 hover:border-brand-text/10 overflow-hidden"
                >
                  {/* Background Decoration */}
                  <div className="absolute top-0 right-0 -mr-6 -mt-6 w-24 h-24 bg-brand-text/5 rounded-full blur-2xl group-hover:bg-brand-primary/5 transition-colors duration-500" />

                  <div className="relative p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="w-12 h-12 rounded-xl bg-[rgb(100,116,139)] group-hover:bg-brand-primary flex items-center justify-center text-white shadow-lg shadow-brand-text/10 group-hover:scale-110 transition-all duration-500">
                        <Shield size={22} strokeWidth={2.5} />
                      </div>

                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-500">
                        <button
                          onClick={() => handleOpenEditModal(role)}
                          className="p-2.5 bg-white text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 rounded-xl transition-all shadow-sm border border-gray-50"
                          title={t('user_roles.edit_role')}
                        >
                          <Edit2 size={18} />
                        </button>
                        <button
                          onClick={() => handleOpenDeleteModal(role)}
                          className="p-2.5 bg-white text-brand-muted hover:text-red-500 hover:bg-red-50 rounded-xl transition-all shadow-sm border border-gray-50"
                          title={t('user_roles.delete_role')}
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    </div>

                    <div>
                      <h3 className="text-base font-black text-brand-text tracking-tight group-hover:text-brand-primary transition-colors duration-300">
                        {role.role}
                      </h3>
                      <p className="text-[10px] font-bold text-brand-muted uppercase tracking-widest mt-0.5">
                        {t('user_roles.access_level_profile')}
                      </p>
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-gray-50/50">
                      <div className="flex -space-x-2">
                        {[1, 2, 3].map(i => (
                          <div key={i} className="w-6 h-6 rounded-full border-2 border-white bg-gray-100 flex items-center justify-center">
                            <UserIcon size={10} className="text-gray-400" />
                          </div>
                        ))}
                        <div className="w-6 h-6 rounded-full border-2 border-white bg-brand-primary/10 flex items-center justify-center text-[8px] font-bold text-brand-primary">
                          +5
                        </div>
                      </div>

                      <span
                        className={cn(
                          "text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-xl flex items-center gap-2 shadow-sm transition-all duration-500",
                          role.status === 'Active'
                            ? "bg-green-50 text-green-600 border border-green-100/50 group-hover:bg-green-500 group-hover:text-white"
                            : "bg-red-50 text-red-600 border border-red-100/50 group-hover:bg-red-500 group-hover:text-white"
                        )}
                      >
                        <span className={cn(
                          "w-1.5 h-1.5 rounded-full animate-pulse",
                          role.status === 'Active' ? "bg-green-500 group-hover:bg-white" : "bg-red-500 group-hover:bg-white"
                        )} />
                        {role.status === 'Active' ? t('user_roles.active') : t('user_roles.inactive')}
                      </span>
                    </div>
                  </div>
                </div>
              ))}

              {filteredRoles.length === 0 && (
                <div className="col-span-full py-12 text-center bg-white rounded-2xl shadow-sm">
                  <Shield size={48} className="mx-auto text-brand-muted/20 mb-4" />
                  <p className="text-brand-muted font-medium text-lg">{t('user_roles.no_roles_found')}</p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Add/Edit Role Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => !isSubmitting && setIsModalOpen(false)}
        title={editingRole ? t('user_roles.edit_role') : t('user_roles.add_new_role')}
        maxWidth="md"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => setIsModalOpen(false)}
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {t('user_roles.cancel')}
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !formData.role.trim()}
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-brand-primary shadow-lg shadow-brand-primary/30 hover:bg-brand-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting && <Loader2 size={16} className="animate-spin" />}
              {editingRole ? t('user_roles.update_role') : t('user_roles.save_role')}
            </button>
          </div>
        }
      >
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-3">
            <label className="text-sm font-bold text-brand-text block">{t('user_roles.role_name')}</label>
            <input
              type="text"
              required
              placeholder={t('user_roles.role_name_placeholder')}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all placeholder:text-gray-400"
              value={formData.role}
              onChange={(e) => setFormData({ ...formData, role: e.target.value })}
              autoFocus
            />
          </div>
          <p className="text-xs text-brand-muted">
            {t('user_roles.role_description')}
          </p>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => !isSubmitting && setIsDeleteModalOpen(false)}
        title={t('user_roles.delete_role')}
        maxWidth="sm"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => setIsDeleteModalOpen(false)}
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {t('user_roles.cancel')}
            </button>
            <button
              onClick={confirmDelete}
              disabled={isSubmitting}
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-red-500 shadow-lg shadow-red-500/30 hover:bg-red-600 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting && <Loader2 size={16} className="animate-spin" />}
              {t('user_roles.delete_role')}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Trash2 size={32} />
          </div>
          <p className="text-center font-bold text-brand-text text-lg">{t('user_roles.delete_confirm_title')}</p>
          <p className="text-center text-brand-muted text-sm px-4">
            {t('user_roles.delete_confirm_text', { role: roleToDelete?.role })}
          </p>
        </div>
      </Modal>
    </div>
  );
};
