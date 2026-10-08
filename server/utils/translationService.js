// ============================================
// TRANSLATION SERVICE
// ============================================
// File: utils/translationService.js
// Description: Google Cloud Translation API service for menu names and categories
// ============================================

const { Translate } = require('@google-cloud/translate').v2;
// Use built-in fetch (Node.js 18+) instead of node-fetch to avoid ES Module warnings

// Initialize Google Cloud Translation client
// Supports multiple authentication methods:
// 1. Service Account JSON key file (GOOGLE_APPLICATION_CREDENTIALS) - Recommended
// 2. Project ID with Application Default Credentials (GOOGLE_CLOUD_PROJECT_ID)
// 3. API Key via REST API (GOOGLE_TRANSLATE_API_KEY) - Simpler but uses REST API
let translateClient = null;
let apiKey = null;
let useRestApi = false;

try {
	// Priority 1: API Key (uses REST API instead of library)
	if (process.env.GOOGLE_TRANSLATE_API_KEY) {
		apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
		useRestApi = true;
		console.log('[TRANSLATION SERVICE] Google Cloud Translation initialized with API Key (REST API)');
	}
	// Priority 2: Service Account JSON key file
	else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
		const config = {
			keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
		};
		
		if (process.env.GOOGLE_CLOUD_PROJECT_ID) {
			config.projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
		}
		
		translateClient = new Translate(config);
		console.log('[TRANSLATION SERVICE] Google Cloud Translation initialized with Service Account');
	}
	// Priority 3: Project ID only (uses Application Default Credentials)
	else if (process.env.GOOGLE_CLOUD_PROJECT_ID) {
		const config = {
			projectId: process.env.GOOGLE_CLOUD_PROJECT_ID
		};
		
		translateClient = new Translate(config);
		console.log('[TRANSLATION SERVICE] Google Cloud Translation initialized with Project ID');
	} else {
		console.warn('[TRANSLATION SERVICE] Google Cloud Translation not configured.');
		console.warn('[TRANSLATION SERVICE] Set one of these environment variables:');
		console.warn('[TRANSLATION SERVICE]   - GOOGLE_TRANSLATE_API_KEY (simplest, uses REST API)');
		console.warn('[TRANSLATION SERVICE]   - GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON)');
		console.warn('[TRANSLATION SERVICE]   - GOOGLE_CLOUD_PROJECT_ID (for Application Default Credentials)');
	}
} catch (error) {
	console.error('[TRANSLATION SERVICE] Error initializing Google Cloud Translation:', error.message);
}

class TranslationService {
	/**
	 * Translate text from source language to target language
	 * @param {string} text - Text to translate
	 * @param {string} targetLanguage - Target language code (e.g., 'en', 'ko', 'ja', 'zh')
	 * @param {string} sourceLanguage - Source language code (optional, auto-detect if not provided)
	 * @returns {Promise<string>} Translated text
	 */
	static async translateText(text, targetLanguage = 'en', sourceLanguage = null) {
		// If translation service is not configured, return original text
		if (!translateClient && !apiKey) {
			return text;
		}

		// If text is empty or null, return as is
		if (!text || typeof text !== 'string' || text.trim() === '') {
			return text;
		}

		try {
			// Normalize Chinese language code for better precision
			// Use zh-CN (Simplified Chinese) for better accuracy
			let normalizedTargetLanguage = targetLanguage;
			if (targetLanguage === 'zh' || targetLanguage.toLowerCase() === 'chinese') {
				normalizedTargetLanguage = 'zh-CN'; // Use Simplified Chinese for better precision
			}
			
			// Use REST API if API key is provided
			if (useRestApi && apiKey) {
				const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
				const body = {
					q: text,
					target: normalizedTargetLanguage,
					format: 'text' // Ensure text format for better precision
				};
				
				if (sourceLanguage) {
					body.source = sourceLanguage;
				}

				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(body)
				});

				if (!response.ok) {
					const errorText = await response.text();
					console.error(`[TRANSLATION SERVICE] API Error Response: ${errorText}`);
					throw new Error(`Translation API error: ${response.status} ${response.statusText} - ${errorText}`);
				}

				const data = await response.json();
				
				if (!data.data || !data.data.translations || !data.data.translations[0]) {
					console.error(`[TRANSLATION SERVICE] Unexpected API response format:`, JSON.stringify(data));
					throw new Error('Invalid translation API response format');
				}
				
				return data.data.translations[0].translatedText;
			}
			
			// Use library for service account authentication
			// normalizedTargetLanguage is already declared above
			const options = {
				to: normalizedTargetLanguage
			};

			// If source language is provided, use it; otherwise auto-detect
			if (sourceLanguage) {
				options.from = sourceLanguage;
			}

