// ============================================
// RECEIPT SCAN HISTORY CONTROLLER
// ============================================

const ReceiptScanHistoryModel = require('../models/receiptScanHistoryModel');
const UserBranchModel = require('../models/userBranchModel');
const ApiResponse = require('../utils/apiResponse');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;

function dataUrlToBufferAndMime(dataUrl) {
	if (dataUrl == null || typeof dataUrl !== 'string') return { buffer: null, mime: null };
	const s = dataUrl.trim();
	const m = s.match(/^data:([^;]+);base64,(.+)$/is);
	if (!m) return { buffer: null, mime: null };
	try {
		const buffer = Buffer.from(m[2], 'base64');
		if (!buffer.length) return { buffer: null, mime: m[1] };
		return { buffer, mime: m[1] };
	} catch {
		return { buffer: null, mime: null };
	}
}

function bufferToDataUrl(buffer, mime) {
	if (!buffer || !Buffer.isBuffer(buffer)) return null;
	const m = mime && String(mime).trim() ? String(mime).trim() : 'image/jpeg';
	return `data:${m};base64,${buffer.toString('base64')}`;
}

async function ensureDir(p) {
	try {
		await fs.mkdir(p, { recursive: true });
	} catch {}
}

async function saveWebpToUploads(buffer) {
	if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
	const dir = path.join(__dirname, '../public/uploads/receipt-scan-history');
	await ensureDir(dir);
	const name = `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.webp`;
	const abs = path.join(dir, name);
	await fs.writeFile(abs, buffer);
	return `/uploads/receipt-scan-history/${name}`;
}

function getPublicBaseUrl(req) {
	const envBase = process.env.PUBLIC_API_BASE_URL || process.env.PUBLIC_BASE_URL || '';
	if (envBase && String(envBase).trim()) return String(envBase).trim().replace(/\/+$/, '');

	// Prefer forwarded headers when behind a reverse proxy.
	const xfProto = req.get('x-forwarded-proto');
	const xfHost = req.get('x-forwarded-host');
	const xfPort = req.get('x-forwarded-port');

	const proto = (xfProto ? String(xfProto).split(',')[0].trim() : req.protocol) || 'http';
	let host = (xfHost ? String(xfHost).split(',')[0].trim() : req.get('host')) || '';

	// Some proxies set host without port, plus a separate x-forwarded-port.
	if (xfPort && host && !/:\d+$/.test(host)) {
		const port = String(xfPort).split(',')[0].trim();
		if (port && port !== '80' && port !== '443') host = `${host}:${port}`;
	}
	return `${proto}://${host}`;
}

