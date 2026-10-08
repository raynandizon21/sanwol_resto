// ============================================
// CATEGORY ROUTES
// ============================================
// File: routes/categoryRoutes.js
// Description: Routes for category endpoints (calls controllers)
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const CategoryController = require('../controllers/categoryController');

// ============================================
// GET ROUTES
// ============================================

// Category management page route removed - use API endpoints instead

// GET - Fetch all categories (for DataTables)
router.get("/categories_list", authenticate, CategoryController.getAll);

// GET - Fetch single category by ID
router.get("/category/:id", authenticate, CategoryController.getById);

// ============================================
// POST ROUTES
// ============================================

// POST - Create new category
router.post("/category", authenticate, CategoryController.create);

// POST - One-time: flat categories → one new main + all existing become subs (must be before /category/:id)
router.post("/category/migrate-flat-under-main", authenticate, CategoryController.migrateFlatUnderMain);

// ============================================
// PUT ROUTES
// ============================================

// PUT - Update category
router.put("/category/:id", authenticate, CategoryController.update);

// ============================================
// DELETE ROUTES
// ============================================

// DELETE - Soft delete category
router.delete("/category/:id", authenticate, CategoryController.delete);

// ============================================
// EXPORT
// ============================================

module.exports = router;

