const pool = require('../config/db');
const { isArgonHash, generateMD5 } = require('../utils/authUtils'); 
const argon2 = require('argon2');

class UserModel {
    static async findByUsername(username) {
        const query = `SELECT * FROM user_info
            WHERE USERNAME = ? AND ACTIVE = 1
            ORDER BY (PERMISSIONS = 1) DESC, IDNo DESC`;
        const [rows] = await pool.execute(query, [username]);
        return rows[0];
    }

    static async findAllByUsernameWithRole(username) {
        const query = `
            SELECT 
                u.*,
                ur.ROLE AS role
            FROM user_info u
            LEFT JOIN user_role ur ON ur.IDno = u.PERMISSIONS
            WHERE u.USERNAME = ? AND u.ACTIVE = 1
            ORDER BY (u.PERMISSIONS = 1) DESC, u.IDNo DESC
        `;
        const [rows] = await pool.execute(query, [username]);
        return rows;
    }

    static async findByUsernameWithRole(username) {
        const rows = await this.findAllByUsernameWithRole(username);
        return rows[0];
    }

    static async findById(id) {
        const query = 'SELECT * FROM user_info WHERE IDNo = ? AND ACTIVE = 1';
        const [rows] = await pool.execute(query, [id]);
        return rows[0];
    }

    static async findByIdWithRole(id) {
        const query = `
            SELECT 
                u.IDNo AS user_id,
                u.USERNAME AS username,
                u.FIRSTNAME AS firstname,
                u.LASTNAME AS lastname,
                u.PERMISSIONS AS permissions,
                u.BRANCH_ID AS branch_id,
                u.TABLE_ID AS table_id,
                ur.ROLE AS role
            FROM user_info u
            LEFT JOIN user_role ur ON ur.IDNo = u.PERMISSIONS
            WHERE u.IDNo = ? AND u.ACTIVE = 1
        `;
        const [rows] = await pool.execute(query, [id]);
        return rows[0];
    }

    static async findByEmail(email) {
        const query = 'SELECT * FROM user_info WHERE EMAIL = ? AND ACTIVE = 1';
        const [rows] = await pool.execute(query, [email]);
        return rows[0];
    }

    static async findByResetToken(token) {
        const query = 'SELECT * FROM user_info WHERE RESET_TOKEN = ? AND RESET_TOKEN_EXPIRY > NOW() AND ACTIVE = 1';
        const [rows] = await pool.execute(query, [token]);
        return rows[0];
    }

    static async getManagerUser() {
        const query = 'SELECT * FROM user_info WHERE PERMISSIONS = 1 AND ACTIVE = 1 LIMIT 1';
        const [rows] = await pool.execute(query);
        return rows[0];
    }

    static async updatePassword(id, newPasswordHash) {
        const query = `UPDATE user_info SET PASSWORD = ?, SALT = '' WHERE IDNo = ?`;
        await pool.execute(query, [newPasswordHash, id]);
    }

    static async updatePasswordAndClearResetToken(id, newPasswordHash) {
        const query = 'UPDATE user_info SET PASSWORD = ?, SALT = \'\' WHERE IDNo = ?';
        await pool.execute(query, [newPasswordHash, id]);
    }

    static async setResetToken(id, token, expiry) {
        const query = 'UPDATE user_info SET RESET_TOKEN = ?, RESET_TOKEN_EXPIRY = ? WHERE IDNo = ?';
        await pool.execute(query, [token, expiry, id]);
    }

    static async updateLastLogin(id) {
        const query = `UPDATE user_info SET LAST_LOGIN = ? WHERE IDNo = ?`;
        await pool.execute(query, [new Date(), id]);
    }

    static async verifyPassword(plainPassword, storedPassword, salt) {
        if (isArgonHash(storedPassword)) {
            return argon2.verify(storedPassword, plainPassword);
        } else {
            const hashedMD5 = generateMD5(salt + plainPassword);
            return (hashedMD5 === storedPassword);
        }
    }

