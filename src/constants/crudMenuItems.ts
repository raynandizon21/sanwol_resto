export type CrudActionKey = 'create' | 'update' | 'delete';

export interface CrudModuleConfig<K extends string = string> {
  key: K;
  label: string;
  description: string;
}

export const CRUD_MODULES = [
  {
    key: 'expenses',
    label: 'Expenses',
    description: 'Operations, sub categories and expense items.',
  },
  {
    key: 'menu_management',
    label: 'Menu Management',
    description: 'Menu items that appear on POS and reports.',
  },
  {
    key: 'orders',
    label: 'Orders',
    description: 'Customer orders and order items.',
  },
  {
    key: 'ingredients',
    label: 'Ingredients',
    description: 'Master list of recipe ingredients.',
  },
  {
    key: 'table_settings',
    label: 'Table Settings',
    description: 'Restaurant tables and capacities.',
  },
] as const satisfies readonly CrudModuleConfig[];

export type CrudModuleKey = (typeof CRUD_MODULES)[number]['key'];

export const CRUD_ACTION_LABELS: Record<CrudActionKey, string> = {
  create: 'Add',
  update: 'Edit',
  delete: 'Delete',
};

