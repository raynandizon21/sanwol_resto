// Load env from project root before any route/model requires.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local'), override: true });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });

const express = require('express');
const http = require('http');
const routes = require('./routes');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const session = require('express-session');
const flash = require('connect-flash');
const i18n = require('i18n');

// Telegram bot removed - not needed for template
// const { startTelegramBot } = require('./utils/telegram');
// startTelegramBot(); // run once when server starts

const compression = require('compression');
const cors = require('cors');
const TelegramService = require('./services/telegramService');
const {
	ensureOrderItemsLineCostColumn,
	ensureOrdersFloorColumn,
	ensureRestaurantTablesColumns,
	ensureReceiptScanHistoryTable,
	ensureTelegramSettingsTable,
	ensureBankPaymentMethodEnum,
	ensureAnalyticsPerformanceIndexes,
} = require('./utils/ensureSchema');
const app = express();
app.use(compression());

// Respect reverse proxies (nginx/traefik) so req.protocol/host can be derived from forwarded headers.
// This matters when generating absolute URLs for assets (e.g. receipt scan uploads).
app.set('trust proxy', true);

const API_INFO_FILE = path.join(__dirname, 'public', 'api-info.html');

// CORS configuration - must be at the top to handle preflight requests
// TEMPORARY: Allow all origins for development - RESTRICT IN PRODUCTION!
app.use(cors({
  origin: true, // Allow all origins in development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
  optionsSuccessStatus: 200
}));

// i18n configuration
i18n.configure({
  locales: ['en', 'ko', 'ja', 'zh'], // Supported languages including Chinese
  directory: path.join(__dirname, 'locales'), // Directory where translation files are stored
  defaultLocale: 'en', // Default language
  cookie: 'lang', // Store language preference in a cookie
  queryParameter: 'lang', // Allow the language to be passed in the query string
  autoReload: true, // Automatically reload translation files when changed
  syncFiles: true, // Sync translation files with the current configuration
  objectNotation: true // Use object notation to access translations
});

// Middleware setup
app.use(cookieParser());
app.use(i18n.init);

// Middleware to set the language for each request
app.use((req, res, next) => {
  const lang = req.cookies.lang || 'en'; // Default to English if no language cookie is set
  i18n.setLocale(req, lang); // Set the language for the current request
  res.locals.currentLang = lang; // Make the current language available in the view templates
  next();
});

// Body parser middleware for handling form submissions
// 25MB keeps receipt stitch payloads stable while still bounded.
app.use(express.json({ limit: '25mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '25mb' }));

// Serve API info page (simple HTML for browser access)
app.use(express.static(path.join(__dirname, 'public'), {
	maxAge: '1h',
	etag: true
}));

// Serve uploaded menu images only (needed for API)
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads'), {
  maxAge: '1y',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Set proper Content-Type for WebP images
    if (filePath.endsWith('.webp')) {
      res.setHeader('Content-Type', 'image/webp');
    }
    // Cache images aggressively
    if (filePath.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
  }
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24,
    sameSite: 'lax', // so cookie is sent on GET from frontend (e.g. localhost:3000 -> localhost:2000)
  }
}));
app.use(flash());
app.use((req, res, next) => {
  res.locals.messages = req.flash();
  next();
});

// Session middleware for API routes (if needed)
// Note: Pure REST API - no EJS views, session mainly for backward compatibility
app.use((req, res, next) => {
  // Session data available for API routes if needed
  next();
});


app.use(passport.initialize());
app.use(passport.session());

// Set port
app.set('port', process.env.PORT || 2000);
// EJS view engine removed - pure REST API backend

// Static files removed - frontend should serve its own assets
// Language switch moved to API endpoint if needed
app.get('/api/change-lang', (req, res) => {
  const lang = req.query.lang;
  if (['en', 'ko', 'ja', 'zh'].includes(lang)) {
    res.cookie('lang', lang);
    i18n.setLocale(req, lang);
  }
  res.json({ success: true, language: lang });
});

// Public health-check endpoint — no auth required.
// Used by the Flutter offline-sync probe to verify server reachability
// without triggering 401 errors in the browser console.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});


// Returns HTML page if browser requests HTML, JSON otherwise
app.get('/', (req, res) => {
	const accepts = req.headers.accept || '';
	
	// If browser requests HTML, serve info page
	if (accepts.includes('text/html')) {
		return res.sendFile(API_INFO_FILE, (err) => {
			if (err) {
				// Fallback to JSON when the static info page is unavailable.
				return res.json({
					success: true,
					message: 'Restaurant Management System API',
					version: '2.0.0',
					documentation: '/api',
				});
			}
		});
	}
	
	// Otherwise return JSON (API clients, Postman, etc.)
	res.json({
		success: true,
		message: 'Restaurant Management System API',
		version: '2.0.0',
		documentation: '/api',
		endpoints: {
			auth: '/api/login',
			dashboard: '/dashboard/stats',
			orders: '/orders/data',
			menu: '/menus',
			categories: '/categories_list',
			tables: '/restaurant_tables',
			billing: '/billing/data',
			employees: '/employees_list',
			branches: '/branch'
		},
		authentication: {
			methods: ['JWT', 'Session'],
			jwt: 'Authorization: Bearer <token>',
			session: 'Cookie-based (backward compatible)'
		}
	});
});

