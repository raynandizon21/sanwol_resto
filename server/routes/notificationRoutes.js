// ============================================
// NOTIFICATION ROUTES
// ============================================
// File: routes/notificationRoutes.js
// Description: Routes for notification endpoints
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const NotificationController = require('../controllers/notificationController');

// ============================================
// GET ROUTES
// ============================================

// GET - Get user notifications
// Query: ?unread_only=true&limit=50
router.get("/notifications", authenticate, NotificationController.getAll);

// ============================================
// POST ROUTES
// ============================================

// POST - Create notification (admin/system)
router.post("/notifications", authenticate, NotificationController.create);

// POST - Mark notification as read
router.post("/notifications/:id/mark-read", authenticate, NotificationController.markAsRead);

// POST - Mark all notifications as read
router.post("/notifications/mark-read", authenticate, NotificationController.markAllAsRead);

// POST - Clear all notifications
router.post("/notifications/clear", authenticate, NotificationController.clearAll);

// ============================================
// EXPORT
// ============================================

module.exports = router;

