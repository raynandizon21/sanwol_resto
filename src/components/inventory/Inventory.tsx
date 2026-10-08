import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Filter, Search, AlertTriangle, ArrowLeft, Scale, Loader2 } from 'lucide-react';
import { DataTable, ColumnDef } from '../ui/DataTable';
import { cn } from '../../lib/utils';
import { formatQty } from '../../lib/uomUtils';
import { motion, AnimatePresence } from 'framer-motion';
import { SkeletonPageHeader, SkeletonStatCards, SkeletonTable } from '../ui/Skeleton';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { getInventoryItems, adjustStock, type InventoryItem } from '../../services/inventoryItemService';
import { getInventoryCategories, type InventoryCategory } from '../../services/inventoryService';
import { type Branch } from '../partials/Header';
import { Modal } from '../ui/Modal';

interface InventoryProps {
  onBack?: () => void;
  selectedBranch?: Branch | null;
  onCategoryResolved?: (categoryId: string, categoryName: string) => void;
}

type ItemStatus = 'In Stock' | 'Low Stock' | 'Out of Stock';

const computeStatus = (stockQty: number, reorderLevel: number): ItemStatus => {
  if (stockQty <= 0) return 'Out of Stock';
  if (stockQty <= reorderLevel) return 'Low Stock';
  return 'In Stock';
};

const toItemCode = (id: string) => `INV-${String(Number(id) || 0).padStart(3, '0')}`;

const getUnitKey = (u: string) => {
  const s = String(u || 'kg').toLowerCase();
  if (s === 'l') return 'L';
  if (s === 'ml') return 'mL';
  return s;
};

