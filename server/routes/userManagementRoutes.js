const express = require('express');
const router = express.Router();
const UserManagementController = require('../controllers/userManagementController');
const { authenticate } = require('../middleware/unifiedAuth'); // Assuming user management requires authentication

// Apply authentication middleware to all user management routes
router.use(authenticate);

// User Role Management
router.post('/add_user_role', UserManagementController.addUserRole);
router.get('/user_role_data', UserManagementController.getUserRoleData);
router.put('/user_role/:id', UserManagementController.updateUserRole);
router.put('/user_role/remove/:id', UserManagementController.archiveUserRole);

// User Management
router.get('/users', UserManagementController.getUsers);
router.post('/add_user', UserManagementController.addUser);
router.put('/user/:id', UserManagementController.updateUser);
router.put('/user/remove/:id', UserManagementController.archiveUser);

module.exports = router;