    static async create(firstName, lastName, userName, password, salt, permissions, tableId, encodedBy) {
        const date_now = new Date();
        const hashedPassword = await argon2.hash(password);
        const query = `
            INSERT INTO user_info 
            (FIRSTNAME, LASTNAME, USERNAME, PASSWORD, SALT, PERMISSIONS, TABLE_ID, LAST_LOGIN, ENCODED_BY, ENCODED_DT) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const [result] = await pool.execute(query, [
            firstName, lastName, userName,
            hashedPassword, salt, permissions,
            tableId, date_now, encodedBy, date_now
        ]);
        return result.insertId;
    }

    static async update(id, firstName, lastName, userName, permissions, tableId, editedBy) {
        const date_now = new Date();
        const query = `
            UPDATE user_info 
            SET FIRSTNAME = ?, LASTNAME = ?, USERNAME = ?, PERMISSIONS = ?, TABLE_ID = ?, EDITED_BY = ?, EDITED_DT = ? 
            WHERE IDNo = ?
        `;
        await pool.execute(query, [
            firstName, lastName, userName,
            permissions, tableId, editedBy,
            date_now, id
        ]);
    }

    static async archive(id, editedBy) {
        const date_now = new Date();
        const query = `
            UPDATE user_info 
            SET ACTIVE = ?, TABLE_ID = NULL, EDITED_BY = ?, EDITED_DT = ? 
            WHERE IDNo = ?
        `;
        await pool.execute(query, [0, editedBy, date_now, id]);
    }

    static async updateBranch(userId, branchId) {
        const query = 'UPDATE user_info SET BRANCH_ID = ? WHERE IDNo = ?';
        await pool.execute(query, [branchId, userId]);
    }

    static async updateFloor(userId, floor) {
        const query = 'UPDATE user_info SET FLOOR = ? WHERE IDNo = ?';
        await pool.execute(query, [floor, userId]);
    }

    // Single-device-session enforcement for the mobile /api/login surface: a
    // login overwrites this, and authenticateJWT rejects any older token
    // whose sid no longer matches it.
    static async updateActiveSession(userId, sid) {
        const query = 'UPDATE user_info SET ACTIVE_SESSION_ID = ? WHERE IDNo = ?';
        await pool.execute(query, [sid, userId]);
    }

    static async getActiveSessionId(userId) {
        const [rows] = await pool.execute(
            'SELECT ACTIVE_SESSION_ID FROM user_info WHERE IDNo = ? LIMIT 1',
            [userId]
        );
        return rows.length > 0 ? rows[0].ACTIVE_SESSION_ID : null;
    }

    static async getBranchId(userId) {
        const [rows] = await pool.execute(
            'SELECT BRANCH_ID FROM user_info WHERE IDNo = ? LIMIT 1',
            [userId]
        );
        return rows.length > 0 ? rows[0].BRANCH_ID : null;
    }

    static async getAllUsersWithRoleAndBranch(currentBranchId = null) {
        let query = `
            SELECT 
                u.*,
                ur.ROLE AS role,
                u.IDNo AS user_id,
                rt.TABLE_NUMBER AS TABLE_NUMBER,
                CASE 
                    WHEN u.PERMISSIONS = 1 THEN 'ALL'
                    ELSE COALESCE(
                    NULLIF(b.BRANCH_NAME, ''),
                        '—'
                    )
                END AS BRANCH_LABEL
            FROM user_info u
            LEFT JOIN user_role ur ON ur.IDno = u.PERMISSIONS
            LEFT JOIN restaurant_tables rt ON rt.IDNo = u.TABLE_ID
            LEFT JOIN branches b ON b.IDNo = u.BRANCH_ID
            WHERE u.ACTIVE = 1
        `;

        const params = [];
        if (currentBranchId) {
            query += ` AND u.BRANCH_ID = ?`;
            params.push(parseInt(currentBranchId));
        }

        query += `
            ORDER BY u.LASTNAME ASC, u.FIRSTNAME ASC
        `;
        const [results] = await pool.execute(query, params);
        return results;
    }

    static async getNonAdminUsersWithRoleAndBranch(currentBranchId) {
        const query = `
            SELECT 
                u.*,
                ur.ROLE AS role,
                u.IDNo AS user_id,
                rt.TABLE_NUMBER AS TABLE_NUMBER,
                b.BRANCH_CODE AS BRANCH_CODE,
                b.BRANCH_NAME AS BRANCH_NAME
            FROM user_info u
            LEFT JOIN user_role ur ON ur.IDno = u.PERMISSIONS
            LEFT JOIN restaurant_tables rt ON rt.IDNo = u.TABLE_ID
            LEFT JOIN branches b ON b.IDNo = u.BRANCH_ID
            WHERE u.ACTIVE = 1 
              AND u.PERMISSIONS <> 1
              AND u.BRANCH_ID = ?
            ORDER BY u.LASTNAME ASC, u.FIRSTNAME ASC
        `;
        const [results] = await pool.execute(query, [parseInt(currentBranchId)]);
        return results;
    }

    static async isTableAssigned(tableId, excludeUserId = null) {
        let query = `SELECT IDNo FROM user_info WHERE TABLE_ID = ? AND ACTIVE = 1`;
        const params = [tableId];
        if (excludeUserId) {
            query += ` AND IDNo <> ?`;
            params.push(excludeUserId);
        }
        query += ` LIMIT 1`;
        const [existing] = await pool.execute(query, params);
        return existing.length > 0;
    }

    static async getAllActiveSummary() {
        const query = `
            SELECT IDNo, USERNAME, FIRSTNAME, LASTNAME, CONCAT(FIRSTNAME, ' ', LASTNAME) AS FULLNAME
            FROM user_info WHERE ACTIVE = 1 ORDER BY LASTNAME, FIRSTNAME ASC
        `;
        const [rows] = await pool.execute(query);
        return rows;
    }

    static async getActiveSummaryByBranch(branchId) {
        const query = `
            SELECT DISTINCT u.IDNo, u.USERNAME, u.FIRSTNAME, u.LASTNAME, CONCAT(u.FIRSTNAME, ' ', u.LASTNAME) AS FULLNAME
            FROM user_info u
            WHERE u.ACTIVE = 1 AND u.BRANCH_ID = ?
            ORDER BY u.LASTNAME, u.FIRSTNAME ASC
        `;
        const [rows] = await pool.execute(query, [branchId]);
        return rows;
    }

    static async getUserPermissions(userId) {
        const query = 'SELECT PERMISSIONS FROM user_info WHERE IDNo = ?';
        const [rows] = await pool.execute(query, [userId]);
        return rows.length > 0 ? rows[0].PERMISSIONS : null;
    }

    static async isUsernameExists(username) {
        const query = 'SELECT IDNo FROM user_info WHERE USERNAME = ? AND ACTIVE = 1 LIMIT 1';
        const [rows] = await pool.execute(query, [username]);
        return rows.length > 0;
    }
}

module.exports = UserModel;
