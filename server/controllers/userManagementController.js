const UserModel = require('../models/userModel');
const UserRoleModel = require('../models/userRoleModel');
const UserBranchModel = require('../models/userBranchModel');
const RoleCrudPermissionModel = require('../models/roleCrudPermissionModel');
const argon2 = require('argon2');

class UserManagementController {
    // Helper to determine if response should be JSON
    static isJsonRequest(req) {
        return req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1) || req.path.startsWith('/api/');
    }

    // --- User Role Management ---

    static async getUserRoleData(req, res) {
        try {
            const perm = parseInt(req.session?.permissions || req.user?.permissions);
            const results = await UserRoleModel.getAll(perm !== 1);
            res.json(results);
        } catch (error) {
            console.error('Error fetching role data:', error);
            res.status(500).send('Error fetching data');
        }
    }

    static async getRoles(req, res) {
        // Alias for API consistency
        return UserManagementController.getUserRoleData(req, res);
    }

    // --- Role CRUD Permissions (per-module add/edit/delete) ---

    static async getRoleCrudPermissions(req, res) {
        try {
            const roleId = parseInt(req.params.roleId);
            if (!roleId || Number.isNaN(roleId)) {
                return res.status(400).json({ success: false, error: 'Invalid role ID' });
            }

            const data = await RoleCrudPermissionModel.getByRoleId(roleId);
            return res.json({ success: true, data });
        } catch (error) {
            console.error('Error fetching role CRUD permissions:', error);
            return res.status(500).json({
                success: false,
                error: 'Error fetching role CRUD permissions',
            });
        }
    }

    static async updateRoleCrudPermissions(req, res) {
        try {
            const roleId = parseInt(req.params.roleId);
            if (!roleId || Number.isNaN(roleId)) {
                return res.status(400).json({ success: false, error: 'Invalid role ID' });
            }

            const permissions = req.body?.permissions || req.body;
            await RoleCrudPermissionModel.setForRole(roleId, permissions || {});

            return res.json({
                success: true,
                message: 'Role CRUD permissions updated successfully',
            });
        } catch (error) {
            console.error('Error updating role CRUD permissions:', error);
            return res.status(500).json({
                success: false,
                error: 'Error updating role CRUD permissions',
            });
        }
    }

    static async addUserRole(req, res) {
        try {
            const { role } = req.body;
            const userId = req.session?.user_id || req.user?.user_id;
            await UserRoleModel.create(role, userId);
            
            if (UserManagementController.isJsonRequest(req)) {
                res.json({ success: true, message: 'User role created successfully' });
            } else {
                res.redirect('/userRoles');
            }
        } catch (err) {
            console.error('Error inserting user role:', err);
            if (UserManagementController.isJsonRequest(req)) {
                res.status(500).json({ success: false, error: 'Error inserting user role' });
            } else {
                res.status(500).send('Error inserting user role');
            }
        }
    }

    static async createRole(req, res) {
        return UserManagementController.addUserRole(req, res);
    }

    static async updateUserRole(req, res) {
        try {
            const id = parseInt(req.params.id);
            const { role } = req.body;
            const userId = req.session?.user_id || req.user?.user_id;
            await UserRoleModel.update(id, role, userId);

            if (UserManagementController.isJsonRequest(req)) {
                res.json({ success: true, message: 'User role updated successfully' });
            } else {
                res.send('User role updated successfully');
            }
        } catch (err) {
            console.error('Error updating user role:', err);
            res.status(500).send('Error updating user role');
        }
    }

    static async updateRole(req, res) {
        return UserManagementController.updateUserRole(req, res);
    }

    static async archiveUserRole(req, res) {
        try {
            const id = parseInt(req.params.id);
            const userId = req.session?.user_id || req.user?.user_id;
            await UserRoleModel.archive(id, userId);

            if (UserManagementController.isJsonRequest(req)) {
                res.json({ success: true, message: 'User role archived successfully' });
            } else {
                res.send('User role archived successfully');
            }
        } catch (err) {
            console.error('Error archiving user role:', err);
            res.status(500).send('Error archiving user role');
        }
    }

    static async deleteRole(req, res) {
        return UserManagementController.archiveUserRole(req, res);
    }

    // --- User Management ---

    static async getUsers(req, res) {
        try {
            const perm = parseInt(req.session?.permissions || req.user?.permissions);
            
            // For admin (perm 1), only filter by branch if it's explicitly in the query
            // Otherwise, show all users. For non-admins, force their own branch.
            let currentBranchId = req.query.branch_id;
            if (perm !== 1) {
                currentBranchId = req.session?.branch_id || req.user?.branch_id;
            }

            let results;
            if (perm === 1) {
                results = await UserModel.getAllUsersWithRoleAndBranch(currentBranchId);
            } else {
                if (!currentBranchId) {
                    return res.json({ success: true, data: [] });
                }
                results = await UserModel.getNonAdminUsersWithRoleAndBranch(currentBranchId);
            }

            if (UserManagementController.isJsonRequest(req)) {
                res.json({ success: true, data: results });
            } else {
                res.json(results);
            }
        } catch (error) {
            console.error('Error fetching users:', error);
            res.status(500).send('Error fetching users');
        }
    }

    static async addUser(req, res) {
        try {
            const {
                txtFirstName, txtLastName, txtUserName,
                txtPassword, txtPassword2,
                user_role, table_id, salt, branch_id, floor
            } = req.body;

            if (txtPassword !== txtPassword2) {
                return res.status(400).json({ success: false, error: 'Passwords do not match' });
            }

            const roleId = parseInt(user_role);
            let tableIdToSave = null;
            const creatorPerm = parseInt(req.session?.permissions || req.user?.permissions);
            const creatorId = req.session?.user_id || req.user?.user_id;

            if (roleId === 1 && creatorPerm !== 1) {
                return res.status(403).json({ success: false, error: 'Only admin can create Administrator accounts.' });
            }

            if (roleId === 2) {
                if (!table_id) return res.status(400).json({ success: false, error: 'Table is required for this role.' });
                tableIdToSave = parseInt(table_id);
                if (await UserModel.isTableAssigned(tableIdToSave)) {
                    return res.status(400).json({ success: false, error: 'Selected table is already assigned to another user.' });
                }
            }

            const newUserId = await UserModel.create(
                txtFirstName, txtLastName, txtUserName,
                txtPassword, salt || '', roleId, tableIdToSave, creatorId
            );

            // Branch Assignment
            if (roleId === 1) {
                await UserModel.updateBranch(newUserId, null);
            } else {
                let targetBranchId = (creatorPerm === 1 && branch_id) 
                    ? parseInt(branch_id) 
                    : (req.session?.branch_id || req.user?.branch_id || await UserModel.getBranchId(creatorId));

                if (targetBranchId && !isNaN(targetBranchId)) {
                    await UserModel.updateBranch(newUserId, targetBranchId);
                }
            }

            await UserModel.updateFloor(newUserId, floor || null);

            // Always return JSON for API routes
            res.json({ success: true, message: 'User created successfully', data: { id: newUserId } });
        } catch (err) {
            console.error('Error inserting user:', err);
            if (UserManagementController.isJsonRequest(req)) {
                res.status(500).json({ success: false, error: 'Error inserting user' });
            } else {
                res.status(500).send('Error inserting user');
            }
        }
    }

    static async createUser(req, res) {
        return UserManagementController.addUser(req, res);
    }

    static async updateUser(req, res) {
        try {
            const id = parseInt(req.params.id);
            const {
                txtFirstName, txtLastName, txtUserName,
                txtPassword, txtPassword2,
                user_role, table_id, branch_id, floor
            } = req.body;

            const roleId = parseInt(user_role);
            let tableIdToSave = null;
            const creatorId = req.session?.user_id || req.user?.user_id;
            const creatorPerm = parseInt(req.session?.permissions || req.user?.permissions);

            if (roleId === 2) {
                if (!table_id) return res.status(400).json({ success: false, error: 'Table is required for this role.' });
                tableIdToSave = parseInt(table_id);
                if (await UserModel.isTableAssigned(tableIdToSave, id)) {
                    return res.status(400).json({ success: false, error: 'Selected table is already assigned to another user.' });
                }
            }

            await UserModel.update(id, txtFirstName, txtLastName, txtUserName, roleId, tableIdToSave, creatorId);

            // Update Password if provided
            if (txtPassword && txtPassword === txtPassword2) {
                const hashedPassword = await argon2.hash(txtPassword);
                await UserModel.updatePassword(id, hashedPassword);
            } else if (txtPassword && txtPassword !== txtPassword2) {
                return res.status(400).json({ success: false, error: 'Passwords do not match' });
            }

            // Update Branch if creator is admin and branch_id is provided
            if (creatorPerm === 1 && branch_id !== undefined) {
                const targetBranchId = roleId === 1 ? null : (branch_id ? parseInt(branch_id) : null);
                await UserModel.updateBranch(id, targetBranchId);
            }

            if (floor !== undefined) {
                await UserModel.updateFloor(id, floor || null);
            }

            // Always return JSON for API routes
            res.json({ success: true, message: 'User updated successfully' });
        } catch (err) {
            console.error('Error updating user:', err);
            res.status(500).json({ success: false, error: 'Error updating user' });
        }
    }

    static async archiveUser(req, res) {
        try {
            const id = parseInt(req.params.id);
            const creatorId = req.session?.user_id || req.user?.user_id;
            await UserModel.archive(id, creatorId);

            if (UserManagementController.isJsonRequest(req)) {
                res.json({ success: true, message: 'User archived successfully' });
            } else {
                res.send('User archived successfully');
            }
        } catch (err) {
            console.error('Error archiving user:', err);
            res.status(500).send('Error archiving user');
        }
    }

    static async deleteUser(req, res) {
        return UserManagementController.archiveUser(req, res);
    }
}

module.exports = UserManagementController;
