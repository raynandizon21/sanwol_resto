// ============================================
// REPORTS CONTROLLER
// ============================================
// File: controllers/reportsController.js
// Description: Handles reports and analytics business logic
// ============================================

const ReportsModel = require('../models/reportsModel');
const ApiResponse = require('../utils/apiResponse');
const { buildSalesDashboardBundle } = require('../services/salesDashboardBundle');
const {
	buildSalesDashboardBundleCacheKey,
	getCachedSalesDashboardBundle,
	setCachedSalesDashboardBundle,
} = require('../services/salesDashboardBundleCache');
const {
	getOrBuildMenuReportBundle,
	getOrBuildCategoryReportRows,
} = require('../services/analyticsReportBundleCache');
const {
	buildBranchDashboardBundleCacheKey,
	getCachedBranchDashboardBundle,
	setCachedBranchDashboardBundle,
} = require('../services/branchDashboardBundleCache');
const { buildBranchDashboardBundle, probeBranchDashboardActivity } = require('../services/branchDashboardBundle');
const { buildAdminDashboardBundle } = require('../services/adminDashboardBundle');
const {
	buildAdminDashboardBundleCacheKey,
	getCachedAdminDashboardBundle,
	setCachedAdminDashboardBundle,
} = require('../services/adminDashboardBundleCache');

// Python analytics service (PyServer) base URL - internal only
const PYSERVER_BASE_URL = process.env.PYSERVER_BASE_URL || 'http://127.0.0.1:2100';
const PYSERVER_TIMEOUT_MS = Number(process.env.PYSERVER_TIMEOUT_MS || 15000);
// node-fetch v3 is ESM-only; use dynamic import bridge for CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

class ReportsController {
	/** Prefer explicit query branch_id; ignore session when client sends all/none. */
	static resolveAnalyticsBranchId(req) {
		const raw = req.query.branch_id;
		if (raw === 'all' || raw === '') return null;
		if (raw != null && String(raw).trim() !== '') return raw;
		return req.user?.branch_id || req.session?.branch_id || null;
	}

