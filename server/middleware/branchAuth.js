    // ============================================
// BRANCH AUTHENTICATION MIDDLEWARE
// ============================================
// File: middleware/branchAuth.js
// Description: Middleware to handle branch access control
// ============================================

const UserBranchModel = require('../models/userBranchModel');
const pool = require('../config/db');

/**
 * Middleware to get user's accessible branches
 * Attaches req.userBranches array to request
 * Permission 11 (admin) can access all branches
 */
const getUserBranches = async (req, res, next) => {
	try {
		if (!req.user || !req.user.user_id) {
			return res.status(401).json({
				success: false,
				error: 'Authentication required'
			});
		}

		// Admin (permission 1) can access all branches
		if (req.user.permissions === 1) {
			const [allBranches] = await pool.execute(
				'SELECT IDNo, BRANCH_CODE, BRANCH_NAME FROM branches WHERE ACTIVE = 1'
			);
			req.userBranches = allBranches.map(b => b.IDNo);
			req.allBranches = allBranches;
		} else {
			// Regular users can only access their assigned branches
			const branches = await UserBranchModel.getBranchesByUserId(req.user.user_id);
			req.userBranches = branches.map(b => b.IDNo);
			req.allBranches = branches;
		}

		next();
	} catch (error) {
		console.error('Error getting user branches:', error);
		return res.status(500).json({
			success: false,
			error: 'Failed to get user branches'
		});
	}
};

/**
 * Middleware to validate branch access
 * Checks if user has access to the specified branch
 * Can be used as: requireBranchAccess or requireBranchAccess('BRANCH_ID')
 */
const requireBranchAccess = (branchParam = 'branch_id') => {
	return async (req, res, next) => {
		try {
			if (!req.user || !req.user.user_id) {
				return res.status(401).json({
					success: false,
					error: 'Authentication required'
				});
			}

			// Get branch ID from params, query, or body
			const branchId = req.params[branchParam] || 
				req.query[branchParam] || 
				req.body[branchParam] ||
				req.body.BRANCH_ID;

			if (!branchId) {
				return res.status(400).json({
					success: false,
					error: 'Branch ID is required'
				});
			}

			// Admin can access all branches
			if (req.user.permissions === 1) {
				return next();
			}

			// Check if user has access to this branch
			const hasAccess = await UserBranchModel.hasAccess(req.user.user_id, parseInt(branchId));
			
			if (!hasAccess) {
				return res.status(403).json({
					success: false,
					error: 'Access denied to this branch'
				});
			}

			// Attach branch ID to request for use in controllers
			req.branchId = parseInt(branchId);
			next();
		} catch (error) {
			console.error('Error validating branch access:', error);
			return res.status(500).json({
				success: false,
				error: 'Failed to validate branch access'
			});
		}
	};
};

/**
 * Middleware to filter by user's accessible branches
 * Automatically filters queries by user's branches
 * Admin users see all branches
 */
const filterByUserBranches = async (req, res, next) => {
	try {
		if (!req.user || !req.user.user_id) {
			return next(); // Let other middleware handle auth
		}

		// Get user's accessible branches
		await getUserBranches(req, res, () => {
			// If user has no branches, set to empty array (will return no results)
			if (!req.userBranches || req.userBranches.length === 0) {
				req.userBranches = [];
			}
			next();
		});
	} catch (error) {
		next();
	}
};

module.exports = {
	getUserBranches,
	requireBranchAccess,
	filterByUserBranches
};

