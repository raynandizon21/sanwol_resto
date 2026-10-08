// ============================================
// UNIFIED AUTHENTICATION MIDDLEWARE
// ============================================
// File: middleware/unifiedAuth.js
// Description: Supports both JWT and Session authentication
// Priority: JWT first, then Session fallback
// ============================================

const { verifyAccessToken } = require('../utils/jwt');
const ApiResponse = require('../utils/apiResponse');

/**
 * Unified Authentication Middleware
 * Supports both JWT (Bearer token) and Session-based auth
 * Attaches user info to req.user
 */
const authenticate = (req, res, next) => {
	// Priority 1: Check for JWT token
	const authHeader = req.headers.authorization;
	
	if (authHeader && authHeader.startsWith('Bearer ')) {
		try {
			const token = authHeader.slice(7);
			const decoded = verifyAccessToken(token);
			
			// JWT authentication successful
			req.user = {
				user_id: decoded.user_id,
				username: decoded.username,
				permissions: decoded.permissions,
				branch_id: decoded.branch_id || null,
				branch_name: decoded.branch_name || null,
				branch_code: decoded.branch_code || null,
				firstname: decoded.firstname || null,
				lastname: decoded.lastname || null,
				auth_method: 'jwt'
			};
			
			// Also populate session for backward compatibility
			if (!req.session) {
				req.session = {};
			}
			req.session.user_id = decoded.user_id;
			req.session.username = decoded.username;
			req.session.permissions = decoded.permissions;
			req.session.branch_id = decoded.branch_id || null;
			req.session.branch_name = decoded.branch_name || null;
			req.session.branch_code = decoded.branch_code || null;
			req.session.firstname = decoded.firstname || null;
			req.session.lastname = decoded.lastname || null;
			
			return next();
		} catch (error) {
			// JWT invalid, try session fallback
		}
	}
	
	// Priority 2: Check for Session
	if (req.session && req.session.username) {
		req.user = {
			user_id: req.session.user_id,
			username: req.session.username,
			permissions: req.session.permissions,
			branch_id: req.session.branch_id || null,
			firstname: req.session.firstname || null,
			lastname: req.session.lastname || null,
			auth_method: 'session'
		};
		return next();
	}
	
	// No valid authentication found
	return ApiResponse.unauthorized(res, 'Authentication required. Please provide JWT token or valid session.');
};

/**
 * Optional authentication: sets req.user when valid JWT/session, otherwise continues with req.user undefined.
 * Use for endpoints like GET /me that should return 200 with null instead of 401 when not logged in.
 */
const optionalAuthenticate = (req, res, next) => {
	const authHeader = req.headers.authorization;

	if (authHeader && authHeader.startsWith('Bearer ')) {
		try {
			const token = authHeader.slice(7);
			const decoded = verifyAccessToken(token);
			req.user = {
				user_id: decoded.user_id,
				username: decoded.username,
				permissions: decoded.permissions,
				branch_id: decoded.branch_id || null,
				branch_name: decoded.branch_name || null,
				branch_code: decoded.branch_code || null,
				firstname: decoded.firstname || null,
				lastname: decoded.lastname || null,
				auth_method: 'jwt'
			};
			if (!req.session) req.session = {};
			req.session.user_id = decoded.user_id;
			req.session.username = decoded.username;
			req.session.permissions = decoded.permissions;
			req.session.branch_id = decoded.branch_id || null;
			req.session.branch_name = decoded.branch_name || null;
			req.session.branch_code = decoded.branch_code || null;
			req.session.firstname = decoded.firstname || null;
			req.session.lastname = decoded.lastname || null;
			return next();
		} catch (_) {
			// token invalid/expired – continue without user
		}
	}

	if (req.session && req.session.username) {
		req.user = {
			user_id: req.session.user_id,
			username: req.session.username,
			permissions: req.session.permissions,
			branch_id: req.session.branch_id || null,
			firstname: req.session.firstname || null,
			lastname: req.session.lastname || null,
			auth_method: 'session'
		};
	}
	return next();
};

/**
 * Admin-only middleware
 * Must be used after authenticate()
 */
const requireAdmin = (req, res, next) => {
	if (!req.user) {
		return ApiResponse.unauthorized(res, 'Authentication required');
	}
	
	const permissions = req.user.permissions || req.session?.permissions;
	if (permissions !== 1) {
		return ApiResponse.forbidden(res, 'Admin access required');
	}
	
	next();
};

/**
 * Restrict to the 3coredev developer account (username check, not role).
 * Must be used after authenticate()
 */
const require3core = (req, res, next) => {
	if (!req.user) {
		return ApiResponse.unauthorized(res, 'Authentication required');
	}

	const username = String(req.user.username || req.session?.username || '').trim().toLowerCase();
	if (username !== '3coredev') {
		return ApiResponse.forbidden(res, 'Only the 3coredev account can perform this action');
	}

	next();
};

/**
 * Order meta editors (edit ENCODED_DT / soft delete).
 * 3coredev: any branch. Other listed usernames: only their assigned branch
 * (enforced in the controller via req.orderMetaBranchId).
 * Keep in sync with ORDER_META_EDITOR_USERNAMES in src/components/orders/Orders.tsx.
 */
const ORDER_META_BRANCH_EDITORS = { bmoon: 3 };

const requireOrderMetaEditor = (req, res, next) => {
	if (!req.user) {
		return ApiResponse.unauthorized(res, 'Authentication required');
	}

	const username = String(req.user.username || req.session?.username || '').trim().toLowerCase();
	if (username === '3coredev') {
		req.orderMetaBranchId = null;
		return next();
	}
	if (Object.prototype.hasOwnProperty.call(ORDER_META_BRANCH_EDITORS, username)) {
		req.orderMetaBranchId = ORDER_META_BRANCH_EDITORS[username];
		return next();
	}

	return ApiResponse.forbidden(res, 'You are not allowed to perform this action');
};

/**
 * Permission-based authorization
 * @param {Array|Number} requiredPermissions - Required permission level(s)
 */
const requirePermission = (requiredPermissions) => {
	return (req, res, next) => {
		if (!req.user) {
			return ApiResponse.unauthorized(res, 'Authentication required');
		}
		
		const userPermissions = req.user.permissions || req.session?.permissions;
		const permissionsArray = Array.isArray(requiredPermissions) 
			? requiredPermissions 
			: [requiredPermissions];
		
		if (userPermissions === 1 || permissionsArray.includes(userPermissions)) {
			next();
		} else {
			return ApiResponse.forbidden(res, 'Insufficient permissions');
		}
	};
};

module.exports = {
	authenticate,
	optionalAuthenticate,
	requireAdmin,
	require3core,
	requireOrderMetaEditor,
	requirePermission
};

