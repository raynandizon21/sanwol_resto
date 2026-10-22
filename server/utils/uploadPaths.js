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

/**
 * Origin the client used to reach the API (e.g. "http://45.32.103.210:3600").
 *
 * The Vite dev proxy rewrites Host to the Node API (localhost:2300), so
 * req.get('host') alone builds image URLs that only work on the server
 * itself. Prefer the X-Forwarded-* headers the proxy adds (xfwd: true in
 * vite.config.ts); PUBLIC_API_BASE_URL / PUBLIC_BASE_URL override both.
 */
function publicBaseUrl(req) {
	const envBase = process.env.PUBLIC_API_BASE_URL || process.env.PUBLIC_BASE_URL || '';
	if (envBase && String(envBase).trim()) return String(envBase).trim().replace(/\/+$/, '');

	const xfProto = req.get('x-forwarded-proto');
	const xfHost = req.get('x-forwarded-host');
	const xfPort = req.get('x-forwarded-port');

	let proto = (xfProto ? String(xfProto).split(',')[0].trim() : req.protocol) || 'http';
	let host = (xfHost ? String(xfHost).split(',')[0].trim() : req.get('host')) || '';

	// Some proxies set host without port, plus a separate x-forwarded-port.
	if (xfPort && host && !/:\d+$/.test(host)) {
		const port = String(xfPort).split(',')[0].trim();
		if (port && port !== '80' && port !== '443') host = `${host}:${port}`;
	}
	if (host.includes('resto-admin.3core21.com')) proto = 'https';
	return `${proto}://${host}`;
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
	publicBaseUrl,
	isPathInSubdir,
	absolutePathFromPublic,
	safeDeletePublicFile,
};
