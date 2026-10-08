const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const MasterCategoryController = require('../controllers/masterCategoryController');

router.get('/inventory/categories', authenticate, MasterCategoryController.getAll);
router.get('/inventory/categories/:id', authenticate, MasterCategoryController.getById);
router.post('/inventory/categories', authenticate, MasterCategoryController.create);
router.put('/inventory/categories/:id', authenticate, MasterCategoryController.update);
router.delete('/inventory/categories/:id', authenticate, MasterCategoryController.delete);

module.exports = router;
