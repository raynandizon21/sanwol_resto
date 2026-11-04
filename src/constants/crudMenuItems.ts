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
  {
    // Key kept from when this page was "Device Users", so saved role permissions still apply.
    key: 'device_users',
    label: 'Employees',
    description: 'Employees (users on the MB160 attendance device). Add: add people to the device (and enroll their fingerprint). Edit: edit profiles (the name on the device follows the profile name), enroll fingerprints. Delete: remove people from the device.',
  },
  {
    key: 'attendance_logs',
    label: 'Attendance Logs',
    description: 'Punches from the attendance device and attendance rules. Add: add a forgotten punch. Edit: correct a punch time or status, change the attendance rules. Delete: delete and restore punches.',
  },
] as const satisfies readonly CrudModuleConfig[];

export type CrudModuleKey = (typeof CRUD_MODULES)[number]['key'];

export const CRUD_ACTION_LABELS: Record<CrudActionKey, string> = {
  create: 'Add',
  update: 'Edit',
  delete: 'Delete',
};

