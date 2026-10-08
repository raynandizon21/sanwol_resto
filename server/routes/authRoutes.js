const express = require('express');
const router = express.Router();
const argon2 = require('argon2');
const { generateTokenPair } = require('../utils/jwt');
const { authenticate, optionalAuthenticate } = require('../middleware/unifiedAuth');
const UserModel = require('../models/userModel');
const UserBranchModel = require('../models/userBranchModel');
const BranchModel = require('../models/branchModel');
const { isArgonHash, generateMD5 } = require('../utils/authUtils');
const crypto = require('crypto');

// Middleware to check session
const checkSession = (req, res, next) => {
    if (!req.session || !req.session.username) {
        res.redirect('/login');
    } else {
        next();
    }
};

const wantsJson = (req) => {
  const accept = req.headers.accept || '';
  const contentType = req.headers['content-type'] || '';
  return req.xhr
    || accept.includes('application/json')
    || contentType.includes('application/json')
    || req.headers['x-requested-with'] === 'XMLHttpRequest';
};
function sessions(req, page) {
	return {
		username: req.session.username,
		firstname: req.session.firstname,
			lastname: req.session.lastname,
		user_id: req.session.user_id,
		currentPage: page
	};
}

// Get current user (JWT or session) - for SPA refresh persistence. Returns 200 with data: null when not logged in (avoids 401 in console).
router.get('/me', optionalAuthenticate, (req, res) => {
  if (!req.user) {
    return res.json({ success: true, data: null });
  }
  const u = req.user;
  return res.json({
    success: true,
    data: {
      user_id: u.user_id,
      username: u.username || '',
      firstname: u.firstname || null,
      lastname: u.lastname || null,
      permissions: u.permissions,
      branch_id: u.branch_id || null,
      branch_name: req.session?.branch_name || null,
      branch_code: req.session?.branch_code || null
    }
  });
});

// Login route
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
  
    const safeRedirectWithError = (msg) => {
      if (wantsJson(req)) {
        return res.status(401).json({ success: false, error: msg });
      }
      if (req.session) {
        req.flash('error', msg);
        return res.redirect('/login');
      }
      return res.redirect('/login?error=' + encodeURIComponent(msg));
    };
  
    try {
      const user = await UserModel.findByUsername(username);
  
      if (user) {
        const storedPassword = user.PASSWORD;
        const salt = user.SALT;
  
        let isValid = false;
        let isLegacy = false;
  
        if (isArgonHash(storedPassword)) {
          isValid = await argon2.verify(storedPassword, password);
        } else {
          const hashedMD5 = generateMD5(salt + password);
          isValid = (hashedMD5 === storedPassword);
          isLegacy = true;
        }
  
        if (isValid) {
          if (user.PERMISSIONS === 2) {
            return safeRedirectWithError('This account is for tablet app only. Please use the tablet application to login.');
          }

          if (isLegacy) {
            const newHash = await argon2.hash(password);
            await UserModel.updatePassword(user.IDNo, newHash);
          }
  
          req.session.username = username;
          req.session.firstname = user.FIRSTNAME;
          req.session.lastname = user.LASTNAME;
          req.session.user_id = user.IDNo;
          req.session.permissions = user.PERMISSIONS;
          
          let userBranches = [];
          try {
            if (user.PERMISSIONS === 1) {
              userBranches = await BranchModel.getAllActive();
            } else {
              userBranches = await UserBranchModel.getBranchesByUserId(user.IDNo);
            }
            
            if (user.PERMISSIONS === 1) {
              req.session.branch_id = null;
              req.session.branch_name = null;
              req.session.branch_code = null;
              req.session.available_branches = userBranches;
            } else {
              if (userBranches.length !== 1) {
                const msg = 'This account is not assigned to a branch yet (or has multiple branches). Please contact admin.';
                if (req.session) {
                  return req.session.destroy(() => res.redirect('/login?error=' + encodeURIComponent(msg)));
                }
                return res.redirect('/login?error=' + encodeURIComponent(msg));
              }
              req.session.branch_id = userBranches[0].IDNo;
              req.session.branch_name = userBranches[0].BRANCH_NAME;
              req.session.branch_code = userBranches[0].BRANCH_CODE;
            }
          } catch (branchError) {
            console.error('Error getting user branches during login:', branchError);
          }

          if (!req.session) {
            return res.redirect('/login?error=' + encodeURIComponent('Session error, please try again.'));
          }
  
          req.session.save(err => {
            if (err) {
              return safeRedirectWithError('Session error, please try again.');
            }

            if (wantsJson(req)) {
              const tokenPayload = {
                user_id: req.session.user_id,
                username: req.session.username,
                permissions: req.session.permissions,
                firstname: req.session.firstname || null,
                lastname: req.session.lastname || null,
                branch_id: req.session.branch_id || null
              };
              const tokens = generateTokenPair(tokenPayload);
              return res.json({
                success: true,
                data: {
                  user_id: req.session.user_id,
                  username: req.session.username,
                  firstname: req.session.firstname,
                  lastname: req.session.lastname,
                  permissions: req.session.permissions,
                  branch_id: req.session.branch_id || null,
                  branch_name: req.session.branch_name || null,
                  branch_code: req.session.branch_code || null,
                  available_branches: req.session.available_branches || []
                },
                tokens: {
                  accessToken: tokens.accessToken,
                  expiresIn: tokens.expiresIn
                }
              });
            }

            return res.redirect('/dashboard');
          });
        } else {
          return safeRedirectWithError('Incorrect password');
        }
      } else {
        return safeRedirectWithError('User not found or inactive');
      }
    } catch (error) {
      console.error('Login error:', error);
      return safeRedirectWithError('Internal server error');
    }
  });
  
