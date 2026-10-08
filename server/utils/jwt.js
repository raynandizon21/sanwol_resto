// ============================================
// JWT UTILITY
// ============================================
// File: utils/jwt.js
// Description: JWT token generation and verification utilities
// ============================================

const jwt = require('jsonwebtoken');

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_change_in_production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your_jwt_refresh_secret_key_change_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h'; // Access token expires in 15 minutes
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d'; // Refresh token expires in 7 days

/**
 * Generate access token (short-lived)
 * @param {Object} payload - User data to encode in token
 * @returns {String} JWT access token
 */
function generateAccessToken(payload) {
	return jwt.sign(
		{
			user_id: payload.user_id,
			username: payload.username,
			permissions: payload.permissions,
			firstname: payload.firstname || null,
			lastname: payload.lastname || null,
			branch_id: payload.branch_id || null,
			branch_name: payload.branch_name || null,
			branch_code: payload.branch_code || null,
			sid: payload.sid || null,
			type: 'access'
		},
		JWT_SECRET,
		{
			expiresIn: JWT_EXPIRES_IN,
			issuer: 'restaurant-admin',
			audience: 'restaurant-app'
		}
	);
}

/**
 * Generate refresh token (long-lived)
 * @param {Object} payload - User data to encode in token
 * @returns {String} JWT refresh token
 */
function generateRefreshToken(payload) {
	return jwt.sign(
		{
			user_id: payload.user_id,
			username: payload.username,
			sid: payload.sid || null,
			type: 'refresh'
		},
		JWT_REFRESH_SECRET,
		{
			expiresIn: JWT_REFRESH_EXPIRES_IN,
			issuer: 'restaurant-admin',
			audience: 'restaurant-app'
		}
	);
}

/**
 * Generate both access and refresh tokens
 * @param {Object} payload - User data to encode in tokens
 * @returns {Object} Object containing accessToken and refreshToken
 */
function generateTokenPair(payload) {
	return {
		accessToken: generateAccessToken(payload),
		refreshToken: generateRefreshToken(payload),
		expiresIn: JWT_EXPIRES_IN
	};
}

/**
 * Verify access token
 * @param {String} token - JWT access token
 * @returns {Object} Decoded token payload or null if invalid
 */
function verifyAccessToken(token) {
	try {
		return jwt.verify(token, JWT_SECRET, {
			issuer: 'restaurant-admin',
			audience: 'restaurant-app'
		});
	} catch (error) {
		if (error.name === 'TokenExpiredError') {
			throw new Error('Token expired');
		} else if (error.name === 'JsonWebTokenError') {
			throw new Error('Invalid token');
		} else {
			throw new Error('Token verification failed');
		}
	}
}

/**
 * Verify refresh token
 * @param {String} token - JWT refresh token
 * @returns {Object} Decoded token payload or null if invalid
 */
function verifyRefreshToken(token) {
	try {
		return jwt.verify(token, JWT_REFRESH_SECRET, {
			issuer: 'restaurant-admin',
			audience: 'restaurant-app'
		});
	} catch (error) {
		if (error.name === 'TokenExpiredError') {
			throw new Error('Refresh token expired');
		} else if (error.name === 'JsonWebTokenError') {
			throw new Error('Invalid refresh token');
		} else {
			throw new Error('Refresh token verification failed');
		}
	}
}

/**
 * Decode token without verification (for debugging)
 * @param {String} token - JWT token
 * @returns {Object} Decoded token payload
 */
function decodeToken(token) {
	return jwt.decode(token);
}

module.exports = {
	generateAccessToken,
	generateRefreshToken,
	generateTokenPair,
	verifyAccessToken,
	verifyRefreshToken,
	decodeToken,
	JWT_EXPIRES_IN
};

