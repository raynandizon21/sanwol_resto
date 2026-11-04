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

// POST - Add a user to the device (queued; delivered on the device's next poll)
// Body: { device_id?, pin, name, privilege (0 user | 14 admin), password? }
router.post('/zkteco/device-users', authenticate, getUserBranches, ZktecoController.createDeviceUser);

// POST - Make the device prompt for a fingerprint for this user (ENROLL_FP)
// Body: { device_id, finger (0-9) }
router.post('/zkteco/device-users/:pin/fingerprint', authenticate, getUserBranches, ZktecoController.startFingerprintEnrollment);

// POST - Restore a soft-deleted punch
router.post('/zkteco/attendance-logs/:id/restore', authenticate, getUserBranches, ZktecoController.restoreAttendanceLog);

// POST - Add a punch someone forgot (stored apart from the device's punches)
// Body: { device_user_id, punch_dt: 'YYYY-MM-DD HH:mm:ss', status: 0-5, reason }
router.post('/zkteco/manual-punches', authenticate, getUserBranches, ZktecoController.createManualPunch);

// POST - Restore a deleted manual punch
router.post('/zkteco/manual-punches/:id/restore', authenticate, getUserBranches, ZktecoController.restoreManualPunch);

// GET - Progress of a fingerprint command. Enroll: waiting | prompting | enrolled | timed_out | duplicate | expired | cancelled | failed. Remove: waiting | removed | cancelled | failed
router.get('/zkteco/enrollments/:id', authenticate, getUserBranches, ZktecoController.getEnrollment);

// ============================================
// PATCH ROUTES
// ============================================

// PATCH - Correct a punch's time/status (stored as a correction; the raw punch is never changed)
// Body: { punch_dt: 'YYYY-MM-DD HH:mm:ss', status: 0 (time-in) | 1 (time-out) | its current type, reason? }
router.patch('/zkteco/attendance-logs/:id', authenticate, getUserBranches, ZktecoController.updateAttendanceLog);

// PATCH - Change a manual punch's time/status. Body: { punch_dt, status: 0 | 1 | its current type, reason? }
router.patch('/zkteco/manual-punches/:id', authenticate, getUserBranches, ZktecoController.updateManualPunch);


// ============================================
// DELETE ROUTES
// ============================================

// DELETE - Soft-delete a punch (restorable). Body: { reason? }
router.delete('/zkteco/attendance-logs/:id', authenticate, getUserBranches, ZktecoController.deleteAttendanceLog);

// DELETE - Soft-delete a manual punch (restorable). Body: { reason? }
router.delete('/zkteco/manual-punches/:id', authenticate, getUserBranches, ZktecoController.deleteManualPunch);

// DELETE - Remove a user from the device (queued); soft-deleted here once the device confirms
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
