// ============================================
// BRANCH SIDEBAR PERMISSION MODEL
// ============================================
// Stores which sidebar features are enabled per branch.
// Only admin can modify via User Access UI.
// ============================================

const pool = require('../config/db');

/** All sidebar feature keys (must match frontend SIDEBAR_FEATURE_KEYS) */
const ALL_FEATURES = [
	'dashboard',
	'expenses',
	'inventory',
	'menu_management',
	'sales_report',
	'sales_analytics',
	'menu',
	'category',
	'payment_type',
	'receipt',
	'orders',
	'billing',
	'ingredients',
	'table_settings',
];

function getTableName() {
	return 'branch_sidebar_permissions';
}

async function ensureSchema() {
	await pool.execute(`
		CREATE TABLE IF NOT EXISTS branch_sidebar_permissions (
			branch_id INT NOT NULL,
			feature_key VARCHAR(64) NOT NULL,
			PRIMARY KEY (branch_id, feature_key),
			INDEX idx_branch (branch_id),
			INDEX idx_feature (feature_key),
			FOREIGN KEY (branch_id) REFERENCES branches(IDNo) ON DELETE CASCADE
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
	`);
}

/**
 * Get enabled feature keys for one branch.
 * If no rows exist for branch, returns all features (backward compatible).
 */
async function getByBranchId(branchId) {
	await ensureSchema();
	const [rows] = await pool.execute(
		`SELECT feature_key FROM branch_sidebar_permissions WHERE branch_id = ?`,
		[Number(branchId)]
	);
	const list = (rows || []).map((r) => r.feature_key);
	if (list.length === 0) {
		return [...ALL_FEATURES];
	}
	return list;
}

/**
 * Get permissions for all branches. Returns { [branchId]: string[] }.
 * Branches with no rows get ALL_FEATURES.
 */
async function getAllByBranches(branchIds) {
	if (!branchIds || branchIds.length === 0) return {};
	await ensureSchema();
	const placeholders = branchIds.map(() => '?').join(',');
	const [rows] = await pool.execute(
		`SELECT branch_id, feature_key FROM branch_sidebar_permissions WHERE branch_id IN (${placeholders})`,
		branchIds.map(Number)
	);
	const byBranch = {};
	branchIds.forEach((id) => {
		byBranch[String(id)] = [];
	});
	(rows || []).forEach((r) => {
		const id = String(r.branch_id);
		if (!byBranch[id]) byBranch[id] = [];
		byBranch[id].push(r.feature_key);
	});
	// Branches with no rows = all features
	Object.keys(byBranch).forEach((id) => {
		if (byBranch[id].length === 0) {
			byBranch[id] = [...ALL_FEATURES];
		}
	});
	return byBranch;
}

/**
 * Replace permissions for one branch. featureKeys = array of enabled feature keys.
 */
async function setForBranch(branchId, featureKeys) {
	await ensureSchema();
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		await conn.execute(
			`DELETE FROM branch_sidebar_permissions WHERE branch_id = ?`,
			[Number(branchId)]
		);
		const validKeys = (featureKeys || []).filter((k) =>
			ALL_FEATURES.includes(String(k))
		);
		for (const key of validKeys) {
			await conn.execute(
				`INSERT INTO branch_sidebar_permissions (branch_id, feature_key) VALUES (?, ?)`,
				[Number(branchId), key]
			);
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

/**
 * Replace permissions for all branches. permissions = { [branchId]: string[] }.
 */
async function setAll(permissions) {
	if (!permissions || typeof permissions !== 'object') return;
	const branchIds = Object.keys(permissions).filter((id) => id !== 'all');
	for (const branchId of branchIds) {
		await setForBranch(branchId, permissions[branchId] || []);
	}
}

module.exports = {
	ALL_FEATURES,
	ensureSchema,
	getByBranchId,
	getAllByBranches,
	setForBranch,
	setAll,
};
