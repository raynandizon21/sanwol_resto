const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const IngredientController = require('../controllers/ingredientController');
const MenuIngredientController = require('../controllers/menuIngredientController');

// Ingredients (master list)
router.get('/ingredients', authenticate, IngredientController.getAll);
router.post('/ingredients/sync', authenticate, IngredientController.syncFromExpenses);
router.get('/ingredients/:ingredientId/menus', authenticate, MenuIngredientController.getByIngredientId);
router.get('/ingredients/:id', authenticate, IngredientController.getById);
router.post('/ingredients', authenticate, IngredientController.create);
router.put('/ingredients/:id', authenticate, IngredientController.update);
router.delete('/ingredients/:id', authenticate, IngredientController.delete);

// Menu ingredients (recipe)
router.get('/menu/:menuId/ingredients', authenticate, MenuIngredientController.getByMenuId);
router.post('/menu-ingredients', authenticate, MenuIngredientController.create);
router.put('/menu-ingredients/:id', authenticate, MenuIngredientController.update);
router.delete('/menu-ingredients/:id', authenticate, MenuIngredientController.delete);

module.exports = router;
