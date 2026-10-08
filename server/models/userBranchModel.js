const pool = require('../config/db');
const BranchModel = require('./branchModel');

class UserBranchModel {

	// Initialize database structure for BRANCH_ID in user_info
	static async initialize() {
		try {
			const [columns] = await pool.query(`SHOW COLUMNS FROM user_info LIKE 'BRANCH_ID'`);
			if (columns.length === 0) {
				await pool.query(`ALTER TABLE user_info ADD COLUMN BRANCH_ID INT DEFAULT NULL`);
				console.log('Added BRANCH_ID column to user_info table');

				// Migrate existing data from user_branches to user_info if table exists
				try {
					await pool.query(`
						UPDATE user_info u
						JOIN user_branches ub ON u.IDNo = ub.USER_ID
						SET u.BRANCH_ID = ub.BRANCH_ID
						WHERE u.BRANCH_ID IS NULL
					`);
					console.log('Migrated branch data to user_info');
				} catch (migrateErr) {
					console.log('Migration step skipped (user_branches might not exist):', migrateErr.message);
				}
			}
		} catch (error) {
			console.error('Failed to initialize BRANCH_ID in user_info:', error);
		}
	}

	// Get all branches for a user
	static async getBranchesByUserId(userId) {
		await BranchModel.ensureSchema();
		const query = `
			SELECT 
				b.IDNo,
				b.BRANCH_CODE,
				b.BRANCH_NAME,
				b.ADDRESS,
				b.PHONE,
				b.BRANCH_LOGO,
				b.MENU_CATEGORY_LEVEL,
				b.ACTIVE
			FROM user_info u
			INNER JOIN branches b ON b.IDNo = u.BRANCH_ID
			WHERE u.IDNo = ? AND b.ACTIVE = 1
			ORDER BY b.BRANCH_NAME ASC
		`;
		const [rows] = await pool.execute(query, [userId]);
		return rows;
	}

	// Get all users for a branch
	static async getUsersByBranchId(branchId) {
		const query = `
			SELECT 
				u.IDNo,
				u.USERNAME,
				u.FIRSTNAME,
				u.LASTNAME,
				u.PERMISSIONS,
				u.ACTIVE
			FROM user_info u
			WHERE u.BRANCH_ID = ? AND u.ACTIVE = 1
			ORDER BY u.USERNAME ASC
		`;
		const [rows] = await pool.execute(query, [branchId]);
		return rows;
	}

	// Check if user has access to branch
	static async hasAccess(userId, branchId) {
		const query = `
			SELECT COUNT(*) as count
			FROM user_info
			WHERE IDNo = ? AND BRANCH_ID = ?
		`;
		const [rows] = await pool.execute(query, [userId, branchId]);
		return rows[0].count > 0;
	}

	// Add user to branch
	static async addUserToBranch(userId, branchId) {
		const query = `
			UPDATE user_info 
			SET BRANCH_ID = ?
			WHERE IDNo = ?
		`;
		await pool.execute(query, [branchId, userId]);
		return true;
	}

	// Remove user from branch
	static async removeUserFromBranch(userId, branchId) {
		const query = `
			UPDATE user_info
			SET BRANCH_ID = NULL
			WHERE IDNo = ? AND BRANCH_ID = ?
		`;
		const [result] = await pool.execute(query, [userId, branchId]);
		return result.affectedRows > 0;
	}

	// Replace all branches for a user
	static async setUserBranches(userId, branchIds) {
		const branchId = (branchIds && branchIds.length > 0) ? branchIds[0] : null;
		const query = `
			UPDATE user_info
			SET BRANCH_ID = ?
			WHERE IDNo = ?
		`;
		await pool.execute(query, [branchId, userId]);
		
		return true;
	}

}

// Run initialization
UserBranchModel.initialize();

module.exports = UserBranchModel;

