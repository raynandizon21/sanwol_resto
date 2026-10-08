import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Filter, Package, Droplets, Leaf, Beef, Wheat, Fish, Flame, Shell, Coffee } from 'lucide-react';
import { DataTable, ColumnDef } from '../ui/DataTable';
import { cn } from '../../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { SkeletonPageHeader, SkeletonStatCards, SkeletonTable } from '../ui/Skeleton';
import { type Branch } from '../partials/Header';
import { getInventoryCategories, type InventoryCategory } from '../../services/inventoryService';
import {
  getInventoryCategoryMetrics,
  type InventoryCategoryMetric,
} from '../../services/inventoryItemService';
import { toast } from 'sonner';


// Icon mapping based on category name
const getIconForCategory = (name: string) => {
  const map: Record<string, any> = {
    'Meat': Beef,
    'Seafood': Fish,
    'Vegetables': Leaf,
    'Dairy': Droplets,
    'Grains': Wheat,
    'Oils': Flame,
    'Pasta': Shell,
    'Beverages': Coffee,
  };
  return map[name] || Package;
};

const getIconFromKey = (icon: string | null | undefined) => {
  const map: Record<string, any> = {
    package: Package,
    beef: Beef,
    fish: Fish,
    leaf: Leaf,
    droplets: Droplets,
    wheat: Wheat,
    shell: Shell,
    coffee: Coffee,
    flame: Flame,
  };
  return map[String(icon || '').toLowerCase()] || null;
};

interface CategoriesProps {
  onCategoryClick: (category: InventoryCategory) => void;
  selectedBranch: Branch | null;
}

export const Categories: React.FC<CategoriesProps> = ({ onCategoryClick, selectedBranch }) => {
  const { t, i18n } = useTranslation();
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [categoryMetricsMap, setCategoryMetricsMap] = useState<Map<string, InventoryCategoryMetric>>(
    () => new Map(),
  );
  const [dashboardMetrics, setDashboardMetrics] = useState({
    totalItems: 0,
    totalValue: 0,
    needsAttention: 0,
  });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchCategories = async () => {
    try {
      setLoading(true);
      const branchId = String(selectedBranch?.id || '');
      const [categoryRows, metrics] = await Promise.all([
        getInventoryCategories(branchId),
        getInventoryCategoryMetrics(branchId),
      ]);
      setCategories(categoryRows);
      const map = new Map<string, InventoryCategoryMetric>();
      for (const row of metrics.byCategory || []) {
        map.set(String(row.categoryId), row);
      }
      setCategoryMetricsMap(map);
      setDashboardMetrics({
        totalItems: Number(metrics.totals?.totalItems) || 0,
        totalValue: Number(metrics.totals?.totalValue) || 0,
        needsAttention: Number(metrics.totals?.needsAttention) || 0,
      });
    } catch (error: any) {
      toast.error(error.message || t('categories.messages.fetch_failed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedBranch) return;
    fetchCategories();
  }, [selectedBranch?.id]);

  const filteredCategories = categories.filter(cat =>
    cat.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    cat.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const metricFor = (category: InventoryCategory) =>
    categoryMetricsMap.get(category.id) || {
      categoryId: category.id,
      itemCount: 0,
      totalValue: 0,
      needsAttention: 0,
    };

  const localeForLanguage = (lng: string) => {
    const base = String(lng || 'en').split('-')[0];
    if (base === 'ja') return 'ja-JP';
    if (base === 'ko') return 'ko-KR';
    if (base === 'zh') return 'zh-CN';
    return 'en-US';
  };

  const formatValue = (value: number) => {
    const n = Number(value || 0);
    const safe = Number.isFinite(n) ? Math.trunc(n) : 0;
    return `${t('common.currency_symbol')}${safe.toLocaleString(localeForLanguage(i18n.language), {
      maximumFractionDigits: 0,
    })}`;
  };

  const columns: ColumnDef<InventoryCategory>[] = [
    {
      header: t('categories.category_name'),
      className: 'w-1/3',
      render: (category) => {
        const IconFromKey = getIconFromKey(category.icon);
        const IconComponent = IconFromKey || getIconForCategory(category.name);
        return (
          <div
            className="flex items-center gap-4 cursor-pointer group"
            onClick={() => onCategoryClick(category)}
          >
            <div className="w-12 h-12 rounded-xl border border-gray-200 bg-white flex items-center justify-center text-brand-muted group-hover:border-brand-primary group-hover:bg-brand-primary/5 group-hover:text-brand-primary transition-colors shrink-0">
              <IconComponent size={24} />
            </div>
            <div>
              <h3 className="text-base font-bold text-brand-text mb-0.5 group-hover:text-brand-primary transition-colors">
                {category.name}
              </h3>
              <p className="text-xs text-brand-muted font-medium truncate max-w-[200px] xl:max-w-[300px]">
                {category.description || t('categories.no_description')}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      header: t('categories.total_items'),
      className: 'text-center',
      render: (category) => {
        const metric = metricFor(category);
        return (
          <div className="flex flex-col items-center justify-center">
            <span className="text-sm font-bold text-brand-text">{metric.itemCount}</span>
            <span className="text-xs text-brand-muted">{t('categories.products')}</span>
          </div>
        );
      },
    },
    {
      header: t('categories.total_value'),
      className: 'text-center',
      render: (category) => {
        const metric = metricFor(category);
        return (
          <div className="flex flex-col items-center justify-center">
            <span className="text-sm font-bold text-brand-text">{formatValue(metric.totalValue)}</span>
            <span className="text-xs text-brand-muted">{t('categories.asset_value')}</span>
          </div>
        );
      },
    },
    {
      header: t('categories.status'),
      className: 'text-center',
      render: (category) => (
        <div className="flex justify-center">
          <span
            className={cn(
              "text-xs font-bold px-3 py-1.5 rounded-lg flex items-center gap-1.5 w-fit",
              category.active
                ? "bg-green-100 text-green-600"
                : "bg-red-100 text-red-600"
            )}
          >
            <span className={cn(
              "w-1.5 h-1.5 rounded-full",
              category.active ? "bg-green-500" : "bg-red-500"
            )} />
            {category.active ? t('categories.active') : t('categories.inactive')}
          </span>
        </div>
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
              <SkeletonTable columns={5} rows={8} />
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
            <div className="flex items-center gap-4">
              <div className="bg-white p-3 rounded-xl shadow-sm">
                <Filter size={18} className="text-brand-muted" />
              </div>
              <div className="relative">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                <input
                  type="text"
                  placeholder={t('categories.search_placeholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-80 shadow-sm focus:ring-2 focus:ring-brand-orange/20 outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-6">
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('categories.total_categories')}</p>
                <h3 className="text-3xl font-bold">{categories.length}</h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('categories.total_items')}</p>
                <h3 className="text-3xl font-bold">{dashboardMetrics.totalItems}</h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('categories.total_value')}</p>
                <h3 className="text-3xl font-bold text-green-600">{formatValue(dashboardMetrics.totalValue)}</h3>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm">
                <p className="text-brand-muted text-sm font-medium mb-1">{t('categories.needs_attention')}</p>
                <h3 className="text-3xl font-bold text-orange-500">{dashboardMetrics.needsAttention}</h3>
              </div>
            </div>

            <DataTable
              data={filteredCategories}
              columns={columns}
              keyExtractor={(item) => item.id}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
