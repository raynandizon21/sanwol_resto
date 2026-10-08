// ============================================
// ORDER ROUTES
// ============================================
// File: routes/orderRoutes.js
// Description: Routes for orders management
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate, requireOrderMetaEditor } = require('../middleware/unifiedAuth');
const OrderController = require('../controllers/orderController');

// Orders page route removed - use API endpoints instead

router.get('/orders/data', authenticate, OrderController.getAll);
router.get('/orders/:id', authenticate, OrderController.getById);
router.get('/orders/:id/items', authenticate, OrderController.getItems);

router.post('/orders', authenticate, OrderController.create);
// Manual Order: creates an order that is immediately SETTLED (no billing process needed)
router.post('/orders/manual-settled', authenticate, OrderController.createManualSettled);
router.post('/orders/:id/items', authenticate, OrderController.addItemsToOrder);
router.put('/orders/:id', authenticate, OrderController.update);
router.patch('/orders/:id/status', authenticate, OrderController.updateStatus);
router.patch('/orders/:id/encoded-dt', authenticate, requireOrderMetaEditor, OrderController.updateEncodedDt);
router.patch('/orders/:id/soft-delete', authenticate, requireOrderMetaEditor, OrderController.softDelete);
router.put('/order_items/:id/status', authenticate, OrderController.updateItemStatus);

// Order Items Individual Operations
router.get('/order_items/:id', authenticate, OrderController.getOrderItemById);
router.put('/order_items/:id', authenticate, OrderController.updateOrderItem);
router.delete('/order_items/:id', authenticate, OrderController.deleteOrderItem);

module.exports = router;
