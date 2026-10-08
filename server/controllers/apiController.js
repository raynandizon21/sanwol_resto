// ============================================
// API CONTROLLER
// ============================================
// File: controllers/apiController.js
// Description: Public API endpoints for Android app
// ============================================

const MenuModel = require('../models/menuModel');
const CategoryModel = require('../models/categoryModel');
const OrderModel = require('../models/orderModel');
const OrderItemsModel = require('../models/orderItemsModel');
const BillingModel = require('../models/billingModel');
const TableModel = require('../models/tableModel');
const UserModel = require('../models/userModel');
const UserBranchModel = require('../models/userBranchModel');
const BranchModel = require('../models/branchModel');
const InventoryDeductionService = require('../services/inventoryDeductionService');
const InventoryDeductionModel = require('../models/inventoryDeductionModel');
const argon2 = require('argon2');
const { generateTokenPair, verifyRefreshToken } = require('../utils/jwt');
const socketService = require('../utils/socketService');
const TranslationService = require('../utils/translationService');
const { isArgonHash, generateMD5 } = require('../utils/authUtils');
const { stitchReceiptDataUrls } = require('../services/receiptStitchService');
const { analyzeReceipt, extractOrderLinesFromReceipt } = require('../services/orderReceiptHelpers');
const { toPublicImageUrl, publicUrl, SUBDIRS, UPLOAD_ROOT } = require('../utils/uploadPaths');
const { getBusinessTodayYmd } = require('../utils/businessDay');
const pool = require('../config/db');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

