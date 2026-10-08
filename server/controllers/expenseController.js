const ExpenseModel = require('../models/expenseModel');
const MasterCategoryModel = require('../models/masterCategoryModel');
const InventoryModel = require('../models/inventoryModel');
const ApiResponse = require('../utils/apiResponse');

function csvEscape(value) {
	const text = String(value ?? '');
	if (/[",\n]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}
	return text;
}

class ExpenseController {
	static _resolveBranchId(req) {
		const raw =
			req.query?.branch_id ||
			req.body?.branch_id ||
			req.body?.BRANCH_ID ||
			req.session?.branch_id ||
			req.user?.branch_id ||
			null;
		if (raw === null || raw === undefined || raw === '' || raw === 'all') return null;
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : null;
	}

	static _resolvePayload(req) {
		return {
			MASTER_CAT_ID: req.body.MASTER_CAT_ID ?? req.body.masterCatId ?? req.body.master_cat_id ?? null,
			EXP_CAT: req.body.EXP_CAT || req.body.expCat || req.body.categoryType || req.body.CATEGORY_TYPE || '',
			EXP_NAME: req.body.EXP_NAME || req.body.expName || req.body.categoryName || req.body.CATEGORY_NAME || '',
			EXP_DESC: req.body.EXP_DESC || req.body.expDesc || req.body.description || req.body.DESC || null,
			EXP_AMOUNT: req.body.EXP_AMOUNT ?? req.body.expAmount ?? req.body.amount ?? null,
			EXP_QTY: req.body.EXP_QTY ?? req.body.expQty ?? req.body.exp_qty ?? null,
			UNIT: req.body.UNIT ?? req.body.unit ?? null,
			EXP_SOURCE: req.body.EXP_SOURCE || req.body.expSource || req.body.source || null,
			RECEIPT_IMAGE_PATH:
				req.body.RECEIPT_IMAGE_PATH ??
				req.body.receiptImagePath ??
				req.body.receipt_image_path ??
				req.body.receipt_image ??
				null,
			ENCODED_DT: req.body.ENCODED_DT ?? req.body.encoded_dt ?? req.body.encodedDt ?? undefined,
		};
	}

	static _resolveReportFilters(req) {
		return {
			branchId: ExpenseController._resolveBranchId(req),
			dateFrom: req.query.date_from || req.query.start_date || null,
			dateTo: req.query.date_to || req.query.end_date || null,
			categoryType: req.query.exp_cat || req.query.category_type || null,
			categoryName: req.query.exp_name || req.query.category_name || null,
			search: req.query.search || null,
			period: req.query.period === 'daily' ? 'daily' : 'monthly',
		};
	}

	static async getAll(req, res) {
		try {
			const branchId = ExpenseController._resolveBranchId(req);
			const startDate = req.query.start_date || req.query.date_from || null;
			const endDate = req.query.end_date || req.query.date_to || null;
			const rows = await ExpenseModel.getAll(branchId, {
				start_date: startDate,
				end_date: endDate,
			});
			return ApiResponse.success(res, rows, 'Expenses retrieved successfully');
		} catch (error) {
			console.error('[ExpenseController.getAll] error:', error);
			return ApiResponse.error(res, 'Failed to fetch expenses', 500, error.message);
		}
	}

	static async getById(req, res) {
		try {
			const { id } = req.params;
			const row = await ExpenseModel.getById(id);
			if (!row) return ApiResponse.notFound(res, 'Expense');
			return ApiResponse.success(res, row, 'Expense retrieved successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to fetch expense', 500, error.message);
		}
	}

	static async create(req, res) {
		try {
			const branchId = ExpenseController._resolveBranchId(req);
			if (!branchId) return ApiResponse.badRequest(res, 'Branch ID is required');

			const payload = ExpenseController._resolvePayload(req);
			const masterCatIdRaw = payload.MASTER_CAT_ID;
			const masterCatId = masterCatIdRaw !== null && masterCatIdRaw !== undefined && masterCatIdRaw !== ''
				? Number(masterCatIdRaw)
				: null;

			const amount = Number(payload.EXP_AMOUNT);
			if (!Number.isFinite(amount) || amount < 0) {
				return ApiResponse.badRequest(res, 'Amount must be a valid non-negative number');
			}

			let masterCategory = null;
			if (masterCatId) {
				masterCategory = await MasterCategoryModel.getByIdForBranch(branchId, masterCatId);
			} else if (payload.EXP_CAT && payload.EXP_NAME) {
				masterCategory = await MasterCategoryModel.getByTypeAndName(
					branchId,
					String(payload.EXP_CAT).trim(),
					String(payload.EXP_NAME).trim()
				);
			}
			if (!masterCategory) {
				return ApiResponse.badRequest(res, 'Please select a valid expense category');
			}

			const userId = req.session?.user_id || req.user?.user_id || null;
			const encodedBy = userId || req.user?.username || 'system';
			const encodedDtRaw =
				req.body?.ENCODED_DT ??
				req.body?.encoded_dt ??
				req.body?.encodedDt ??
				null;
			const encodedDt = encodedDtRaw && String(encodedDtRaw).trim() !== '' ? String(encodedDtRaw) : null;
			const id = await ExpenseModel.create({
				BRANCH_ID: branchId,
				MASTER_CAT_ID: masterCategory.IDNo,
				EXP_DESC: payload.EXP_DESC,
				EXP_AMOUNT: amount,
				EXP_QTY: payload.EXP_QTY,
				UNIT: payload.UNIT,
				EXP_SOURCE: payload.EXP_SOURCE,
				RECEIPT_IMAGE_PATH: payload.RECEIPT_IMAGE_PATH,
				user_id: userId,
				ENCODED_BY: encodedBy,
				ENCODED_DT: encodedDt,
			});

			return ApiResponse.created(res, { id }, 'Expense created successfully');
		} catch (error) {
			console.error('[ExpenseController.create] error:', error);
			return ApiResponse.error(res, error.message || 'Failed to create expense', 500, error.message);
		}
	}

	static async update(req, res) {
		try {
			const { id } = req.params;
			const current = await ExpenseModel.getById(id);
			if (!current) return ApiResponse.notFound(res, 'Expense');

			const payload = ExpenseController._resolvePayload(req);
			const masterCatIdRaw = payload.MASTER_CAT_ID;
			const masterCatId = masterCatIdRaw !== null && masterCatIdRaw !== undefined && masterCatIdRaw !== ''
				? Number(masterCatIdRaw)
				: null;

			const amount = Number(payload.EXP_AMOUNT);
			if (!Number.isFinite(amount) || amount < 0) {
				return ApiResponse.badRequest(res, 'Amount must be a valid non-negative number');
			}

			let masterCategory = null;
			if (masterCatId) {
				masterCategory = await MasterCategoryModel.getByIdForBranch(Number(current.BRANCH_ID), masterCatId);
			} else if (payload.EXP_CAT && payload.EXP_NAME) {
				masterCategory = await MasterCategoryModel.getByTypeAndName(
					Number(current.BRANCH_ID),
					String(payload.EXP_CAT).trim(),
					String(payload.EXP_NAME).trim()
				);
			}
			if (!masterCategory) {
				return ApiResponse.badRequest(res, 'Please select a valid expense category');
			}

			const userId = req.session?.user_id || req.user?.user_id || null;
			const encodedDtRaw = payload.ENCODED_DT;
			const encodedDt =
				encodedDtRaw !== undefined && encodedDtRaw !== null && String(encodedDtRaw).trim() !== ''
					? String(encodedDtRaw).trim()
					: encodedDtRaw !== undefined
						? null
						: undefined;

			const ok = await ExpenseModel.update(id, {
				MASTER_CAT_ID: masterCategory.IDNo,
				EXP_DESC: payload.EXP_DESC,
				EXP_AMOUNT: amount,
				EXP_QTY: payload.EXP_QTY,
				UNIT: payload.UNIT,
				EXP_SOURCE: payload.EXP_SOURCE,
				RECEIPT_IMAGE_PATH: payload.RECEIPT_IMAGE_PATH,
				user_id: userId,
				...(encodedDt !== undefined ? { ENCODED_DT: encodedDt } : {}),
			});

			if (!ok) return ApiResponse.notFound(res, 'Expense');

			return ApiResponse.success(res, null, 'Expense updated successfully');
		} catch (error) {
			console.error('[ExpenseController.update] error:', error);
			return ApiResponse.error(res, error.message || 'Failed to update expense', 500, error.message);
		}
	}

	static async delete(req, res) {
		try {
			const { id } = req.params;
			const current = await ExpenseModel.getById(id);
			if (!current) return ApiResponse.notFound(res, 'Expense');

			// Deduct inventory qty before soft delete (inventory category only)
			const isInventoryCategory = current.OP_CAT_STATE === 1;
			const expQty = current.EXP_QTY != null ? Number(current.EXP_QTY) : 0;
			if (isInventoryCategory && Number.isFinite(expQty) && expQty > 0) {
				try {
					await InventoryModel.updateStockByExpenseId(id, -expQty, current.BRANCH_ID, true);
				} catch (invErr) {
					console.warn('[ExpenseController.delete] inventory deduct:', invErr?.message);
				}
			}

			const userId = req.session?.user_id || req.user?.user_id || null;
			const ok = await ExpenseModel.delete(id, userId);
			if (!ok) return ApiResponse.notFound(res, 'Expense');
			return ApiResponse.success(res, null, 'Expense deleted successfully');
		} catch (error) {
			console.error('[ExpenseController.delete] error:', error);
			return ApiResponse.error(res, error.message || 'Failed to delete expense', 500, error.message);
		}
	}

	static async getSummary(req, res) {
		try {
			const filters = ExpenseController._resolveReportFilters(req);
			const summary = await ExpenseModel.getSummary(filters);
			return ApiResponse.success(res, summary, 'Expense summary retrieved successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to fetch expense summary', 500, error.message);
		}
	}

	static async getByCategory(req, res) {
		try {
			const filters = ExpenseController._resolveReportFilters(req);
			const rows = await ExpenseModel.getCategoryBreakdown(filters);
			return ApiResponse.success(res, rows, 'Expense category breakdown retrieved successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to fetch expense category breakdown', 500, error.message);
		}
	}

	static async getTrend(req, res) {
		try {
			const filters = ExpenseController._resolveReportFilters(req);
			const rows = await ExpenseModel.getTrend(filters);
			return ApiResponse.success(res, rows, 'Expense trend retrieved successfully');
		} catch (error) {
			return ApiResponse.error(res, 'Failed to fetch expense trend', 500, error.message);
		}
	}

	static async exportCsv(req, res) {
		try {
			const filters = ExpenseController._resolveReportFilters(req);
			const rows = await ExpenseModel.getExportRows(filters);
			const header = [
				'ID',
				'Branch',
				'Category Type',
				'Category Name',
				'Description',
				'Amount',
				'Source',
				'Encoded By',
				'Encoded Date',
			];
			const lines = [
				header.join(','),
				...rows.map((row) =>
					[
						row.IDNo,
						row.BRANCH_NAME || row.BRANCH_ID || '',
						row.EXP_CAT || '',
						row.EXP_NAME || '',
						row.EXP_DESC || '',
						Number(row.EXP_AMOUNT || 0).toFixed(2),
						row.EXP_SOURCE || '',
						row.ENCODED_BY || '',
						row.ENCODED_DT || '',
					]
						.map(csvEscape)
						.join(',')
				),
			];

			res.setHeader('Content-Type', 'text/csv; charset=utf-8');
			res.setHeader('Content-Disposition', `attachment; filename="expenses-${new Date().toISOString().slice(0, 10)}.csv"`);
			return res.status(200).send(lines.join('\n'));
		} catch (error) {
			return ApiResponse.error(res, 'Failed to export expenses CSV', 500, error.message);
		}
	}
}

module.exports = ExpenseController;
