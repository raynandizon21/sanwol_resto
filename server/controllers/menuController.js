// ============================================
// MENU CONTROLLER
// ============================================
// File: controllers/menuController.js
// Description: Handles menu-related business logic
// ============================================

const MenuModel = require('../models/menuModel');
const { SUBDIRS, publicUrl, toPublicImageUrl, safeDeletePublicFile } = require('../utils/uploadPaths');
const TranslationService = require('../utils/translationService');
const ApiResponse = require('../utils/apiResponse');

class MenuController {
	// Get all menus
	static async getAll(req, res) {
		try {
			// Prioritize query param so the frontend branch selector works for admin
			const rawBranch = req.query.branch_id ?? req.body.branch_id ?? req.session?.branch_id ?? req.user?.branch_id ?? null;
			// If 'all' is passed, fetch menus for ALL branches (admin view)
			const branchId = (rawBranch === 'all' || rawBranch === '') ? null : rawBranch;
			const includeDescription = !['0', 'false', 'no'].includes(String(req.query.include_description ?? '').toLowerCase());
			const menus = await MenuModel.getAll(branchId, { includeDescription });

			// Get target language from query parameter, cookie, or default to 'en'
			// If user selected Korean in UI, show original Korean text (no translation)
			// If user selected English/Japanese/Chinese, translate from Korean to that language
			const targetLanguage = req.query.lang || req.query.language || req.cookies?.lang || 'en';

			// Apply translation based on target language
			// Descriptions: ALWAYS translate to selected language (English descriptions should be translated to Korean, Japanese, Chinese, etc.)
			// Menu names & Category names: translate only if not Korean (Korean stays in Korean)
			const translateRequested = ['1', 'true', 'yes'].includes(String(req.query.translate || '').toLowerCase());
			if (TranslationService.isAvailable() && translateRequested) {
				// First, translate descriptions (always, regardless of target language)
				if (includeDescription) {
					try {
						const descTextsToTranslate = [];
						const descTextMapping = [];

						menus.forEach(menu => {
							if (menu.MENU_DESCRIPTION) {
								descTextsToTranslate.push(menu.MENU_DESCRIPTION);
								descTextMapping.push({ menu: menu });
							}
						});

						if (descTextsToTranslate.length > 0) {
							const descTranslations = await TranslationService.translateBatch(descTextsToTranslate, targetLanguage);
							descTranslations.forEach((translation, index) => {
								if (descTextMapping[index]) {
									descTextMapping[index].menu.MENU_DESCRIPTION = translation || descTextMapping[index].menu.MENU_DESCRIPTION;
								}
							});
						}
					} catch (descError) {
						console.error('[MENU CONTROLLER] Description translation error:', descError.message);
					}
				}

				// Then, translate menu names and category names
				// If Korean is selected: translate English text to Korean, keep Korean text as is
				// If other language is selected: translate to that language
				try {
					// Collect all texts to translate in batch
					const textsToTranslate = [];
					const textMapping = []; // Track which field each text belongs to

					menus.forEach(menu => {
						// Menu names: always translate (auto-detect will handle Korean vs English)
						if (menu.MENU_NAME) {
							textsToTranslate.push(menu.MENU_NAME);
							textMapping.push({ type: 'name', menu: menu });
						}
						// Category names: always translate (auto-detect will handle Korean vs English)
						if (menu.CATEGORY_NAME) {
							textsToTranslate.push(menu.CATEGORY_NAME);
							textMapping.push({ type: 'category', menu: menu });
						}
					});

					if (textsToTranslate.length > 0) {
						// Translate in batch - auto-detect source language (handles both Korean and English)
						// This will translate English to Korean when Korean is selected
						// And translate Korean to other languages when other languages are selected
						const translations = await TranslationService.translateBatch(textsToTranslate, targetLanguage);

						// Map translations back to menus
						translations.forEach((translation, index) => {
							const mapping = textMapping[index];
							if (mapping) {
								if (mapping.type === 'name') {
									mapping.menu.MENU_NAME = translation || mapping.menu.MENU_NAME;
								} else if (mapping.type === 'category') {
									mapping.menu.CATEGORY_NAME = translation || mapping.menu.CATEGORY_NAME;
								}
							}
						});
					}
				} catch (nameError) {
					console.error('[MENU CONTROLLER] Menu/Category name translation error:', nameError.message);
				}
			}

			return ApiResponse.success(res, menus, 'Menus retrieved successfully');
		} catch (error) {
			console.error('Error fetching menus:', error);
			return ApiResponse.error(res, 'Failed to fetch menus', 500, error.message);
		}
	}

	// Get menu by ID
	static async getById(req, res) {
		try {
			const { id } = req.params;
			const menu = await MenuModel.getById(id);

			if (!menu) {
				return ApiResponse.notFound(res, 'Menu');
			}

			// Format image URL if exists
			if (menu.MENU_IMG) {
				const baseUrl = req.protocol + '://' + req.get('host');
				menu.MENU_IMG = toPublicImageUrl(baseUrl, menu.MENU_IMG);
			}

			return ApiResponse.success(res, menu, 'Menu retrieved successfully');
		} catch (error) {
			console.error('Error fetching menu:', error);
			return ApiResponse.error(res, 'Failed to fetch menu', 500, error.message);
		}
	}