class ApiController {
	// Login endpoint for mobile app
	static async login(req, res) {
		const timestamp = new Date().toISOString();

		try {
			const { username, password } = req.body;

			if (!username || !password) {
				console.log(`[${timestamp}] [LOGIN FAILED] Missing credentials - Username: ${username || 'N/A'}`);
				return res.status(400).json({
					success: false,
					error: 'Username and password are required'
				});
			}

			const candidates = await UserModel.findAllByUsernameWithRole(username);

			if (!candidates.length) {
				console.log(`[${timestamp}] [LOGIN FAILED] ${username}`);
				return res.status(401).json({
					success: false,
					error: 'User not found or inactive'
				});
			}

			const matches = [];
			for (const user of candidates) {
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
					matches.push({ user, isLegacy });
				}
			}

			if (!matches.length) {
				console.log(`[${timestamp}] [LOGIN FAILED] ${username}`);
				return res.status(401).json({
					success: false,
					error: 'Incorrect password'
				});
			}

			const picked = matches.find((m) => parseInt(m.user.PERMISSIONS, 10) === 1) || matches[0];
			const user = picked.user;
			const isLegacy = picked.isLegacy;
			const userRole = user.role || null;
			const allowedPermissions = [1, 2, 3, 14, 15, 16];
			const userPermissions = parseInt(user.PERMISSIONS, 10);

			console.log(`[${timestamp}] [LOGIN CHECK] ${username} - PERMISSIONS: ${user.PERMISSIONS}, parsed: ${userPermissions}, allowed: [${allowedPermissions.join(', ')}]`);

			if (!allowedPermissions.includes(userPermissions)) {
				console.log(`[${timestamp}] [LOGIN FAILED] ${username} - Not an allowed mobile app user`);
				return res.status(403).json({
					success: false,
					error: 'This account is for web admin only. Please use the web application to login.'
				});
			}

			console.log(`[${timestamp}] [LOGIN PERMISSION CHECK PASSED] ${username} - PERMISSIONS: ${userPermissions}`);

			if (isLegacy) {
				const newHash = await argon2.hash(password);
				await UserModel.updatePassword(user.IDNo, newHash);
			}

			await UserModel.updateLastLogin(user.IDNo);

			console.log(`[${timestamp}] [LOGIN] ${username} (user_id=${user.IDNo}, role=${userRole || 'n/a'})`);

			let branches = [];
			try {
				if (user.PERMISSIONS === 1) {
					branches = await BranchModel.getAllActive();
				} else {
					branches = await UserBranchModel.getBranchesByUserId(user.IDNo);
				}
			} catch (branchError) {
				console.error(`[${timestamp}] [LOGIN] Error getting branches for user ${user.IDNo}:`, branchError);
				branches = [];
			}

			// Resolve branch metadata for per-branch users so the frontend can display the real name immediately.
			let branchMeta = null;
			try {
				if (user.BRANCH_ID != null && user.BRANCH_ID !== '') {
					branchMeta = await BranchModel.getById(user.BRANCH_ID);
				}
			} catch (_) {
				branchMeta = null;
			}

			// Single-device-session enforcement: this login's sid becomes the
			// only valid one for this account — authenticateJWT rejects any
			// older token still out there on another device on its next call.
			const sid = crypto.randomUUID();
			await UserModel.updateActiveSession(user.IDNo, sid);

			const tokenPayload = {
				user_id: user.IDNo,
				username: user.USERNAME,
				permissions: user.PERMISSIONS,
				firstname: user.FIRSTNAME,
				lastname: user.LASTNAME,
				branch_id: user.BRANCH_ID || null,
				branch_name: branchMeta?.BRANCH_NAME || null,
				branch_code: branchMeta?.BRANCH_CODE || null,
				floor: user.FLOOR || null,
				sid,
			};
			const tokens = generateTokenPair(tokenPayload);

			return res.json({
				success: true,
				data: {
					user_id: user.IDNo,
					username: user.USERNAME,
					firstname: user.FIRSTNAME,
					lastname: user.LASTNAME,
					permissions: user.PERMISSIONS,
					branch_id: user.BRANCH_ID || null,
					branch_name: branchMeta?.BRANCH_NAME || null,
					branch_code: branchMeta?.BRANCH_CODE || null,
					floor: user.FLOOR || null,
					role: userRole,
					table_id: user.TABLE_ID || null,
					branches: branches
				},
				tokens: {
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken,
					expiresIn: tokens.expiresIn
				}
			});
		} catch (error) {
			console.error(`[${timestamp}] [LOGIN ERROR] ${req.body?.username || 'N/A'}`);
			return res.status(500).json({
				success: false,
				error: 'Internal server error'
			});
		}
	}

	static async getReceiptScannerApiKey(req, res) {
		const timestamp = new Date().toISOString();
		try {
			const [cols] = await pool.execute(`SHOW COLUMNS FROM receiptscanner_api`);
			const colNames = new Set((cols || []).map((c) => String(c.Field || '').toUpperCase()));
			const keyCol = colNames.has('GEMINI_API') ? 'GEMINI_API' : (colNames.has('GEMENI_API') ? 'GEMENI_API' : null);
			if (!keyCol) {
				return res.status(500).json({
					success: false,
					error: 'No Gemini API column found in receiptscanner_api'
				});
			}
			const whereActive = colNames.has('ACTIVE') ? ' WHERE ACTIVE = 1' : '';
			const [rows] = await pool.execute(
				`SELECT ${keyCol} FROM receiptscanner_api${whereActive} ORDER BY IDNo DESC LIMIT 1`
			);
			const rawKey = rows?.[0]?.GEMINI_API ?? rows?.[0]?.GEMENI_API ?? '';
			const apiKey = String(rawKey).trim();
			if (!apiKey) {
				return res.status(404).json({
					success: false,
					error: 'Receipt scanner API key not configured'
				});
			}
			return res.json({
				success: true,
				data: { apiKey }
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] GET /api/receiptscanner/gemini-key - Error:`, error);
			return res.status(500).json({
				success: false,
				error: 'Failed to fetch receipt scanner API key'
			});
		}
	}

	static async stitchReceiptImages(req, res) {
		const timestamp = new Date().toISOString();
		try {
			const pages = Array.isArray(req.body?.images) ? req.body.images : [];
			if (!pages.length) {
				return res.status(400).json({
					success: false,
					error: 'images[] is required'
				});
			}

			const stitchedDataUrl = await stitchReceiptDataUrls(pages, {
				maxWidth: req.body?.maxWidth,
				maxHeight: req.body?.maxHeight,
				quality: req.body?.quality
			});

			return res.json({
				success: true,
				data: {
					image: stitchedDataUrl,
					count: pages.length
				}
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] POST /api/receiptscanner/stitch - Error:`, error);
			return res.status(500).json({
				success: false,
				error: error?.message || 'Failed to stitch receipt images'
			});
		}
	}

	static async analyzeReceipt(req, res) {
		const timestamp = new Date().toISOString();
		try {
			const base64 = req.body?.base64 ?? req.body?.image ?? req.body?.imageBase64 ?? '';
			if (!base64) {
				return res.status(400).json({
					success: false,
					error: 'base64 is required'
				});
			}

			const categories = req.body?.categories;
			const data = await analyzeReceipt(base64, categories);
			return res.json({
				success: true,
				data
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] POST /api/receiptscanner/analyze - Error:`, error);
			if (error?.code === 'RECEIPT_MODEL_JSON_PARSE' && typeof error?.rawModelText === 'string') {
				const raw = error.rawModelText;
				console.error(
					`[${timestamp}] [receiptscanner] JSON parse failed; raw model text length=${raw.length}. First/last 500 chars for debugging:`
				);
				console.error(raw.length <= 1000 ? raw : `${raw.slice(0, 500)}\n…\n${raw.slice(-500)}`);
			}
			const msg = error?.message || 'Failed to analyze receipt';
			const isVertexAuthBilling = error?.code === 'VERTEX_AUTH_BILLING' || /Vertex AI request failed/i.test(String(msg));
			const isVertexModelNotFound = error?.code === 'VERTEX_MODEL_NOT_FOUND';
			const isModelJsonParse =
				error?.code === 'RECEIPT_MODEL_JSON_PARSE' ||
				/invalid json|after array element in json|expected[\s\S]{0,120}array element|json at position|unexpected token|unterminated string/i.test(
					String(msg)
				);
			const status = isVertexAuthBilling ? 503 : isVertexModelNotFound ? 404 : isModelJsonParse ? 422 : 500;
			return res.status(status).json({
				success: false,
				error: msg
			});
		}
	}

	static async analyzeReceiptOrders(req, res) {
		const timestamp = new Date().toISOString();
		try {
			const base64 = req.body?.base64 ?? req.body?.image ?? req.body?.imageBase64 ?? '';
			if (!base64) {
				return res.status(400).json({
					success: false,
					error: 'base64 is required'
				});
			}

			const data = await extractOrderLinesFromReceipt(base64);
			return res.json({
				success: true,
				data
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] POST /api/receiptscanner/analyze-orders - Error:`, error);
			if (error?.code === 'RECEIPT_MODEL_JSON_PARSE' && typeof error?.rawModelText === 'string') {
				const raw = error.rawModelText;
				console.error(
					`[${timestamp}] [receiptscanner] JSON parse failed; raw model text length=${raw.length}. First/last 500 chars for debugging:`
				);
				console.error(raw.length <= 1000 ? raw : `${raw.slice(0, 500)}\n…\n${raw.slice(-500)}`);
			}
			const msg = error?.message || 'Failed to analyze receipt for orders';
			const isVertexAuthBilling = error?.code === 'VERTEX_AUTH_BILLING' || /Vertex AI request failed/i.test(String(msg));
			const isVertexModelNotFound = error?.code === 'VERTEX_MODEL_NOT_FOUND';
			const isModelJsonParse =
				error?.code === 'RECEIPT_MODEL_JSON_PARSE' ||
				/invalid json|after array element in json|expected[\s\S]{0,120}array element|json at position|unexpected token|unterminated string/i.test(
					String(msg)
				);
			const status = isVertexAuthBilling ? 503 : isVertexModelNotFound ? 404 : isModelJsonParse ? 422 : 500;
			return res.status(status).json({
				success: false,
				error: msg
			});
		}
	}

	static async getCategories(req, res) {
		const timestamp = new Date().toISOString();
		const clientIp = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'Unknown';
		const targetLanguage = req.query.lang || req.query.language || 'en';

		try {
			const branchId = req.query.branch_id || req.user?.branch_id || null;
			const categories = await CategoryModel.getAll(branchId);
			let formattedCategories = categories.map(cat => ({
				id: cat.IDNo,
				name: cat.CAT_NAME,
				description: cat.CAT_DESC || null
			}));

			const translationAvailable = TranslationService.isAvailable();
			if (translationAvailable) {
				try {
					const descTextsToTranslate = [];
					const descTextMapping = [];
					formattedCategories.forEach(cat => {
						if (cat.description) {
							descTextsToTranslate.push(cat.description);
							descTextMapping.push({ cat: cat });
						}
					});
					if (descTextsToTranslate.length > 0) {
						const descTranslations = await TranslationService.translateBatch(descTextsToTranslate, targetLanguage);
						descTranslations.forEach((translation, index) => {
							if (descTextMapping[index]) {
								descTextMapping[index].cat.description = translation || descTextMapping[index].cat.description;
							}
						});
					}
				} catch (descError) {
					console.error(`[${timestamp}] [TRANSLATION ERROR] Failed to translate category descriptions:`, descError);
				}
				
				try {
					const textsToTranslate = [];
					const textMapping = [];
					formattedCategories.forEach(cat => {
						if (cat.name) {
							textsToTranslate.push(cat.name);
							textMapping.push({ type: 'name', cat: cat });
						}
					});
					if (textsToTranslate.length > 0) {
						const translations = await TranslationService.translateBatch(textsToTranslate, targetLanguage);
						translations.forEach((translation, index) => {
							const mapping = textMapping[index];
							if (mapping && mapping.type === 'name') {
								mapping.cat.name = translation || mapping.cat.name;
							}
						});
					}
				} catch (nameError) {
					console.error(`[${timestamp}] [TRANSLATION ERROR] Failed to translate category names:`, nameError);
				}
			}

			res.json({
				success: true,
				data: formattedCategories
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] GET /api/categories - IP: ${clientIp}, Error:`, error);
			res.status(500).json({ 
				success: false,
				error: 'Failed to fetch categories' 
			});
		}
	}

	static async getTables(req, res) {
		const timestamp = new Date().toISOString();
		const user_id = req.user?.user_id;

		try {
			let resolvedBranchId = req.query.branch_id || req.user?.branch_id || null;
			if (!resolvedBranchId && user_id) {
				const branches = await UserBranchModel.getBranchesByUserId(user_id);
				if (branches.length > 0) {
					resolvedBranchId = branches[0].IDNo;
				}
			}

			const tables = await TableModel.getAll(resolvedBranchId);
			const formattedTables = tables.map(table => ({
				id: table.IDNo,
				table_number: table.TABLE_NUMBER,
				capacity: table.CAPACITY,
				room_charge: table.ROOM_CHARGE != null ? parseFloat(table.ROOM_CHARGE) : null,
				status: table.STATUS,
				branch_id: table.BRANCH_ID ?? null
			}));

			return res.json({
				success: true,
				data: formattedTables
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] GET /api/tables - User ID: ${user_id}, Error:`, error);
			return res.status(500).json({
				success: false,
				error: 'Failed to fetch tables'
			});
		}
	}

	static async getMenuItems(req, res) {
		const timestamp = new Date().toISOString();
		const categoryId = req.query.category_id || null;
		const targetLanguage = req.query.lang || req.query.language || 'en';

		try {
			const branchId = req.query.branch_id || req.user?.branch_id || null;
			const menus = await MenuModel.getByCategory(categoryId, branchId);
			
			let baseUrl = req.protocol + '://' + req.get('host');
			if (req.get('x-forwarded-proto') === 'https' || req.get('host').includes('resto-admin.3core21.com')) {
				baseUrl = 'https://' + req.get('host');
			}
			let formattedMenus = menus.map(menu => ({
				id: menu.IDNo,
				category_id: menu.CATEGORY_ID,
				category_name: menu.CATEGORY_NAME || null,
				name: menu.MENU_NAME,
				description: menu.MENU_DESCRIPTION || null,
				image: toPublicImageUrl(baseUrl, menu.MENU_IMG),
				price: parseFloat(menu.MENU_PRICE || 0),
				is_available: (menu.EFFECTIVE_AVAILABLE ?? menu.IS_AVAILABLE) === 1,
				inventory_tracked: menu.INVENTORY_TRACKED === 1,
				inventory_available: menu.INVENTORY_AVAILABLE === 1,
				inventory_stock: menu.INVENTORY_STOCK !== null && menu.INVENTORY_STOCK !== undefined
					? parseFloat(menu.INVENTORY_STOCK)
					: null,
				sales_qty: parseInt(menu.total_qty || 0, 10),
				total_revenue: parseFloat(menu.total_revenue || 0)
			}));

			if (TranslationService.isAvailable()) {
				try {
					const descTextsToTranslate = [];
					const descTextMapping = [];
					formattedMenus.forEach(menu => {
						if (menu.description) {
							descTextsToTranslate.push(menu.description);
							descTextMapping.push({ menu: menu });
						}
					});
					if (descTextsToTranslate.length > 0) {
						const descTranslations = await TranslationService.translateBatch(descTextsToTranslate, targetLanguage);
						descTranslations.forEach((translation, index) => {
							if (descTextMapping[index]) {
								descTextMapping[index].menu.description = translation || descTextMapping[index].menu.description;
							}
						});
					}
				} catch (descError) {
					console.error(`[${timestamp}] [TRANSLATION ERROR] Failed to translate descriptions:`, descError);
				}
				
				try {
					const textsToTranslate = [];
					const textMapping = [];
					formattedMenus.forEach(menu => {
						if (menu.name) {
							textsToTranslate.push(menu.name);
							textMapping.push({ type: 'name', menu: menu });
						}
						if (menu.category_name) {
							textsToTranslate.push(menu.category_name);
							textMapping.push({ type: 'category', menu: menu });
						}
					});
					if (textsToTranslate.length > 0) {
						const translations = await TranslationService.translateBatch(textsToTranslate, targetLanguage);
						translations.forEach((translation, index) => {
							const mapping = textMapping[index];
							if (mapping) {
								if (mapping.type === 'name') {
									mapping.menu.name = translation || mapping.menu.name;
								} else if (mapping.type === 'category') {
									mapping.menu.category_name = translation || mapping.menu.category_name;
								}
							}
						});
					}
				} catch (nameError) {
					console.error(`[${timestamp}] [TRANSLATION ERROR] Failed to translate menu/category names:`, nameError);
				}
			}

			res.json({
				success: true,
				data: formattedMenus,
				count: formattedMenus.length
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] GET /api/menu - Error:`, error);
			res.status(500).json({ 
				success: false,
				error: 'Failed to fetch menu items' 
			});
		}
	}

	static async getTopRevenueItems(req, res) {
		const timestamp = new Date().toISOString();
		try {
			const branchId = parseInt(req.query.branch_id || req.user?.branch_id || '3', 10);
			const limit = parseInt(req.query.limit || '20', 10);

			if (
				ApiController._topRevenueCache &&
				(Date.now() - ApiController._topRevenueCache.timestamp < 60000) &&
				ApiController._topRevenueCache.branchId === branchId &&
				ApiController._topRevenueCache.limit === limit
			) {
				return res.json(ApiController._topRevenueCache.response);
			}

			let [rows] = await pool.execute(`
				SELECT 
					m.IDNo as id,
					m.CATEGORY_ID as category_id,
					c.CAT_NAME as category_name,
					m.MENU_NAME as name,
					m.MENU_DESCRIPTION as description,
					m.MENU_IMG as image,
					m.MENU_PRICE as price,
					m.IS_AVAILABLE as is_available,
					COALESCE(SUM(oi.QTY), 0) as total_qty,
					COALESCE(SUM(oi.LINE_TOTAL), 0) as total_revenue
				FROM menu m
				INNER JOIN order_items oi ON oi.MENU_ID = m.IDNo
				LEFT JOIN categories c ON c.IDNo = m.CATEGORY_ID
				LEFT JOIN orders o ON o.IDNo = oi.ORDER_ID
				WHERE m.ACTIVE = 1 AND m.BRANCH_ID = ?
				GROUP BY m.IDNo, m.CATEGORY_ID, c.CAT_NAME, m.MENU_NAME, m.MENU_DESCRIPTION, m.MENU_IMG, m.MENU_PRICE, m.IS_AVAILABLE
				ORDER BY total_revenue DESC, total_qty DESC
				LIMIT ${limit}
			`, [branchId]);

			if (!rows || rows.length === 0) {
				const [fallback] = await pool.execute(`
					SELECT 
						m.IDNo as id,
						m.CATEGORY_ID as category_id,
						c.CAT_NAME as category_name,
						m.MENU_NAME as name,
						m.MENU_DESCRIPTION as description,
						m.MENU_IMG as image,
						m.MENU_PRICE as price,
						m.IS_AVAILABLE as is_available,
						0 as total_qty,
						0 as total_revenue
					FROM menu m
					LEFT JOIN categories c ON c.IDNo = m.CATEGORY_ID
					WHERE m.ACTIVE = 1 AND m.BRANCH_ID = ?
					ORDER BY m.IDNo ASC
					LIMIT ${limit}
				`, [branchId]);
				rows = fallback;
			}

			let baseUrl = req.protocol + '://' + req.get('host');
			if (req.get('x-forwarded-proto') === 'https' || req.get('host').includes('resto-admin.3core21.com')) {
				baseUrl = 'https://' + req.get('host');
			}

			const formattedMenus = rows.map(menu => ({
				id: menu.id,
				category_id: menu.category_id,
				category_name: menu.category_name || null,
				name: menu.name,
				description: menu.description || null,
				image: toPublicImageUrl(baseUrl, menu.image),
				price: parseFloat(menu.price || 0),
				is_available: Number(menu.is_available) === 1,
				inventory_tracked: false,
				inventory_available: true,
				inventory_stock: null,
				sales_qty: parseInt(menu.total_qty || 0, 10),
				total_revenue: parseFloat(menu.total_revenue || 0)
			}));

			const responsePayload = {
				success: true,
				data: formattedMenus,
				count: formattedMenus.length
			};

			ApiController._topRevenueCache = {
				response: responsePayload,
				timestamp: Date.now(),
				branchId,
				limit
			};

			return res.json(responsePayload);
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] GET /api/menu/top-revenue - Error:`, error);
			return res.status(500).json({
				success: false,
				error: 'Failed to fetch top revenue menu items'
			});
		}
	}

	static async refreshToken(req, res) {
		const timestamp = new Date().toISOString();
		try {
			const { refreshToken } = req.body;
			if (!refreshToken) {
				return res.status(400).json({ success: false, error: 'Refresh token is required' });
			}
			const decoded = verifyRefreshToken(refreshToken);
			const user = await UserModel.findById(decoded.user_id);

			if (!user) {
				return res.status(401).json({ success: false, error: 'User not found or inactive' });
			}

			// Carry the login's sid forward so authenticateJWT accepts the new
			// access token. If the account has since logged in elsewhere, this
			// refresh token belongs to a replaced session — don't revive it.
			const activeSessionId = await UserModel.getActiveSessionId(user.IDNo);
			if (activeSessionId && decoded.sid !== activeSessionId) {
				return res.status(401).json({
					success: false,
					error: 'This account was signed in on another device.',
					code: 'SESSION_REPLACED'
				});
			}

			let branchMeta = null;
			try {
				if (user.BRANCH_ID != null && user.BRANCH_ID !== '') {
					branchMeta = await BranchModel.getById(user.BRANCH_ID);
				}
			} catch (_) {
				branchMeta = null;
			}

			const tokenPayload = {
				user_id: user.IDNo,
				username: user.USERNAME,
				permissions: user.PERMISSIONS,
				firstname: user.FIRSTNAME,
				lastname: user.LASTNAME,
				branch_id: user.BRANCH_ID || null,
				branch_name: branchMeta?.BRANCH_NAME || null,
				branch_code: branchMeta?.BRANCH_CODE || null,
				sid: decoded.sid || null,
			};
			const tokens = generateTokenPair(tokenPayload);

			return res.json({
				success: true,
				tokens: {
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken,
					expiresIn: tokens.expiresIn
				}
			});
		} catch (error) {
			console.error(`[${timestamp}] [REFRESH ERROR] Error:`, error);
			if (error.message === 'Refresh token expired') {
				return res.status(401).json({ success: false, error: 'Refresh token expired', code: 'REFRESH_TOKEN_EXPIRED' });
			} else if (error.message === 'Invalid refresh token') {
				return res.status(401).json({ success: false, error: 'Invalid refresh token', code: 'INVALID_REFRESH_TOKEN' });
			} else {
				return res.status(500).json({ success: false, error: 'Internal server error' });
			}
		}
	}

	static async getUserOrders(req, res) {
		const timestamp = new Date().toISOString();
		const user_id = req.user?.user_id;
		const table_id = req.query.table_id ? parseInt(req.query.table_id) : null;

		try {
			if (!user_id) {
				return res.status(400).json({ success: false, error: 'User ID is required' });
			}
			const branchId = req.query.branch_id || req.user?.branch_id || null;
			const orders = await OrderModel.getByUserIdOrTableId(user_id, table_id, branchId);

			const ordersWithItems = await Promise.all(
				orders.map(async (order) => {
					const items = await OrderItemsModel.getByOrderId(order.IDNo);
					return {
						order_id: order.IDNo,
						order_no: order.ORDER_NO,
						table_id: order.TABLE_ID,
						order_type: order.ORDER_TYPE,
						floor: order.FLOOR || null,
						status: order.STATUS,
						subtotal: parseFloat(order.SUBTOTAL || 0),
						tax_amount: parseFloat(order.TAX_AMOUNT || 0),
						service_charge: parseFloat(order.SERVICE_CHARGE || 0),
						discount_amount: parseFloat(order.DISCOUNT_AMOUNT || 0),
						grand_total: parseFloat(order.GRAND_TOTAL || 0),
						encoded_dt: order.ENCODED_DT,
						items: items.map(item => ({
							menu_id: item.MENU_ID,
							menu_name: item.MENU_NAME,
							qty: parseFloat(item.QTY || 0),
							unit_price: parseFloat(item.UNIT_PRICE || 0),
							line_total: parseFloat(item.LINE_TOTAL || 0),
							status: item.STATUS,
							remarks: item.REMARKS || null
						}))
					};
				})
			);

			return res.json({
				success: true,
				data: ordersWithItems
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] GET /api/orders - User ID: ${user_id}, Error:`, error);
			return res.status(500).json({
				success: false,
				error: 'Failed to fetch orders'
			});
		}
	}

	static async getKitchenOrders(req, res) {
		const timestamp = new Date().toISOString();
		const user_id = req.user?.user_id;

		try {
			if (!user_id) {
				return res.status(400).json({ success: false, error: 'User ID is required' });
			}
			const branchId = req.query.branch_id || req.user?.branch_id || null;
			const orders = await OrderModel.getKitchenOrders(branchId);

			const ordersWithItems = await Promise.all(
				orders.map(async (order) => {
					const items = await OrderItemsModel.getByOrderId(order.IDNo);
					let overallStatus = 1; 
					const hasPending = items.some(item => item.STATUS === 3);
					const hasPreparing = items.some(item => item.STATUS === 2);
					const allReady = items.every(item => item.STATUS === 1);
					
					if (hasPending) overallStatus = 3;
					else if (hasPreparing) overallStatus = 2;
					else if (allReady) overallStatus = 1;
					
					return {
						order_id: order.IDNo,
						order_no: order.ORDER_NO,
						table_id: order.TABLE_ID,
						table_number: order.TABLE_NUMBER || null,
						order_type: order.ORDER_TYPE,
						status: overallStatus,
						subtotal: parseFloat(order.SUBTOTAL || 0),
						tax_amount: parseFloat(order.TAX_AMOUNT || 0),
						service_charge: parseFloat(order.SERVICE_CHARGE || 0),
						discount_amount: parseFloat(order.DISCOUNT_AMOUNT || 0),
						grand_total: parseFloat(order.GRAND_TOTAL || 0),
						encoded_dt: order.ENCODED_DT,
						items: items.map(item => ({
							item_id: item.IDNo,
							menu_id: item.MENU_ID,
							menu_name: item.MENU_NAME,
							qty: parseFloat(item.QTY || 0),
							unit_price: parseFloat(item.UNIT_PRICE || 0),
							line_total: parseFloat(item.LINE_TOTAL || 0),
							status: item.STATUS
						}))
					};
				})
			);

			return res.json({
				success: true,
				data: ordersWithItems
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] GET /api/kitchen/orders - User ID: ${user_id}, Error:`, error);
			return res.status(500).json({
				success: false,
				error: 'Failed to fetch kitchen orders'
			});
		}
	}

	static async updateKitchenOrderStatus(req, res) {
		const timestamp = new Date().toISOString();
		const user_id = req.user?.user_id;
		const { order_id } = req.params;
		const { status } = req.body || {};
		const allowedStatuses = [3, 2, 1];

		try {
			if (!user_id) {
				return res.status(400).json({ success: false, error: 'User ID is required' });
			}
			const targetStatus = parseInt(status, 10);
			if (isNaN(targetStatus) || !allowedStatuses.includes(targetStatus)) {
				return res.status(400).json({ success: false, error: 'Invalid status.' });
			}

			const order = await OrderModel.getById(order_id);
			if (!order) {
				return res.status(404).json({ success: false, error: 'Order not found' });
			}

			const resolvedBranchId = req.query.branch_id || req.user?.branch_id || null;
			if (resolvedBranchId && order.BRANCH_ID && parseInt(order.BRANCH_ID) !== parseInt(resolvedBranchId)) {
				return res.status(403).json({ success: false, error: 'Order is not in your branch' });
			}

			const items = await OrderItemsModel.getByOrderId(order_id);
			if (items.length === 0) {
				return res.status(404).json({ success: false, error: 'Order has no items to update' });
			}

			await Promise.all(items.map(item => OrderItemsModel.updateStatus(item.IDNo, targetStatus, user_id)));

			if (targetStatus !== 1) {
				await OrderModel.updateStatus(order_id, targetStatus, user_id);
			}

			socketService.emitOrderUpdate(order_id, {
				order_id: parseInt(order_id, 10),
				order_no: order.ORDER_NO,
				table_id: order.TABLE_ID,
				order_type: order.ORDER_TYPE,
				floor: order.FLOOR || null,
				status: targetStatus === 1 ? (order.STATUS || 2) : targetStatus,
				grand_total: parseFloat(order.GRAND_TOTAL || 0),
				items: items.map(item => ({ ...item, STATUS: targetStatus }))
			});

			return res.json({
				success: true,
				data: { order_id: parseInt(order_id, 10), status: targetStatus, items_updated: items.length }
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] POST /api/kitchen/orders/${order_id}/status - Error:`, error);
			return res.status(500).json({ success: false, error: 'Failed to update order status' });
		}
	}

	static async getWaiterOrders(req, res) {
		const timestamp = new Date().toISOString();
		const user_id = req.user?.user_id;

		try {
			let resolvedBranchId = req.query.branch_id || req.user?.branch_id || null;
			if (!resolvedBranchId && user_id) {
				const branches = await UserBranchModel.getBranchesByUserId(user_id);
				if (branches.length > 0) resolvedBranchId = branches[0].IDNo;
			}
			// Waiter view is a shift-based worklist, not an all-time archive —
			// scope to today (Manila business day) so this doesn't keep growing
			// forever as settled orders pile up. Pending/confirmed orders are
			// realistically always from today anyway (they get resolved fast).
			// A branch whose shift crosses midnight has "today" run
			// until 07:00 (utils/businessDay.js) — otherwise orders opened before
			// midnight would drop out of the waiter/cashier list at 12:00AM.
			const today = getBusinessTodayYmd(resolvedBranchId);
			const orders = await OrderModel.getAll(resolvedBranchId, {
				start_date: today,
				end_date: today,
			});
			const activeOrders = orders.filter(order => [3, 2, 1].includes(order.STATUS));

			// One query for every order's items instead of one query PER order
			// (that N+1 loop was the real cost once order history grew — e.g.
			// 500 orders meant 500 separate round-trips just to render this list).
			const itemsByOrderId = await OrderItemsModel.getByOrderIds(
				activeOrders.map(order => order.IDNo)
			);

			const ordersWithItems = activeOrders.map((order) => {
				const items = itemsByOrderId.get(order.IDNo) || [];
				return {
					order_id: order.IDNo,
					order_no: order.ORDER_NO,
					payment_method: order.payment_method || null,
					table_id: order.TABLE_ID,
					table_number: order.TABLE_NUMBER || null,
					room_charge: order.ROOM_CHARGE != null ? parseFloat(order.ROOM_CHARGE) : 0,
					order_type: order.ORDER_TYPE,
					floor: order.FLOOR || null,
					status: order.STATUS,
					subtotal: parseFloat(order.SUBTOTAL || 0),
					tax_amount: parseFloat(order.TAX_AMOUNT || 0),
					service_charge: parseFloat(order.SERVICE_CHARGE || 0),
					discount_amount: parseFloat(order.DISCOUNT_AMOUNT || 0),
					grand_total: parseFloat(order.GRAND_TOTAL || 0),
					amount_paid: parseFloat(order.amount_paid || order.AMOUNT_PAID || 0),
					payment_ref: order.payment_ref || order.PAYMENT_REF || null,
					encoded_by_name: order.ENCODED_BY_NAME || null,
					encoded_dt: order.ENCODED_DT,
					items: items.map(item => ({
						item_id: item.IDNo,
						menu_id: item.MENU_ID,
						menu_name: item.MENU_NAME,
						qty: parseFloat(item.QTY || 0),
						unit_price: parseFloat(item.UNIT_PRICE || 0),
						line_total: parseFloat(item.LINE_TOTAL || 0),
						status: item.STATUS,
						remarks: item.REMARKS || null
					}))
				};
			});

			return res.json({ success: true, data: ordersWithItems });
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] GET /api/waiter/orders - User ID: ${user_id}, Error:`, error);
			return res.status(500).json({ success: false, error: 'Failed to fetch waiter orders' });
		}
	}

	static async updateWaiterOrderStatus(req, res) {
		const timestamp = new Date().toISOString();
		const user_id = req.user?.user_id;
		const { order_id } = req.params;
		const {
			status,
			payment_method,
			discount_amount,
			grand_total,
			amount_paid,
			payment_ref,
			remarks
		} = req.body || {};
		const allowedStatuses = [3, 2, 1, -1];

		try {
			if (!user_id) return res.status(400).json({ success: false, error: 'User ID is required' });
			const targetStatus = parseInt(status, 10);
			if (!allowedStatuses.includes(targetStatus)) return res.status(400).json({ success: false, error: 'Invalid status.' });

			const order = await OrderModel.getById(order_id);
			if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
			
			const resolvedBranchId = req.query.branch_id || req.user?.branch_id || null;
			if (resolvedBranchId && order.BRANCH_ID && parseInt(order.BRANCH_ID) !== parseInt(resolvedBranchId)) {
				return res.status(403).json({ success: false, error: 'Order is not in your branch' });
			}

			let finalGrandTotal = parseFloat(order.GRAND_TOTAL || 0);
			const discountNum = parseFloat(discount_amount || 0);

			if (targetStatus === 1 && (discountNum > 0 || grand_total != null)) {
				finalGrandTotal = grand_total != null
					? parseFloat(grand_total)
					: Math.max(0, parseFloat(order.SUBTOTAL || order.GRAND_TOTAL || 0) - (discountNum > 0 ? discountNum : 0));

				await pool.execute(
					'UPDATE orders SET DISCOUNT_AMOUNT = ?, GRAND_TOTAL = ?, EDITED_BY = ?, EDITED_DT = NOW() WHERE IDNo = ?',
					[discountNum > 0 ? discountNum : 0, finalGrandTotal, user_id, order_id]
				);
			}

			if (targetStatus === 1) {
				await InventoryDeductionModel.updateStatusByOrderId(Number(order_id), 1, user_id);
				await OrderModel.updateStatus(order_id, 1, user_id);
			} else if (targetStatus === -1) {
				// CANCELLED: reverse deductions (add stock back), same as the
				// admin web panel's own cancel handler.
				await InventoryDeductionService.reverseOnOrderCancelled(Number(order_id), user_id);
				await OrderModel.updateStatus(order_id, targetStatus, user_id);
			} else {
				await OrderModel.updateStatus(order_id, targetStatus, user_id);
			}

			const paymentMethod = payment_method || 'CASH';
			const finalAmountPaid = amount_paid != null ? parseFloat(amount_paid) : finalGrandTotal;
			const finalPaymentRef = payment_ref || (paymentMethod === 'CASH' ? 'Settled via Cashier App' : null);

			if (targetStatus === 1) {
				if (order.TABLE_ID) await TableModel.updateStatus(order.TABLE_ID, 1);
				const existingBilling = await BillingModel.getByOrderId(order_id);
				if (existingBilling) {
					await BillingModel.updateForOrder(order_id, {
						status: 1,
						amount_due: finalGrandTotal,
						amount_paid: finalAmountPaid,
						payment_method: paymentMethod,
						payment_ref: finalPaymentRef,
						encoded_dt: order.ENCODED_DT || null,
					});
				} else {
					await BillingModel.createForOrder({
						branch_id: order.BRANCH_ID,
						order_id: order_id,
						payment_method: paymentMethod,
						amount_due: finalGrandTotal,
						amount_paid: finalAmountPaid,
						payment_ref: finalPaymentRef,
						status: 1,
						user_id: user_id,
						encoded_dt: order.ENCODED_DT || null,
					});
				}

				try {
					await BillingModel.recordTransaction({
						order_id: order_id,
						payment_method: paymentMethod,
						amount_paid: finalAmountPaid,
						payment_ref: finalPaymentRef || 'Settled via Cashier App',
						user_id: user_id,
						encoded_dt: order.ENCODED_DT || null,
					});
				} catch (e) {
					console.error(`[${timestamp}] [TRANSACTION ERROR] ${e.message}`);
				}
			} else if (targetStatus === -1) {
				// CANCELLED: free the table, same as SETTLED — no billing record needed.
				if (order.TABLE_ID) await TableModel.updateStatus(order.TABLE_ID, 1);
			}

			let tableNumber = null;
			if (order.TABLE_ID) {
				const table = await TableModel.getById(order.TABLE_ID);
				if (table) tableNumber = table.TABLE_NUMBER;
			}

			const orderItems = await OrderItemsModel.getByOrderId(order_id);
			socketService.emitOrderUpdate(order_id, {
				order_id: parseInt(order_id, 10),
				order_no: order.ORDER_NO,
				payment_method: targetStatus === 1 ? paymentMethod : null,
				table_id: order.TABLE_ID,
				table_number: tableNumber,
				order_type: order.ORDER_TYPE,
				floor: order.FLOOR || null,
				status: targetStatus,
				subtotal: parseFloat(order.SUBTOTAL || 0),
				tax_amount: parseFloat(order.TAX_AMOUNT || 0),
				service_charge: parseFloat(order.SERVICE_CHARGE || 0),
				discount_amount: discountNum > 0 ? discountNum : parseFloat(order.DISCOUNT_AMOUNT || 0),
				grand_total: finalGrandTotal,
				items: orderItems.map(item => ({
					item_id: item.IDNo,
					menu_id: item.MENU_ID,
					menu_name: item.MENU_NAME,
					qty: parseFloat(item.QTY || 0),
					unit_price: parseFloat(item.UNIT_PRICE || 0),
					line_total: parseFloat(item.LINE_TOTAL || 0),
					status: item.STATUS,
					remarks: item.REMARKS || null
				})),
				encoded_by: order.ENCODED_BY ?? user_id ?? null,
				branch_id: order.BRANCH_ID || resolvedBranchId || null
			});

			return res.json({ success: true, data: { order_id: parseInt(order_id, 10), status: targetStatus } });
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] PATCH /api/waiter/orders/${order_id}/status - Error:`, error);
			return res.status(500).json({ success: false, error: 'Failed to update order status' });
		}
	}

	static async transferTableOrder(req, res) {
		const timestamp = new Date().toISOString();
		const user_id = req.user?.user_id;
		const { order_id } = req.params;
		const { target_table_id } = req.body || {};

		try {
			if (!user_id) return res.status(400).json({ success: false, error: 'User ID is required' });
			if (!order_id) return res.status(400).json({ success: false, error: 'Order ID is required' });
			if (!target_table_id) return res.status(400).json({ success: false, error: 'Target table is required' });

			const order = await OrderModel.getById(order_id);
			if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

			const targetTable = await TableModel.getById(target_table_id);
			if (!targetTable) return res.status(404).json({ success: false, error: 'Target table not found' });

			const oldTableId = order.TABLE_ID;
			const newTableId = parseInt(target_table_id, 10);

			if (oldTableId === newTableId) {
				return res.status(400).json({ success: false, error: 'Target table is already the current table' });
			}

			// Update order's table ID
			await OrderModel.update(order_id, {
				TABLE_ID: newTableId,
				ORDER_TYPE: order.ORDER_TYPE,
				STATUS: order.STATUS,
				SUBTOTAL: order.SUBTOTAL,
				TAX_AMOUNT: order.TAX_AMOUNT,
				SERVICE_CHARGE: order.SERVICE_CHARGE,
				DISCOUNT_AMOUNT: order.DISCOUNT_AMOUNT,
				GRAND_TOTAL: order.GRAND_TOTAL,
				user_id: user_id
			});

			// Update new table status to Occupied (2)
			await TableModel.updateStatus(newTableId, 2);

			// Check if old table has any remaining active orders
			if (oldTableId) {
				const remainingOrders = await OrderModel.getByTableId(oldTableId);
				const otherActive = (remainingOrders || []).filter(o => o.IDNo !== parseInt(order_id, 10) && [2, 3].includes(o.STATUS));
				if (otherActive.length === 0) {
					await TableModel.updateStatus(oldTableId, 1); // Set to Available
				}
			}

			// Broadcast socket updates to all clients
			const orderItems = await OrderItemsModel.getByOrderId(order_id);
			const targetTableName = targetTable.TABLE_NAME || targetTable.TABLE_NO || `Table ${newTableId}`;
			socketService.emitOrderUpdate(order_id, {
				order_id: parseInt(order_id, 10),
				order_no: order.ORDER_NO,
				table_id: newTableId,
				table_number: targetTableName,
				old_table_id: oldTableId,
				status: order.STATUS,
				grand_total: parseFloat(order.GRAND_TOTAL || 0),
				items: orderItems,
				encoded_by: order.ENCODED_BY ?? user_id ?? null
			});

			return res.json({
				success: true,
				message: `Order #${order.ORDER_NO} successfully transferred to ${targetTableName}`,
				data: {
					order_id: parseInt(order_id, 10),
					old_table_id: oldTableId,
					new_table_id: newTableId,
					new_table_name: targetTableName
				}
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] POST /api/waiter/orders/${order_id}/transfer-table - Error:`, error);
			return res.status(500).json({ success: false, error: 'Failed to transfer table order' });
		}
	}

	// Extend the room charge on an active order: adds one more unit of the
	// table's ROOM_CHARGE to the order's SERVICE_CHARGE and recomputes
	// GRAND_TOTAL (SUBTOTAL + TAX + SERVICE_CHARGE - DISCOUNT).
	static async extendRoomCharge(req, res) {
		const timestamp = new Date().toISOString();
		const user_id = req.user?.user_id;
		const { order_id } = req.params;

		try {
			if (!user_id) return res.status(400).json({ success: false, error: 'User ID is required' });
			if (!order_id) return res.status(400).json({ success: false, error: 'Order ID is required' });

			const order = await OrderModel.getById(order_id);
			if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

			const resolvedBranchId = req.query.branch_id || req.user?.branch_id || null;
			if (resolvedBranchId && order.BRANCH_ID && parseInt(order.BRANCH_ID) !== parseInt(resolvedBranchId)) {
				return res.status(403).json({ success: false, error: 'Order is not in your branch' });
			}

			// Only active (pending / confirmed) orders can be extended.
			if (![2, 3].includes(parseInt(order.STATUS, 10))) {
				return res.status(400).json({ success: false, error: 'Only active orders can be extended' });
			}

			if (!order.TABLE_ID) {
				return res.status(400).json({ success: false, error: 'Order has no table assigned' });
			}

			const table = await TableModel.getById(order.TABLE_ID);
			const roomCharge = parseFloat(table?.ROOM_CHARGE) || 0;
			if (!Number.isFinite(roomCharge) || roomCharge <= 0) {
				return res.status(400).json({ success: false, error: 'This table has no room charge' });
			}

			// Qty supports 0.5 steps, same as admin's manual-order room charge stepper.
			const rawQty = parseFloat(req.body?.qty);
			const qty = Number.isFinite(rawQty) && rawQty > 0 ? Math.round(rawQty * 2) / 2 : 1;
			const roomChargeAdded = Number((roomCharge * qty).toFixed(2));

			const newServiceCharge = Number((parseFloat(order.SERVICE_CHARGE || 0) + roomChargeAdded).toFixed(2));
			const newGrandTotal = OrderModel.computeGrandTotal(
				order.SUBTOTAL,
				order.TAX_AMOUNT,
				newServiceCharge,
				order.DISCOUNT_AMOUNT
			);

			await pool.execute(
				'UPDATE orders SET SERVICE_CHARGE = ?, GRAND_TOTAL = ?, EDITED_BY = ?, EDITED_DT = NOW() WHERE IDNo = ?',
				[newServiceCharge, newGrandTotal, user_id, order_id]
			);

			let tableNumber = table?.TABLE_NUMBER || null;
			const orderItems = await OrderItemsModel.getByOrderId(order_id);
			socketService.emitOrderUpdate(order_id, {
				order_id: parseInt(order_id, 10),
				order_no: order.ORDER_NO,
				table_id: order.TABLE_ID,
				table_number: tableNumber,
				room_charge: roomCharge,
				room_charge_units_added: qty,
				order_type: order.ORDER_TYPE,
				floor: order.FLOOR || null,
				status: order.STATUS,
				subtotal: parseFloat(order.SUBTOTAL || 0),
				tax_amount: parseFloat(order.TAX_AMOUNT || 0),
				service_charge: newServiceCharge,
				discount_amount: parseFloat(order.DISCOUNT_AMOUNT || 0),
				grand_total: newGrandTotal,
				items: orderItems.map(item => ({
					item_id: item.IDNo,
					menu_id: item.MENU_ID,
					menu_name: item.MENU_NAME,
					qty: parseFloat(item.QTY || 0),
					unit_price: parseFloat(item.UNIT_PRICE || 0),
					line_total: parseFloat(item.LINE_TOTAL || 0),
					status: item.STATUS,
					remarks: item.REMARKS || null
				})),
				encoded_by: order.ENCODED_BY ?? user_id ?? null,
				branch_id: order.BRANCH_ID || resolvedBranchId || null
			});

			return res.json({
				success: true,
				data: {
					order_id: parseInt(order_id, 10),
					room_charge_added: roomChargeAdded,
					units_added: qty,
					service_charge: newServiceCharge,
					grand_total: newGrandTotal
				}
			});
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] POST /api/waiter/orders/${order_id}/extend-room-charge - Error:`, error);
			return res.status(500).json({ success: false, error: 'Failed to extend room charge' });
		}
	}

	static async createOrder(req, res) {
		const timestamp = new Date().toISOString();
		const user_id = req.user?.user_id;

		try {
			const { branch_id, order_no, table_id, order_type, subtotal, tax_amount, service_charge, discount_amount, grand_total, items, encoded_dt } = req.body;

			if (!order_no || order_no.trim() === '') return res.status(400).json({ success: false, error: 'Order number is required' });
			if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, error: 'At least one order item is required' });

			let resolvedBranchId = branch_id ? parseInt(branch_id) : null;
			if (!resolvedBranchId && table_id) {
				const table = await TableModel.getById(table_id);
				if (table?.BRANCH_ID) resolvedBranchId = parseInt(table.BRANCH_ID);
			}
			if (!resolvedBranchId && user_id) {
				const branches = await UserBranchModel.getBranchesByUserId(user_id);
				if (branches.length > 0) resolvedBranchId = parseInt(branches[0].IDNo);
			}
			if (!resolvedBranchId) return res.status(400).json({ success: false, error: 'Branch ID is required' });

			const newOrderItems = items.map(item => ({
				menu_id: parseInt(item.menu_id),
				qty: parseFloat(item.qty),
				unit_price: parseFloat(item.unit_price),
				line_total: parseFloat(item.qty) * parseFloat(item.unit_price),
				status: item.status || 3,
				remarks: item.remarks || item.notes || null
			}));

			const validation = await InventoryDeductionService.validateOrderItemsForInventory(resolvedBranchId, newOrderItems);
			if (!validation.valid) {
				return res.status(200).json({
					success: false,
					error: 'Insufficient inventory for order items',
					insufficient: validation.insufficient,
				});
			}

			const orderData = {
				BRANCH_ID: resolvedBranchId,
				ORDER_NO: order_no.trim(),
				TABLE_ID: table_id || null,
				ORDER_TYPE: order_type || null,
				STATUS: 3, 
				SUBTOTAL: parseFloat(subtotal) || 0,
				TAX_AMOUNT: parseFloat(tax_amount) || 0,
				SERVICE_CHARGE: parseFloat(service_charge) || 0,
				DISCOUNT_AMOUNT: parseFloat(discount_amount) || 0,
				GRAND_TOTAL: parseFloat(grand_total) || 0,
				// Preserve offline timestamp: if the tablet took this order while offline,
				// encoded_dt holds the original time so reports/billing show the correct time
				// instead of the later sync time. Falls back to NOW() if not provided.
				ENCODED_DT: encoded_dt || null,
				user_id: user_id
			};

			const existingOrder = await OrderModel.findLatestByOrderNo(orderData.BRANCH_ID, orderData.ORDER_NO);
			if (existingOrder) {
				// Idempotent: if a tablet retried after a brief dropout and the order was
				// already saved, return the existing order ID so the sync engine can
				// continue processing subsequent queued actions (e.g. settlements).
				return res.status(200).json({
					success: true,
					data: {
						order_id: existingOrder.IDNo,
						order_no: existingOrder.ORDER_NO,
						table_id: existingOrder.TABLE_ID,
						status: existingOrder.STATUS,
						grand_total: parseFloat(existingOrder.GRAND_TOTAL || 0),
						already_exists: true,
					},
				});
			}

			// A table can only have one open order at a time. Creating a second one here
			// would also re-stamp the table's Room Charge onto it (see resolveServiceChargeWithRoomCharge),
			// double-billing the guest. Same guard orderController.js already applies for the web
			// admin's order endpoint — this mobile/tablet endpoint was missing it, letting two
			// waiters both tapping "New Order" on the same table within the same instant silently
			// create two separate orders for it.
			if (orderData.TABLE_ID) {
				const activeTableOrder = await OrderModel.getActiveByTable(orderData.BRANCH_ID, orderData.TABLE_ID);
				if (activeTableOrder) {
					return res.status(409).json({
						success: false,
						error: `This table already has an active order (#${activeTableOrder.ORDER_NO}). Add items to that order instead of creating a new one.`,
						code: 'ACTIVE_ORDER_EXISTS',
						existing_order_id: activeTableOrder.IDNo,
						existing_order_no: activeTableOrder.ORDER_NO,
					});
				}
			}

			orderData.SERVICE_CHARGE = await OrderModel.resolveServiceChargeWithRoomCharge(orderData.TABLE_ID, service_charge);
			orderData.GRAND_TOTAL = OrderModel.computeGrandTotal(
				orderData.SUBTOTAL,
				orderData.TAX_AMOUNT,
				orderData.SERVICE_CHARGE,
				orderData.DISCOUNT_AMOUNT
			);

			// Floor is derived server-side (table FLOOR, else the account's FLOOR), never trusted from the client body.
			orderData.FLOOR = await OrderModel.resolveFloor(orderData.TABLE_ID, user_id);
			const orderId = await OrderModel.create(orderData);
			await OrderItemsModel.createForOrder(orderId, newOrderItems, user_id);
			await BillingModel.createForOrder({ branch_id: orderData.BRANCH_ID, order_id: orderId, amount_due: orderData.GRAND_TOTAL, amount_paid: 0, status: 3, user_id: user_id });

			if (orderData.TABLE_ID) await TableModel.updateStatus(orderData.TABLE_ID, 2);

			let tableNumber = null;
			if (orderData.TABLE_ID) {
				const table = await TableModel.getById(orderData.TABLE_ID);
				if (table) tableNumber = table.TABLE_NUMBER;
			}

			const orderItems = await OrderItemsModel.getByOrderId(orderId);
			// encoded_by lets clients tell whether THEY created this order, so the
			// "New Order Received" alert only fires for other staff, not the creator.
			socketService.emitOrderCreated(orderId, {
				order_id: orderId,
				order_no: orderData.ORDER_NO,
				table_id: orderData.TABLE_ID,
				table_number: tableNumber,
				order_type: orderData.ORDER_TYPE,
				floor: orderData.FLOOR || null,
				status: orderData.STATUS,
				subtotal: parseFloat(orderData.SUBTOTAL || 0),
				tax_amount: parseFloat(orderData.TAX_AMOUNT || 0),
				service_charge: parseFloat(orderData.SERVICE_CHARGE || 0),
				discount_amount: parseFloat(orderData.DISCOUNT_AMOUNT || 0),
				grand_total: parseFloat(orderData.GRAND_TOTAL || 0),
				items: orderItems.map(item => ({
					item_id: item.IDNo,
					menu_id: item.MENU_ID,
					menu_name: item.MENU_NAME,
					qty: parseFloat(item.QTY || 0),
					unit_price: parseFloat(item.UNIT_PRICE || 0),
					line_total: parseFloat(item.LINE_TOTAL || 0),
					status: item.STATUS,
					remarks: item.REMARKS || null
				})),
				items_count: items.length,
				encoded_by: user_id || null,
				branch_id: resolvedBranchId
			});

			return res.json({ success: true, data: { order_id: orderId, order_no: orderData.ORDER_NO, table_id: orderData.TABLE_ID, status: orderData.STATUS, grand_total: orderData.GRAND_TOTAL, items_count: items.length } });
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] POST /api/orders - Error:`, error);
			return res.status(500).json({ success: false, error: 'Failed to create order' });
		}
	}

	static async addItemsToOrder(req, res) {
		const timestamp = new Date().toISOString();
		const user_id = req.user?.user_id;
		const { order_id } = req.params;

		try {
			if (!order_id) return res.status(400).json({ success: false, error: 'Order ID is required' });

			const existingOrder = await OrderModel.getById(order_id);
			if (!existingOrder) return res.status(404).json({ success: false, error: 'Order not found' });
			
			const resolvedBranchId = req.query.branch_id || req.user?.branch_id || null;
			if (resolvedBranchId && existingOrder.BRANCH_ID && parseInt(existingOrder.BRANCH_ID) !== parseInt(resolvedBranchId)) {
				return res.status(403).json({ success: false, error: 'Order is not in your branch' });
			}

			const { items } = req.body;
			if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, error: 'At least one order item is required' });

			const existingItems = await OrderItemsModel.getByOrderId(order_id);
			const newItemsTotal = items.reduce((sum, item) => sum + (parseFloat(item.qty) * parseFloat(item.unit_price)), 0);
			const existingItemsTotal = existingItems.reduce((sum, item) => sum + (parseFloat(item.LINE_TOTAL) || 0), 0);

			const orderItemsToAdd = items.map(item => ({
				menu_id: parseInt(item.menu_id),
				qty: parseFloat(item.qty),
				unit_price: parseFloat(item.unit_price),
				line_total: parseFloat(item.qty) * parseFloat(item.unit_price),
				status: item.status || 3,
				remarks: item.remarks || item.notes || null
			}));

			await OrderItemsModel.createForOrder(order_id, orderItemsToAdd, user_id);

			const newSubtotal = Number((existingItemsTotal + newItemsTotal).toFixed(2));
			const newGrandTotal = Number((newSubtotal + (Number(existingOrder.TAX_AMOUNT) || 0) + (Number(existingOrder.SERVICE_CHARGE) || 0) - (Number(existingOrder.DISCOUNT_AMOUNT) || 0)).toFixed(2));

			await OrderModel.update(order_id, {
				TABLE_ID: existingOrder.TABLE_ID,
				ORDER_TYPE: existingOrder.ORDER_TYPE,
				STATUS: existingOrder.STATUS,
				SUBTOTAL: newSubtotal,
				TAX_AMOUNT: existingOrder.TAX_AMOUNT,
				SERVICE_CHARGE: existingOrder.SERVICE_CHARGE,
				DISCOUNT_AMOUNT: existingOrder.DISCOUNT_AMOUNT,
				GRAND_TOTAL: newGrandTotal,
				user_id: user_id
			});

			const existingBilling = await BillingModel.getByOrderId(order_id);
			if (existingBilling) await BillingModel.updateForOrder(order_id, { amount_due: newGrandTotal });

			let tableNumber = null;
			if (existingOrder.TABLE_ID) {
				const table = await TableModel.getById(existingOrder.TABLE_ID);
				if (table) tableNumber = table.TABLE_NUMBER;
			}

			const allOrderItems = await OrderItemsModel.getByOrderId(order_id);
			socketService.emitOrderItemsAdded(order_id, {
				order_id: parseInt(order_id),
				order_no: existingOrder.ORDER_NO,
				table_id: existingOrder.TABLE_ID,
				table_number: tableNumber,
				order_type: existingOrder.ORDER_TYPE,
				floor: existingOrder.FLOOR || null,
				status: existingOrder.STATUS,
				subtotal: newSubtotal,
				tax_amount: parseFloat(existingOrder.TAX_AMOUNT || 0),
				service_charge: parseFloat(existingOrder.SERVICE_CHARGE || 0),
				discount_amount: parseFloat(existingOrder.DISCOUNT_AMOUNT || 0),
				grand_total: newGrandTotal,
				items: allOrderItems.map(item => ({
					item_id: item.IDNo,
					menu_id: item.MENU_ID,
					menu_name: item.MENU_NAME,
					qty: parseFloat(item.QTY || 0),
					unit_price: parseFloat(item.UNIT_PRICE || 0),
					line_total: parseFloat(item.LINE_TOTAL || 0),
					status: item.STATUS,
					remarks: item.REMARKS || null
				})),
				items_added: items.length,
				encoded_by: user_id || null,
				branch_id: resolvedBranchId
			});

			return res.json({ success: true, data: { order_id: parseInt(order_id), order_no: existingOrder.ORDER_NO, items_added: items.length, new_subtotal: newSubtotal, new_grand_total: newGrandTotal } });
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] POST /api/orders/${order_id}/items - Error:`, error);
			return res.status(500).json({ success: false, error: 'Failed to add items to order' });
		}
	}

	static async replaceOrderItems(req, res) {
		const timestamp = new Date().toISOString();
		const user_id = req.user?.user_id;
		const { order_id } = req.params;

		try {
			if (!order_id) return res.status(400).json({ success: false, error: 'Order ID is required' });

			const existingOrder = await OrderModel.getById(order_id);
			if (!existingOrder) return res.status(404).json({ success: false, error: 'Order not found' });
			
			const resolvedBranchId = req.query.branch_id || req.user?.branch_id || null;
			if (resolvedBranchId && existingOrder.BRANCH_ID && parseInt(existingOrder.BRANCH_ID) !== parseInt(resolvedBranchId)) {
				return res.status(403).json({ success: false, error: 'Order is not in your branch' });
			}

			const { items } = req.body;
			if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, error: 'At least one order item is required' });

			const replacementItems = items.map(item => ({
				menu_id: parseInt(item.menu_id),
				qty: parseFloat(item.qty),
				unit_price: parseFloat(item.unit_price),
				line_total: parseFloat(item.qty) * parseFloat(item.unit_price),
				status: item.status || 3
			}));

			const newSubtotal = Number(replacementItems.reduce((sum, item) => sum + item.line_total, 0).toFixed(2));
			const newGrandTotal = Number((newSubtotal + (Number(existingOrder.TAX_AMOUNT) || 0) + (Number(existingOrder.SERVICE_CHARGE) || 0) - (Number(existingOrder.DISCOUNT_AMOUNT) || 0)).toFixed(2));

			await OrderItemsModel.replaceForOrder(order_id, replacementItems, user_id);
			await OrderModel.update(order_id, {
				TABLE_ID: existingOrder.TABLE_ID,
				ORDER_TYPE: existingOrder.ORDER_TYPE,
				STATUS: existingOrder.STATUS,
				SUBTOTAL: newSubtotal,
				TAX_AMOUNT: existingOrder.TAX_AMOUNT,
				SERVICE_CHARGE: existingOrder.SERVICE_CHARGE,
				DISCOUNT_AMOUNT: existingOrder.DISCOUNT_AMOUNT,
				GRAND_TOTAL: newGrandTotal,
				user_id: user_id
			});

			const existingBilling = await BillingModel.getByOrderId(order_id);
			if (existingBilling) await BillingModel.updateForOrder(order_id, { amount_due: newGrandTotal });

			const updatedItems = await OrderItemsModel.getByOrderId(order_id);
			socketService.emitOrderUpdate(order_id, { order_id: parseInt(order_id), order_no: existingOrder.ORDER_NO, table_id: existingOrder.TABLE_ID, status: existingOrder.STATUS, grand_total: newGrandTotal, items: updatedItems });

			return res.json({ success: true, data: { order_id: parseInt(order_id), order_no: existingOrder.ORDER_NO, items_count: replacementItems.length, new_grand_total: newGrandTotal } });
		} catch (error) {
			console.error(`[${timestamp}] [API ERROR] PUT /api/orders/${order_id}/items - Error:`, error);
			return res.status(500).json({ success: false, error: 'Failed to update order items' });
		}
	}

	static async getMe(req, res) {
		try {
			if (!req.user) return res.json({ success: true, data: null });
			const user = await UserModel.findByIdWithRole(req.user.user_id);
			if (!user) return res.json({ success: true, data: null });
			return res.json({ success: true, data: user });
		} catch (error) {
			console.error('getMe error:', error);
			return res.status(500).json({ success: false, error: 'Internal server error' });
		}
	}

	static async getDashboardData(req, res) {
		const timestamp = new Date().toISOString();
		const { branchId } = req.query;

		try {
			// If branchId is 'all', we don't filter by branch
			const filterBranchId = branchId === 'all' ? null : branchId;

			// Mock data generation
			const seed = filterBranchId ? parseInt(filterBranchId, 10) : new Date().getMilliseconds();
			const dynamicStats = {
				orders: (48652 + (seed * 123)).toLocaleString(),
				customers: (1248 + (seed * 5)).toLocaleString(),
				revenue: `$${(215860 + (seed * 456)).toLocaleString()}`
			};
			
			const revenueData = [
				{ name: 'Mar', income: 8000, expense: 5000 },
				{ name: 'Apr', income: 10000, expense: 6000 },
				{ name: 'May', income: 9000, expense: 7000 },
				{ name: 'Jun', income: 12000, expense: 8000 },
				{ name: 'Jul', income: 16580, expense: 9000 },
				{ name: 'Aug', income: 11000, expense: 7000 },
				{ name: 'Sep', income: 14000, expense: 8500 },
				{ name: 'Oct', income: 13000, expense: 7500 },
			];

			const dynamicRevenueData = revenueData.map((item, idx) => ({
				...item,
				income: Math.floor(item.income * (0.8 + (seed % 5) * 0.1) + (idx * 100)),
				expense: Math.floor(item.expense * (0.9 + (seed % 3) * 0.05))
			}));

			res.json({
				success: true,
				data: {
					dynamicStats,
					dynamicRevenueData
				}
			});

		} catch (error) {
			console.error(`[${timestamp}] [DASHBOARD ERROR] - Branch: ${branchId}, Error:`, error);
			return res.status(500).json({
				success: false,
				error: 'Failed to fetch dashboard data'
			});
		}
	}

	static async getBranchPerformance(req, res) {
		const timestamp = new Date().toISOString();
		try {
			const branches = await BranchModel.getAllActive();
			
			const performanceData = branches.map(branch => {
				// Simple seeding based on branch ID for mock data variation
				const seed = branch.IDNo;
				const revenue = 50000 + (seed * 12345 % 25000);
				return {
					id: branch.IDNo,
					name: branch.BRANCH_LABEL || branch.BRANCH_NAME,
					totalSales: revenue,
					totalExpenses: revenue * (0.6 + (seed * 0.01 % 0.25)), // Expenses between 60% and 85% of revenue
					totalOrders: 800 + (seed * 543 % 400),
					trend: (seed % 10) - 5,
				};
			});

			const summary = performanceData.reduce((acc, branch) => {
				acc.totalSales += branch.totalSales;
				acc.totalExpenses += branch.totalExpenses;
				return acc;
			}, { totalSales: 0, totalExpenses: 0 });

			summary.totalRevenue = summary.totalSales - summary.totalExpenses;

			res.json({
				success: true,
				data: {
					branches: performanceData,
					summary: summary
				}
			});

		} catch (error) {
			console.error(`[${timestamp}] [BRANCH PERFORMANCE ERROR] Error:`, error);
			return res.status(500).json({
				success: false,
				error: 'Failed to fetch branch performance data'
			});
		}
	}

	static async getMonthlyPerformance(req, res) {
		const timestamp = new Date().toISOString();
		try {
			const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
			
			const monthlyData = months.map((month, index) => {
				const seed = index + 1;
				const totalSales = 200000 + (seed * 50000 % 150000) + Math.random() * 20000;
				const totalExpenses = totalSales * (0.6 + (seed * 0.01 % 0.20)); // Expenses between 60% and 80%
				return {
					name: month.substring(0, 3),
					totalSales: totalSales,
					totalExpenses: totalExpenses,
				};
			});

			res.json({
				success: true,
				data: monthlyData
			});

		} catch (error) {
			console.error(`[${timestamp}] [MONTHLY PERFORMANCE ERROR] Error:`, error);
			return res.status(500).json({
				success: false,
				error: 'Failed to fetch monthly performance data'
			});
		}
	}

	// GET /api/app/version - lets tablets self-check for a newer APK build.
	// Reads latest.json by hand from the app-releases folder: after building
	// a new APK, copy it there and edit that one file - no DB row, no extra
	// deploy step, matches the existing manual build/scp workflow.
	static async getAppVersion(req, res) {
		try {
			const releaseDir = path.join(UPLOAD_ROOT, SUBDIRS.APP_RELEASES);
			const raw = await fs.readFile(path.join(releaseDir, 'latest.json'), 'utf8');
			const release = JSON.parse(raw);

			let baseUrl = req.protocol + '://' + req.get('host');
			if (req.get('x-forwarded-proto') === 'https' || req.get('host').includes('resto-admin.3core21.com')) {
				baseUrl = 'https://' + req.get('host');
			}

			const apkUrl = release.apkFileName
				? toPublicImageUrl(baseUrl, publicUrl(SUBDIRS.APP_RELEASES, release.apkFileName))
				: null;

			res.json({
				success: true,
				data: {
					versionCode: release.versionCode || 1,
					versionName: release.versionName || '1.0.0',
					apkUrl,
					releaseNotes: release.releaseNotes || '',
				}
			});
		} catch (error) {
			console.error('[APP VERSION ERROR]', error);
			return res.status(500).json({
				success: false,
				error: 'Failed to fetch app version info'
			});
		}
	}
}

module.exports = ApiController;
