// ============================================
// API RESPONSE HELPER
// ============================================
// File: utils/apiResponse.js
// Description: Standardized JSON response format for REST API
// ============================================

class ApiResponse {
	/**
	 * Success response
	 * @param {Object} res - Express response object
	 * @param {*} data - Response data
	 * @param {string} message - Success message
	 * @param {number} statusCode - HTTP status code (default: 200)
	 */
	static success(res, data = null, message = 'Success', statusCode = 200) {
		return res.status(statusCode).json({
			success: true,
			message,
			data
		});
	}

	/**
	 * Error response
	 * @param {Object} res - Express response object
	 * @param {string} message - Error message
	 * @param {number} statusCode - HTTP status code (default: 500)
	 * @param {*} details - Additional error details (for development)
	 */
	static error(res, message = 'An error occurred', statusCode = 500, details = null) {
		const response = {
			success: false,
			error: message
		};

		if (details && process.env.NODE_ENV === 'development') {
			response.details = details;
		}

		return res.status(statusCode).json(response);
	}

	/**
	 * Not found response
	 * @param {Object} res - Express response object
	 * @param {string} resource - Resource name (e.g., 'Order', 'Menu')
	 */
	static notFound(res, resource = 'Resource') {
		return res.status(404).json({
			success: false,
			error: `${resource} not found`
		});
	}

	/**
	 * Bad request response
	 * @param {Object} res - Express response object
	 * @param {string} message - Error message
	 */
	static badRequest(res, message = 'Bad request') {
		return res.status(400).json({
			success: false,
			error: message
		});
	}

	/**
	 * Unauthorized response
	 * @param {Object} res - Express response object
	 * @param {string} message - Error message
	 */
	static unauthorized(res, message = 'Unauthorized') {
		return res.status(401).json({
			success: false,
			error: message
		});
	}

	/**
	 * Forbidden response
	 * @param {Object} res - Express response object
	 * @param {string} message - Error message
	 */
	static forbidden(res, message = 'Forbidden') {
		return res.status(403).json({
			success: false,
			error: message
		});
	}

	/**
	 * Created response (for POST requests)
	 * @param {Object} res - Express response object
	 * @param {*} data - Created resource data
	 * @param {string} message - Success message
	 */
	static created(res, data = null, message = 'Resource created successfully') {
		return res.status(201).json({
			success: true,
			message,
			data
		});
	}

	/**
	 * No content response (for DELETE requests)
	 * @param {Object} res - Express response object
	 */
	static noContent(res) {
		return res.status(204).send();
	}
}

module.exports = ApiResponse;

