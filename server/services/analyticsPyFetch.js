const { LRUCache } = require('lru-cache');

const PYSERVER_BASE_URL = process.env.PYSERVER_BASE_URL || 'http://127.0.0.1:2100';
const PYSERVER_TIMEOUT_MS = Number(process.env.ANALYTICS_PYSERVER_TIMEOUT_MS || 15000);
const CACHE_TTL_MS = Number(process.env.ANALYTICS_PY_CACHE_TTL_MS || 30000);
const CACHE_MAX = Number(process.env.ANALYTICS_PY_CACHE_MAX || 64);
/** Cap concurrent in-flight PyServer requests to avoid timeout stampedes. */
const PY_CONCURRENCY = Math.max(1, Number(process.env.ANALYTICS_PY_CONCURRENCY || 8));

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const pyCache = new LRUCache({ max: CACHE_MAX, ttl: CACHE_TTL_MS });

let pyInFlight = 0;
const pyWaitQueue = [];

function acquirePySlot() {
  if (pyInFlight < PY_CONCURRENCY) {
    pyInFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    pyWaitQueue.push(resolve);
  });
}

function releasePySlot() {
  const next = pyWaitQueue.shift();
  if (next) {
    next();
    return;
  }
  pyInFlight = Math.max(0, pyInFlight - 1);
}

function cacheKey(path, params) {
  const sorted = Object.entries(params || {})
    .filter(([, v]) => v != null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${path}?${sorted}`;
}

/** Do not cache empty menu/category report payloads (timeouts often surface as []). */
function shouldStorePyCache(path, json) {
  if (/\/menu-report$|\/category-report$/.test(String(path))) {
    const rows = json?.data?.data;
    return Array.isArray(rows) && rows.length > 0;
  }
  return true;
}

/**
 * Cached PyServer fetch for analytics endpoints (short TTL, same period reuses data).
 */
async function fetchPyCached(path, params, opts = {}) {
  const key = cacheKey(path, params);
  if (!opts.skipCacheRead) {
    const cached = pyCache.get(key);
    if (cached !== undefined) {
      if (shouldStorePyCache(path, cached)) {
        return cached;
      }
      pyCache.delete(key);
    }
  }

  const url = new URL(path, PYSERVER_BASE_URL);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  await acquirePySlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PYSERVER_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PyServer ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = await res.json().catch(() => null);
    if (!json || json.success === false) {
      throw new Error(json?.message || `PyServer ${path} returned error`);
    }
    if (!opts.skipCacheWrite && shouldStorePyCache(path, json)) {
      pyCache.set(key, json);
    }
    return json;
  } finally {
    clearTimeout(timer);
    releasePySlot();
  }
}

/**
 * Like fetchPyCached but returns null on failure (timeouts, PyServer down).
 * Used by dashboard bundles so one slow endpoint does not fail the whole payload.
 * Connection errors during boot are silent — warm path waits for PyServer first.
 */
function isPyConnectionError(msg) {
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|EAI_AGAIN/i.test(String(msg || ''));
}

async function fetchPyCachedOptional(path, params, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? PYSERVER_TIMEOUT_MS;
  try {
    return await fetchPyCached(path, params, { ...opts, timeoutMs });
  } catch (err) {
    const msg = err?.message || String(err);
    // Expected during brief restart race or when Py is down — no error log spam.
    if (isPyConnectionError(msg) || /aborted/i.test(msg)) {
      return null;
    }
    return null;
  }
}

module.exports = { fetchPyCached, fetchPyCachedOptional, cacheKey };
