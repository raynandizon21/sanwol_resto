const pool = require('../config/db');

class UserRoleModel {
    static async getAll(excludeAdmin = false) {
        let sql = 'SELECT * FROM user_role WHERE ACTIVE = 1';
        const params = [];
        if (excludeAdmin) {
            sql += ' AND IDNo <> 1'; // Assuming IDNo 1 is Administrator
        }
        const [rows] = await pool.execute(sql, params);
        return rows;
    }

    static async create(role, encodedBy) {
        const date_now = new Date();
        const query = `INSERT INTO user_role (ROLE, ENCODED_BY, ENCODED_DT) VALUES (?, ?, ?)`;
        const [result] = await pool.execute(query, [role, encodedBy, date_now]);
        return result.insertId;
    }

    static async update(id, role, editedBy) {
        const date_now = new Date();
        const query = `UPDATE user_role SET ROLE = ?, EDITED_BY = ?, EDITED_DT = ? WHERE IDNo = ?`;
        await pool.execute(query, [role, editedBy, date_now, id]);
    }

    static async archive(id, editedBy) {
        const date_now = new Date();
        const query = `UPDATE user_role SET ACTIVE = ?, EDITED_BY = ?, EDITED_DT = ? WHERE IDNo = ?`;
        await pool.execute(query, [0, editedBy, date_now, id]);
    }

    static async getAllActiveSummary() {
        const query = `
            SELECT IDNo, ROLE FROM user_role WHERE ACTIVE = 1 ORDER BY ROLE ASC
        `;
        const [rows] = await pool.execute(query);
        return rows;
    }
}

module.exports = UserRoleModel;
