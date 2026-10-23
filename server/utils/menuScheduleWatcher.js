// ============================================
// MENU SCHEDULE WATCHER
// ============================================
// File: utils/menuScheduleWatcher.js
// Description: Nobody presses anything when breakfast ends, so every 30 s
// this checks which items / categories with available hours are inside
// their window and sends menu_updated when that changes; the tablets then
// reload their menu.
// ============================================

const pool = require('../config/db');
const CategoryModel = require('../models/categoryModel');
const MenuModel = require('../models/menuModel');
const { isWithinHours, storeNowMinutes } = require('./menuSchedule');
const { emitMenuUpdated } = require('./socketService');

const INTERVAL_MS = 30 * 1000;
let lastSignature = null;
let timer = null;

async function currentSignature() {
	await CategoryModel.ensureSchema();
	await MenuModel.ensureSchema();
	const [cats] = await pool.execute(
		'SELECT IDNo, AVAILABLE_FROM, AVAILABLE_TO FROM categories WHERE ACTIVE = 1 AND AVAILABLE_FROM IS NOT NULL AND AVAILABLE_TO IS NOT NULL'
	);
	const [menus] = await pool.execute(
		'SELECT IDNo, AVAILABLE_FROM, AVAILABLE_TO FROM menu WHERE ACTIVE = 1 AND AVAILABLE_FROM IS NOT NULL AND AVAILABLE_TO IS NOT NULL'
	);
	const now = storeNowMinutes();
	const open = (rows, prefix) => rows
		.filter((r) => isWithinHours(r.AVAILABLE_FROM, r.AVAILABLE_TO, now))
		.map((r) => `${prefix}${r.IDNo}`);
	return [...open(cats, 'c'), ...open(menus, 'm')].sort().join(',');
}

async function tick() {
	try {
		const signature = await currentSignature();
		// The first check only records the state (no reload at server start).
		if (lastSignature !== null && signature !== lastSignature) {
			emitMenuUpdated({ reason: 'schedule' });
		}
		lastSignature = signature;
	} catch (e) {
		console.warn('[MenuScheduleWatcher]', e?.message || e);
	}
}

function startMenuScheduleWatcher() {
	if (timer) return;
	tick();
	timer = setInterval(tick, INTERVAL_MS);
	if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { startMenuScheduleWatcher };