function toPublicReceiptUrl(req, receiptImageValue) {
	if (receiptImageValue == null) return null;
	const raw = String(receiptImageValue).trim();
	if (!raw) return null;

	// Already absolute.
	if (/^https?:\/\//i.test(raw)) return raw;

	// If we stored a local uploads path, prefer returning a relative URL so the frontend can
	// fetch it via its `/uploads` proxy (avoids localhost loopback / PNA blocks in browsers).
	if (raw.startsWith('/uploads/')) return raw;

	// Other relative paths: make absolute based on public base.
	const baseUrl = getPublicBaseUrl(req);
	return raw.startsWith('/') ? baseUrl + raw : `${baseUrl}/${raw}`;
}

class ReceiptScanHistoryController {
	static _bundleFromRow(row) {
		if (!row) return null;
		const baseUrl = row._baseUrl || null;
		const imageDataUrl = row.RECEIPT_IMAGE
			? (String(row.RECEIPT_IMAGE).startsWith('http')
					? String(row.RECEIPT_IMAGE)
					: baseUrl
						? baseUrl + String(row.RECEIPT_IMAGE)
						: String(row.RECEIPT_IMAGE))
			: null;
		return { imageDataUrl };
	}

	static async list(req, res) {
		try {
			const isAdmin = req.user?.permissions === 1 || req.session?.permissions === 1;
			const userId = req.session?.user_id || req.user?.user_id || null;
			const qBranch = req.query.branch_id ?? req.query.BRANCH_ID ?? null;

			let branchId = null;
			if (qBranch != null && String(qBranch).trim() !== '' && String(qBranch) !== 'all') {
				branchId = String(qBranch).trim();
			} else if (!isAdmin) {
				branchId = req.session?.branch_id ?? req.user?.branch_id ?? null;
				if (!branchId && userId) {
					const branches = await UserBranchModel.getBranchesByUserId(userId);
					if (branches?.[0]?.IDNo) branchId = String(branches[0].IDNo);
				}
			} else if (String(qBranch) === 'all') {
				branchId = null;
			}

			if (!isAdmin && branchId) {
				const branches = userId ? await UserBranchModel.getBranchesByUserId(userId) : [];
				const allowed = Array.isArray(branches) && branches.some((b) => String(b?.IDNo) === String(branchId));
				if (!allowed) {
					return ApiResponse.forbidden(res, 'Not allowed for this branch');
				}
			}

			if (!isAdmin && !branchId) {
				return ApiResponse.badRequest(res, 'Branch is required');
			}

			const limit = parseInt(req.query.limit, 10) || 100;
			const offset = parseInt(req.query.offset, 10) || 0;
			const sourcesRaw = req.query.sources ?? req.query.SOURCES ?? '';
			const sources = String(sourcesRaw)
				.split(',')
				.map((s) => String(s).trim().toLowerCase().replace(/\s+/g, '_'))
				.filter(Boolean);
			const listOptions = sources.length ? { sources } : {};
			const rows = await ReceiptScanHistoryModel.list(branchId, limit, offset, listOptions);
			return ApiResponse.success(res, rows, 'Receipt scan history');
		} catch (error) {
			console.error('receiptScanHistory list:', error);
			return ApiResponse.error(res, 'Failed to load receipt scan history', 500, error.message);
		}
	}

	static async getById(req, res) {
		try {
			const id = req.params.id;
			const row = await ReceiptScanHistoryModel.getById(id);
			if (!row) return ApiResponse.notFound(res, 'Receipt scan record');

			const isAdmin = req.user?.permissions === 1 || req.session?.permissions === 1;
			const userId = req.session?.user_id || req.user?.user_id || null;
			if (!isAdmin) {
				const sessionBranch = req.session?.branch_id ?? req.user?.branch_id ?? null;
				const sameSession = sessionBranch != null && String(row.BRANCH_ID) === String(sessionBranch);
				let allowed = sameSession;
				if (!allowed && userId) {
					const branches = await UserBranchModel.getBranchesByUserId(userId);
					allowed = Array.isArray(branches) && branches.some((b) => String(b?.IDNo) === String(row.BRANCH_ID));
				}
				if (!allowed) return ApiResponse.forbidden(res, 'Not allowed');
			}

			const baseUrl = getPublicBaseUrl(req);
			const bundle = await ReceiptScanHistoryModel.getOrderBundleByReceiptImage(row.RECEIPT_IMAGE);
			const itemsByOrderId = new Map();
			for (const it of bundle.items || []) {
				const oid = it?.ORDER_ID != null ? Number(it.ORDER_ID) : null;
				if (!oid) continue;
				if (!itemsByOrderId.has(oid)) itemsByOrderId.set(oid, []);
				itemsByOrderId.get(oid).push(it);
			}
			let orders = (bundle.orders || []).map((o) => ({
				...o,
				items: itemsByOrderId.get(Number(o.ORDER_ID)) || [],
			}));
			// IMPORTANT: show only the clicked order in detail (even if same receipt image is shared).
			if (row.ORDER_ID != null) {
				const clickedId = Number(row.ORDER_ID);
				orders = orders.filter((o) => Number(o?.ORDER_ID) === clickedId);
			}

			const imageDataUrl = toPublicReceiptUrl(req, row.RECEIPT_IMAGE);

			const { RECEIPT_IMAGE, ...rest } = row;
			return ApiResponse.success(
				res,
				{
					...rest,
					receipt_image_data_url: imageDataUrl,
					orders,
				},
				'OK'
			);
		} catch (error) {
			console.error('receiptScanHistory getById:', error);
			return ApiResponse.error(res, 'Failed to load record', 500, error.message);
		}
	}

	static async getLatestByOrderId(req, res) {
		try {
			const orderId = req.params.orderId;
			const row = await ReceiptScanHistoryModel.getLatestByOrderId(orderId);
			// For billing UI: "no receipt" is a valid state, not an error.
			if (!row) {
				return ApiResponse.success(
					res,
					{
						ORDER_ID: orderId != null && String(orderId).trim() !== '' ? Number(orderId) : null,
						receipt_image_data_url: null,
						orders: [],
					},
					'No receipt image'
				);
			}

			const isAdmin = req.user?.permissions === 1 || req.session?.permissions === 1;
			const userId = req.session?.user_id || req.user?.user_id || null;
			if (!isAdmin) {
				const sessionBranch = req.session?.branch_id ?? req.user?.branch_id ?? null;
				const sameSession = sessionBranch != null && String(row.BRANCH_ID) === String(sessionBranch);
				let allowed = sameSession;
				if (!allowed && userId) {
					const branches = await UserBranchModel.getBranchesByUserId(userId);
					allowed = Array.isArray(branches) && branches.some((b) => String(b?.IDNo) === String(row.BRANCH_ID));
				}
				if (!allowed) return ApiResponse.forbidden(res, 'Not allowed');
			}

			const baseUrl = getPublicBaseUrl(req);
			const bundle = await ReceiptScanHistoryModel.getOrderBundleByReceiptImage(row.RECEIPT_IMAGE);
			const itemsByOrderId = new Map();
			for (const it of bundle.items || []) {
				const oid = it?.ORDER_ID != null ? Number(it.ORDER_ID) : null;
				if (!oid) continue;
				if (!itemsByOrderId.has(oid)) itemsByOrderId.set(oid, []);
				itemsByOrderId.get(oid).push(it);
			}
			let orders = (bundle.orders || []).map((o) => ({
				...o,
				items: itemsByOrderId.get(Number(o.ORDER_ID)) || [],
			}));
			// IMPORTANT: show only the requested order in detail (even if same receipt image is shared).
			const requestedId = orderId != null && String(orderId).trim() !== '' ? Number(orderId) : NaN;
			if (Number.isFinite(requestedId)) {
				orders = orders.filter((o) => Number(o?.ORDER_ID) === requestedId);
			}

			const imageDataUrl = toPublicReceiptUrl(req, row.RECEIPT_IMAGE);
			const { RECEIPT_IMAGE, ...rest } = row;
			return ApiResponse.success(
				res,
				{
					...rest,
					receipt_image_data_url: imageDataUrl,
					orders,
				},
				'OK'
			);
		} catch (error) {
			console.error('receiptScanHistory getLatestByOrderId:', error);
			return ApiResponse.error(res, 'Failed to load record', 500, error.message);
		}
	}

	static async create(req, res) {
		try {
			const isAdmin = req.user?.permissions === 1 || req.session?.permissions === 1;
			const userId = req.session?.user_id || req.user?.user_id || null;

			const bodyBranch =
				req.body?.BRANCH_ID ?? req.body?.branch_id ?? req.session?.branch_id ?? req.user?.branch_id ?? null;
			let branchId = bodyBranch != null && String(bodyBranch).trim() !== '' ? String(bodyBranch).trim() : null;

			if (!branchId || branchId === 'all') {
				return ApiResponse.badRequest(res, 'branch_id is required');
			}

			if (!isAdmin && userId) {
				const branches = await UserBranchModel.getBranchesByUserId(userId);
				const allowed = Array.isArray(branches) && branches.some((b) => String(b?.IDNo) === String(branchId));
				if (!allowed) {
					return ApiResponse.forbidden(res, 'Not allowed for this branch');
				}
			}

			const receiptImagePathRaw = req.body.receipt_image_path ?? req.body.receipt_image_url ?? null;
			const receiptImagePath =
				receiptImagePathRaw != null && String(receiptImagePathRaw).trim() !== ''
					? String(receiptImagePathRaw).trim()
					: null;

			const receiptImageInput = req.body.receipt_image_data_url ?? req.body.receipt_image ?? null;
			const { buffer: receiptImageBuffer, mime: receiptImageMime } = dataUrlToBufferAndMime(
				typeof receiptImageInput === 'string' ? receiptImageInput : null
			);
			let receipt_image = null;
			let image_mime = null;
			// Prefer reusing an existing uploaded path (avoid duplicate uploads).
			if (receiptImagePath && /^\/uploads\//.test(receiptImagePath)) {
				receipt_image = receiptImagePath;
				image_mime = null;
			} else if (receiptImageBuffer && Buffer.isBuffer(receiptImageBuffer) && receiptImageBuffer.length) {
				try {
					const webp = await sharp(receiptImageBuffer).rotate().webp({ quality: 82 }).toBuffer();
					const savedPath = await saveWebpToUploads(webp);
					receipt_image = savedPath;
					image_mime = 'image/webp';
				} catch (err) {
					console.warn('[receiptScanHistory] webp save failed:', err?.message || err);
					// Fallback: do not block save; store nothing if we fail to write file.
					receipt_image = null;
					image_mime = receiptImageMime;
				}
			}

			const sourceRaw = req.body.source ?? req.body.SOURCE ?? 'resto_admin';
			const source = String(sourceRaw).slice(0, 32) || 'resto_admin';
			const orderIdRaw = req.body.order_id ?? req.body.ORDER_ID ?? null;
			const order_id =
				orderIdRaw != null && String(orderIdRaw).trim() !== '' && /^\d+$/.test(String(orderIdRaw).trim())
					? Number(orderIdRaw)
					: null;
			const encodedDtRaw = req.body.ENCODED_DT ?? req.body.encoded_dt ?? null;
			const encoded_dt =
				encodedDtRaw != null && String(encodedDtRaw).trim() !== '' ? String(encodedDtRaw).trim().slice(0, 19) : null;

			const grandRaw = req.body.receipt_grand_total ?? req.body.RECEIPT_GRAND_TOTAL;
			const receipt_grand_total =
				grandRaw != null && String(grandRaw).trim() !== '' ? Number(grandRaw) : null;

			const insertId = await ReceiptScanHistoryModel.create({
				branch_id: branchId,
				order_id,
				encoded_by: userId,
				source,
				encoded_dt,
				receipt_grand_total: Number.isFinite(receipt_grand_total) ? receipt_grand_total : null,
				receipt_image,
			});

			return ApiResponse.success(res, { id: insertId, receipt_image_path: receipt_image }, 'Saved');
		} catch (error) {
			console.error('receiptScanHistory create:', error);
			return ApiResponse.error(res, 'Failed to save receipt scan', 500, error.message);
		}
	}

	/** Link a pending scan row (ORDER_ID null) to a created order — used by ReceiptLens after extraction + send. */
	static async patchOrder(req, res) {
		try {
			const isAdmin = req.user?.permissions === 1 || req.session?.permissions === 1;
			const userId = req.session?.user_id || req.user?.user_id || null;

			const idRaw = req.params?.id;
			const id =
				idRaw != null && String(idRaw).trim() !== '' && /^\d+$/.test(String(idRaw).trim())
					? Number(idRaw)
					: NaN;
			if (!Number.isFinite(id)) {
				return ApiResponse.badRequest(res, 'Invalid id');
			}

			const row = await ReceiptScanHistoryModel.getBranchAndImageById(id);
			if (!row) {
				return ApiResponse.notFound(res, 'Receipt scan record');
			}

			const branchId = String(row.BRANCH_ID);
			if (!isAdmin && userId) {
				const branches = await UserBranchModel.getBranchesByUserId(userId);
				const allowed = Array.isArray(branches) && branches.some((b) => String(b?.IDNo) === branchId);
				if (!allowed) {
					return ApiResponse.forbidden(res, 'Not allowed for this branch');
				}
			}

			const orderIdRaw = req.body?.order_id ?? req.body?.ORDER_ID ?? null;
			const order_id =
				orderIdRaw != null && String(orderIdRaw).trim() !== '' && /^\d+$/.test(String(orderIdRaw).trim())
					? Number(orderIdRaw)
					: null;
			if (!order_id) {
				return ApiResponse.badRequest(res, 'order_id is required');
			}

			const encodedDtRaw = req.body?.ENCODED_DT ?? req.body?.encoded_dt ?? null;
			const encoded_dt_patch =
				encodedDtRaw != null && String(encodedDtRaw).trim() !== ''
					? String(encodedDtRaw).trim().slice(0, 19)
					: null;

			const ok = await ReceiptScanHistoryModel.updateOrderId(id, order_id, encoded_dt_patch);
			if (!ok) {
				return ApiResponse.error(res, 'Failed to update receipt scan', 500, 'No rows updated');
			}

			return ApiResponse.success(
				res,
				{ id, receipt_image_path: row.RECEIPT_IMAGE },
				'Updated'
			);
		} catch (error) {
			console.error('receiptScanHistory patchOrder:', error);
			return ApiResponse.error(res, 'Failed to update receipt scan', 500, error.message);
		}
	}
}

module.exports = ReceiptScanHistoryController;
