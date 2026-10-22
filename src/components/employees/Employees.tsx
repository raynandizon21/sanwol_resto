import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Search, Plus, Edit2, Trash2, Info } from 'lucide-react';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Select2 } from '../ui/Select2';
import { cn } from '../../lib/utils';

interface EmployeeRow {
  id: number;
  fullname: string;
  contact: string;
  department: string;
  branch: string;
  dateStarted: string;
  active: boolean;
}

// Static placeholder rows until the page is wired to /employees_list.
const SAMPLE_EMPLOYEES: EmployeeRow[] = [
  { id: 1, fullname: 'Juan Dela Cruz', contact: '0917 123 4567', department: 'Kitchen', branch: 'Sanwol BBQ', dateStarted: '2025-03-01', active: true },
  { id: 2, fullname: 'Maria Santos', contact: '0918 234 5678', department: 'Cashier', branch: 'Sanwol BBQ', dateStarted: '2025-04-15', active: true },
  { id: 3, fullname: 'Pedro Reyes', contact: '0919 345 6789', department: 'Waiter/Waitress', branch: 'Sanwol BBQ', dateStarted: '2025-06-10', active: true },
  { id: 4, fullname: 'Ana Garcia', contact: '0920 456 7890', department: 'Manager', branch: 'Sanwol BBQ', dateStarted: '2024-11-20', active: true },
  { id: 5, fullname: 'Jose Ramos', contact: '0921 567 8901', department: 'Service', branch: 'Sanwol BBQ', dateStarted: '2025-01-05', active: false },
];

export const Employees: React.FC = () => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const filteredEmployees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return SAMPLE_EMPLOYEES.filter((emp) => {
      if (statusFilter === 'active' && !emp.active) return false;
      if (statusFilter === 'inactive' && emp.active) return false;
      if (!q) return true;
      return [emp.fullname, emp.contact, emp.department, emp.branch].some((v) =>
        v.toLowerCase().includes(q),
      );
    });
  }, [searchQuery, statusFilter]);

  const activeCount = SAMPLE_EMPLOYEES.filter((emp) => emp.active).length;

  const columns: ColumnDef<EmployeeRow>[] = [
    {
      header: t('employee.fullname'),
      render: (emp) => <span className="text-sm font-bold text-brand-text">{emp.fullname}</span>,
    },
    {
      header: t('employee.contact'),
      render: (emp) => <span className="text-sm font-medium tabular-nums">{emp.contact}</span>,
    },
    {
      header: t('employee.department'),
      render: (emp) => <span className="text-sm font-medium">{emp.department}</span>,
    },
    {
      header: t('employee.branch'),
      render: (emp) => <span className="text-sm font-medium">{emp.branch}</span>,
    },
    {
      header: t('employee.date_started'),
      render: (emp) => <span className="text-sm font-medium tabular-nums">{emp.dateStarted}</span>,
    },
    {
      header: t('employee.status'),
      render: (emp) => (
        <span
          className={cn(
            'px-2.5 py-1 rounded-full text-xs font-bold',
            emp.active ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-brand-muted',
          )}
        >
          {emp.active ? t('employee.active') : t('employee.inactive')}
        </span>
      ),
    },
    {
      header: t('employee.action'),
      className: 'text-right',
      render: () => (
        <div className="flex justify-end items-center gap-2">
          <button
            type="button"
            disabled
            className="p-2 text-brand-muted/50 rounded-lg cursor-not-allowed"
          >
            <Edit2 size={16} />
          </button>
          <button
            type="button"
            disabled
            className="p-2 text-brand-muted/50 rounded-lg cursor-not-allowed"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-8 pt-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="space-y-8"
      >
        <div className="flex items-center gap-2 bg-brand-primary/5 border border-brand-primary/20 text-brand-primary rounded-xl px-4 py-3 text-sm font-medium">
          <Info size={16} className="shrink-0" />
          {t('employee.static_preview_notice', 'Preview only — showing sample data. Employee records will be connected soon.')}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="relative">
              <Search
                size={18}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted"
              />
              <input
                type="text"
                placeholder={t('table.pagination.search_placeholder')}
                className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-80 shadow-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select2
              options={[
                { value: 'all', label: t('table.all') },
                { value: 'active', label: t('employee.active') },
                { value: 'inactive', label: t('employee.inactive') },
              ]}
              value={statusFilter}
              onChange={(v) => setStatusFilter((v as string) || 'all')}
              placeholder={t('employee.status')}
              className="w-48"
            />
          </div>
          <button
            type="button"
            disabled
            className="bg-brand-primary/60 text-white px-6 py-2.5 rounded-xl text-base font-bold flex items-center gap-2 cursor-not-allowed"
          >
            <Plus size={18} />
            {t('employee.new_employee')}
          </button>
        </div>

        <div className="grid grid-cols-3 gap-6">
          <div className="bg-white p-6 rounded-2xl shadow-sm">
            <p className="text-brand-muted text-sm font-medium mb-1">{t('employee.manage_employee')}</p>
            <h3 className="text-3xl font-bold">{SAMPLE_EMPLOYEES.length}</h3>
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm">
            <p className="text-brand-muted text-sm font-medium mb-1">{t('employee.active')}</p>
            <h3 className="text-3xl font-bold text-green-600">{activeCount}</h3>
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm">
            <p className="text-brand-muted text-sm font-medium mb-1">{t('employee.inactive')}</p>
            <h3 className="text-3xl font-bold text-brand-muted">
              {SAMPLE_EMPLOYEES.length - activeCount}
            </h3>
          </div>
        </div>

        <DataTable
          data={filteredEmployees}
          columns={columns}
          keyExtractor={(item) => String(item.id)}
        />
      </motion.div>
    </div>
  );
};
