// ============================================
// AUDIT LOG CONTROLLER
// ============================================
// File: controllers/auditLogController.js
// Description: Handles audit log-related business logic
// ============================================

const AuditLogModel = require('../models/auditLogModel');
const ApiResponse = require('../utils/apiResponse');

class AuditLogController {
	// Get all audit logs with filters
	static async getAll(req, res) {
		try {
			const {
				user_id,
				branch_id,
				table_name,
				action,
				start_date,
				end_date,
				limit,
				offset
			} = req.query;

			// Build filters object
			const filters = {};
			if (user_id) filters.user_id = parseInt(user_id);
			if (branch_id) filters.branch_id = parseInt(branch_id);
			if (table_name) filters.table_name = table_name;
			if (action) filters.action = action;
			if (start_date) filters.start_date = start_date;
			if (end_date) filters.end_date = end_date;
			if (limit) filters.limit = parseInt(limit) || 100;
			if (offset) filters.offset = parseInt(offset) || 0;

			// Default limit and offset if not provided
			if (!filters.limit) filters.limit = 100;
			if (!filters.offset) filters.offset = 0;

			const auditLogs = await AuditLogModel.getAll(filters);

			return ApiResponse.success(res, auditLogs, 'Audit logs retrieved successfully');
		} catch (error) {
			console.error('Error fetching audit logs:', error);
			return ApiResponse.error(res, 'Failed to fetch audit logs', 500, error.message);
		}
	}

	// Get audit logs by branch
	static async getByBranchId(req, res) {
		try {
			const { branchId } = req.params;
			const limit = parseInt(req.query.limit) || 100;

			if (!branchId) {
				return ApiResponse.badRequest(res, 'Branch ID is required');
			}

			const auditLogs = await AuditLogModel.getByBranchId(parseInt(branchId), limit);

			return ApiResponse.success(res, auditLogs, 'Audit logs retrieved successfully');
		} catch (error) {
			console.error('Error fetching audit logs by branch:', error);
			return ApiResponse.error(res, 'Failed to fetch audit logs', 500, error.message);
		}
	}

	// Get audit logs by user
	static async getByUserId(req, res) {
		try {
			const { userId } = req.params;
			const limit = parseInt(req.query.limit) || 100;

			if (!userId) {
				return ApiResponse.badRequest(res, 'User ID is required');
			}

			const auditLogs = await AuditLogModel.getByUserId(parseInt(userId), limit);

			return ApiResponse.success(res, auditLogs, 'Audit logs retrieved successfully');
		} catch (error) {
			console.error('Error fetching audit logs by user:', error);
			return ApiResponse.error(res, 'Failed to fetch audit logs', 500, error.message);
		}
	}
}

module.exports = AuditLogController;

