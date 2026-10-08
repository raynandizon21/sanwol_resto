const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const CashReconciliationController = require('../controllers/cashReconciliationController');

router.get('/cash-reconciliation/aggregates', authenticate, CashReconciliationController.aggregates);
router.get('/cash-reconciliation', authenticate, CashReconciliationController.list);
router.get('/cash-reconciliation/:id', authenticate, CashReconciliationController.getById);
router.post('/cash-reconciliation', authenticate, CashReconciliationController.create);
router.put('/cash-reconciliation/:id', authenticate, CashReconciliationController.update);
router.delete('/cash-reconciliation/:id', authenticate, CashReconciliationController.remove);

module.exports = router;
