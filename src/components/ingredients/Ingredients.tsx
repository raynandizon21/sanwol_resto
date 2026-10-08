import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Plus, RefreshCw, Edit2, Trash2, FlaskConical } from 'lucide-react';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { cn } from '../../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { SkeletonPageHeader, SkeletonStatCards, SkeletonTable } from '../ui/Skeleton';
import { SidePanel } from '../ui/SidePanel';
import { Modal } from '../ui/Modal';
import { toast } from 'sonner';
import {
  getIngredients,
  createIngredient,
  updateIngredient,
  deleteIngredient,
  syncIngredientsFromExpenses,
  type Ingredient,
} from '../../services/ingredientService';
import { getInventoryCategories, type InventoryCategory } from '../../services/inventoryService';
import { UOM_OPTIONS, getUnitLabel } from '../../lib/uomUtils';
import { type Branch } from '../partials/Header';
import { useCrudPermissions } from '../../hooks/useCrudPermissions';
import { Select2 } from '../ui/Select2';

type IngredientsProps = {
  selectedBranch: Branch | null;
};

export const Ingredients: React.FC<IngredientsProps> = ({ selectedBranch }) => {
  const { t } = useTranslation();
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [editingIngredient, setEditingIngredient] = useState<Ingredient | null>(null);
  const [toDelete, setToDelete] = useState<Ingredient | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [form, setForm] = useState({ name: '', categoryId: '', unit: 'pcs' });

  const { canCreate, canUpdate, canDelete } = useCrudPermissions();

  const isSpecificBranch = selectedBranch != null && String(selectedBranch.id) !== 'all';
  const branchId = String(selectedBranch?.id || '');

  const fetchData = async () => {
    if (!branchId || branchId === 'all') return;
    try {
      setLoading(true);
      const [ingredientRows, categoryRows] = await Promise.all([
        getIngredients(branchId, categoryFilter || undefined),
        getInventoryCategories(branchId),
      ]);
      setIngredients(ingredientRows);
      setCategories(categoryRows);
    } catch (err: unknown) {
      toast.error((err as Error)?.message || 'Failed to fetch ingredients');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [branchId, categoryFilter]);

  const filteredIngredients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return ingredients;
    return ingredients.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        (i.categoryName || '').toLowerCase().includes(q) ||
        (i.unit || '').toLowerCase().includes(q)
    );
  }, [ingredients, searchQuery]);

  const handleOpenAdd = () => {
    setEditingIngredient(null);
    setForm({ name: '', categoryId: '', unit: 'pcs' });
    setIsPanelOpen(true);
  };

  const handleOpenEdit = (ing: Ingredient) => {
    setEditingIngredient(ing);
    setForm({
      name: ing.name,
      categoryId: ing.categoryId || '',
      unit: ing.unit || 'pcs',
    });
    setIsPanelOpen(true);
  };

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) {
      toast.error('Ingredient name is required');
      return;
    }
    try {
      setIsSubmitting(true);
      if (editingIngredient) {
        await updateIngredient(editingIngredient.id, {
          name,
          categoryId: form.categoryId || null,
          unit: form.unit || 'pcs',
        });
        toast.success('Ingredient updated');
      } else {
        await createIngredient({
          branchId,
          name,
          categoryId: form.categoryId || null,
          unit: form.unit || 'pcs',
        });
        toast.success('Ingredient added');
      }
      setIsPanelOpen(false);
      fetchData();
    } catch (err: unknown) {
      toast.error((err as Error)?.message || 'Failed to save');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!toDelete) return;
    try {
      setIsSubmitting(true);
      await deleteIngredient(toDelete.id);
      toast.success('Ingredient removed');
      setToDelete(null);
      fetchData();
    } catch (err: unknown) {
      toast.error((err as Error)?.message || 'Failed to delete');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSync = async () => {
    try {
      setIsSyncing(true);
      await syncIngredientsFromExpenses();
      toast.success('Ingredients synced from expenses');
      fetchData();
    } catch (err: unknown) {
      toast.error((err as Error)?.message || 'Failed to sync');
    } finally {
      setIsSyncing(false);
    }
  };

  const columns: ColumnDef<Ingredient>[] = [
    {
      header: 'Name',
      render: (row) => (
        <div>
          <span className="font-bold text-brand-text">{row.name}</span>
          {row.categoryName && (
            <p className="text-xs text-brand-muted mt-0.5">{row.categoryName}</p>
          )}
        </div>
      ),
    },
    {
      header: 'Category',
      render: (row) => (
        <span className="text-sm text-brand-muted">{row.categoryName || '—'}</span>
      ),
    },
    {
      header: 'Unit',
      render: (row) => (
        <span className="text-sm font-medium">{getUnitLabel(row.unit || 'pcs')}</span>
      ),
    },
    {
      header: 'Action',
      render: (row) => (
        <div className="flex items-center gap-2">
          {canUpdate('ingredients') && (
            <button
              onClick={() => handleOpenEdit(row)}
              className="p-2 rounded-lg text-brand-muted hover:bg-brand-primary/10 hover:text-brand-primary transition-colors"
              title="Edit"
            >
              <Edit2 size={16} />
            </button>
          )}
          {canDelete('ingredients') && (
            <button
              onClick={() => setToDelete(row)}
              className="p-2 rounded-lg text-brand-muted hover:bg-red-50 hover:text-red-500 transition-colors"
              title="Delete"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      ),
    },
  ];

  if (!isSpecificBranch) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-brand-muted">
        <FlaskConical size={48} className="mb-4 opacity-50" />
        <p className="font-bold">Select a branch to manage ingredients</p>
      </div>
    );
  }

  return (
    <div className="pt-6">
      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div
            key="skeleton"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-8"
          >
            <SkeletonPageHeader />
            <SkeletonStatCards />
            <div className="bg-white rounded-2xl shadow-sm p-6">
              <SkeletonTable columns={4} rows={10} />
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="content"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="space-y-8"
          >
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h1 className="text-2xl font-black text-brand-text">Ingredients</h1>
                <p className="text-sm text-brand-muted mt-1">
                  Master list for menu recipes. Synced from expenses (inventory categories).
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSync}
                  disabled={isSyncing}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-100 text-brand-muted hover:bg-gray-200 font-medium text-sm transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={16} className={cn(isSyncing && 'animate-spin')} />
                  Sync from Expenses
                </button>
                {canCreate('ingredients') && (
                  <button
                    onClick={handleOpenAdd}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold text-sm shadow-lg shadow-brand-primary/30 transition-all"
                  >
                    <Plus size={18} />
                    Add Ingredient
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                <input
                  type="text"
                  placeholder="Search ingredients..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-white border border-gray-200 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none"
                />
              </div>
              <div className="min-w-[220px]">
                <Select2
                  options={[
                    { value: '', label: 'All categories' },
                    ...categories.map((c) => ({
                      value: c.id,
                      label: c.name,
                    })),
                  ]}
                  value={categoryFilter ?? ''}
                  onChange={(val) => setCategoryFilter(val ? String(val) : null)}
                  placeholder="All categories"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">Total Ingredients</p>
                <h3 className="text-3xl font-bold text-brand-text">{filteredIngredients.length}</h3>
              </div>
            </div>

            <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
              <DataTable
                data={filteredIngredients}
                columns={columns}
                keyExtractor={(row) => row.id}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <SidePanel
        isOpen={isPanelOpen}
        onClose={() => setIsPanelOpen(false)}
        title={editingIngredient ? 'Edit Ingredient' : 'Add Ingredient'}
        width="md"
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setIsPanelOpen(false)}
              className="px-4 py-2 rounded-xl bg-gray-100 text-brand-muted hover:bg-gray-200 font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold disabled:opacity-50"
            >
              {isSubmitting ? 'Saving...' : editingIngredient ? 'Update' : 'Add'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-brand-muted mb-1.5">
              Name
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Pork, Rice, Soy Sauce"
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-brand-muted mb-1.5">
              Category
            </label>
            <Select2
              options={[
                { value: '', label: '— Select category —' },
                ...categories.map((c) => ({
                  value: c.id,
                  label: c.name,
                })),
              ]}
              value={form.categoryId}
              onChange={(val) =>
                setForm((f) => ({ ...f, categoryId: val ? String(val) : '' }))
              }
              placeholder="— Select category —"
            />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-brand-muted mb-1.5">
              Unit
            </label>
            <Select2
              options={UOM_OPTIONS.map((u) => ({
                value: u,
                label: getUnitLabel(u),
              }))}
              value={form.unit}
              onChange={(val) =>
                setForm((f) => ({ ...f, unit: (val as string) || 'pcs' }))
              }
              placeholder="Select unit"
            />
          </div>
        </div>
      </SidePanel>

      <Modal
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete Ingredient"
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setToDelete(null)}
              className="px-4 py-2 rounded-xl bg-gray-100 text-brand-muted hover:bg-gray-200 font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl bg-red-500 text-white hover:bg-red-600 font-bold disabled:opacity-50"
            >
              {isSubmitting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        }
      >
        {toDelete && (
          <p className="text-brand-muted">
            Remove <strong className="text-brand-text">{toDelete.name}</strong> from the master list?
            This will not affect expenses or inventory.
          </p>
        )}
      </Modal>
    </div>
  );
};
