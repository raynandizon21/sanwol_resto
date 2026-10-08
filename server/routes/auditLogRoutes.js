// ============================================
// AUDIT LOG ROUTES
// ============================================
// File: routes/auditLogRoutes.js
// Description: Routes for audit log endpoints
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const AuditLogController = require('../controllers/auditLogController');

// ============================================
// GET ROUTES
// ============================================

// GET - Get all audit logs (with filters)
// Query params: ?user_id=X&branch_id=Y&table_name=Z&action=CREATE&start_date=...&end_date=...&limit=100&offset=0
router.get("/audit-logs", authenticate, AuditLogController.getAll);

// GET - Get audit logs by branch
router.get("/audit-logs/branch/:branchId", authenticate, AuditLogController.getByBranchId);

// GET - Get audit logs by user
router.get("/audit-logs/user/:userId", authenticate, AuditLogController.getByUserId);

// ============================================
// EXPORT
// ============================================

module.exports = router;

