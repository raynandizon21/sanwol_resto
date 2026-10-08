const CashReconciliationModel = require('../models/cashReconciliationModel');
const ApiResponse = require('../utils/apiResponse');

class CashReconciliationController {
	static _branchId(req) {
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

	static async aggregates(req, res) {
		try {
			const rawBranch =
				req.query?.branch_id ??
				req.query?.BRANCH_ID ??
				req.body?.branch_id ??
				null;
			const branchId =
				rawBranch === null || rawBranch === undefined || rawBranch === '' || rawBranch === 'all'
					? null
					: Number(rawBranch);
			if (rawBranch !== null && rawBranch !== undefined && rawBranch !== '' && rawBranch !== 'all' && !Number.isFinite(branchId)) {
				return ApiResponse.badRequest(res, 'Invalid branch_id');
			}
			const startDate = req.query.start_date || req.query.date_from || null;
			const endDate = req.query.end_date || req.query.date_to || null;
			if (!startDate || !endDate) {
				return ApiResponse.badRequest(res, 'start_date and end_date are required');
			}
			const agg = await CashReconciliationModel.aggregatesForRange(branchId, startDate, endDate);
			return ApiResponse.success(res, agg, 'Cash reconciliation aggregates retrieved successfully');
		} catch (error) {
			console.error('[CashReconciliationController.aggregates]', error);
			return ApiResponse.error(res, 'Failed to fetch aggregates', 500, error.message);
		}
	}

	static async list(req, res) {
		try {
			const branchId = CashReconciliationController._branchId(req);
			if (!branchId) {
				return ApiResponse.badRequest(res, 'branch_id is required');
			}
			const startDate = req.query.start_date || req.query.date_from || null;
			const endDate = req.query.end_date || req.query.date_to || null;
			const rows = await CashReconciliationModel.list(branchId, startDate, endDate);
			return ApiResponse.success(res, rows, 'Cash reconciliation retrieved successfully');
		} catch (error) {
			console.error('[CashReconciliationController.list]', error);
			return ApiResponse.error(res, 'Failed to fetch cash reconciliation', 500, error.message);
		}
	}

	static async getById(req, res) {
		try {
			const branchId = CashReconciliationController._branchId(req);
			if (!branchId) {
				return ApiResponse.badRequest(res, 'branch_id is required');
			}
			const { id } = req.params;
			const row = await CashReconciliationModel.getById(id, branchId);
			if (!row) return ApiResponse.notFound(res, 'Cash reconciliation');
			return ApiResponse.success(res, row, 'Cash reconciliation retrieved successfully');
		} catch (error) {
			console.error('[CashReconciliationController.getById]', error);
			return ApiResponse.error(res, 'Failed to fetch record', 500, error.message);
		}
	}

	static async create(req, res) {
		try {
			const branchId = CashReconciliationController._branchId(req);
			if (!branchId) {
				return ApiResponse.badRequest(res, 'branch_id is required');
			}
			const businessDate = req.body.BUSINESS_DATE || req.body.business_date || req.body.businessDate;
			const amountRaw = req.body.AMOUNT ?? req.body.amount;
			if (!businessDate || String(businessDate).trim() === '') {
				return ApiResponse.badRequest(res, 'BUSINESS_DATE is required');
			}
			const amount = Number(amountRaw);
			if (!Number.isFinite(amount)) {
				return ApiResponse.badRequest(res, 'AMOUNT must be a valid number');
			}
			const userId = req.session?.user_id ?? req.user?.user_id ?? null;
			const id = await CashReconciliationModel.create({
				BRANCH_ID: branchId,
				BUSINESS_DATE: businessDate,
				AMOUNT: amount,
				ENCODED_BY: userId,
			});
			return ApiResponse.created(res, { id }, 'Cash reconciliation created successfully');
		} catch (error) {
			console.error('[CashReconciliationController.create]', error);
			return ApiResponse.error(res, error.message || 'Failed to create', 500, error.message);
		}
	}

	static async update(req, res) {
		try {
			const branchId = CashReconciliationController._branchId(req);
			if (!branchId) {
				return ApiResponse.badRequest(res, 'branch_id is required');
			}
			const { id } = req.params;
			const current = await CashReconciliationModel.getById(id, branchId);
			if (!current) return ApiResponse.notFound(res, 'Cash reconciliation');

			const businessDate = req.body.BUSINESS_DATE || req.body.business_date || req.body.businessDate;
			const amountRaw = req.body.AMOUNT ?? req.body.amount;
			if (!businessDate || String(businessDate).trim() === '') {
				return ApiResponse.badRequest(res, 'BUSINESS_DATE is required');
			}
			const amount = Number(amountRaw);
			if (!Number.isFinite(amount)) {
				return ApiResponse.badRequest(res, 'AMOUNT must be a valid number');
			}
			const userId = req.session?.user_id ?? req.user?.user_id ?? null;
			const ok = await CashReconciliationModel.update(id, branchId, {
				BUSINESS_DATE: businessDate,
				AMOUNT: amount,
				EDITED_BY: userId,
			});
			if (!ok) return ApiResponse.notFound(res, 'Cash reconciliation');
			return ApiResponse.success(res, null, 'Cash reconciliation updated successfully');
		} catch (error) {
			console.error('[CashReconciliationController.update]', error);
			return ApiResponse.error(res, error.message || 'Failed to update', 500, error.message);
		}
	}

	static async remove(req, res) {
		try {
			const branchId = CashReconciliationController._branchId(req);
			if (!branchId) {
				return ApiResponse.badRequest(res, 'branch_id is required');
			}
			const { id } = req.params;
			const userId = req.session?.user_id ?? req.user?.user_id ?? null;
			const ok = await CashReconciliationModel.softDelete(id, branchId, userId);
			if (!ok) return ApiResponse.notFound(res, 'Cash reconciliation');
			return ApiResponse.success(res, null, 'Cash reconciliation deleted successfully');
		} catch (error) {
			console.error('[CashReconciliationController.remove]', error);
			return ApiResponse.error(res, error.message || 'Failed to delete', 500, error.message);
		}
	}
}

module.exports = CashReconciliationController;
