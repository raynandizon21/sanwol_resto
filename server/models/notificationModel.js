// ============================================
// NOTIFICATION MODEL
// ============================================
// File: models/notificationModel.js
// Description: Database operations for notifications
// ============================================

const pool = require('../config/db');

class NotificationModel {
	// Create notification (tries with BRANCH_ID first; falls back to no BRANCH_ID if column missing)
	static async create(data) {
		const {
			user_id,
			branch_id,
			title,
			message,
			type = 'info',
			link = null
		} = data;

		const branchVal = branch_id != null && Number.isFinite(Number(branch_id)) ? Number(branch_id) : 1;
		const createdDt = new Date();

		const queryWithBranch = `
			INSERT INTO notifications (
				USER_ID,
				BRANCH_ID,
				TITLE,
				MESSAGE,
				TYPE,
				LINK,
				IS_READ,
				CREATED_DT
			) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
		`;
		const queryWithoutBranch = `
			INSERT INTO notifications (
				USER_ID,
				TITLE,
				MESSAGE,
				TYPE,
				LINK,
				IS_READ,
				CREATED_DT
			) VALUES (?, ?, ?, ?, ?, 0, ?)
		`;

		const executeInsert = async (includeBranch) => {
			const query = includeBranch ? queryWithBranch : queryWithoutBranch;
			const values = includeBranch
				? [user_id, branchVal, title, message, type, link, createdDt]
				: [user_id, title, message, type, link, createdDt];
			const [result] = await pool.execute(query, values);
			return {
				insertId: result.insertId,
				branchId: includeBranch ? branchVal : null,
				createdAt: createdDt
			};
		};

		const executeInsertWithManualId = async (includeBranch) => {
			for (let attempt = 0; attempt < 5; attempt += 1) {
				const [rows] = await pool.execute('SELECT COALESCE(MAX(IDNo), 0) + 1 AS nextId FROM notifications');
				const nextId = Number(rows[0]?.nextId ?? 1) || 1;
				try {
					const query = includeBranch
						? `
							INSERT INTO notifications (
								IDNo,
								USER_ID,
								BRANCH_ID,
								TITLE,
								MESSAGE,
								TYPE,
								LINK,
								IS_READ,
								CREATED_DT
							) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
						`
						: `
							INSERT INTO notifications (
								IDNo,
								USER_ID,
								TITLE,
								MESSAGE,
								TYPE,
								LINK,
								IS_READ,
								CREATED_DT
							) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
						`;
					const values = includeBranch
						? [nextId, user_id, branchVal, title, message, type, link, createdDt]
						: [nextId, user_id, title, message, type, link, createdDt];
					await pool.execute(query, values);
					return {
						insertId: nextId,
						branchId: includeBranch ? branchVal : null,
						createdAt: createdDt
					};
				} catch (insertErr) {
					if (insertErr?.code === 'ER_DUP_ENTRY') {
						continue;
					}
					throw insertErr;
				}
			}
			throw new Error('Failed to allocate unique notifications.IDNo after retries');
		};

		try {
			return await executeInsert(true);
		} catch (err) {
			const msg = String(err?.message || err?.sqlMessage || '');
			const missingBranchColumn = err?.code === 'ER_BAD_FIELD_ERROR' && msg.includes('BRANCH_ID');
			const missingIdDefault = msg.includes('IDNo') && msg.includes('default');

			if (missingBranchColumn) {
				try {
					return await executeInsert(false);
				} catch (fallbackErr) {
					const fallbackMsg = String(fallbackErr?.message || fallbackErr?.sqlMessage || '');
					if (fallbackMsg.includes('IDNo') && fallbackMsg.includes('default')) {
						return executeInsertWithManualId(false);
					}
					throw fallbackErr;
				}
			}

			if (missingIdDefault) {
				return executeInsertWithManualId(true);
			}
			throw err;
		}
	}

	// Get user notifications (branchId null = all branches / global view)
	static async getByUserId(userId, unreadOnly = false, limit = 50, branchId = null) {
		const useBranch = branchId != null && branchId !== '' && branchId !== 'all';
		let query = `
			SELECT 
				IDNo,
				USER_ID,
				BRANCH_ID,
				TITLE,
				MESSAGE,
				TYPE,
				LINK,
				IS_READ,
				CREATED_DT
			FROM notifications
			WHERE USER_ID = ?
		`;
		const params = [userId];
		if (useBranch) {
			query += ` AND BRANCH_ID = ?`;
			params.push(branchId);
		}
		if (unreadOnly) {
			query += ` AND IS_READ = 0`;
		}
		query += ` ORDER BY CREATED_DT DESC LIMIT ?`;
		params.push(limit);

		try {
			const [rows] = await pool.execute(query, params);
			return rows;
		} catch (err) {
			if (err.code === 'ER_BAD_FIELD_ERROR' && err.sqlMessage && err.sqlMessage.includes('BRANCH_ID')) {
				const fallbackQuery = `
					SELECT IDNo, USER_ID, TITLE, MESSAGE, TYPE, LINK, IS_READ, CREATED_DT
					FROM notifications
					WHERE USER_ID = ? ${unreadOnly ? 'AND IS_READ = 0' : ''}
					ORDER BY CREATED_DT DESC LIMIT ?
				`;
				const fallbackParams = [userId, limit];
				const [rows] = await pool.execute(fallbackQuery, fallbackParams);
				return rows;
			}
			throw err;
		}
	}

	// Mark notification as read
	static async markAsRead(notificationId, userId) {
		const query = `
			UPDATE notifications 
			SET IS_READ = 1 
			WHERE IDNo = ? AND USER_ID = ?
		`;
		const [result] = await pool.execute(query, [notificationId, userId]);
		return result.affectedRows > 0;
	}

	// Mark all notifications as read for user
	static async markAllAsRead(userId) {
		const query = `
			UPDATE notifications 
			SET IS_READ = 1 
			WHERE USER_ID = ? AND IS_READ = 0
		`;
		await pool.execute(query, [userId]);
		return true;
	}

	// Clear all notifications for user
	static async clearAll(userId) {
		const query = `DELETE FROM notifications WHERE USER_ID = ?`;
		await pool.execute(query, [userId]);
		return true;
	}

	// Get unread count (branchId null = all branches / global view)
	static async getUnreadCount(userId, branchId = null) {
		let query = `SELECT COUNT(*) as count FROM notifications WHERE USER_ID = ? AND IS_READ = 0`;
		const params = [userId];
		if (branchId != null && branchId !== '' && branchId !== 'all') {
			query += ` AND BRANCH_ID = ?`;
			params.push(branchId);
		}
		try {
			const [rows] = await pool.execute(query, params);
			return parseInt(rows[0]?.count || 0);
		} catch (err) {
			if (err.code === 'ER_BAD_FIELD_ERROR' && err.sqlMessage && err.sqlMessage.includes('BRANCH_ID')) {
				const [rows] = await pool.execute(
					'SELECT COUNT(*) as count FROM notifications WHERE USER_ID = ? AND IS_READ = 0',
					[userId]
				);
				return parseInt(rows[0]?.count || 0);
			}
			throw err;
		}
	}
}

module.exports = NotificationModel;

