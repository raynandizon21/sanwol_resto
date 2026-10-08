// ============================================
// NOTIFICATION CONTROLLER
// ============================================
// File: controllers/notificationController.js
// Description: Handles notification business logic
// ============================================

const NotificationModel = require('../models/notificationModel');
const ApiResponse = require('../utils/apiResponse');

const isNoSuchTable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146);

class NotificationController {
	// Get user notifications (query.branch_id optional: omit = all branches, set = that branch only)
	static async getAll(req, res) {
		try {
			const userId = req.session?.user_id || req.user?.user_id;
			const unreadOnly = req.query.unread_only === 'true';
			const limit = parseInt(req.query.limit) || 50;
			const branchId = req.query.branch_id != null && req.query.branch_id !== '' && req.query.branch_id !== 'all'
				? req.query.branch_id
				: null;

			if (!userId) {
				return ApiResponse.badRequest(res, 'User ID is required');
			}

			const notifications = await NotificationModel.getByUserId(userId, unreadOnly, limit, branchId);
			const unreadCount = await NotificationModel.getUnreadCount(userId, branchId);

			return ApiResponse.success(res, {
				notifications,
				unread_count: unreadCount
			}, 'Notifications retrieved successfully');
		} catch (error) {
			if (isNoSuchTable(error)) {
				return ApiResponse.success(res, { notifications: [], unread_count: 0 }, 'Notifications retrieved successfully');
			}
			console.error('Error fetching notifications:', error);
			return ApiResponse.error(res, 'Failed to fetch notifications', 500, error.message);
		}
	}

	// Mark notification as read
	static async markAsRead(req, res) {
		try {
			const { id } = req.params;
			const userId = req.session?.user_id || req.user?.user_id;

			if (!userId) {
				return ApiResponse.badRequest(res, 'User ID is required');
			}

			const updated = await NotificationModel.markAsRead(id, userId);
			if (!updated) {
				return ApiResponse.notFound(res, 'Notification');
			}

			return ApiResponse.success(res, { notification_id: parseInt(id) }, 'Notification marked as read');
		} catch (error) {
			if (isNoSuchTable(error)) {
				return ApiResponse.success(res, { notification_id: parseInt(req.params.id) }, 'Notification marked as read');
			}
			console.error('Error marking notification as read:', error);
			return ApiResponse.error(res, 'Failed to mark notification as read', 500, error.message);
		}
	}

	// Mark all notifications as read
	static async markAllAsRead(req, res) {
		try {
			const userId = req.session?.user_id || req.user?.user_id;

			if (!userId) {
				return ApiResponse.badRequest(res, 'User ID is required');
			}

			await NotificationModel.markAllAsRead(userId);

			return ApiResponse.success(res, null, 'All notifications marked as read');
		} catch (error) {
			if (isNoSuchTable(error)) {
				return ApiResponse.success(res, null, 'All notifications marked as read');
			}
			console.error('Error marking all notifications as read:', error);
			return ApiResponse.error(res, 'Failed to mark all notifications as read', 500, error.message);
		}
	}

	// Clear all notifications
	static async clearAll(req, res) {
		try {
			const userId = req.session?.user_id || req.user?.user_id;

			if (!userId) {
				return ApiResponse.badRequest(res, 'User ID is required');
			}

			await NotificationModel.clearAll(userId);

			return ApiResponse.success(res, null, 'All notifications cleared');
		} catch (error) {
			if (isNoSuchTable(error)) {
				return ApiResponse.success(res, null, 'All notifications cleared');
			}
			console.error('Error clearing notifications:', error);
			return ApiResponse.error(res, 'Failed to clear notifications', 500, error.message);
		}
	}

	// Create notification (admin/system use)
	static async create(req, res) {
		try {
			const { user_id, branch_id, title, message, type = 'info', link = null } = req.body;

			if (!user_id || !title || !message) {
				return ApiResponse.badRequest(res, 'User ID, title, and message are required');
			}

			await NotificationModel.create({
				user_id,
				branch_id: branch_id != null ? branch_id : 1,
				title,
				message,
				type,
				link
			});

			return ApiResponse.created(res, { user_id: parseInt(user_id) }, 'Notification created successfully');
		} catch (error) {
			if (isNoSuchTable(error)) {
				return ApiResponse.badRequest(res, 'Notifications table does not exist. Run migration: scripts/migrations/2026-02-11-notifications-table.sql');
			}
			console.error('Error creating notification:', error);
			return ApiResponse.error(res, 'Failed to create notification', 500, error.message);
		}
	}
}

module.exports = NotificationController;

