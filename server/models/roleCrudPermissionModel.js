// ============================================
// ROLE CRUD PERMISSION MODEL
// ============================================
// Stores which CRUD actions are allowed per role
// for each CRUD-capable module in the admin UI.
// ============================================

const pool = require('../config/db');

/**
 * CRUD-capable modules.
 * Must stay in sync with frontend CRUD_MODULES / CrudModuleKey.
 */
const ALL_MODULE_KEYS = [
  'expenses',
  'menu_management',
  'orders',
  'ingredients',
  'table_settings',
];

function getTableName() {
  return 'user_role_crud_permissions';
}

async function ensureSchema() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS ${getTableName()} (
      role_id INT NOT NULL,
      module_key VARCHAR(64) NOT NULL,
      can_create TINYINT(1) NOT NULL DEFAULT 0,
      can_update TINYINT(1) NOT NULL DEFAULT 0,
      can_delete TINYINT(1) NOT NULL DEFAULT 0,
      PRIMARY KEY (role_id, module_key),
      INDEX idx_role (role_id),
      INDEX idx_module (module_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/**
 * Get CRUD permissions for a given role.
 * Returns an object: { [moduleKey]: { create, update, delete } }
 * Missing modules default to all false.
 */
async function getByRoleId(roleId) {
  await ensureSchema();
  const [rows] = await pool.execute(
    `SELECT module_key, can_create, can_update, can_delete
     FROM ${getTableName()}
     WHERE role_id = ?`,
    [Number(roleId)]
  );

  const result = {};
  (rows || []).forEach((r) => {
    const key = String(r.module_key);
    if (!ALL_MODULE_KEYS.includes(key)) return;
    result[key] = {
      create: !!r.can_create,
      update: !!r.can_update,
      delete: !!r.can_delete,
    };
  });

  // Ensure all known modules exist in the object
  ALL_MODULE_KEYS.forEach((key) => {
    if (!result[key]) {
      result[key] = { create: false, update: false, delete: false };
    }
  });

  return result;
}

/**
 * Replace CRUD permissions for a given role.
 * permissions shape: { [moduleKey]: { create?: boolean, update?: boolean, delete?: boolean } }
 */
async function setForRole(roleId, permissions) {
  await ensureSchema();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    await conn.execute(
      `DELETE FROM ${getTableName()} WHERE role_id = ?`,
      [Number(roleId)]
    );

    if (permissions && typeof permissions === 'object') {
      const entries = Object.entries(permissions);
      for (const [moduleKey, value] of entries) {
        const key = String(moduleKey);
        if (!ALL_MODULE_KEYS.includes(key)) continue;

        const create = value && typeof value === 'object' ? !!value.create : false;
        const update = value && typeof value === 'object' ? !!value.update : false;
        const del = value && typeof value === 'object' ? !!value.delete : false;

        // Skip inserting rows that have no allowed actions at all
        if (!create && !update && !del) continue;

        await conn.execute(
          `INSERT INTO ${getTableName()} (role_id, module_key, can_create, can_update, can_delete)
           VALUES (?, ?, ?, ?, ?)`,
          [Number(roleId), key, create ? 1 : 0, update ? 1 : 0, del ? 1 : 0]
        );
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  ALL_MODULE_KEYS,
  ensureSchema,
  getByRoleId,
  setForRole,
};

