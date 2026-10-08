const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const ExpenseController = require('../controllers/expenseController');

router.get('/expenses', authenticate, ExpenseController.getAll);
router.get('/expenses/:id', authenticate, ExpenseController.getById);
router.post('/expenses', authenticate, ExpenseController.create);
router.put('/expenses/:id', authenticate, ExpenseController.update);
router.delete('/expenses/:id', authenticate, ExpenseController.delete);

router.get('/expenses/reports/summary', authenticate, ExpenseController.getSummary);
router.get('/expenses/reports/by-category', authenticate, ExpenseController.getByCategory);
router.get('/expenses/reports/trend', authenticate, ExpenseController.getTrend);
router.get('/expenses/reports/export.csv', authenticate, ExpenseController.exportCsv);

module.exports = router;
