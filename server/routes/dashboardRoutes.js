// ============================================
// DASHBOARD ROUTES
// ============================================
// File: routes/dashboardRoutes.js
// Description: REST API routes for dashboard endpoints
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const DashboardController = require('../controllers/dashboardController');

// ============================================
// GET ROUTES
// ============================================

// GET - Get dashboard statistics (supports both JWT and Session auth)
// URL: /dashboard/stats
// Auth: JWT (Bearer token) or Session
router.get("/dashboard/stats", authenticate, DashboardController.getStats);

// GET - Get individual dashboard stats
router.get("/dashboard/revenue", authenticate, DashboardController.getRevenue);
router.get("/dashboard/orders", authenticate, DashboardController.getOrders);
router.get("/dashboard/tables", authenticate, DashboardController.getTables);
router.get("/dashboard/pending", authenticate, DashboardController.getPending);
router.get("/dashboard/popular", authenticate, DashboardController.getPopular);
router.get("/dashboard/bestseller", authenticate, DashboardController.getBestsellerByPeriod);
router.get("/dashboard/payment-methods-summary", authenticate, DashboardController.getPaymentMethodsSummary);

// ============================================
// EXPORT
// ============================================

module.exports = router;
