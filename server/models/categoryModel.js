// Category model: DB operations for menu categories

const pool = require('../config/db');

class CategoryModel {
	static _schemaReady = false;
	static _schemaPromise = null;

	/** Nullable PARENT_CAT_ID: null = main category; set = subcategory under that main (one level). */
	static async ensureSchema() {
		if (CategoryModel._schemaReady) return;
		if (CategoryModel._schemaPromise) return CategoryModel._schemaPromise;

		CategoryModel._schemaPromise = (async () => {
			try {
				await pool.execute(`
					ALTER TABLE categories
					ADD COLUMN PARENT_CAT_ID INT NULL
				`);
			} catch (e) {
				const msg = String(e?.message || '');
				if (!/Duplicate column name/i.test(msg)) {
					console.warn('[CategoryModel] ensureSchema PARENT_CAT_ID:', msg);
				}
			}
			try {
				await pool.execute(`
					ALTER TABLE categories
					ADD INDEX idx_categories_parent (PARENT_CAT_ID)
				`);
			} catch (e) {
				const msg = String(e?.message || '');
				if (!/Duplicate key name/i.test(msg)) {
					console.warn('[CategoryModel] ensureSchema idx_categories_parent:', msg);
				}
			}
			CategoryModel._schemaReady = true;
			CategoryModel._schemaPromise = null;
		})().catch((err) => {
			CategoryModel._schemaPromise = null;
			throw err;
		});

		return CategoryModel._schemaPromise;
	}