			const [translation] = await translateClient.translate(text, options);
			return translation;
		} catch (error) {
			console.error(`[TRANSLATION SERVICE] Error translating text:`, error.message);
			// Return original text if translation fails
			return text;
		}
	}

	/**
	 * Translate multiple texts in batch
	 * @param {string[]} texts - Array of texts to translate
	 * @param {string} targetLanguage - Target language code
	 * @param {string} sourceLanguage - Source language code (optional)
	 * @returns {Promise<string[]>} Array of translated texts
	 */
	static async translateBatch(texts, targetLanguage = 'en', sourceLanguage = null) {
		// If translation service is not configured, return original texts
		if (!translateClient && !apiKey) {
			return texts;
		}

		// Filter out empty texts
		const validTexts = texts.filter(text => text && typeof text === 'string' && text.trim() !== '');
		
		if (validTexts.length === 0) {
			return texts;
		}

		// Normalize Chinese language code for better precision
		// Use zh-CN (Simplified Chinese) for better accuracy
		let normalizedTargetLanguage = targetLanguage;
		if (targetLanguage === 'zh' || targetLanguage.toLowerCase() === 'chinese') {
			normalizedTargetLanguage = 'zh-CN'; // Use Simplified Chinese for better precision
		}

		try {
			// Use REST API if API key is provided
			if (useRestApi && apiKey) {
				// Google Cloud Translation API limit: 128 text segments per request
				const MAX_SEGMENTS_PER_REQUEST = 128;
				const allTranslations = [];
				
				// Split texts into chunks of 128
				for (let i = 0; i < validTexts.length; i += MAX_SEGMENTS_PER_REQUEST) {
					const chunk = validTexts.slice(i, i + MAX_SEGMENTS_PER_REQUEST);
					
					const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
					const body = {
						q: chunk,
						target: normalizedTargetLanguage,
						format: 'text' // Ensure text format for better precision
					};
					
					if (sourceLanguage) {
						body.source = sourceLanguage;
					}

					const response = await fetch(url, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify(body)
					});

					if (!response.ok) {
						const errorText = await response.text();
						console.error(`[TRANSLATION SERVICE] Batch API Error Response (chunk ${Math.floor(i / MAX_SEGMENTS_PER_REQUEST) + 1}): ${errorText}`);
						throw new Error(`Translation API error: ${response.status} ${response.statusText} - ${errorText}`);
					}

					const data = await response.json();
					
					if (!data.data || !data.data.translations) {
						console.error(`[TRANSLATION SERVICE] Unexpected batch API response format:`, JSON.stringify(data));
						throw new Error('Invalid translation API response format');
					}
					
					const chunkTranslations = data.data.translations.map(t => t.translatedText);
					allTranslations.push(...chunkTranslations);
				}
				
				// Map translations back to original array structure
				let translationIndex = 0;
				return texts.map(text => {
					if (text && typeof text === 'string' && text.trim() !== '') {
						return allTranslations[translationIndex++] || text;
					}
					return text;
				});
			}
			
			// Use library for service account authentication
			// Google Cloud Translation API limit: 128 text segments per request
			const MAX_SEGMENTS_PER_REQUEST = 128;
			const allTranslations = [];
			
			// Normalize Chinese language code for better precision (if not already normalized)
			// Use zh-CN (Simplified Chinese) for better accuracy
			let normalizedTargetLanguageForLib = normalizedTargetLanguage;
			if (!normalizedTargetLanguageForLib) {
				normalizedTargetLanguageForLib = targetLanguage;
				if (targetLanguage === 'zh' || targetLanguage.toLowerCase() === 'chinese') {
					normalizedTargetLanguageForLib = 'zh-CN'; // Use Simplified Chinese for better precision
				}
			}
			
			// Split texts into chunks of 128
			for (let i = 0; i < validTexts.length; i += MAX_SEGMENTS_PER_REQUEST) {
				const chunk = validTexts.slice(i, i + MAX_SEGMENTS_PER_REQUEST);
				
				const options = {
					to: normalizedTargetLanguageForLib
				};

				if (sourceLanguage) {
					options.from = sourceLanguage;
				}

				const [chunkTranslations] = await translateClient.translate(chunk, options);
				
				// Handle both single translation and array of translations
				const translationArray = Array.isArray(chunkTranslations) ? chunkTranslations : [chunkTranslations];
				allTranslations.push(...translationArray);
			}
			
			// Map translations back to original array structure
			let translationIndex = 0;
			return texts.map(text => {
				if (text && typeof text === 'string' && text.trim() !== '') {
					return allTranslations[translationIndex++] || text;
				}
				return text;
			});
		} catch (error) {
			console.error(`[TRANSLATION SERVICE] Error translating batch:`, error.message);
			// Return original texts if translation fails
			return texts;
		}
	}

	/**
	 * Detect the language of a text
	 * @param {string} text - Text to detect language for
	 * @returns {Promise<string>} Language code (e.g., 'ko', 'en', 'ja')
	 */
	static async detectLanguage(text) {
		if (!translateClient) {
			return 'en'; // Default to English if service not configured
		}

		if (!text || typeof text !== 'string' || text.trim() === '') {
			return 'en';
		}

		try {
			const [detection] = await translateClient.detect(text);
			return detection.language;
		} catch (error) {
			console.error(`[TRANSLATION SERVICE] Error detecting language:`, error.message);
			return 'en'; // Default to English on error
		}
	}

	/**
	 * Check if translation service is available
	 * @returns {boolean} True if translation service is configured
	 */
	static isAvailable() {
		return translateClient !== null || apiKey !== null;
	}
}

module.exports = TranslationService;

