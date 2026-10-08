// ============================================
// UPLOAD ROUTES
// ============================================
// File: routes/uploadRoutes.js
// Description: Routes for generic file upload
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const { UploadController, uploadMiddleware } = require('../controllers/uploadController');

// ============================================
// POST ROUTES
// ============================================

// POST - Generic file upload
// Query: ?subdir=avatars&webp=true
// Form data: file (multipart/form-data)
router.post("/upload", authenticate, uploadMiddleware, UploadController.uploadFile);

// ============================================
// EXPORT
// ============================================

module.exports = router;