export const Inventory: React.FC<InventoryProps> = ({ onBack, selectedBranch = null, onCategoryResolved }) => {
  const { t } = useTranslation();
  const { categoryId } = useParams<{ categoryId: string }>();
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [adjustItem, setAdjustItem] = useState<InventoryItem | null>(null);
  const [adjustType, setAdjustType] = useState<'add' | 'deduct'>('add');
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustSubmitting, setAdjustSubmitting] = useState(false);

  const formatMoneyNoDecimals = (value: unknown) => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return '0';
    return Math.trunc(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  };

  const currentCategory = useMemo(
    () => (categoryId && categories.find((c) => c.id === categoryId)) || null,
    [categories, categoryId]
  );

  useEffect(() => {
    if (!categoryId || !currentCategory?.name) return;
    onCategoryResolved?.(String(categoryId), String(currentCategory.name));
  }, [categoryId, currentCategory?.name, onCategoryResolved]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const branchId = String(selectedBranch?.id || '');
      const [itemRows, categoryRows] = await Promise.all([
        getInventoryItems(branchId, categoryId || undefined),
        getInventoryCategories(branchId),
      ]);
      setItems(itemRows);
      setCategories(categoryRows);
    } catch (error: any) {
      toast.error(error.message || t('inventory_page.messages.fetch_failed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedBranch) return;
    fetchData();
  }, [selectedBranch?.id, categoryId]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const itemCategory = String(item.categoryName || '').toLowerCase();
      return (
        item.id.toLowerCase().includes(q) ||
        (item.itemName || '').toLowerCase().includes(q) ||
        itemCategory.includes(q)
      );
    });
  }, [items, searchQuery]);

  const stats = useMemo(() => {
    const total = filteredItems.length;
    const low = filteredItems.filter((item) => computeStatus(item.stockQty, item.reorderLevel) === 'Low Stock').length;
    const out = filteredItems.filter((item) => computeStatus(item.stockQty, item.reorderLevel) === 'Out of Stock').length;
    const totalValue = filteredItems.reduce((sum, item) => sum + Number(item.stockQty || 0) * Number(item.unitCost || 0), 0);
    return { total, low, out, totalValue };
  }, [filteredItems]);

  const columns: ColumnDef<InventoryItem>[] = [
    {
      header: t('inventory_page.table.item_code'),
      render: (item) => <span className="text-sm font-bold text-brand-muted">{toItemCode(item.id)}</span>,
    },
    {
      header: t('inventory_page.table.name'),
      render: (item) => (
        <div>
          <span className="text-sm font-bold">{item.itemName}</span>
          <p className="text-xs text-brand-muted">{item.categoryName || t('inventory_page.table.uncategorized')}</p>
        </div>
      ),
    },
    {
      header: t('inventory_page.table.stock_level'),
      render: (item) => {
        const status = computeStatus(item.stockQty, item.reorderLevel);
        const denominator = Math.max(item.reorderLevel * 2, item.stockQty, 1);
        const widthPercent = Math.min((item.stockQty / denominator) * 100, 100);
        return (
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold">
              {formatQty(item.stockQty, item.unit || 'pcs')} {t(`inventory_page.units.${getUnitKey(item.unit || '')}`)}
            </span>
            <div className="w-24 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full',
                  status === 'In Stock' ? 'bg-green-500' : status === 'Low Stock' ? 'bg-orange-500' : 'bg-red-500'
                )}
                style={{ width: `${widthPercent}%` }}
              />
            </div>
          </div>
        );
      },
    },
    {
      header: t('inventory_page.table.reorder_stock'),
      render: (item) => (
        <span className="text-sm font-bold text-brand-text">
          {formatQty(item.reorderLevel, item.unit || 'pcs')} {t(`inventory_page.units.${getUnitKey(item.unit || '')}`)}
        </span>
      ),
    },
    {
      header: t('inventory_page.table.unit_cost'),
      render: (item) => (
        <span className="text-sm font-bold text-brand-text">
          {formatMoneyNoDecimals(item.unitCost || 0)}
        </span>
      ),
    },
    {
      header: t('inventory_page.table.status'),
      render: (item) => {
        const status = computeStatus(item.stockQty, item.reorderLevel);
        return (
          <span
            className={cn(
              'text-xs font-bold px-2 py-1 rounded-lg',
              status === 'In Stock'
                ? 'bg-green-100 text-green-600'
                : status === 'Low Stock'
                  ? 'bg-orange-100 text-orange-600'
                  : 'bg-red-100 text-red-600'
            )}
          >
            {status === 'In Stock' ? t('inventory_page.status.in_stock') :
              status === 'Low Stock' ? t('inventory_page.status.low_stock') :
                t('inventory_page.status.out_of_stock')}
          </span>
        );
      },
    },
    {
      header: t('inventory_page.table.actions'),
      render: (item) =>
        item.isManualStock && item.ingredientId ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setAdjustItem(item);
              setAdjustType('add');
              setAdjustQty('');
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-primary/10 text-brand-primary hover:bg-brand-primary/20 font-medium text-sm transition-colors"
            title={t('inventory_page.modal.adjust_title')}
          >
            <Scale size={14} />
            {t('inventory_page.modal.adjust_title')}
          </button>
        ) : (
          <span className="text-xs text-brand-muted">—</span>
        ),
    },
  ];


  return (
    <div className="pt-6">
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
                {onBack && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onBack();
                    }}
                    className="bg-white p-3 rounded-xl shadow-sm border border-transparent hover:border-brand-primary/30 transition-all group"
                    title={t('inventory_page.back_to_categories')}
                  >
                    <ArrowLeft size={18} className="text-brand-muted group-hover:text-brand-primary transition-colors" />
                  </button>
                )}
                <div className="bg-white p-3 rounded-xl shadow-sm">
                  <Filter size={18} className="text-brand-muted" />
                </div>
                <div className="relative">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                  <input
                    type="text"
                    placeholder={t('inventory_page.search_placeholder')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-80 shadow-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-6">
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('inventory_page.stats.total_items')}</p>
                <h3 className="text-3xl font-bold">{stats.total}</h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('inventory_page.stats.low_stock')}</p>
                <div className="flex items-center gap-2">
                  <h3 className="text-3xl font-bold text-orange-500">{stats.low}</h3>
                  <AlertTriangle size={18} className="text-orange-500" />
                </div>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('inventory_page.stats.out_of_stock')}</p>
                <h3 className="text-3xl font-bold text-red-500">{stats.out}</h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('inventory_page.stats.total_value')}</p>
                <h3 className="text-3xl font-bold">
                  {t('inventory_page.currency_symbol')}{formatMoneyNoDecimals(stats.totalValue)}
                </h3>
              </div>
            </div>

            <DataTable
              data={filteredItems}
              columns={columns}
              keyExtractor={(item) => item.id}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <Modal
        isOpen={!!adjustItem}
        onClose={() => {
          if (!adjustSubmitting) {
            setAdjustItem(null);
            setAdjustQty('');
          }
        }}
        title={t('inventory_page.modal.adjust_title')}
        maxWidth="md"
        footer={
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                if (!adjustSubmitting) {
                  setAdjustItem(null);
                  setAdjustQty('');
                }
              }}
              className="px-4 py-2 rounded-xl border border-gray-200 text-brand-text hover:bg-gray-50 font-medium transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={adjustSubmitting || !adjustQty || Number(adjustQty) <= 0}
              onClick={async () => {
                if (!adjustItem?.ingredientId || !adjustItem?.branchId || !adjustQty || Number(adjustQty) <= 0) return;
                setAdjustSubmitting(true);
                try {
                  await adjustStock(adjustItem.ingredientId, adjustItem.branchId, Number(adjustQty), adjustType);
                  toast.success(t('inventory_page.messages.adjust_success'));
                  setAdjustItem(null);
                  setAdjustQty('');
                  fetchData();
                } catch (err: any) {
                  toast.error(err?.message || t('inventory_page.messages.adjust_insufficient'));
                } finally {
                  setAdjustSubmitting(false);
                }
              }}
              className="px-4 py-2 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {adjustSubmitting && <Loader2 size={16} className="animate-spin" />}
              {t('common.save')}
            </button>
          </div>
        }
      >
        {adjustItem && (
          <div className="space-y-4">
            <p className="text-sm text-brand-muted">{t('inventory_page.modal.adjust_subtitle')}</p>
            <div>
              <p className="text-sm font-medium text-brand-text mb-1">{adjustItem.itemName}</p>
              <p className="text-xs text-brand-muted">
                {t('inventory_page.modal.current_stock', {
                  qty: formatQty(adjustItem.stockQty, adjustItem.unit || 'pcs'),
                  unit: t(`inventory_page.units.${getUnitKey(adjustItem.unit || '')}`),
                })}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAdjustType('add')}
                className={cn(
                  'flex-1 py-2.5 rounded-xl font-medium text-sm transition-colors',
                  adjustType === 'add'
                    ? 'bg-green-100 text-green-700 border-2 border-green-300'
                    : 'bg-gray-50 text-brand-muted border-2 border-transparent hover:bg-gray-100'
                )}
              >
                {t('inventory_page.modal.adjust_add')}
              </button>
              <button
                type="button"
                onClick={() => setAdjustType('deduct')}
                className={cn(
                  'flex-1 py-2.5 rounded-xl font-medium text-sm transition-colors',
                  adjustType === 'deduct'
                    ? 'bg-orange-100 text-orange-700 border-2 border-orange-300'
                    : 'bg-gray-50 text-brand-muted border-2 border-transparent hover:bg-gray-100'
                )}
              >
                {t('inventory_page.modal.adjust_deduct')}
              </button>
            </div>
            <div>
              <label className="block text-sm font-medium text-brand-text mb-1">
                {t('inventory_page.modal.adjust_qty')}
              </label>
              <input
                type="number"
                min="0"
                step="any"
                value={adjustQty}
                onChange={(e) => setAdjustQty(e.target.value)}
                placeholder={t('inventory_page.modal.adjust_qty_placeholder')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary outline-none"
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
