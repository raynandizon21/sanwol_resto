// ============================================
// BILLING ROUTES
// ============================================
// File: routes/billingRoutes.js
// Description: Routes for billing records
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const BillingController = require('../controllers/billingController');

// Billing page route removed - use API endpoints instead
router.get('/billing/data', authenticate, BillingController.getAll);
router.get('/billing/:orderId/payments', authenticate, BillingController.getPaymentHistory);
router.get('/billing/:orderId', authenticate, BillingController.getByOrderId);
router.post('/billing', authenticate, BillingController.create);
router.put('/billing/:id', authenticate, BillingController.updateBilling);

module.exports = router;
