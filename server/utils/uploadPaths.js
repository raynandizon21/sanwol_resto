// ============================================
// UPLOAD PATH HELPERS
// ============================================
// Centralizes upload subdirs and safe path checks so menu vs branch
// assets never overlap or delete each other's files.
// ============================================

const path = require('path');
const fs = require('fs').promises;

const UPLOAD_ROOT = path.join(__dirname, '../public/uploads');

/** Disk + URL subfolders under /uploads — keep menu and branches separate. */
const SUBDIRS = Object.freeze({
	MENU: 'menu',
	BRANCHES: 'branches',
	APP_RELEASES: 'app-releases',
});

/** Multipart field names — must match frontend FormData keys and route .single() */
const FIELDS = Object.freeze({
	MENU_IMG: 'MENU_IMG',
	BRANCH_LOGO: 'BRANCH_LOGO',
});

function publicUrl(subdir, filename) {
	return `/uploads/${subdir}/${filename}`;
}

/**
 * Turns a stored relative path (e.g. "/uploads/menu/some file, name.webp")
 * into a full, correctly percent-encoded URL the client can actually fetch.
 *
 * Some existing filenames on disk contain raw spaces/commas (from
 * AI-generated image names uploaded outside the sanitizing multer
 * filename() in middleware/upload.js). `baseUrl + relativePath` string
 * concatenation leaves those characters unencoded, which produces an
 * invalid URI — browsers/HTTP clients then fail to fetch the image at all.
 * The URL constructor percent-encodes the path correctly either way.
 */
function toPublicImageUrl(baseUrl, relativePath) {
	if (!relativePath) return null;
	if (relativePath.startsWith('http')) return relativePath;
	return new URL(relativePath, baseUrl).href;
}

function isPathInSubdir(relativePath, subdir) {
	if (!relativePath || typeof relativePath !== 'string') return false;
	const normalized = relativePath.replace(/^\/+/, '');
	return normalized.startsWith(`uploads/${subdir}/`);
}

function absolutePathFromPublic(relativePath, subdir) {
	if (!isPathInSubdir(relativePath, subdir)) return null;
	const normalized = relativePath.replace(/^\/+/, '');
	return path.join(__dirname, '../public', normalized);
}

async function safeDeletePublicFile(relativePath, subdir) {
	const absolute = absolutePathFromPublic(relativePath, subdir);
	if (!absolute) return;
	try {
		await fs.unlink(absolute);
	} catch {
		// ignore missing files
	}
}

module.exports = {
	UPLOAD_ROOT,
	SUBDIRS,
	FIELDS,
	publicUrl,
	toPublicImageUrl,
	isPathInSubdir,
	absolutePathFromPublic,
	safeDeletePublicFile,
};
