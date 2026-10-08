// ============================================
// TABLE CONTROLLER
// ============================================
// File: controllers/tableController.js
// Description: Handles restaurant table-related business logic
// ============================================

const TableModel = require('../models/tableModel');
const ApiResponse = require('../utils/apiResponse');

class TableController {

	// Get all restaurant tables
	static async getAll(req, res) {
		try {
			let branchId = null;

			// Admin (permissions = 1): by default see ALL branches,
			// but allow explicit ?branch_id=... override when provided.
			if (req.user?.permissions === 1 || req.session?.permissions === 1) {
				branchId = req.query.branch_id || req.body.branch_id || null;
			} else {
				// Non-admin: strictly scoped to their branch (session/user),
				// optionally narrowed further by explicit branch_id if provided.
				branchId =
					req.query.branch_id ||
					req.body.branch_id ||
					req.session?.branch_id ||
					req.user?.branch_id ||
					null;
			}

			const tables = await TableModel.getAll(branchId);
			return ApiResponse.success(res, tables, 'Tables retrieved successfully');
		} catch (error) {
			console.error('Error fetching restaurant tables:', error);
			return ApiResponse.error(res, 'Failed to fetch restaurant tables', 500, error.message);
		}
	}

	// Get single restaurant table by ID
	static async getById(req, res) {
		try {
			const { id } = req.params;
			const table = await TableModel.getById(id);
			if (!table) return ApiResponse.notFound(res, 'Restaurant table');
			return ApiResponse.success(res, table, 'Restaurant table retrieved successfully');
		} catch (error) {
			console.error('Error fetching restaurant table:', error);
			return ApiResponse.error(res, 'Failed to fetch restaurant table', 500, error.message);
		}
	}

	// Create new restaurant table
	static async create(req, res) {
		try {
			const {
				TABLE_NUMBER,
				FLOOR,
				CAPACITY,
				ROOM_CHARGE,
				STATUS
			} = req.body;

			if (!TABLE_NUMBER || TABLE_NUMBER.trim() === '') {
				return ApiResponse.badRequest(res, 'Table number is required');
			}

			const user_id = req.session.user_id || req.user?.user_id;

			// Prefer explicitly selected branch (from body/query) over session,
			// so admins can manage tables for different branches.
			const explicitBranchId = req.body.BRANCH_ID || req.query.branch_id;
			const sessionBranchId = req.session?.branch_id;
			const userBranchId = req.user?.branch_id;
			const branchId = explicitBranchId || sessionBranchId || userBranchId;

			if (!branchId) {
				return ApiResponse.badRequest(res, 'Branch ID is required. Please select a branch first.');
			}

			const normalizedTableNumber = TABLE_NUMBER.trim();
			const tableExists = await TableModel.existsByBranchAndNumber(branchId, normalizedTableNumber);
			if (tableExists) {
				return ApiResponse.error(res, 'Table number already exists for the selected branch.', 409);
			}

			const tableId = await TableModel.create({
				BRANCH_ID: branchId,
				TABLE_NUMBER: normalizedTableNumber,
				FLOOR,
				CAPACITY,
				ROOM_CHARGE,
				STATUS,
				user_id
			});

			return ApiResponse.created(res, { id: tableId }, 'Restaurant table created successfully');
		} catch (error) {
			console.error('Error creating restaurant table:', error);
			return ApiResponse.error(res, 'Failed to create restaurant table', 500, error.message);
		}
	}

	// Update restaurant table
	static async update(req, res) {
		try {
			const { id } = req.params;
			const {
				TABLE_NUMBER,
				FLOOR,
				CAPACITY,
				ROOM_CHARGE,
				STATUS
			} = req.body;

			if (!TABLE_NUMBER || TABLE_NUMBER.trim() === '') {
				return ApiResponse.badRequest(res, 'Table number is required');
			}

			const updated = await TableModel.update(id, {
				TABLE_NUMBER,
				FLOOR,
				CAPACITY,
				ROOM_CHARGE,
				STATUS
			});

			if (!updated) {
				return ApiResponse.notFound(res, 'Restaurant table');
			}

			return ApiResponse.success(res, null, 'Restaurant table updated successfully');
		} catch (error) {
			console.error('Error updating restaurant table:', error);
			return ApiResponse.error(res, 'Failed to update restaurant table', 500, error.message);
		}
	}

	// Delete restaurant table
	static async delete(req, res) {
		try {
			const { id } = req.params;

			const deleted = await TableModel.delete(id);

			if (!deleted) {
				return ApiResponse.notFound(res, 'Restaurant table');
			}

			return ApiResponse.success(res, null, 'Restaurant table deleted successfully');
		} catch (error) {
			console.error('Error deleting restaurant table:', error);
			return ApiResponse.error(res, 'Failed to delete restaurant table', 500, error.message);
		}
	}

	// Get transaction history for a specific table
	static async getTransactionHistory(req, res) {
		try {
			const { id } = req.params;
			const branchId = req.query.branch_id || req.body.branch_id || req.session?.branch_id || null;
			const transactions = await TableModel.getTransactionHistory(id, branchId);
			return ApiResponse.success(res, transactions, 'Transaction history retrieved successfully');
		} catch (error) {
			console.error('Error fetching transaction history:', error);
			return ApiResponse.error(res, 'Failed to fetch transaction history', 500, error.message);
		}
	}

	// Update table status directly
	static async updateStatus(req, res) {
		try {
			const { id } = req.params;
			const { status } = req.body;

			if (status === undefined || status === null) {
				return ApiResponse.badRequest(res, 'Status is required');
			}

			const table = await TableModel.getById(id);
			if (!table) {
				return ApiResponse.notFound(res, 'Restaurant table');
			}

			const updated = await TableModel.updateStatus(id, parseInt(status));
			if (!updated) {
				return ApiResponse.error(res, 'Failed to update table status', 500);
			}

			return ApiResponse.success(res, { 
				id: parseInt(id), 
				status: parseInt(status) 
			}, 'Table status updated successfully');
		} catch (error) {
			console.error('Error updating table status:', error);
			return ApiResponse.error(res, 'Failed to update table status', 500, error.message);
		}
	}
}

module.exports = TableController;