// Handle favicon requests (common browser request)
app.get('/favicon.ico', (req, res) => {
	res.status(204).end(); // No content
});

// Handle robots.txt (common crawler request)
app.get('/robots.txt', (req, res) => {
	res.type('text/plain');
	res.send('User-agent: *\nDisallow: /');
});

// Register API routes with /api prefix (public endpoints for Android app)
// IMPORTANT: API routes must be registered FIRST to avoid route conflicts
app.use('/api', require('./routes/apiRoutes'));

// Register branch routes at /branch to avoid conflicts with /api routes
app.use('/branch', require('./routes/branchRoutes'));

// Register other routes
routes.forEach(router => app.use('/', router));

// 404 Handler - API endpoint not found
app.use((req, res) => {
	res.status(404).json({
		success: false,
		error: 'Endpoint not found',
		path: req.path,
		method: req.method,
		message: 'This is a REST API server. Please check the API documentation for available endpoints.'
	});
});

// Error Handler - Global error handler
app.use((err, req, res, next) => {
	console.error('Error:', err);
	res.status(err.status || 500).json({
		success: false,
		error: err.message || 'Internal server error',
		...(process.env.NODE_ENV === 'development' && { stack: err.stack })
	});
});

// Start the server
(async () => {
	try {
		await ensureOrderItemsLineCostColumn();
		await ensureOrdersFloorColumn();
		await ensureRestaurantTablesColumns();
		await ensureReceiptScanHistoryTable();
		await ensureTelegramSettingsTable();
		await ensureBankPaymentMethodEnum();
		await ensureAnalyticsPerformanceIndexes();
	} catch (e) {
		console.error('[Schema] ensure startup schema failed:', e?.message || e);
	}

	const server = app.listen(app.get('port'), function () {
		console.log('Server started on port ' + app.get('port'));
		console.log('API Server running at http://localhost:' + app.get('port'));
		console.log('Root endpoint: http://localhost:' + app.get('port') + '/');

		// Warm only the admin landing cache after PyServer is ready.
		// Branch/sales/menu-category boot warms stampeded PyServer and slowed first loads;
		// those pages still build on demand when opened (same logic, no warm required).
		setImmediate(() => {
			void (async () => {
				const { waitForPyServerReady } = require('./services/pyServerReady');
				const ready = await waitForPyServerReady();
				if (!ready) {
					console.warn('[PyServer] Not ready after boot wait — skipping dashboard cache warm');
					return;
				}

				const { warmAdminDashboardBundle } = require('./services/adminDashboardBundleCache');
				await warmAdminDashboardBundle().catch((err) => {
					console.warn('[AdminDashboardCache] Background warm error:', err?.message || err);
				});
			})();
		});

		const telegramPollingEnabled = String(process.env.TELEGRAM_POLLING_ENABLED || 'true').toLowerCase() !== 'false';
		if (telegramPollingEnabled) {
			TelegramService.startPolling().catch((error) => {
				console.error('[Telegram] Failed to start polling:', error?.message || error);
			});
			// console.log('[Telegram] Long polling enabled');
		}

		// Optional startup health check for Python analytics service.
		// Disabled by default to avoid noisy logs when PyServer is not running.
		const pyServerPingEnabled = String(process.env.PYSERVER_STARTUP_PING || '').toLowerCase() === 'true';
		if (pyServerPingEnabled) {
			// Prefer IPv4 loopback first to avoid localhost -> ::1 resolution issues.
			const pyServerPort = Number(process.env.PYSERVER_PORT || 2100);
			const samplePath = '/api/analytics/sample';
			const pyServerHosts = ['127.0.0.1', 'localhost'];

			const pingPyServer = (hostIndex = 0) => {
				const host = pyServerHosts[hostIndex];
				if (!host) return;

				const options = {
					hostname: host,
					port: pyServerPort,
					path: samplePath,
					method: 'GET',
					timeout: 3000,
				};

				const req = http.request(options, (res) => {
					let data = '';
					res.on('data', (chunk) => {
						data += chunk;
					});
					res.on('end', () => {
						console.log('[PyServer] status:', res.statusCode);
						console.log('[PyServer] response:', data);
					});
				});

				req.on('timeout', () => {
					req.destroy(new Error('Request timed out'));
				});

				req.on('error', () => {
					if (hostIndex < pyServerHosts.length - 1) {
						pingPyServer(hostIndex + 1);
					}
				});

				req.end();
			};

			pingPyServer();
		}

	});

	// Initialize Socket.io
	const socketService = require('./utils/socketService');
	socketService.initializeSocket(server);
})();
