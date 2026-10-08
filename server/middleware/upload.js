// ============================================
// UPLOAD MIDDLEWARE
// ============================================
// Menu images  -> public/uploads/menu/     (field: MENU_IMG)
// Branch logos -> public/uploads/branches/ (field: BRANCH_LOGO)
// Each has its own multer instance + WebP converter scoped to that folder.
// ============================================

const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');
const { SUBDIRS, FIELDS } = require('../utils/uploadPaths');

function ensureUploadDir(subdir) {
	const dir = path.join(__dirname, '../public/uploads', subdir);
	if (!require('fs').existsSync(dir)) {
		require('fs').mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function createImageStorage(subdir) {
	const uploadDir = ensureUploadDir(subdir);
	return multer.diskStorage({
		destination: function (req, file, cb) {
			cb(null, uploadDir);
		},
		filename: function (req, file, cb) {
			const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
			const ext = path.extname(file.originalname);
			const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_');
			cb(null, name + '-' + uniqueSuffix + ext);
		},
	});
}

const fileFilter = (req, file, cb) => {
	if (file.mimetype.startsWith('image/')) {
		cb(null, true);
	} else {
		cb(new Error('Only image files are allowed!'), false);
	}
};

const multerOptions = {
	limits: { fileSize: 5 * 1024 * 1024 },
	fileFilter,
};

/** Menu item images only — never writes to branches/ */
const menuUpload = multer({
	storage: createImageStorage(SUBDIRS.MENU),
	...multerOptions,
});

/** Branch logos only — never writes to menu/ */
const branchUpload = multer({
	storage: createImageStorage(SUBDIRS.BRANCHES),
	...multerOptions,
});

/**
 * WebP conversion locked to one subdir so menu/branch pipelines cannot cross-convert.
 */
function createConvertToWebp(expectedSubdir) {
	return async function convertToWebp(req, res, next) {
		if (!req.file) {
			return next();
		}

		const fileSubdir = path.basename(path.dirname(req.file.path));
		if (fileSubdir !== expectedSubdir) {
			console.error(
				`[upload] Blocked WebP conversion: file in "${fileSubdir}", expected "${expectedSubdir}"`
			);
			try {
				await fs.unlink(req.file.path);
			} catch {
				// ignore
			}
			return next(new Error(`Upload must be saved under uploads/${expectedSubdir}`));
		}

		try {
			const originalPath = req.file.path;
			const uploadDir = path.dirname(originalPath);
			const ext = path.extname(req.file.filename).toLowerCase();

			if (ext === '.webp') {
				return next();
			}

			const webpFilename = req.file.filename.replace(new RegExp(ext + '$', 'i'), '.webp');
			const webpPath = path.join(uploadDir, webpFilename);

			await sharp(originalPath).webp({ quality: 85 }).toFile(webpPath);
			await fs.unlink(originalPath);

			req.file.filename = webpFilename;
			req.file.path = webpPath;
			req.file.mimetype = 'image/webp';

			next();
		} catch (error) {
			console.error(`[upload] WebP conversion failed (${expectedSubdir}):`, error);
			next();
		}
	};
}

const convertMenuToWebp = createConvertToWebp(SUBDIRS.MENU);
const convertBranchToWebp = createConvertToWebp(SUBDIRS.BRANCHES);

module.exports = {
	SUBDIRS,
	FIELDS,
	menuUpload,
	branchUpload,
	convertMenuToWebp,
	convertBranchToWebp,
	/** @deprecated Use menuUpload — kept so existing menu routes keep working */
	upload: menuUpload,
	/** @deprecated Use convertMenuToWebp — branch routes must use convertBranchToWebp */
	convertToWebp: convertMenuToWebp,
};
