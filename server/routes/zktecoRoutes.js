// ============================================
// ZKTECO ROUTES
// ============================================
// File: routes/zktecoRoutes.js
// Description: App-facing endpoints for ZKTeco (MB160) data. The frontend calls
// them through the /data-api proxy prefix. The device's own /iclock/* endpoints
// are on a separate port (services/admsServer.js).
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const { getUserBranches } = require('../middleware/branchAuth');
const ZktecoController = require('../controllers/zktecoController');

// ============================================
// GET ROUTES
// ============================================

// GET - Devices with online status and counts
router.get('/zkteco/devices', authenticate, getUserBranches, ZktecoController.getDevices);

// GET - Punches (newest first), with the app's corrections applied
// Query params: ?branch_id=all|X&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&device_id=X&limit=5000&include_deleted=1
router.get('/zkteco/attendance-logs', authenticate, getUserBranches, ZktecoController.getAttendanceLogs);

// GET - Users registered on the device(s). Query params: ?branch_id=&device_id=&include_deleted=1 (removed users too)
router.get('/zkteco/device-users', authenticate, getUserBranches, ZktecoController.getDeviceUsers);

// GET - Users added from the app that the device hasn't confirmed yet (or failed in the last day)
router.get('/zkteco/device-users/pending', authenticate, getUserBranches, ZktecoController.getPendingUserCommands);

// GET - Server-Sent Events: { type: attendance|users|commands|device } whenever the device sends data
router.get('/zkteco/events', authenticate, getUserBranches, ZktecoController.streamEvents);

// ============================================
// POST ROUTES
// ============================================

// POST - Add an employee to the device (queued; delivered on the device's next poll)
// Body: { device_id?, pin, profile?, name?, readd_of? (employee IDNo, for "Add again") }
router.post('/zkteco/device-users', authenticate, getUserBranches, ZktecoController.createDeviceUser);

// POST - Make the device prompt for a fingerprint for this user (ENROLL_FP)
// Body: { device_id, finger (0-9) }
router.post('/zkteco/device-users/:pin/fingerprint', authenticate, getUserBranches, ZktecoController.startFingerprintEnrollment);

// POST - Add a punch someone forgot (SOURCE = 'manual')
// Body: { employee_id, punch_dt: 'YYYY-MM-DD HH:mm:ss', status: 0 (time-in) | 1 (time-out), reason }
router.post('/zkteco/attendance-logs', authenticate, getUserBranches, ZktecoController.createManualPunch);

// POST - Restore a soft-deleted punch (device or manual)
router.post('/zkteco/attendance-logs/:id/restore', authenticate, getUserBranches, ZktecoController.restoreAttendanceLog);

// GET - Progress of a fingerprint command. Enroll: waiting | prompting | enrolled | timed_out | duplicate | expired | cancelled | failed. Remove: waiting | removed | cancelled | failed
router.get('/zkteco/enrollments/:id', authenticate, getUserBranches, ZktecoController.getEnrollment);

// ============================================
// PATCH ROUTES
// ============================================

// PATCH - Edit a punch's time/status. A device punch keeps the device's record (the edit is kept
// beside it); a manual punch is changed.
// Body: { punch_dt: 'YYYY-MM-DD HH:mm:ss', status: 0 (time-in) | 1 (time-out) | its current type, reason (required unless setting a device punch back to the device's values) }
router.patch('/zkteco/attendance-logs/:id', authenticate, getUserBranches, ZktecoController.updateAttendanceLog);

// ============================================
// DELETE ROUTES
// ============================================

// DELETE - Soft-delete a punch, device or manual (restorable). Body: { reason } (required)
router.delete('/zkteco/attendance-logs/:id', authenticate, getUserBranches, ZktecoController.deleteAttendanceLog);

// DELETE - Remove a user from the device (queued); their employee row stays (ZK_ON_DEVICE = 0) once the device confirms
// Query params: ?branch_id=&device_id=
router.delete('/zkteco/device-users/:pin', authenticate, getUserBranches, ZktecoController.deleteDeviceUser);

// DELETE - Cancel a user add/removal the device hasn't picked up yet
router.delete('/zkteco/user-commands/:id', authenticate, getUserBranches, ZktecoController.cancelUserCommand);

// DELETE - Cancel an enrollment/removal the device hasn't picked up yet
router.delete('/zkteco/enrollments/:id', authenticate, getUserBranches, ZktecoController.cancelEnrollment);

// DELETE - Remove one fingerprint from the device (needed before re-enrolling that finger)
// Query params: ?branch_id=&device_id=
router.delete('/zkteco/device-users/:pin/fingerprints/:finger', authenticate, getUserBranches, ZktecoController.removeFingerprint);

// ============================================
// EXPORT
// ============================================

module.exports = router;
