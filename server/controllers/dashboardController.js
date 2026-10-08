// ============================================
// DASHBOARD CONTROLLER
// ============================================
// File: controllers/dashboardController.js
// Description: Handles dashboard-related business logic
// ============================================

const DashboardModel = require('../models/dashboardModel');
const BranchModel = require('../models/branchModel');
const ApiResponse = require('../utils/apiResponse');

class DashboardController {
	// Get dashboard statistics
	static async getStats(req, res) {
		try {
			const permissions = req.session?.permissions || req.user?.permissions;
			if (permissions === undefined) {
				return ApiResponse.error(res, 'Permissions are undefined', 500);
			}

			const branchId = req.session?.branch_id || req.user?.branch_id || req.query.branch_id || null;
			const startDate = req.query.start_date || null;
			const endDate = req.query.end_date || null;

			// Fetch all dashboard statistics (generic cards)
			const stats = await DashboardModel.getDashboardStats(branchId, startDate, endDate);

			const currentBranch = branchId ? await BranchModel.getById(branchId) : null;

			return ApiResponse.success(res, {
				stats: {
					todaysRevenue: stats.todaysRevenue || 0,
					totalOrders: stats.totalOrders || 0,
					activeTables: stats.activeTables || 0,
					pendingOrders: stats.pendingOrders || 0,
					popularItems: stats.popularItems || 0,
					todaysRefunds: stats.todaysRefunds || 0
				},
				currentBranch,
				permissions,
				user: {
					username: req.session?.username || req.user?.username,
					firstname: req.session?.firstname || req.user?.firstname,
					lastname: req.session?.lastname || req.user?.lastname,
					user_id: req.session?.user_id || req.user?.user_id
				}
			}, 'Dashboard statistics retrieved successfully');
		} catch (error) {
			console.error('Error fetching dashboard data:', error);
			return ApiResponse.error(res, 'Failed to fetch dashboard statistics', 500, error.message);
		}
	}

	// Get individual dashboard stats
	static async getRevenue(req, res) {
		try {
			const branchId = req.session?.branch_id || req.query.branch_id || req.user?.branch_id || null;
			const startDate = req.query.start_date || null;
			const endDate = req.query.end_date || null;
			const revenue = await DashboardModel.getTodaysRevenue(branchId, startDate, endDate);
			return ApiResponse.success(res, { revenue }, 'Revenue retrieved successfully');
		} catch (error) {
			console.error('Error fetching revenue:', error);
			return ApiResponse.error(res, 'Failed to fetch revenue', 500, error.message);
		}
	}

	static async getOrders(req, res) {
		try {
			const branchId = req.session?.branch_id || req.query.branch_id || req.user?.branch_id || null;
			const startDate = req.query.start_date || null;
			const endDate = req.query.end_date || null;
			const orders = await DashboardModel.getTotalOrders(branchId, startDate, endDate);
			return ApiResponse.success(res, { orders }, 'Orders count retrieved successfully');
		} catch (error) {
			console.error('Error fetching orders:', error);
			return ApiResponse.error(res, 'Failed to fetch orders', 500, error.message);
		}
	}

	static async getTables(req, res) {
		try {
			const branchId = req.session?.branch_id || req.query.branch_id || req.user?.branch_id || null;
			const startDate = req.query.start_date || null;
			const endDate = req.query.end_date || null;
			const tables = await DashboardModel.getActiveTables(branchId, startDate, endDate);
			return ApiResponse.success(res, { tables }, 'rlly');
		} catch (error) {
			console.error('Error fetching tables:', error);
			return ApiResponse.error(res, 'Failed to fetch tables', 500, error.message);
		}
	}

	static async getPending(req, res) {
		try {
			const branchId = req.session?.branch_id || req.query.branch_id || req.user?.branch_id || null;
			const startDate = req.query.start_date || null;
			const endDate = req.query.end_date || null;
			const pending = await DashboardModel.getPendingOrders(branchId, startDate, endDate);
			return ApiResponse.success(res, { pending }, 'Pending orders count retrieved successfully');
		} catch (error) {
			console.error('Error fetching pending orders:', error);
			return ApiResponse.error(res, 'Failed to fetch pending orders', 500, error.message);
		}
	}

	static async getPopular(req, res) {
		try {
			const branchId = req.session?.branch_id || req.query.branch_id || req.user?.branch_id || null;
			const startDate = req.query.start_date || null;
			const endDate = req.query.end_date || null;
			const popular = await DashboardModel.getPopularItems(branchId, startDate, endDate);
			return ApiResponse.success(res, { popular }, 'Popular items count retrieved successfully');
		} catch (error) {
			console.error('Error fetching popular items:', error);
			return ApiResponse.error(res, 'Failed to fetch popular items', 500, error.message);
		}
	}

	static async getBestsellerByPeriod(req, res) {
		try {
			const branchId = req.session?.branch_id || req.query.branch_id || req.user?.branch_id || null;
			const startDate = req.query.start_date || null;
			const endDate = req.query.end_date || null;
			const bestsellers = await DashboardModel.getBestsellerByPeriod(branchId, startDate, endDate);
			return ApiResponse.success(res, { bestsellers }, 'Bestseller by period retrieved successfully');
		} catch (error) {
			console.error('Error fetching bestseller by period:', error);
			return ApiResponse.error(res, 'Failed to fetch bestseller by period', 500, error.message);
		}
	}

	static async getPaymentMethodsSummary(req, res) {
		try {
			const branchId = req.session?.branch_id || req.query.branch_id || req.user?.branch_id || null;
			const startDate = req.query.start_date || null;
			const endDate = req.query.end_date || null;
			const summary = await DashboardModel.getPaymentMethodsSummary(branchId, startDate, endDate);
			return ApiResponse.success(res, { summary }, 'Payment methods summary retrieved successfully');
		} catch (error) {
			console.error('Error fetching payment methods summary:', error);
			return ApiResponse.error(res, 'Failed to fetch payment methods summary', 500, error.message);
		}
	}
}

module.exports = DashboardController;

