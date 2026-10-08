// ============================================
// MENU ROUTES
// ============================================
// File: routes/menuRoutes.js
// Description: Routes for menu endpoints (calls controllers)
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const MenuController = require('../controllers/menuController');
const { menuUpload, convertMenuToWebp, FIELDS } = require('../middleware/upload');

// ============================================
// GET ROUTES
// ============================================

// Menu management page route removed - use API endpoints instead

// GET - Fetch all menus (for DataTables)
router.get("/menus", authenticate, MenuController.getAll);

// GET - Fetch single menu by ID
router.get("/menu/:id", authenticate, MenuController.getById);

// GET - Fetch all categories (for dropdown)
router.get("/categories", authenticate, MenuController.getCategories);

// ============================================
// POST ROUTES
// ============================================

// POST - Create new menu (with file upload and WebP conversion)
router.post("/menu", authenticate, menuUpload.single(FIELDS.MENU_IMG), convertMenuToWebp, MenuController.create);

// ============================================
// PUT ROUTES
// ============================================

// PUT - Update menu (with optional file upload and WebP conversion)
router.put("/menu/:id", authenticate, menuUpload.single(FIELDS.MENU_IMG), convertMenuToWebp, MenuController.update);

// ============================================
// DELETE ROUTES
// ============================================

// DELETE - Soft delete menu
router.delete("/menu/:id", authenticate, MenuController.delete);

// ============================================
// EXPORT
// ============================================

module.exports = router;

