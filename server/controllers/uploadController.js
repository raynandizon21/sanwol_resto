// ============================================
// UPLOAD CONTROLLER
// ============================================
// File: controllers/uploadController.js
// Description: Handles generic file uploads
// ============================================

const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');
const ApiResponse = require('../utils/apiResponse');

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../public/uploads');
if (!require('fs').existsSync(uploadDir)) {
	require('fs').mkdirSync(uploadDir, { recursive: true });
}

// Configure storage for generic uploads
const storage = multer.diskStorage({
	destination: function (req, file, cb) {
		// Allow subdirectory in query param
		const subdir = req.query.subdir || 'general';
		const targetDir = path.join(uploadDir, subdir);
		if (!require('fs').existsSync(targetDir)) {
			require('fs').mkdirSync(targetDir, { recursive: true });
		}
		cb(null, targetDir);
	},
	filename: function (req, file, cb) {
		// Generate unique filename: timestamp-random-originalname
		const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
		const ext = path.extname(file.originalname);
		const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_');
		cb(null, name + '-' + uniqueSuffix + ext);
	}
});

// File filter - accept images and documents
const fileFilter = (req, file, cb) => {
	const allowedMimes = [
		'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
		'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
	];
	if (allowedMimes.includes(file.mimetype)) {
		cb(null, true);
	} else {
		cb(new Error('File type not allowed!'), false);
	}
};

// Configure multer
const upload = multer({
	storage: storage,
	limits: {
		fileSize: 10 * 1024 * 1024 // 10MB limit
	},
	fileFilter: fileFilter
});

class UploadController {
	// Generic file upload
	static async uploadFile(req, res) {
		try {
			if (!req.file) {
				return ApiResponse.badRequest(res, 'No file uploaded');
			}

			const baseUrl = req.protocol + '://' + req.get('host');
			const subdir = req.query.subdir || 'general';
			const fileUrl = `/uploads/${subdir}/${req.file.filename}`;
			const fullUrl = baseUrl + fileUrl;

			// Convert images to WebP if requested
			const convertToWebp = req.query.webp === 'true';
			if (convertToWebp && req.file.mimetype.startsWith('image/')) {
				try {
					const originalPath = req.file.path;
					const ext = path.extname(req.file.filename).toLowerCase();
					
					if (ext !== '.webp') {
						const webpFilename = req.file.filename.replace(new RegExp(ext + '$', 'i'), '.webp');
						const webpPath = path.join(path.dirname(originalPath), webpFilename);

						await sharp(originalPath)
							.webp({ quality: 85 })
							.toFile(webpPath);

						// Delete original file
						await fs.unlink(originalPath);

						const webpUrl = `/uploads/${subdir}/${webpFilename}`;
						const webpFullUrl = baseUrl + webpUrl;

						return ApiResponse.success(res, {
							url: webpFullUrl,
							filename: webpFilename,
							size: req.file.size,
							mimetype: 'image/webp',
							original_filename: req.file.originalname
						}, 'File uploaded and converted to WebP successfully');
					}
				} catch (webpError) {
					console.error('Error converting to WebP:', webpError);
					// Continue with original file if conversion fails
				}
			}

			return ApiResponse.success(res, {
				url: fullUrl,
				filename: req.file.filename,
				size: req.file.size,
				mimetype: req.file.mimetype,
				original_filename: req.file.originalname
			}, 'File uploaded successfully');
		} catch (error) {
			console.error('Error uploading file:', error);
			return ApiResponse.error(res, 'Failed to upload file', 500, error.message);
		}
	}
}

// Export controller and upload middleware
module.exports = {
	UploadController,
	uploadMiddleware: upload.single('file')
};