	static async fetchPyServer(urlString) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PYSERVER_TIMEOUT_MS);
		try {
			return await fetch(urlString, { signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
	}

	static mapRevenueRowsToDailySales(rows) {
		return (rows || []).map((row) => {
			const total = Number(row?.revenue ?? row?.total_sales ?? 0) || 0;
			const dateKey = String(row?.date ?? row?.sale_date ?? '').slice(0, 10);
			return {
				sale_date: dateKey,
				total_sales: total,
				refund: 0,
				discount: 0,
				net_sales: total,
				product_cost: 0,
				gross_profit: total,
			};
		});
	}
	// Get revenue report
	static async getRevenueReport(req, res) {
		try {
			const { period = 'daily', start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			if (!['daily', 'weekly', 'monthly'].includes(period)) {
				return ApiResponse.badRequest(res, 'Period must be daily, weekly, or monthly');
			}

			const report = await ReportsModel.getRevenueReport(period, start_date, end_date, branchId);

			return ApiResponse.success(res, {
				period,
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branchId,
				data: report,
				total_revenue: report.reduce((sum, item) => sum + parseFloat(item.revenue || 0), 0),
				total_orders: report.reduce((sum, item) => sum + parseInt(item.order_count || 0), 0)
			}, 'Revenue report retrieved successfully');
		} catch (error) {
			console.error('Error fetching revenue report:', error);
			return ApiResponse.error(res, 'Failed to fetch revenue report', 500, error.message);
		}
	}

	// Get order report
	static async getOrderReport(req, res) {
		try {
			const { start_date, end_date, status } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const report = await ReportsModel.getOrderReport(start_date, end_date, branchId, status ? parseInt(status) : null);

			return ApiResponse.success(res, {
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branchId,
				status: status ? parseInt(status) : null,
				data: report
			}, 'Order report retrieved successfully');
		} catch (error) {
			console.error('Error fetching order report:', error);
			return ApiResponse.error(res, 'Failed to fetch order report', 500, error.message);
		}
	}

	// Get popular menu items
	static async getPopularMenuItems(req, res) {
		try {
			const { start_date, end_date, limit = 10 } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const report = await ReportsModel.getPopularMenuItems(start_date, end_date, branchId, parseInt(limit));

			return ApiResponse.success(res, {
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branchId,
				limit: parseInt(limit),
				data: report
			}, 'Popular menu items retrieved successfully');
		} catch (error) {
			console.error('Error fetching popular menu items:', error);
			return ApiResponse.error(res, 'Failed to fetch popular menu items', 500, error.message);
		}
	}

	// Get daily sales by product (for chart)
	static async getDailySalesByProduct(req, res) {
		try {
			const { start_date, end_date, limit = 5 } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const report = await ReportsModel.getDailySalesByProduct(start_date, end_date, branchId, parseInt(limit));

			return ApiResponse.success(res, {
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branchId,
				limit: parseInt(limit),
				data: report
			}, 'Daily sales by product retrieved successfully');
		} catch (error) {
			console.error('Error fetching daily sales by product:', error);
			return ApiResponse.error(res, 'Failed to fetch daily sales by product', 500, error.message);
		}
	}

	/** Fast menu-item trend/comparison (Node SQL — avoids N× PyServer menu-report). */
	static async getAnalyticsMenuItemTrend(req, res) {
		try {
			const goods = String(req.query.goods || '').trim();
			const start_date = String(req.query.start_date || '').trim();
			const end_date = String(req.query.end_date || '').trim();
			if (!goods || !start_date || !end_date) {
				return ApiResponse.badRequest(res, 'goods, start_date and end_date are required');
			}

			const branchId = ReportsController.resolveAnalyticsBranchId(req);
			const result = await ReportsModel.getMenuItemAnalytics({
				goods,
				branchId,
				rangeStart: start_date,
				rangeEnd: end_date,
			});

			return ApiResponse.success(
				res,
				{
					goods,
					start_date,
					end_date,
					branch_id: branchId,
					daily: result.daily || [],
				},
				'Menu item trend retrieved'
			);
		} catch (error) {
			console.error('Error fetching menu item trend:', error);
			return ApiResponse.error(res, 'Failed to fetch menu item trend', 500, error.message);
		}
	}

	// Get table utilization report
	static async getTableUtilizationReport(req, res) {
		try {
			const { start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const report = await ReportsModel.getTableUtilizationReport(start_date, end_date, branchId);

			return ApiResponse.success(res, {
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branchId,
				data: report
			}, 'Table utilization report retrieved successfully');
		} catch (error) {
			console.error('Error fetching table utilization report:', error);
			return ApiResponse.error(res, 'Failed to fetch table utilization report', 500, error.message);
		}
	}

	// Get employee performance report
	static async getEmployeePerformanceReport(req, res) {
		try {
			const { start_date, end_date, employee_id } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const report = await ReportsModel.getEmployeePerformanceReport(
				start_date,
				end_date,
				branchId,
				employee_id ? parseInt(employee_id) : null
			);

			return ApiResponse.success(res, {
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branchId,
				employee_id: employee_id ? parseInt(employee_id) : null,
				data: report
			}, 'Employee performance report retrieved successfully');
		} catch (error) {
			console.error('Error fetching employee performance report:', error);
			return ApiResponse.error(res, 'Failed to fetch employee performance report', 500, error.message);
		}
	}

	// Get sales hourly summary (Total Sales Detail modal)
	static async getSalesHourlySummary(req, res) {
		try {
			const { start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const report = await ReportsModel.getSalesHourlySummary(start_date, end_date, branchId);

			return ApiResponse.success(res, {
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branchId,
				data: report
			}, 'Sales hourly summary retrieved successfully');
		} catch (error) {
			console.error('Error fetching sales hourly summary:', error);
			return ApiResponse.error(res, 'Failed to fetch sales hourly summary', 500, error.message);
		}
	}

	// Get discount report (from discount_report table)
	static async getDiscountReport(req, res) {
		try {
			const { start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const report = await ReportsModel.getDiscountReport(start_date, end_date, branchId);

			return ApiResponse.success(res, {
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branchId,
				data: report
			}, 'Discount report retrieved successfully');
		} catch (error) {
			console.error('Error fetching discount report:', error);
			return ApiResponse.error(res, 'Failed to fetch discount report', 500, error.message);
		}
	}

	// Get sales by category report (from sales_category_report table)
	static async getSalesCategoryReport(req, res) {
		try {
			const { start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const report = await ReportsModel.getSalesCategoryReport(start_date, end_date, branchId);

			return ApiResponse.success(res, {
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branchId,
				data: report
			}, 'Sales by category report retrieved successfully');
		} catch (error) {
			console.error('Error fetching sales by category report:', error);
			return ApiResponse.error(res, 'Failed to fetch sales by category report', 500, error.message);
		}
	}

	// Get goods sales report (from goods_sales_report table)
	static async getGoodsSalesReport(req, res) {
		try {
			const { start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const report = await ReportsModel.getGoodsSalesReport(start_date, end_date, branchId);

			return ApiResponse.success(res, {
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branchId,
				data: report
			}, 'Goods sales report retrieved successfully');
		} catch (error) {
			console.error('Error fetching goods sales report:', error);
			return ApiResponse.error(res, 'Failed to fetch goods sales report', 500, error.message);
		}
	}

	// Get total sales per branch
	static async getSalesPerBranch(req, res) {
		try {
			const { start_date, end_date, branch_id } = req.query;

			const report = await ReportsModel.getSalesPerBranch(start_date || null, end_date || null, branch_id || null);

			return ApiResponse.success(res, {
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branch_id || null,
				data: report
			}, 'Sales per branch retrieved successfully');
		} catch (error) {
			console.error('Error fetching sales per branch:', error);
			return ApiResponse.error(res, 'Failed to fetch sales per branch', 500, error.message);
		}
	}

	// Get least selling / zero-sales menu items
	static async getLeastSellingItems(req, res) {
		try {
			const { start_date, end_date, limit = 5 } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const report = await ReportsModel.getLeastSellingItems(start_date || null, end_date || null, branchId, parseInt(limit));

			return ApiResponse.success(res, {
				start_date: start_date || null,
				end_date: end_date || null,
				branch_id: branchId,
				limit: parseInt(limit),
				data: report
			}, 'Least selling items retrieved successfully');
		} catch (error) {
			console.error('Error fetching least selling items:', error);
			return ApiResponse.error(res, 'Failed to fetch least selling items', 500, error.message);
		}
	}

	// ============================================
	// PYTHON ANALYTICS (PyServer) PROXY ENDPOINTS
	// ============================================

	// Daily sales time series (proxied to PyServer)
	static async getAnalyticsDailySales(req, res) {
		try {
			const { start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/daily-sales', PYSERVER_BASE_URL);
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId) url.searchParams.set('branch_id', String(branchId));

			let series = [];
			try {
				const pyRes = await ReportsController.fetchPyServer(url.toString());
				if (!pyRes.ok) {
					const text = await pyRes.text().catch(() => '');
					throw new Error(`PyServer status ${pyRes.status}: ${text}`);
				}
				const json = await pyRes.json().catch(() => null);
				if (!json || json.success === false) {
					throw new Error(json?.message || 'PyServer daily-sales error');
				}
				series = json?.data?.data || [];
			} catch (pyErr) {
				console.warn('[PyServer] daily-sales unavailable, using Node revenue fallback:', pyErr?.message || pyErr);
				const report = await ReportsModel.getRevenueReport('daily', start_date, end_date, branchId);
				series = ReportsController.mapRevenueRowsToDailySales(report);
			}

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					data: series
				},
				'Daily sales analytics retrieved'
			);
		} catch (error) {
			console.error('Error fetching analytics daily sales:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics daily sales', 500, error.message);
		}
	}

	// Daily sales per branch (day × branch matrix)
	static async getAnalyticsDailyPerBranch(req, res) {
		try {
			const { start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/daily-per-branch', PYSERVER_BASE_URL);
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId) url.searchParams.set('branch_id', String(branchId));

			let series = [];
			try {
				const pyRes = await ReportsController.fetchPyServer(url.toString());
				if (!pyRes.ok) {
					const text = await pyRes.text().catch(() => '');
					throw new Error(`PyServer status ${pyRes.status}: ${text}`);
				}
				const json = await pyRes.json().catch(() => null);
				if (!json || json.success === false) {
					throw new Error(json?.message || 'PyServer daily-per-branch error');
				}
				series = json?.data?.data || [];
			} catch (pyErr) {
				console.warn(
					'[PyServer] daily-per-branch unavailable, using Node SQL fallback:',
					pyErr?.message || pyErr,
				);
				series = await ReportsModel.getDailySalesPerBranch(start_date, end_date, branchId);
			}

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					data: series,
				},
				'Daily sales per branch retrieved',
			);
		} catch (error) {
			console.error('Error fetching analytics daily-per-branch:', error);
			return ApiResponse.error(res, 'Failed to fetch daily sales per branch', 500, error.message);
		}
	}

	// Branch-level sales (proxied to PyServer)
	static async getAnalyticsBranchSales(req, res) {
		try {
			const { start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/branch-sales', PYSERVER_BASE_URL);
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId) url.searchParams.set('branch_id', String(branchId));

			const pyRes = await fetch(url.toString());
			if (!pyRes.ok) {
				const text = await pyRes.text().catch(() => '');
				console.error('[PyServer] branch-sales HTTP error:', pyRes.status, text);
				return ApiResponse.error(
					res,
					`Python analytics service error (status ${pyRes.status})`,
					502,
					text || `PyServer responded with status ${pyRes.status}`
				);
			}

			const json = await pyRes.json().catch((err) => {
				console.error('[PyServer] branch-sales JSON parse error:', err);
				return null;
			});

			if (!json || json.success === false) {
				const msg = json?.message || 'Unknown error from Python analytics service';
				console.error('[PyServer] branch-sales error payload:', json);
				return ApiResponse.error(res, msg, 502, json?.error || msg);
			}

			const rows = json?.data?.data || [];

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					data: rows
				},
				'Branch sales analytics retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics branch sales from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics branch sales', 500, error.message);
		}
	}

	// Expense summary (proxied to PyServer)
	static async getAnalyticsExpenseSummary(req, res) {
		try {
			const { start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/expense-summary', PYSERVER_BASE_URL);
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId) url.searchParams.set('branch_id', String(branchId));

			const pyRes = await fetch(url.toString());
			if (!pyRes.ok) {
				const text = await pyRes.text().catch(() => '');
				console.error('[PyServer] expense-summary HTTP error:', pyRes.status, text);
				return ApiResponse.error(
					res,
					`Python analytics service error (status ${pyRes.status})`,
					502,
					text || `PyServer responded with status ${pyRes.status}`
				);
			}

			const json = await pyRes.json().catch((err) => {
				console.error('[PyServer] expense-summary JSON parse error:', err);
				return null;
			});

			if (!json || json.success === false) {
				const msg = json?.message || 'Unknown error from Python analytics service';
				console.error('[PyServer] expense-summary error payload:', json);
				return ApiResponse.error(res, msg, 502, json?.error || msg);
			}

			const summary = json?.data || { total_expense: 0 };

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					data: summary
				},
				'Expense summary retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics expense summary from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics expense summary', 500, error.message);
		}
	}

	// Expense breakdown by category (proxied to PyServer)
	static async getAnalyticsExpenseBreakdown(req, res) {
		try {
			const { start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/expense-breakdown', PYSERVER_BASE_URL);
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId) url.searchParams.set('branch_id', String(branchId));

			const pyRes = await fetch(url.toString());
			if (!pyRes.ok) {
				const text = await pyRes.text().catch(() => '');
				console.error('[PyServer] expense-breakdown HTTP error:', pyRes.status, text);
				return ApiResponse.error(
					res,
					`Python analytics service error (status ${pyRes.status})`,
					502,
					text || `PyServer responded with status ${pyRes.status}`
				);
			}

			const json = await pyRes.json().catch((err) => {
				console.error('[PyServer] expense-breakdown JSON parse error:', err);
				return null;
			});

			if (!json || json.success === false) {
				const msg = json?.message || 'Unknown error from Python analytics service';
				console.error('[PyServer] expense-breakdown error payload:', json);
				return ApiResponse.error(res, msg, 502, json?.error || msg);
			}

			const rows = json?.data?.data || [];

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					data: rows,
				},
				'Expense breakdown retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics expense breakdown from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics expense breakdown', 500, error.message);
		}
	}

	// Performance trend (proxied to PyServer)
	static async getAnalyticsPerformanceTrend(req, res) {
		try {
			const { start_date, end_date, period = 'monthly' } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/performance-trend', PYSERVER_BASE_URL);
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId) url.searchParams.set('branch_id', String(branchId));
			if (period) url.searchParams.set('period', String(period));

			const pyRes = await fetch(url.toString());
			if (!pyRes.ok) {
				const text = await pyRes.text().catch(() => '');
				console.error('[PyServer] performance-trend HTTP error:', pyRes.status, text);
				return ApiResponse.error(
					res,
					`Python analytics service error (status ${pyRes.status})`,
					502,
					text || `PyServer responded with status ${pyRes.status}`
				);
			}

			const json = await pyRes.json().catch((err) => {
				console.error('[PyServer] performance-trend JSON parse error:', err);
				return null;
			});

			if (!json || json.success === false) {
				const msg = json?.message || 'Unknown error from Python analytics service';
				console.error('[PyServer] performance-trend error payload:', json);
				return ApiResponse.error(res, msg, 502, json?.error || msg);
			}

			const rows = json?.data?.data || [];

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					period: String(period || 'monthly'),
					data: rows,
				},
				'Performance trend retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics performance trend from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics performance trend', 500, error.message);
		}
	}

	// Menu-level sales report (proxied to PyServer, cached)
	static async getAnalyticsMenuReport(req, res) {
		try {
			const { start_date, end_date } = req.query;
			if (!start_date || !end_date) {
				return ApiResponse.badRequest(res, 'start_date and end_date are required');
			}

			const branchId = ReportsController.resolveAnalyticsBranchId(req);
			const bundle = await getOrBuildMenuReportBundle({
				start_date,
				end_date,
				branchId,
			});
			const rows = bundle.menuRows || [];

			return ApiResponse.success(
				res,
				{
					start_date,
					end_date,
					branch_id: branchId,
					data: rows,
				},
				'Menu report retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics menu report from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics menu report', 500, error.message);
		}
	}

	// Menu report + daily sales in one round-trip (MenuReport UI)
	static async getAnalyticsMenuReportBundle(req, res) {
		try {
			const { start_date, end_date } = req.query;
			if (!start_date || !end_date) {
				return ApiResponse.badRequest(res, 'start_date and end_date are required');
			}

			const branchId = ReportsController.resolveAnalyticsBranchId(req);
			const bundle = await getOrBuildMenuReportBundle({
				start_date,
				end_date,
				branchId,
			});

			return ApiResponse.success(
				res,
				{
					start_date,
					end_date,
					branch_id: branchId,
					menuRows: bundle.menuRows || [],
					dailySalesCurrent: bundle.dailySalesCurrent || [],
				},
				'Menu report bundle retrieved'
			);
		} catch (error) {
			console.error('Error fetching menu report bundle:', error);
			return ApiResponse.error(res, 'Failed to fetch menu report bundle', 500, error.message);
		}
	}

	// Category-level sales report (proxied to PyServer, cached)
	static async getAnalyticsCategoryReport(req, res) {
		try {
			const { start_date, end_date } = req.query;
			if (!start_date || !end_date) {
				return ApiResponse.badRequest(res, 'start_date and end_date are required');
			}

			const branchId = ReportsController.resolveAnalyticsBranchId(req);
			const rows = await getOrBuildCategoryReportRows({
				start_date,
				end_date,
				branchId,
			});

			return ApiResponse.success(
				res,
				{
					start_date,
					end_date,
					branch_id: branchId,
					data: rows || [],
				},
				'Category report retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics category report from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics category report', 500, error.message);
		}
	}

	// Per-menu lines within one category (proxied to PyServer)
	static async getAnalyticsCategoryMenuBreakdown(req, res) {
		try {
			const { category_id, start_date, end_date } = req.query;
			if (category_id == null || String(category_id).trim() === '') {
				return ApiResponse.badRequest(res, 'category_id is required');
			}

			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/category-menu-breakdown', PYSERVER_BASE_URL);
			url.searchParams.set('category_id', String(category_id));
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId != null && String(branchId) !== '' && String(branchId) !== 'all') {
				url.searchParams.set('branch_id', String(branchId));
			}

			const pyRes = await fetch(url.toString());
			if (!pyRes.ok) {
				const text = await pyRes.text().catch(() => '');
				console.error('[PyServer] category-menu-breakdown HTTP error:', pyRes.status, text);
				return ApiResponse.error(
					res,
					`Python analytics service error (status ${pyRes.status})`,
					502,
					text || `PyServer responded with status ${pyRes.status}`
				);
			}

			const json = await pyRes.json().catch((err) => {
				console.error('[PyServer] category-menu-breakdown JSON parse error:', err);
				return null;
			});

			if (!json || json.success === false) {
				const msg = json?.message || 'Unknown error from Python analytics service';
				console.error('[PyServer] category-menu-breakdown error payload:', json);
				return ApiResponse.error(res, msg, 502, json?.error || msg);
			}

			const rows = json?.data?.data || [];

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					category_id,
					data: rows,
				},
				'Category menu breakdown retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics category menu breakdown from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics category menu breakdown', 500, error.message);
		}
	}

	// Payment method breakdown report (proxied to PyServer)
	static async getAnalyticsPaymentReport(req, res) {
		try {
			const { start_date, end_date } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/payment-report', PYSERVER_BASE_URL);
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId) url.searchParams.set('branch_id', String(branchId));

			const pyRes = await fetch(url.toString());
			if (!pyRes.ok) {
				const text = await pyRes.text().catch(() => '');
				console.error('[PyServer] payment-report HTTP error:', pyRes.status, text);
				return ApiResponse.error(
					res,
					`Python analytics service error (status ${pyRes.status})`,
					502,
					text || `PyServer responded with status ${pyRes.status}`
				);
			}

			const json = await pyRes.json().catch((err) => {
				console.error('[PyServer] payment-report JSON parse error:', err);
				return null;
			});

			if (!json || json.success === false) {
				const msg = json?.message || 'Unknown error from Python analytics service';
				console.error('[PyServer] payment-report error payload:', json);
				return ApiResponse.error(res, msg, 502, json?.error || msg);
			}

			const rows = json?.data?.data || [];

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					data: rows
				},
				'Payment report retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics payment report from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics payment report', 500, error.message);
		}
	}

	// Top profit drivers for Sales Analytics dashboard (proxied to PyServer)
	static async getAnalyticsTopProfitDrivers(req, res) {
		try {
			const { start_date, end_date, limit = 20 } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/top-profit-drivers', PYSERVER_BASE_URL);
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId) url.searchParams.set('branch_id', String(branchId));
			if (limit) url.searchParams.set('limit', String(limit));

			const pyRes = await fetch(url.toString());
			if (!pyRes.ok) {
				const text = await pyRes.text().catch(() => '');
				console.error('[PyServer] top-profit-drivers HTTP error:', pyRes.status, text);
				return ApiResponse.error(
					res,
					`Python analytics service error (status ${pyRes.status})`,
					502,
					text || `PyServer responded with status ${pyRes.status}`
				);
			}

			const json = await pyRes.json().catch((err) => {
				console.error('[PyServer] top-profit-drivers JSON parse error:', err);
				return null;
			});

			if (!json || json.success === false) {
				const msg = json?.message || 'Unknown error from Python analytics service';
				console.error('[PyServer] top-profit-drivers error payload:', json);
				return ApiResponse.error(res, msg, 502, json?.error || msg);
			}

			const rows = json?.data?.data || [];

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					limit: parseInt(limit, 10) || 20,
					data: rows
				},
				'Top profit drivers retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics top profit drivers from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics top profit drivers', 500, error.message);
		}
	}

	// Top-selling menu items (proxied to PyServer)
	static async getAnalyticsTopSelling(req, res) {
		try {
			const { start_date, end_date, limit = 5 } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/top-selling', PYSERVER_BASE_URL);
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId) url.searchParams.set('branch_id', String(branchId));
			if (limit) url.searchParams.set('limit', String(limit));

			const pyRes = await fetch(url.toString());
			if (!pyRes.ok) {
				const text = await pyRes.text().catch(() => '');
				console.error('[PyServer] top-selling HTTP error:', pyRes.status, text);
				return ApiResponse.error(
					res,
					`Python analytics service error (status ${pyRes.status})`,
					502,
					text || `PyServer responded with status ${pyRes.status}`
				);
			}

			const json = await pyRes.json().catch((err) => {
				console.error('[PyServer] top-selling JSON parse error:', err);
				return null;
			});

			if (!json || json.success === false) {
				const msg = json?.message || 'Unknown error from Python analytics service';
				console.error('[PyServer] top-selling error payload:', json);
				return ApiResponse.error(res, msg, 502, json?.error || msg);
			}

			const rows = json?.data?.data || [];

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					limit: parseInt(limit, 10) || 5,
					data: rows
				},
				'Top-selling items retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics top-selling items from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics top-selling items', 500, error.message);
		}
	}

	// Least-selling / zero-sales menu items (proxied to PyServer)
	static async getAnalyticsLeastSelling(req, res) {
		try {
			const { start_date, end_date, limit = 5 } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/least-selling', PYSERVER_BASE_URL);
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId) url.searchParams.set('branch_id', String(branchId));
			if (limit) url.searchParams.set('limit', String(limit));

			const pyRes = await fetch(url.toString());
			if (!pyRes.ok) {
				const text = await pyRes.text().catch(() => '');
				console.error('[PyServer] least-selling HTTP error:', pyRes.status, text);
				return ApiResponse.error(
					res,
					`Python analytics service error (status ${pyRes.status})`,
					502,
					text || `PyServer responded with status ${pyRes.status}`
				);
			}

			const json = await pyRes.json().catch((err) => {
				console.error('[PyServer] least-selling JSON parse error:', err);
				return null;
			});

			if (!json || json.success === false) {
				const msg = json?.message || 'Unknown error from Python analytics service';
				console.error('[PyServer] least-selling error payload:', json);
				return ApiResponse.error(res, msg, 502, json?.error || msg);
			}

			const rows = json?.data?.data || [];

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					limit: parseInt(limit, 10) || 5,
					data: rows
				},
				'Least-selling items retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics least-selling items from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics least-selling items', 500, error.message);
		}
	}

	// Receipt-level report (proxied to PyServer)
	static async getAnalyticsReceiptReport(req, res) {
		try {
			const { start_date, end_date, type } = req.query;
			const branchId = ReportsController.resolveAnalyticsBranchId(req);

			const url = new URL('/api/analytics/receipt-report', PYSERVER_BASE_URL);
			if (start_date) url.searchParams.set('start_date', start_date);
			if (end_date) url.searchParams.set('end_date', end_date);
			if (branchId) url.searchParams.set('branch_id', String(branchId));
			if (type) url.searchParams.set('type', String(type));

			const pyRes = await fetch(url.toString());
			if (!pyRes.ok) {
				const text = await pyRes.text().catch(() => '');
				console.error('[PyServer] receipt-report HTTP error:', pyRes.status, text);
				return ApiResponse.error(
					res,
					`Python analytics service error (status ${pyRes.status})`,
					502,
					text || `PyServer responded with status ${pyRes.status}`
				);
			}

			const json = await pyRes.json().catch((err) => {
				console.error('[PyServer] receipt-report JSON parse error:', err);
				return null;
			});

			if (!json || json.success === false) {
				const msg = json?.message || 'Unknown error from Python analytics service';
				console.error('[PyServer] receipt-report error payload:', json);
				return ApiResponse.error(res, msg, 502, json?.error || msg);
			}

			const rows = json?.data?.data || [];

			return ApiResponse.success(
				res,
				{
					start_date: start_date || null,
					end_date: end_date || null,
					branch_id: branchId,
					type: type || null,
					data: rows
				},
				'Receipt report retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics receipt report from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics receipt report', 500, error.message);
		}
	}

	// Single receipt detail (proxied to PyServer)
	static async getAnalyticsReceiptDetail(req, res) {
		try {
			const { order_id } = req.query;
			if (!order_id) {
				return ApiResponse.badRequest(res, 'order_id is required');
			}

			const url = new URL('/api/analytics/receipt-detail', PYSERVER_BASE_URL);
			url.searchParams.set('order_id', String(order_id));

			const pyRes = await fetch(url.toString());
			if (!pyRes.ok) {
				const text = await pyRes.text().catch(() => '');
				console.error('[PyServer] receipt-detail HTTP error:', pyRes.status, text);
				return ApiResponse.error(
					res,
					`Python analytics service error (status ${pyRes.status})`,
					502,
					text || `PyServer responded with status ${pyRes.status}`
				);
			}

			const json = await pyRes.json().catch((err) => {
				console.error('[PyServer] receipt-detail JSON parse error:', err);
				return null;
			});

			if (!json || json.success === false) {
				const msg = json?.message || 'Unknown error from Python analytics service';
				console.error('[PyServer] receipt-detail error payload:', json);
				return ApiResponse.error(res, msg, 502, json?.error || msg);
			}

			const detail = json?.data || null;

			return ApiResponse.success(
				res,
				{
					order_id,
					data: detail
				},
				'Receipt detail retrieved from Python service'
			);
		} catch (error) {
			console.error('Error fetching analytics receipt detail from PyServer:', error);
			return ApiResponse.error(res, 'Failed to fetch analytics receipt detail', 500, error.message);
		}
	}

	// Consolidated Sales Analytics payload (single round-trip for branch load)
	static async getAnalyticsSalesDashboardBundle(req, res) {
		try {
			const { start_date, end_date, profit_branch_id } = req.query;
			if (!start_date || !end_date) {
				return ApiResponse.badRequest(res, 'start_date and end_date are required');
			}

			const branchId = ReportsController.resolveAnalyticsBranchId(req);
			const profitBranchId =
				profit_branch_id != null && String(profit_branch_id).trim() !== ''
					? String(profit_branch_id).trim()
					: branchId;

			const cacheKey = buildSalesDashboardBundleCacheKey({
				start_date,
				end_date,
				branchId,
				profitBranchId,
			});

			let bundle = getCachedSalesDashboardBundle(cacheKey);
			if (!bundle) {
				bundle = await buildSalesDashboardBundle({
					start_date,
					end_date,
					branchId,
					profitBranchId,
					branchNameFallback: branchId ? `Branch #${branchId}` : 'All Branches',
				});
				setCachedSalesDashboardBundle(cacheKey, bundle);
			}

			return ApiResponse.success(
				res,
				{
					start_date,
					end_date,
					branch_id: branchId,
					profit_branch_id: profitBranchId,
					...bundle,
				},
				'Sales dashboard bundle retrieved'
			);
		} catch (error) {
			console.error('Error fetching sales dashboard bundle:', error);
			return ApiResponse.error(res, 'Failed to fetch sales dashboard bundle', 500, error.message);
		}
	}

	// Fast SQL probe — empty branches skip skeleton; active branches show skeleton then load bundle.
	static async getAnalyticsBranchDashboardProbe(req, res) {
		try {
			const { start_date, end_date } = req.query;
			if (!start_date || !end_date) {
				return ApiResponse.badRequest(res, 'start_date and end_date are required');
			}

			const branchId = ReportsController.resolveAnalyticsBranchId(req);
			if (!branchId) {
				return ApiResponse.badRequest(res, 'branch_id is required');
			}

			const probe = await probeBranchDashboardActivity({
				branchId,
				start_date,
				end_date,
			});

			return ApiResponse.success(
				res,
				{
					start_date,
					end_date,
					branch_id: branchId,
					...probe,
				},
				'Branch dashboard probe retrieved'
			);
		} catch (error) {
			console.error('Error fetching branch dashboard probe:', error);
			return ApiResponse.error(res, 'Failed to fetch branch dashboard probe', 500, error.message);
		}
	}

	// Consolidated branch Dashboard payload (single round-trip)
	static async getAnalyticsBranchDashboardBundle(req, res) {
		try {
			const { start_date, end_date } = req.query;
			if (!start_date || !end_date) {
				return ApiResponse.badRequest(res, 'start_date and end_date are required');
			}

			const branchId = ReportsController.resolveAnalyticsBranchId(req);
			if (!branchId) {
				return ApiResponse.badRequest(res, 'branch_id is required');
			}

			const cacheKey = buildBranchDashboardBundleCacheKey({
				start_date,
				end_date,
				branchId,
			});

			let bundle = getCachedBranchDashboardBundle(cacheKey);
			if (!bundle) {
				bundle = await buildBranchDashboardBundle({
					branchId,
					start_date,
					end_date,
				});
				setCachedBranchDashboardBundle(cacheKey, bundle);
			}

			return ApiResponse.success(
				res,
				{
					start_date,
					end_date,
					branch_id: branchId,
					...bundle,
				},
				'Branch dashboard bundle retrieved'
			);
		} catch (error) {
			console.error('Error fetching branch dashboard bundle:', error);
			return ApiResponse.error(res, 'Failed to fetch branch dashboard bundle', 500, error.message);
		}
	}

	// Consolidated admin Dashboard payload (summary + branch cards + chart data in one round-trip)
	static async getAnalyticsAdminDashboardBundle(req, res) {
		try {
			const { start_date, end_date, period } = req.query;
			if (!start_date || !end_date) {
				return ApiResponse.badRequest(res, 'start_date and end_date are required');
			}

			const branchId = ReportsController.resolveAnalyticsBranchId(req);
			const trendPeriod = ['weekly', 'monthly', 'yearly'].includes(String(period || ''))
				? String(period)
				: 'monthly';
			const includeBranchCharts =
				req.query.include_branch_charts === '1' ||
				req.query.include_branch_charts === 'true';
			const modeRaw = String(req.query.mode || 'full').trim().toLowerCase();
			const mode =
				modeRaw === 'drill'
					? 'drill'
					: modeRaw === 'compare' || modeRaw === 'slim'
						? 'compare'
						: 'full';

			const cacheKey = buildAdminDashboardBundleCacheKey({
				start_date,
				end_date,
				branchId,
				period: trendPeriod,
				include_branch_charts: includeBranchCharts,
				mode,
			});

			let bundle = getCachedAdminDashboardBundle(cacheKey);
			if (!bundle) {
				bundle = await buildAdminDashboardBundle({
					start_date,
					end_date,
					branchId,
					period: trendPeriod,
					include_branch_charts: includeBranchCharts,
					mode,
				});
				setCachedAdminDashboardBundle(cacheKey, bundle);
			}

			return ApiResponse.success(
				res,
				{
					start_date,
					end_date,
					branch_id: branchId,
					period: trendPeriod,
					...bundle,
				},
				'Admin dashboard bundle retrieved'
			);
		} catch (error) {
			console.error('Error fetching admin dashboard bundle:', error);
			return ApiResponse.error(res, 'Failed to fetch admin dashboard bundle', 500, error.message);
		}
	}
}

module.exports = ReportsController;
