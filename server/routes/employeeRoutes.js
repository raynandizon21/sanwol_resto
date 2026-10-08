// ============================================
// EMPLOYEE ROUTES
// ============================================
// File: routes/employeeRoutes.js
// Description: Routes for employee endpoints (calls controllers)
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const EmployeeController = require('../controllers/employeeController');

// ============================================
// GET ROUTES
// ============================================

// Employee management page route removed - use API endpoints instead

// GET - Get page metadata (branches, users, roles, departments)
router.get("/employee/metadata", authenticate, EmployeeController.getPageMetadata);

// GET - Fetch all employees (for DataTables)
router.get("/employees_list", authenticate, EmployeeController.getAll);

// GET - Fetch single employee by ID (for edit modal)
router.get("/employee/:id", authenticate, EmployeeController.getById);

// ============================================
// POST ROUTES
// ============================================

// POST - Create new employee
router.post("/employee", authenticate, EmployeeController.create);

// ============================================
// PUT ROUTES
// ============================================

// PUT - Update employee
router.put("/employee/:id", authenticate, EmployeeController.update);

// ============================================
// DELETE ROUTES
// ============================================

// DELETE - Soft delete employee
router.delete("/employee/:id", authenticate, EmployeeController.delete);

// ============================================
// EXPORT
// ============================================

module.exports = router;

