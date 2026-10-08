// ============================================
// TABLE ROUTES
// ============================================
// File: routes/tableRoutes.js
// Description: Routes for restaurant table endpoints (calls controllers)
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const TableController = require('../controllers/tableController');

// ============================================
// GET ROUTES
// ============================================

// Table management page route removed - use API endpoints instead

// GET - Fetch all restaurant tables (for DataTables)
router.get("/restaurant_tables", authenticate, TableController.getAll);

// GET - Fetch a single restaurant table (for room charge computations)
router.get("/restaurant_table/:id", authenticate, TableController.getById);

// GET - Get transaction history for a table
router.get("/restaurant_table/:id/transactions", authenticate, TableController.getTransactionHistory);

// ============================================
// POST ROUTES
// ============================================

// POST - Create new restaurant table
router.post("/restaurant_table", authenticate, TableController.create);

// ============================================
// PUT ROUTES
// ============================================

// PUT - Update restaurant table
router.put("/restaurant_table/:id", authenticate, TableController.update);

// ============================================
// DELETE ROUTES
// ============================================

// DELETE - Delete restaurant table
router.delete("/restaurant_table/:id", authenticate, TableController.delete);

// PATCH - Update table status directly
router.patch("/restaurant_table/:id/status", authenticate, TableController.updateStatus);

// ============================================
// EXPORT
// ============================================

module.exports = router;

