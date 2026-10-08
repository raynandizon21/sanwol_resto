// ============================================
// API ROUTES
// ============================================
// File: routes/apiRoutes.js
// Description: API endpoints for mobile/tablet apps
// Authentication: JWT tokens required for protected endpoints
// ============================================

const express = require('express');
const router = express.Router();
const ApiController = require('../controllers/apiController');
const UserManagementController = require('../controllers/userManagementController');
const { authenticateJWT, optionalJWT } = require('../middleware/jwtAuth');

// ============================================
// PUBLIC ROUTES (No authentication required)
// ============================================

// POST - Login for mobile/tablet app
// URL: /api/login
// Body: { username: "string", password: "string" }
// Response: { success: true, data: {...}, tokens: { accessToken, refreshToken, expiresIn } }
router.post("/login", ApiController.login);

// POST - Refresh access token
// URL: /api/refresh
// Body: { refreshToken: "string" }
// Response: { success: true, tokens: { accessToken, refreshToken, expiresIn } }
router.post("/refresh", ApiController.refreshToken);

// GET - Latest published APK version, for in-app update checks
// URL: /api/app/version
// Response: { success: true, data: { versionCode, versionName, apkUrl, releaseNotes } }
// No auth required - a tablet should be able to check even from the login screen.
router.get("/app/version", ApiController.getAppVersion);

// GET - Receipt scanner Gemini API key from DB
// URL: /api/receiptscanner/gemini-key
router.get("/receiptscanner/gemini-key", optionalJWT, ApiController.getReceiptScannerApiKey);
// POST - Stitch multiple receipt images into one long strip
// URL: /api/receiptscanner/stitch
router.post("/receiptscanner/stitch", optionalJWT, ApiController.stitchReceiptImages);
// POST - Analyze receipt image (Vertex AI Gemini)
// URL: /api/receiptscanner/analyze
// Body: { base64: "data:image/jpeg;base64,..." } OR { base64: "<raw base64>" }
router.post("/receiptscanner/analyze", optionalJWT, ApiController.analyzeReceipt);
// POST - Orders flow: grouped order blocks + line items (Vertex AI)
router.post("/receiptscanner/analyze-orders", optionalJWT, ApiController.analyzeReceiptOrders);

// ============================================
// PROTECTED ROUTES (JWT authentication required)
// ============================================

// GET - Get all categories (for filter button)
// URL: /api/categories
// Headers: Authorization: Bearer <accessToken>
// Note: Categories are public, but keeping protected for consistency
router.get("/categories", authenticateJWT, ApiController.getCategories);

// GET - Get all restaurant tables
// URL: /api/tables
// Headers: Authorization: Bearer <accessToken>
router.get("/tables", authenticateJWT, ApiController.getTables);

// GET - Get all menu items
// URL: /api/menu
// Headers: Authorization: Bearer <accessToken>
// Query params: ?category_id=X (optional - filter by category)
router.get("/menu", authenticateJWT, ApiController.getMenuItems);

// GET - Get top revenue / popular menu items
// URL: /api/menu/top-revenue
// Headers: Authorization: Bearer <accessToken>
router.get("/menu/top-revenue", authenticateJWT, ApiController.getTopRevenueItems);

// GET - Get user orders (for syncing with local storage)
// URL: /api/orders
// Headers: Authorization: Bearer <accessToken>
// Response: { success: true, data: [{ order_id, order_no, items: [...] }] }
router.get("/orders", authenticateJWT, ApiController.getUserOrders);

// GET - Get kitchen orders (all PENDING and CONFIRMED orders)
// URL: /api/kitchen/orders
// Headers: Authorization: Bearer <accessToken>
// Response: { success: true, data: [{ order_id, order_no, table_id, table_number, status, items: [...] }] }
router.get("/kitchen/orders", authenticateJWT, ApiController.getKitchenOrders);

// PATCH - Update kitchen order status
// URL: /api/kitchen/orders/:order_id/status
// Body: { status: number } (allowed: 3=PENDING, 2=PREPARING, 1=READY, -1=CANCELLED)
router.patch("/kitchen/orders/:order_id/status", authenticateJWT, ApiController.updateKitchenOrderStatus);
// POST fallback for CORS issues
router.post("/kitchen/orders/:order_id/status", authenticateJWT, ApiController.updateKitchenOrderStatus);

// GET - Get waiter orders (orders table status)
// URL: /api/waiter/orders
// Headers: Authorization: Bearer <accessToken>
router.get("/waiter/orders", authenticateJWT, ApiController.getWaiterOrders);

// PATCH - Update waiter order status (orders table)
// URL: /api/waiter/orders/:order_id/status
// Body: { status: number } (allowed: 3=PENDING, 2=CONFIRMED)
router.patch("/waiter/orders/:order_id/status", authenticateJWT, ApiController.updateWaiterOrderStatus);

// POST - Transfer table order (Lipat Mesa)
// URL: /api/waiter/orders/:order_id/transfer-table
// Body: { target_table_id: number }
router.post("/waiter/orders/:order_id/transfer-table", authenticateJWT, ApiController.transferTableOrder);

