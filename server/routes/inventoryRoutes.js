const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const InventoryController = require('../controllers/inventoryController');

router.get('/inventory/items', authenticate, InventoryController.getAll);
router.get('/inventory/category-metrics', authenticate, InventoryController.getCategoryMetrics);
router.post('/inventory/items/adjust', authenticate, InventoryController.adjustStock);
router.patch('/inventory/items/by-expense/:expenseId', authenticate, InventoryController.updateStockByExpenseId);
router.get('/inventory/items/:id', authenticate, InventoryController.getById);
router.post('/inventory/items', authenticate, InventoryController.create);
router.put('/inventory/items/:id', authenticate, InventoryController.update);
router.delete('/inventory/items/:id', authenticate, InventoryController.delete);

module.exports = router;
