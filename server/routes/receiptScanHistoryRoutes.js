const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const ReceiptScanHistoryController = require('../controllers/receiptScanHistoryController');

router.get('/receipt-scan-history', authenticate, ReceiptScanHistoryController.list);
router.get('/receipt-scan-history/order/:orderId', authenticate, ReceiptScanHistoryController.getLatestByOrderId);
router.get('/receipt-scan-history/:id', authenticate, ReceiptScanHistoryController.getById);
router.patch('/receipt-scan-history/:id', authenticate, ReceiptScanHistoryController.patchOrder);
router.post('/receipt-scan-history', authenticate, ReceiptScanHistoryController.create);

module.exports = router;
