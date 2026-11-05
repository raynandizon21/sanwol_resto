// ============================================
// ADMS SERVER
// ============================================
// File: services/admsServer.js
// Description: Separate HTTP listener (ZK_ADMS_PORT) that only serves /iclock/*
// for ZKTeco devices. Kept off the main API port so none of the app's CORS,
// session or auth middleware applies, and so it can be firewalled/exposed on
// its own when the app moves to the cloud. See docs/zkteco-mb160.md.
// ============================================

const express = require('express');
const AdmsService = require('./admsService');

<<<<<<< Updated upstream
const LOG_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

=======
>>>>>>> Stashed changes
const firstValue = (v) => (Array.isArray(v) ? v[0] : v);
const clientIp = (req) => String(req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');

// Optional: only these source IPs may talk to the listener (e.g. the restaurant's public IP when
// it is static). Empty = any IP; the device's serial number is then its only check.
const allowedIps = () =>
	String(process.env.ZK_ALLOWED_IPS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

// Which proxies' X-Forwarded-For to believe for the client IP. Default: only one on this machine
// (nginx/Caddy in front of the port). Believing any proxy would let anyone fake their IP and get
// past ZK_ALLOWED_IPS. Values as Express's "trust proxy" (e.g. "loopback", "10.0.0.0/8", "false").
const trustProxySetting = () => {
	const raw = String(process.env.ZK_TRUST_PROXY ?? '').trim();
	if (!raw) return 'loopback';
	if (raw === 'false') return false;
	return raw;
};

function createAdmsApp() {
	const app = express();
	app.disable('x-powered-by');
	// Some firmware mishandles 304s; always answer with the full body.
	app.set('etag', false);
	app.set('trust proxy', trustProxySetting());

	// Refuse other IPs before reading their body.
	app.use((req, res, next) => {
		const ips = allowedIps();
		if (ips.length && !ips.includes(clientIp(req))) {
			return res.status(403).set('Content-Type', 'text/plain; charset=utf-8').send('ERROR: not allowed');
		}
		return next();
	});

	// Device bodies are tab/newline text (sometimes binary JPEG); keep them raw.
	app.use(express.raw({ type: () => true, limit: '20mb' }));

	// Old firmware uses /iclock/cdata.aspx.
	app.all(/^\/iclock\/([A-Za-z]+)(?:\.aspx)?$/, async (req, res) => {
		const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
		const remoteIp = clientIp(req);
		const endpoint = req.params[0].toLowerCase();
		const query = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, firstValue(v)]));

		let status;
		let out;
		try {
			[status, out] = await AdmsService.dispatch(
				req.method,
				endpoint,
				query,
				AdmsService.decodeBody(rawBody),
				remoteIp
			);
		} catch (err) {
			console.error('[ADMS]', err);
			[status, out] = [500, 'ERROR'];
		}

		// Buffer body: Express sends an explicit Content-Length (some firmware mishandles chunked replies).
		res.status(status).set('Content-Type', 'text/plain; charset=utf-8').send(Buffer.from(out, 'utf8'));
	});

	app.use((req, res) => {
		res.status(404).set('Content-Type', 'text/plain; charset=utf-8').send('Not found');
	});

	return app;
}

/** Starts the listener when ZK_ADMS_PORT is set; returns the http.Server or null. */
function startAdmsServer() {
	const port = Number(process.env.ZK_ADMS_PORT || 0);
	if (!port) {
		console.log('[ADMS] ZK_ADMS_PORT not set — ZKTeco device listener disabled');
		return null;
	}

	const server = createAdmsApp().listen(port, '0.0.0.0', () => {
		console.log(`[ADMS] ZKTeco device listener on port ${port} (/iclock/*)`);
		if (!String(process.env.ZK_ALLOWED_SERIALS || '').trim()) {
			console.warn('[ADMS] ZK_ALLOWED_SERIALS is empty: only devices registered before are accepted; new ones are refused');
		}
	});
	server.on('error', (err) => {
		// Don't take the main API down if the port is taken.
		console.error(`[ADMS] listener on port ${port} failed:`, err.message || err);
	});

<<<<<<< Updated upstream
	const prune = () =>
		AdmsService.pruneLogs().catch((err) =>
			console.warn('[ADMS] log prune failed:', err.message || err)
		);
	prune();
	setInterval(prune, LOG_PRUNE_INTERVAL_MS).unref();

=======
>>>>>>> Stashed changes
	return server;
}

module.exports = { startAdmsServer, createAdmsApp };
