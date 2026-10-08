// ============================================
// JWT AUTHENTICATION MIDDLEWARE
// ============================================
// File: middleware/jwtAuth.js
// Description: Middleware to authenticate API requests using JWT
// ============================================

const { verifyAccessToken } = require('../utils/jwt');
const UserModel = require('../models/userModel');

/**
 * JWT Authentication Middleware
 * Verifies JWT token from Authorization header
 * Attaches user info to req.user if valid
 */
const authenticateJWT = async (req, res, next) => {
	try {
		// Get token from Authorization header
		const authHeader = req.headers.authorization;

		if (!authHeader) {
			return res.status(401).json({
				success: false,
				error: 'No authorization header provided'
			});
		}

		// Extract token from "Bearer <token>"
		const token = authHeader.startsWith('Bearer ')
			? authHeader.slice(7)
			: authHeader;

		if (!token) {
			return res.status(401).json({
				success: false,
				error: 'No token provided'
			});
		}

		// Verify token
		const decoded = verifyAccessToken(token);

		// Single-device-session enforcement: if this account has since logged
		// in elsewhere, ACTIVE_SESSION_ID will have moved on from this
		// token's sid. A null DB value means the feature hasn't stamped this
		// account yet (pre-existing token from before this shipped) — allow
		// it through untouched rather than mass-logging-out everyone.
		const activeSessionId = await UserModel.getActiveSessionId(decoded.user_id);
		if (activeSessionId && decoded.sid !== activeSessionId) {
			return res.status(401).json({
				success: false,
				error: 'This account was signed in on another device.',
				code: 'SESSION_REPLACED'
			});
		}

		// Attach user info to request
		req.user = {
			user_id: decoded.user_id,
			username: decoded.username,
			permissions: decoded.permissions,
			branch_id: decoded.branch_id || null // Optional branch context
		};

		// Continue to next middleware
		next();
	} catch (error) {
		// Handle different error types
		if (error.message === 'Token expired') {
			return res.status(401).json({
				success: false,
				error: 'Token expired',
				code: 'TOKEN_EXPIRED'
			});
		} else if (error.message === 'Invalid token') {
			return res.status(401).json({
				success: false,
				error: 'Invalid token',
				code: 'INVALID_TOKEN'
			});
		} else {
			return res.status(401).json({
				success: false,
				error: 'Authentication failed',
				code: 'AUTH_FAILED'
			});
		}
	}
};

/**
 * Optional JWT Authentication Middleware
 * Verifies token if provided, but doesn't require it
 * Useful for endpoints that work with or without authentication
 */
const optionalJWT = (req, res, next) => {
	try {
		const authHeader = req.headers.authorization;
		
		if (authHeader) {
			const token = authHeader.startsWith('Bearer ') 
				? authHeader.slice(7) 
				: authHeader;

			if (token) {
				try {
					const decoded = verifyAccessToken(token);
					req.user = {
						user_id: decoded.user_id,
						username: decoded.username,
						permissions: decoded.permissions,
						branch_id: decoded.branch_id || null
					};
				} catch (error) {
					// Token invalid, but continue without user
					req.user = null;
				}
			}
		}
		
		next();
	} catch (error) {
		next();
	}
};

/**
 * Permission-based authorization middleware
 * Must be used after authenticateJWT
 * @param {Array|Number} requiredPermissions - Required permission level(s)
 */
const requirePermission = (requiredPermissions) => {
	return (req, res, next) => {
		if (!req.user) {
			return res.status(401).json({
				success: false,
				error: 'Authentication required'
			});
		}

		const userPermissions = req.user.permissions;
		const permissionsArray = Array.isArray(requiredPermissions) 
			? requiredPermissions 
			: [requiredPermissions];

		// Check if user has required permission
		// Permission 1 is admin (highest level)
		if (userPermissions === 1 || permissionsArray.includes(userPermissions)) {
			next();
		} else {
			return res.status(403).json({
				success: false,
				error: 'Insufficient permissions',
				required: requiredPermissions,
				user_permission: userPermissions
			});
		}
	};
};

module.exports = {
	authenticateJWT,
	optionalJWT,
	requirePermission
};

