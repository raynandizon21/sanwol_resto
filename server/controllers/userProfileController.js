// ============================================
// USER PROFILE CONTROLLER
// ============================================
// File: controllers/userProfileController.js
// Description: Handles user profile management
// ============================================

const pool = require('../config/db');
const argon2 = require('argon2');
const ApiResponse = require('../utils/apiResponse');

class UserProfileController {
	// Get current user profile
	static async getProfile(req, res) {
		try {
			const userId = req.session?.user_id || req.user?.user_id;

			if (!userId) {
				return ApiResponse.badRequest(res, 'User ID is required');
			}

			const query = `
				SELECT 
					u.IDNo,
					u.USERNAME,
					u.FIRSTNAME,
					u.LASTNAME,
					u.PERMISSIONS,
					u.LAST_LOGIN,
					ur.ROLE AS role_name
				FROM user_info u
				LEFT JOIN user_role ur ON ur.IDNo = u.PERMISSIONS
				WHERE u.IDNo = ? AND u.ACTIVE = 1
			`;

			const [rows] = await pool.execute(query, [userId]);
			if (rows.length === 0) {
				return ApiResponse.notFound(res, 'User');
			}

			return ApiResponse.success(res, rows[0], 'Profile retrieved successfully');
		} catch (error) {
			console.error('Error fetching profile:', error);
			return ApiResponse.error(res, 'Failed to fetch profile', 500, error.message);
		}
	}

	// Update current user profile
	static async updateProfile(req, res) {
		try {
			const userId = req.session?.user_id || req.user?.user_id;
			const { firstname, lastname, username } = req.body;

			if (!userId) {
				return ApiResponse.badRequest(res, 'User ID is required');
			}

			const updateFields = [];
			const params = [];

			if (firstname !== undefined) {
				updateFields.push('FIRSTNAME = ?');
				params.push(firstname);
			}
			if (lastname !== undefined) {
				updateFields.push('LASTNAME = ?');
				params.push(lastname);
			}
			if (username !== undefined) {
				// Check if username is already taken by another user
				const [existing] = await pool.execute(
					'SELECT IDNo FROM user_info WHERE USERNAME = ? AND IDNo != ? AND ACTIVE = 1',
					[username, userId]
				);
				if (existing.length > 0) {
					return ApiResponse.badRequest(res, 'Username is already taken');
				}
				updateFields.push('USERNAME = ?');
				params.push(username);
			}

			if (updateFields.length === 0) {
				return ApiResponse.badRequest(res, 'No fields to update');
			}

			params.push(userId);

			const query = `UPDATE user_info SET ${updateFields.join(', ')} WHERE IDNo = ?`;
			await pool.execute(query, params);

			// Return updated user data
			const [updatedRows] = await pool.execute(
				'SELECT IDNo, USERNAME, FIRSTNAME, LASTNAME, PERMISSIONS FROM user_info WHERE IDNo = ?',
				[userId]
			);

			return ApiResponse.success(res, updatedRows[0] || null, 'Profile updated successfully');
		} catch (error) {
			console.error('Error updating profile:', error);
			return ApiResponse.error(res, 'Failed to update profile', 500, error.message);
		}
	}

	// Change password
	static async changePassword(req, res) {
		try {
			const userId = req.session?.user_id || req.user?.user_id;
			const { current_password, new_password, confirm_password } = req.body;

			if (!userId) {
				return ApiResponse.badRequest(res, 'User ID is required');
			}

			if (!current_password || !new_password || !confirm_password) {
				return ApiResponse.badRequest(res, 'Current password, new password, and confirm password are required');
			}

			if (new_password !== confirm_password) {
				return ApiResponse.badRequest(res, 'New password and confirm password do not match');
			}

			// Get current user
			const [users] = await pool.execute('SELECT PASSWORD, SALT FROM user_info WHERE IDNo = ?', [userId]);
			if (users.length === 0) {
				return ApiResponse.notFound(res, 'User');
			}

			const user = users[0];
			const storedPassword = user.PASSWORD;

			// Verify current password
			let isValid = false;
			if (storedPassword.startsWith('$argon2')) {
				isValid = await argon2.verify(storedPassword, current_password);
			} else {
				// MD5 fallback
				const crypto = require('crypto');
				const hashedMD5 = crypto.createHash('md5').update((user.SALT || '') + current_password).digest('hex');
				isValid = (hashedMD5 === storedPassword);
			}

			if (!isValid) {
				return ApiResponse.error(res, 'Current password is incorrect', 401);
			}

			// Hash new password
			const newHashedPassword = await argon2.hash(new_password);

			// Update password
			await pool.execute('UPDATE user_info SET PASSWORD = ?, SALT = \'\' WHERE IDNo = ?', [newHashedPassword, userId]);

			return ApiResponse.success(res, null, 'Password changed successfully');
		} catch (error) {
			console.error('Error changing password:', error);
			return ApiResponse.error(res, 'Failed to change password', 500, error.message);
		}
	}

	// Get user activity history
	static async getActivity(req, res) {
		try {
			const userId = req.session?.user_id || req.user?.user_id;
			const limit = parseInt(req.query.limit) || 50;

			if (!userId) {
				return ApiResponse.badRequest(res, 'User ID is required');
			}

			// Get audit logs for user
			const AuditLogModel = require('../models/auditLogModel');
			const activities = await AuditLogModel.getByUserId(userId, limit);

			return ApiResponse.success(res, activities, 'Activity history retrieved successfully');
		} catch (error) {
			console.error('Error fetching activity:', error);
			return ApiResponse.error(res, 'Failed to fetch activity history', 500, error.message);
		}
	}
}

module.exports = UserProfileController;

