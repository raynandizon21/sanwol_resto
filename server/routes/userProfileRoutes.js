// ============================================
// USER PROFILE ROUTES
// ============================================
// File: routes/userProfileRoutes.js
// Description: Routes for user profile management
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const UserProfileController = require('../controllers/userProfileController');

// ============================================
// GET ROUTES
// ============================================

// GET - Get current user profile
router.get("/user/profile", authenticate, UserProfileController.getProfile);

// GET - Get user activity history
router.get("/user/activity", authenticate, UserProfileController.getActivity);

// ============================================
// PUT ROUTES
// ============================================

// PUT - Update current user profile
router.put("/user/profile", authenticate, UserProfileController.updateProfile);

// PUT - Change password
router.put("/user/password", authenticate, UserProfileController.changePassword);

// ============================================
// EXPORT
// ============================================

module.exports = router;

