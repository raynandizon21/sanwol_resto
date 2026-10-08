// ============================================
// REPORTS ROUTES
// ============================================
// File: routes/reportsRoutes.js
// Description: Routes for reports and analytics endpoints
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const ReportsController = require('../controllers/reportsController');

// ============================================
// GET ROUTES
// ============================================

// GET - Revenue report
// Query: ?period=daily|weekly|monthly&start_date=...&end_date=...&branch_id=...
router.get("/reports/revenue", authenticate, ReportsController.getRevenueReport);

// GET - Order report
// Query: ?start_date=...&end_date=...&branch_id=...&status=...
router.get("/reports/orders", authenticate, ReportsController.getOrderReport);

// GET - Popular menu items
// Query: ?start_date=...&end_date=...&branch_id=...&limit=10
router.get("/reports/menu-items", authenticate, ReportsController.getPopularMenuItems);

// GET - Daily sales by product (for chart)
// Query: ?start_date=...&end_date=...&branch_id=...&limit=5
router.get("/reports/daily-sales-by-product", authenticate, ReportsController.getDailySalesByProduct);

// GET - Table utilization report
// Query: ?start_date=...&end_date=...&branch_id=...
router.get("/reports/tables", authenticate, ReportsController.getTableUtilizationReport);

// GET - Employee performance report
// Query: ?start_date=...&end_date=...&branch_id=...&employee_id=...
router.get("/reports/employees", authenticate, ReportsController.getEmployeePerformanceReport);

// GET - Sales hourly summary (Total Sales Detail modal)
// Query: ?start_date=...&end_date=...&branch_id=...
router.get("/reports/sales-hourly-summary", authenticate, ReportsController.getSalesHourlySummary);

// GET - Discount report (from paid orders)
// Query: ?start_date=...&end_date=...&branch_id=...
router.get("/reports/discount", authenticate, ReportsController.getDiscountReport);

// GET - Sales by category report (from paid orders)
// Query: ?start_date=...&end_date=...&branch_id=...
router.get("/reports/sales-category", authenticate, ReportsController.getSalesCategoryReport);

// GET - Goods sales report (from paid orders)
// Query: ?start_date=...&end_date=...&branch_id=...
router.get("/reports/goods-sales", authenticate, ReportsController.getGoodsSalesReport);

// GET - Sales per branch (total sales aggregated by branch)
// Query: ?start_date=...&end_date=...
router.get("/reports/sales-per-branch", authenticate, ReportsController.getSalesPerBranch);

// GET - Least selling / zero-sales items
// Query: ?start_date=...&end_date=...&branch_id=...&limit=5
router.get("/reports/least-selling-items", authenticate, ReportsController.getLeastSellingItems);

// GET - Python analytics proxies (Sales Analytics, reports)
router.get("/api/analytics/daily-sales", authenticate, ReportsController.getAnalyticsDailySales);
router.get("/api/analytics/daily-per-branch", authenticate, ReportsController.getAnalyticsDailyPerBranch);
router.get("/api/analytics/branch-sales", authenticate, ReportsController.getAnalyticsBranchSales);
router.get("/api/analytics/menu-report", authenticate, ReportsController.getAnalyticsMenuReport);
router.get("/api/analytics/menu-report-bundle", authenticate, ReportsController.getAnalyticsMenuReportBundle);
router.get("/api/analytics/menu-item-trend", authenticate, ReportsController.getAnalyticsMenuItemTrend);
router.get("/api/analytics/category-report", authenticate, ReportsController.getAnalyticsCategoryReport);
router.get("/api/analytics/category-menu-breakdown", authenticate, ReportsController.getAnalyticsCategoryMenuBreakdown);
router.get("/api/analytics/payment-report", authenticate, ReportsController.getAnalyticsPaymentReport);
router.get("/api/analytics/top-selling", authenticate, ReportsController.getAnalyticsTopSelling);
router.get("/api/analytics/top-profit-drivers", authenticate, ReportsController.getAnalyticsTopProfitDrivers);
router.get("/api/analytics/least-selling", authenticate, ReportsController.getAnalyticsLeastSelling);
router.get("/api/analytics/receipt-report", authenticate, ReportsController.getAnalyticsReceiptReport);
router.get("/api/analytics/receipt-detail", authenticate, ReportsController.getAnalyticsReceiptDetail);
router.get("/api/analytics/expense-summary", authenticate, ReportsController.getAnalyticsExpenseSummary);
router.get("/api/analytics/expense-breakdown", authenticate, ReportsController.getAnalyticsExpenseBreakdown);
router.get("/api/analytics/performance-trend", authenticate, ReportsController.getAnalyticsPerformanceTrend);
router.get("/api/analytics/sales-dashboard-bundle", authenticate, ReportsController.getAnalyticsSalesDashboardBundle);
router.get("/api/analytics/branch-dashboard-probe", authenticate, ReportsController.getAnalyticsBranchDashboardProbe);
router.get("/api/analytics/branch-dashboard-bundle", authenticate, ReportsController.getAnalyticsBranchDashboardBundle);
router.get("/api/analytics/admin-dashboard-bundle", authenticate, ReportsController.getAnalyticsAdminDashboardBundle);

// ============================================
// EXPORT
// ============================================

module.exports = router;

