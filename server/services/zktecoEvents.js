// ============================================
// ZKTECO EVENTS
// ============================================
// File: services/zktecoEvents.js
// Description: In-process notifications from the ADMS receiver to open
// Attendance Logs / Device Users pages (streamed by GET /zkteco/events).
// The receiver and the API run in the same Node process, so an EventEmitter is
// enough; running several API processes would need a shared bus (e.g. Redis pub/sub).
// ============================================

const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per open page

/**
 * @param {'attendance'|'users'|'commands'|'device'} type what changed
 * @param {{ IDNo: number, BRANCH_ID: number|null }} device
 */
function emitZkChange(type, device) {
	emitter.emit('change', { type, deviceId: device.IDNo, branchId: device.BRANCH_ID ?? null });
}

/** @returns {() => void} unsubscribe */
function onZkChange(listener) {
	emitter.on('change', listener);
	return () => emitter.off('change', listener);
}

module.exports = { emitZkChange, onZkChange };