	static async getAll(branchId = null) {
		await CategoryModel.ensureSchema();
		let query = `SELECT IDNo, CAT_NAME, CAT_DESC, PARENT_CAT_ID, ACTIVE, ENCODED_BY, ENCODED_DT, EDITED_BY, EDITED_DT FROM categories WHERE ACTIVE = 1`;
		const params = [];
		if (branchId != null) {
			query += ` AND BRANCH_ID = ?`;
			params.push(branchId);
		}

		query += ` ORDER BY IDNo ASC`;

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	static async getById(id) {
		const [rows] = await pool.execute('SELECT * FROM categories WHERE IDNo = ? AND ACTIVE = 1', [id]);
		return rows[0];
	}

	// IDNo may not be AUTO_INCREMENT; use MAX+1 to avoid duplicate key
	static async create(data) {
		await CategoryModel.ensureSchema();
		const { CAT_NAME, CAT_DESC, BRANCH_ID, PARENT_CAT_ID, user_id } = data;
		const branchId = BRANCH_ID != null && BRANCH_ID !== '' ? Number(BRANCH_ID) : null;
		const encodedBy = user_id != null && user_id !== '' ? Number(user_id) : null;
		let parentId = null;
		if (PARENT_CAT_ID != null && PARENT_CAT_ID !== '') {
			const p = Number(PARENT_CAT_ID);
			if (Number.isFinite(p)) {
				const [prows] = await pool.execute(
					`SELECT IDNo, BRANCH_ID, PARENT_CAT_ID FROM categories WHERE IDNo = ? AND ACTIVE = 1 LIMIT 1`,
					[p]
				);
				const pr = prows[0];
				if (!pr) {
					throw new Error('Parent category not found');
				}
				if (Number(pr.BRANCH_ID) !== Number(branchId)) {
					throw new Error('Parent category must belong to the same branch');
				}
				if (pr.PARENT_CAT_ID != null) {
					throw new Error('Subcategories cannot be nested (parent must be a main category)');
				}
				parentId = p;
			}
		}
		const [rows] = await pool.execute('SELECT COALESCE(MAX(IDNo), 0) + 1 AS nextId FROM categories');
		const nextId = Number(rows[0]?.nextId ?? rows[0]?.nextid ?? 1) || 1;
		const now = new Date();

		await pool.execute(
			'INSERT INTO categories (IDNo, BRANCH_ID, CAT_NAME, CAT_DESC, PARENT_CAT_ID, ACTIVE, ENCODED_BY, ENCODED_DT) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
			[nextId, branchId, (String(CAT_NAME || '')).trim(), CAT_DESC || null, parentId, encodedBy, now]
		);
		return nextId;
	}

	static async update(id, data) {
		await CategoryModel.ensureSchema();
		const { CAT_NAME, CAT_DESC, PARENT_CAT_ID, user_id } = data;
		const categoryId = Number(id);
		let parentId = null;
		if (PARENT_CAT_ID != null && PARENT_CAT_ID !== '') {
			const p = Number(PARENT_CAT_ID);
			if (Number.isFinite(p)) {
				if (p === categoryId) {
					throw new Error('Category cannot be its own parent');
				}
				const [targetRows] = await pool.execute(
					`SELECT IDNo, BRANCH_ID, PARENT_CAT_ID FROM categories WHERE IDNo = ? AND ACTIVE = 1 LIMIT 1`,
					[categoryId]
				);
				const target = targetRows[0];
				if (!target) {
					throw new Error('Category not found');
				}
				const [parentRows] = await pool.execute(
					`SELECT IDNo, BRANCH_ID, PARENT_CAT_ID FROM categories WHERE IDNo = ? AND ACTIVE = 1 LIMIT 1`,
					[p]
				);
				const parent = parentRows[0];
				if (!parent) {
					throw new Error('Parent category not found');
				}
				if (Number(parent.BRANCH_ID) !== Number(target.BRANCH_ID)) {
					throw new Error('Parent category must belong to the same branch');
				}
				if (parent.PARENT_CAT_ID != null) {
					throw new Error('Subcategories cannot be nested (parent must be a main category)');
				}
				parentId = p;
			}
		}
		const now = new Date();
		const [result] = await pool.execute(
			'UPDATE categories SET CAT_NAME = ?, CAT_DESC = ?, PARENT_CAT_ID = ?, EDITED_BY = ?, EDITED_DT = ? WHERE IDNo = ? AND ACTIVE = 1',
			[CAT_NAME.trim(), CAT_DESC || null, parentId, user_id, now, categoryId]
		);
		return result.affectedRows > 0;
	}

	static async delete(id, user_id) {
		await CategoryModel.ensureSchema();
		const [kids] = await pool.execute(
			`SELECT COUNT(*) AS c FROM categories WHERE PARENT_CAT_ID = ? AND ACTIVE = 1`,
			[id]
		);
		if (Number(kids[0]?.c) > 0) {
			throw new Error('Delete or move subcategories before deleting this main category.');
		}
		const now = new Date();
		const [result] = await pool.execute('UPDATE categories SET ACTIVE = 0, EDITED_BY = ?, EDITED_DT = ? WHERE IDNo = ?', [user_id, now, id]);
		return result.affectedRows > 0;
	}

	/**
	 * One-time: branch was flat (all PARENT_CAT_ID null). Create one new main row and set all existing
	 * categories for the branch to be its subcategories. Refuses if any row already has a parent (already migrated).
	 */
	static async groupFlatRootsUnderNewMain(branchId, mainCatName, user_id) {
		await CategoryModel.ensureSchema();
		const bid = Number(branchId);
		if (!Number.isFinite(bid)) {
			throw new Error('Invalid branch id');
		}

		const [hasSubs] = await pool.execute(
			`SELECT COUNT(*) AS c FROM categories WHERE BRANCH_ID = ? AND ACTIVE = 1 AND PARENT_CAT_ID IS NOT NULL`,
			[bid]
		);
		if (Number(hasSubs[0]?.c) > 0) {
			throw new Error(
				'This branch already has subcategories. This tool only runs when every category is still top-level (no parent).'
			);
		}

		const [roots] = await pool.execute(
			`SELECT IDNo FROM categories WHERE BRANCH_ID = ? AND ACTIVE = 1`,
			[bid]
		);
		if (!roots.length) {
			return { moved: 0, newMainId: null };
		}

		const name = String(mainCatName || '').trim() || 'Menu';
		const newMainId = await CategoryModel.create({
			CAT_NAME: name,
			CAT_DESC: null,
			BRANCH_ID: bid,
			PARENT_CAT_ID: null,
			user_id,
		});

		const rootIds = roots.map((r) => r.IDNo);
		const placeholders = rootIds.map(() => '?').join(',');
		const now = new Date();
		const [result] = await pool.execute(
			`UPDATE categories SET PARENT_CAT_ID = ?, EDITED_BY = ?, EDITED_DT = ? WHERE BRANCH_ID = ? AND ACTIVE = 1 AND IDNo IN (${placeholders}) AND IDNo <> ?`,
			[newMainId, user_id, now, bid, ...rootIds, newMainId]
		);

		return { moved: result.affectedRows || 0, newMainId };
	}
}

module.exports = CategoryModel;

