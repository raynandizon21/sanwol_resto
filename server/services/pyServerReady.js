const PYSERVER_BASE_URL = process.env.PYSERVER_BASE_URL || 'http://127.0.0.1:2100';
const DEFAULT_MAX_WAIT_MS = Number(process.env.PYSERVER_BOOT_WAIT_MS || 60000);
const DEFAULT_POLL_MS = Number(process.env.PYSERVER_BOOT_POLL_MS || 500);

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Block until PyServer responds on /docs (or timeout).
 * Used on boot before dashboard cache warm to avoid ECONNREFUSED log spam.
 */
async function waitForPyServerReady(opts = {}) {
	const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
	const healthUrl = `${PYSERVER_BASE_URL.replace(/\/$/, '')}/docs`;
	const started = Date.now();

	while (Date.now() - started < maxWaitMs) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 2000);
			try {
				const res = await fetch(healthUrl, { signal: controller.signal });
				if (res.ok) return true;
			} finally {
				clearTimeout(timer);
			}
		} catch {
			// PyServer still starting
		}
		await delay(pollMs);
	}

	return false;
}

module.exports = { waitForPyServerReady };