// POST - Extend room charge (adds one more unit of the table's ROOM_CHARGE
// to the order's SERVICE_CHARGE and recomputes GRAND_TOTAL)
// URL: /api/waiter/orders/:order_id/extend-room-charge
router.post("/waiter/orders/:order_id/extend-room-charge", authenticateJWT, ApiController.extendRoomCharge);

// POST - Create new order
// URL: /api/orders
// Headers: Authorization: Bearer <accessToken>
// Body: {
//   order_no: "string" (required),
//   table_id: number (optional),
//   order_type: string (optional),
//   subtotal: number (optional, default: 0),
//   tax_amount: number (optional, default: 0),
//   service_charge: number (optional, default: 0),
//   discount_amount: number (optional, default: 0),
//   grand_total: number (optional, default: 0),
//   items: [
//     {
//       menu_id: number (required),
//       qty: number (required),
//       unit_price: number (required),
//       status: number (optional, default: 1)
//     }
//   ] (required, at least one item)
// }
// Response: { success: true, data: { order_id, order_no, table_id, status, grand_total, items_count } }
router.post("/orders", authenticateJWT, ApiController.createOrder);

// POST - Add items to existing order (Additional Order)
// URL: /api/orders/:order_id/items
// Headers: Authorization: Bearer <accessToken>
// Body: {
//   items: [
//     {
//       menu_id: number (required),
//       qty: number (required),
//       unit_price: number (required),
//       status: number (optional, default: 1)
//     }
//   ] (required, at least one item)
// }
// Response: { success: true, data: { order_id, order_no, items_added, new_subtotal, new_grand_total } }
router.post("/orders/:order_id/items", authenticateJWT, ApiController.addItemsToOrder);
// PUT - Replace items in existing order (Edit Order)
// URL: /api/orders/:order_id/items
// Headers: Authorization: Bearer <accessToken>
// Body: {
//   items: [
//     {
//       menu_id: number (required),
//       qty: number (required),
//       unit_price: number (required),
//       status: number (optional, default: 3)
//     }
//   ] (required, at least one item)
// }
// Response: { success: true, data: { order_id, order_no, items_count, new_grand_total } }
router.put("/orders/:order_id/items", authenticateJWT, ApiController.replaceOrderItems);

// ============================================
// USER MANAGEMENT (restoadmin User & Access)
// ============================================

// GET - List users for User Management page
// URL: /api/user-management/users
// Headers: Authorization: Bearer <accessToken>
// Response: { success: true, data: [{ id, name, email, roleId, roleName, lastActive, avatar }] }
router.get("/user-management/users", authenticateJWT, UserManagementController.getUsers);

// GET - List roles for Roles & Permissions tab
// URL: /api/user-management/roles
// Headers: Authorization: Bearer <accessToken>
// Response: { success: true, data: [{ id, name, description, permissions }] }
router.get("/user-management/roles", authenticateJWT, UserManagementController.getRoles);

// POST - Create user (restoadmin Invite User)
router.post("/user-management/users", authenticateJWT, UserManagementController.createUser);

// PUT - Update user
router.put("/user-management/users/:id", authenticateJWT, UserManagementController.updateUser);

// DELETE - Soft-delete user (archive)
router.delete("/user-management/users/:id", authenticateJWT, UserManagementController.deleteUser);

// POST - Create role (restoadmin Create Role)
router.post("/user-management/roles", authenticateJWT, UserManagementController.createRole);

// PUT - Update role
router.put("/user-management/roles/:id", authenticateJWT, UserManagementController.updateRole);

// DELETE - Soft-delete role (archive)
router.delete("/user-management/roles/:id", authenticateJWT, UserManagementController.deleteRole);

// GET - Role CRUD permissions (add/edit/delete) per module
// URL: /api/user-management/roles/:roleId/crud-permissions
router.get(
  "/user-management/roles/:roleId/crud-permissions",
  authenticateJWT,
  UserManagementController.getRoleCrudPermissions
);

// PUT - Update Role CRUD permissions
// URL: /api/user-management/roles/:roleId/crud-permissions
router.put(
  "/user-management/roles/:roleId/crud-permissions",
  authenticateJWT,
  UserManagementController.updateRoleCrudPermissions
);

// GET - Get current user info
// URL: /api/me
// Headers: Authorization: Bearer <accessToken>
// Response: { success: true, data: { user_id, username, firstname, lastname, permissions, branch_id, role } }
router.get("/me", authenticateJWT, ApiController.getMe);

// GET - Get dashboard data
// URL: /api/dashboard-data
// Headers: Authorization: Bearer <accessToken>
// Query: ?branchId=...
router.get("/dashboard-data", authenticateJWT, ApiController.getDashboardData);

// GET - Get branch performance data for admin dashboard
// URL: /api/admin/branch-performance
// Headers: Authorization: Bearer <accessToken>
router.get("/admin/branch-performance", authenticateJWT, ApiController.getBranchPerformance);

// GET - Get monthly performance data for admin dashboard
// URL: /api/admin/monthly-performance
// Headers: Authorization: Bearer <accessToken>
router.get("/admin/monthly-performance", authenticateJWT, ApiController.getMonthlyPerformance);

// ============================================
// EXPORT
// ============================================

module.exports = router;