// Verify Password route using async/await
router.post('/verify-password', async (req, res) => {
    try {
      const { password } = req.body;
      // Assuming there's a way to get the manager's ID or username, e.g., from session or config
      // For now, let's assume a manager with PERMISSIONS = 1 exists and we need to verify against them.
      // This query might need to be refined based on how you identify the manager.
      const manager = await UserModel.getManagerUser(); // A new method in UserModel to fetch manager
      
      if (manager) {
        const salt = manager.SALT;
        // Directly use UserModel's verifyPassword method
        const isValid = await UserModel.verifyPassword(password, manager.PASSWORD, salt);
        
        if (isValid) {
          return res.json({ permissions: manager.PERMISSIONS });
        } else {
          return res.status(403).json({ message: 'Incorrect password' });
        }
      } else {
        return res.status(404).json({ message: 'Manager not found' });
      }
    } catch (error) {
      console.error('Error during password verification: ' + error.stack);
      return res.status(500).json({ message: 'Error during password verification' });
    }
  });

// Check Permission route
router.post('/check-permission', (req, res) => {
    if (!req.session.permissions) {
        return res.status(401).json({ message: 'Not logged in' });
    }
    if (req.session.permissions === 1) {
        return res.json({ permissions: 1 });
    } else {
        return res.json({ permissions: req.session.permissions });
    }
});

// Logout route
router.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Password Reset - Forgot Password
router.post('/auth/forgot-password', async (req, res) => {
	try {
		const { email, username } = req.body;

		if (!email && !username) {
			if (wantsJson(req)) {
				return res.status(400).json({ success: false, error: 'Email or username is required' });
			}
			return res.status(400).send('Email or username is required');
		}

		let user = null;
		if (email) {
			user = await UserModel.findByEmail(email); // Assuming findByEmail method exists in UserModel
		} else {
			user = await UserModel.findByUsername(username);
		}

		if (!user) {
			if (wantsJson(req)) {
				return res.status(404).json({ success: false, error: 'User not found' });
			}
			return res.status(404).send('User not found');
		}

		const resetToken = crypto.randomBytes(32).toString('hex');
		const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now

		try {
			await UserModel.setResetToken(user.IDNo, resetToken, resetTokenExpiry);
		} catch (err) {
			console.log('Reset token columns may not exist, skipping token storage');
		}

		if (wantsJson(req)) {
			return res.json({
				success: true,
				message: 'Password reset instructions sent (if email exists)',
				reset_token: resetToken // REMOVE IN PRODUCTION - only for testing
			});
		}
		return res.send('Password reset instructions sent (if email exists)');
	} catch (error) {
		console.error('Error processing forgot password:', error);
		if (wantsJson(req)) {
			return res.status(500).json({ success: false, error: 'Internal server error' });
		}
		return res.status(500).send('Internal server error');
	}
});

// Password Reset - Reset Password
router.post('/auth/reset-password', async (req, res) => {
	try {
		const { token, new_password, confirm_password } = req.body;

		if (!token || !new_password || !confirm_password) {
			if (wantsJson(req)) {
				return res.status(400).json({ success: false, error: 'Token, new password, and confirm password are required' });
			}
			return res.status(400).send('Token, new password, and confirm password are required');
		}

		if (new_password !== confirm_password) {
			if (wantsJson(req)) {
				return res.status(400).json({ success: false, error: 'Passwords do not match' });
			}
			return res.status(400).send('Passwords do not match');
		}

		const user = await UserModel.findByResetToken(token);

		if (!user) {
			if (wantsJson(req)) {
				return res.status(400).json({ success: false, error: 'Invalid or expired reset token' });
			}
			return res.status(400).send('Invalid or expired reset token');
		}

		const hashedPassword = await argon2.hash(new_password);

		try {
			await UserModel.updatePasswordAndClearResetToken(user.IDNo, hashedPassword);
		} catch (err) {
			await UserModel.updatePassword(user.IDNo, hashedPassword);
		}

		if (wantsJson(req)) {
			return res.json({ success: true, message: 'Password reset successfully' });
		}
		return res.send('Password reset successfully');
	} catch (error) {
		console.error('Error resetting password:', error);
		if (wantsJson(req)) {
			return res.status(500).json({ success: false, error: 'Internal server error' });
		}
		return res.status(500).send('Internal server error');
	}
});

module.exports = {
    router,
    checkSession,
    sessions
  };