	// Get all categories for dropdown
	static async getCategories(req, res) {
		try {
			// Prioritize query param so the frontend branch selector works for admin
			const rawBranch = req.query.branch_id ?? req.body?.branch_id ?? req.session?.branch_id ?? req.user?.branch_id ?? null;
			// If 'all' is passed, fetch categories for ALL branches (admin view)
			const branchId = (rawBranch === 'all' || rawBranch === '') ? null : rawBranch;

			const categories = await MenuModel.getCategories(branchId);

			// Get target language from query parameter, cookie, or default to 'en'
			const targetLanguage = req.query.lang || req.query.language || req.cookies?.lang || 'en';

			// Apply translation for all languages (auto-detect will handle Korean vs English source)
			// This will translate English categories to Korean/Japanese/Chinese when those languages are selected
			// And translate Korean categories to English/Japanese/Chinese when those languages are selected
			const translateRequested = ['1', 'true', 'yes'].includes(String(req.query.translate || '').toLowerCase());
			if (TranslationService.isAvailable() && translateRequested) {
				try {
					// Collect all texts to translate
					const textsToTranslate = [];
					const textMapping = []; // Track which category each text belongs to

					categories.forEach(cat => {
						if (cat.CATEGORY_NAME) {
							textsToTranslate.push(cat.CATEGORY_NAME);
							textMapping.push({ cat: cat });
						}
					});

					if (textsToTranslate.length > 0) {
						// Translate in batch - auto-detect source language (handles both Korean and English)
						// Google Translate will auto-detect if the source is Korean or English
						const translations = await TranslationService.translateBatch(textsToTranslate, targetLanguage);

						// Map translations back to categories
						translations.forEach((translation, index) => {
							const mapping = textMapping[index];
							if (mapping && mapping.cat) {
								mapping.cat.CATEGORY_NAME = translation || mapping.cat.CATEGORY_NAME;
							}
						});
					}
				} catch (translationError) {
					console.error('[MENU CONTROLLER] Category translation error:', translationError);
					// Continue with original text if translation fails
				}
			}

			return ApiResponse.success(res, categories, 'Categories retrieved successfully');
		} catch (error) {
			console.error('Error fetching categories:', error);
			return ApiResponse.error(res, 'Failed to fetch categories', 500, error.message);
		}
	}

	// Create new menu
	static async create(req, res) {
		try {
			const {
				CATEGORY_ID,
				MENU_NAME,
				MENU_DESCRIPTION,
				MENU_PRICE,
				IS_AVAILABLE
			} = req.body;

			// Handle file upload
			let MENU_IMG = null;
			if (req.file) {
				MENU_IMG = publicUrl(SUBDIRS.MENU, req.file.filename);
			}

			const user_id = req.session.user_id || req.user?.user_id;
			// Prioritize explicit branch (admin branch selector), then fall back to session/user
			const branchId = req.body.BRANCH_ID || req.query.branch_id || req.session?.branch_id || req.user?.branch_id;
			if (!branchId) {
				return ApiResponse.badRequest(res, 'Branch ID is required. Please select a branch first.');
			}
			const menuId = await MenuModel.create({
				BRANCH_ID: branchId,
				CATEGORY_ID,
				MENU_NAME,
				MENU_DESCRIPTION,
				MENU_IMG,
				MENU_PRICE,
				IS_AVAILABLE,
				user_id
			});

			return ApiResponse.created(res, { id: menuId }, 'Menu created successfully');
		} catch (error) {
			console.error('Error creating menu:', error);
			return ApiResponse.error(res, 'Failed to create menu', 500, error.message);
		}
	}

	// Update menu
	static async update(req, res) {
		try {
			const { id } = req.params;
			const {
				CATEGORY_ID,
				MENU_NAME,
				MENU_DESCRIPTION,
				MENU_IMG, // This is the existing image URL from hidden input
				MENU_PRICE,
				IS_AVAILABLE
			} = req.body;

			// Handle file upload - if new file uploaded, use it; otherwise keep existing
			let imagePath = MENU_IMG; // Default to existing image
			if (req.file) {
				imagePath = publicUrl(SUBDIRS.MENU, req.file.filename);
				const existingMenu = await MenuModel.getById(id);
				if (existingMenu?.MENU_IMG && existingMenu.MENU_IMG !== imagePath) {
					await safeDeletePublicFile(existingMenu.MENU_IMG, SUBDIRS.MENU);
				}
			}

			const user_id = req.session.user_id;
			const updated = await MenuModel.update(id, {
				CATEGORY_ID,
				MENU_NAME,
				MENU_DESCRIPTION,
				MENU_IMG: imagePath,
				MENU_PRICE,
				IS_AVAILABLE,
				user_id
			});

			if (!updated) {
				return ApiResponse.notFound(res, 'Menu');
			}

			return ApiResponse.success(res, null, 'Menu updated successfully');
		} catch (error) {
			console.error('Error updating menu:', error);
			return ApiResponse.error(res, 'Failed to update menu', 500, error.message);
		}
	}

	// Delete menu
	static async delete(req, res) {
		try {
			const { id } = req.params;
			const user_id = req.session?.user_id || req.user?.user_id;

			const deleted = await MenuModel.delete(id, user_id);

			if (!deleted) {
				return res.status(404).json({ error: 'Menu not found' });
			}

			return ApiResponse.success(res, null, 'Menu deleted successfully');
		} catch (error) {
			console.error('Error deleting menu:', error);
			return ApiResponse.error(res, 'Failed to delete menu', 500, error.message);
		}
	}
}

module.exports = MenuController;

