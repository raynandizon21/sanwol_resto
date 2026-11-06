// ============================================
// ZKTECO CONTROLLER
// ============================================
// File: controllers/zktecoController.js
// Description: Endpoints for the ZKTeco (MB160) pages: Attendance Logs and Device Users
// (reads, adding a user to the device, and a live change stream).
// The device itself talks to services/admsServer.js, not to these routes.
// ============================================

const ZktecoModel = require('../models/zktecoModel');
const EmployeeModel = require('../models/employeeModel');
const AdmsService = require('../services/admsService');
const { onZkChange, emitZkChange } = require('../services/zktecoEvents');
const { initSse, sendSse } = require('../utils/sse');
const ApiResponse = require('../utils/apiResponse');
const {
	YMD,
	HttpError,
	resolveBranchScope,
	inScope,
	hasCrudPermission,
	handleError,
	cleanReason,
	isValidWallClock,
} = require('../utils/zktecoHttp');
const { readProfile, cleanDeviceName, deviceNameFor, charCount, DEVICE_NAME_MAX } = require('../utils/employeeProfile');

const SSE_HEARTBEAT_MS = 25000;

// Limits for users pushed to the MB160. PIN: digits without a leading zero (the device
// keypad enters digits, and "05" vs "5" would be two users). Name: the device shows ~24
// characters. No password, card or admin role from the app: staff use fingerprints, and
// cards and admins are set on the device (see docs/zkteco-mb160.md).
const NEW_USER_RULES = {
	pin: /^[1-9]\d{0,8}$/,
	nameMax: DEVICE_NAME_MAX,
};

const hasDeviceUserPermission = (req, actions) => hasCrudPermission(req, 'device_users', actions);
const canCreateDeviceUser = (req) => hasDeviceUserPermission(req, ['create']);
// Enrolling a finger is an edit of an existing user, but it is also the second step of
// adding one, so either permission allows it.
const canEnrollFingerprint = (req) => hasDeviceUserPermission(req, ['create', 'update']);
const canEditDeviceUser = (req) => hasDeviceUserPermission(req, ['update']);
const canDeleteDeviceUser = (req) => hasDeviceUserPermission(req, ['delete']);
const canEditPunch = (req) => hasCrudPermission(req, 'attendance_logs', ['update']);
const canDeletePunch = (req) => hasCrudPermission(req, 'attendance_logs', ['delete']);
const canAddPunch = (req) => hasCrudPermission(req, 'attendance_logs', ['create']);

// Punch types the app sets (attendance is basic time tracking): Time-in (0) and Time-out (1).
// A punch edited in the app may also keep the type it already has (e.g. OT-in from the device,
// which counts as arriving anyway; see services/attendanceEngine.js).
const APP_PUNCH_STATUSES = [0, 1];
const statusAllowed = (status, current = []) =>
	APP_PUNCH_STATUSES.includes(status) || current.some((c) => c != null && Number(c) === status);

/** Notifies open Attendance Logs / Employees pages after a punch changes. */
const emitPunchChange = (punch) => emitZkChange('attendance', { IDNo: punch.DEVICE_ID, BRANCH_ID: punch.BRANCH_ID });

/**
 * Validates a punch's new time and status; returns an error message or null. `current`: statuses
 * the punch may keep. `duplicateOf`: { employeeId, excludeId } to refuse a second punch of the same
 * person at the exact same time (manual punches).
 */
async function punchError({ punchDt, status, current = [], duplicateOf = null }) {
	if (!isValidWallClock(punchDt)) return 'Enter a valid date and time';
	// Both are device-local "YYYY-MM-DD HH:mm:ss", so they compare as text.
	if (punchDt > String(await ZktecoModel.deviceNow())) return "The punch time can't be in the future";
	if (!statusAllowed(status, current)) return 'Choose Time-in or Time-out';
	if (duplicateOf && (await ZktecoModel.punchExistsAt(duplicateOf.employeeId, punchDt, duplicateOf.excludeId))) {
		return 'This person already has a punch at that exact time';
	}
	return null;
}

const FINGER_MAX = 9; // FID 0-9

/** Device row in the caller's branch scope, or an HttpError. */
async function getScopedDevice(scope, deviceId) {
	const device = await ZktecoModel.getDeviceById(deviceId);
	if (!device || (scope && !scope.includes(Number(device.BRANCH_ID)))) throw new HttpError(404, 'Device not found');
	if (!Number(device.ACTIVE)) throw new HttpError(400, 'This device is disabled');
	return device;
}

class ZktecoController {
	// GET /zkteco/devices?branch_id=
	static async getDevices(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const devices = await ZktecoModel.getDevices(scope);
			return ApiResponse.success(res, devices, 'Devices retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'devices');
		}
	}

	// GET /zkteco/attendance-logs?branch_id=&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&device_id=&limit=&include_deleted=1
	static async getAttendanceLogs(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const { start_date, end_date, device_id, limit } = req.query;
			if ((start_date && !YMD.test(start_date)) || (end_date && !YMD.test(end_date))) {
				return ApiResponse.badRequest(res, 'Dates must be YYYY-MM-DD');
			}
			const { rows, truncated, limit: appliedLimit } = await ZktecoModel.getAttendanceLogs(scope, {
				start_date,
				end_date,
				device_id: parseInt(device_id, 10) || null,
				limit,
				include_deleted: req.query.include_deleted === '1',
			});
			// The newest `appliedLimit` punches only; the page says so instead of showing a short count.
			res.set('X-Result-Truncated', truncated ? String(appliedLimit) : '0');
			return ApiResponse.success(res, rows, 'Attendance logs retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'attendance logs');
		}
	}

	// GET /zkteco/device-users?branch_id=&device_id=&include_deleted=1
	// One row per employee on the device (IDNo = employee.IDNo), with PROFILE: their profile fields.
	static async getDeviceUsers(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const users = await ZktecoModel.getDeviceUsers(scope, {
				device_id: parseInt(req.query.device_id, 10) || null,
				include_deleted: req.query.include_deleted === '1',
			});
			const profiles = new Map(
				(await EmployeeModel.getProfilesByIds(users.map((u) => u.IDNo))).map((p) => [Number(p.IDNo), p])
			);
			const withProfiles = users.map((u) => ({ ...u, PROFILE: profiles.get(Number(u.IDNo)) || null }));
			return ApiResponse.success(res, withProfiles, 'Device users retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'device users');
		}
	}

	// GET /zkteco/device-users/pending?branch_id=  (pushes from the app not yet on the device)
	static async getPendingUserCommands(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const rows = await ZktecoModel.getPendingUserCommands(scope);
			return ApiResponse.success(res, rows, 'Pending device users retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'pending device users');
		}
	}

	// GET /zkteco/device-users/next-pin?device_id=&readd_of=  → { pin, reusedOld }
	// The User ID Add employee shows. The add assigns it again under a lock, so another add
	// sent in between can still move it on by one (the form then tells the user).
	static async getNextUserPin(req, res) {
		try {
			if (!(await canCreateDeviceUser(req))) {
				return ApiResponse.forbidden(res, 'You are not allowed to add users to the attendance device');
			}
			const device = await getScopedDevice(resolveBranchScope(req), parseInt(req.query.device_id, 10));
			const next = await ZktecoModel.nextNewUserPin(device.IDNo, parseInt(req.query.readd_of, 10) || null);
			return ApiResponse.success(res, next, 'Next User ID retrieved successfully');
		} catch (error) {
			if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
			return handleError(res, error, 'next User ID');
		}
	}

	// POST /zkteco/device-users  { device_id?, profile?, name?, readd_of? }
	// readd_of: "Add again" of that removed employee (employee.IDNo): the same person goes back on.
	// The User ID is assigned here (ZktecoModel.nextNewUserPin); a `pin` in the body is ignored.
	// Queues DATA UPDATE USERINFO; the device picks it up on its next poll (≤ 10 s).
	// The person is put on the device in the app once it confirms (admsService.applyCommandResult).
	static async createDeviceUser(req, res) {
		try {
			if (!(await canCreateDeviceUser(req))) {
				return ApiResponse.forbidden(res, 'You are not allowed to add users to the attendance device');
			}
			const scope = resolveBranchScope(req);
			const body = req.body || {};

			let deviceId = parseInt(body.device_id, 10) || null;
			if (!deviceId) {
				const devices = await ZktecoModel.getDevices(scope);
				if (devices.length !== 1) {
					return ApiResponse.badRequest(res, devices.length ? 'Choose a device' : 'No attendance device for this branch');
				}
				deviceId = devices[0].IDNo;
			}
			const device = await ZktecoModel.getDeviceById(deviceId);
			if (!device || (scope && !scope.includes(Number(device.BRANCH_ID)))) {
				return ApiResponse.error(res, 'Device not found', 404);
			}
			if (!Number(device.ACTIVE)) return ApiResponse.badRequest(res, 'This device is disabled');

			// Profile details (optional; first name required when sent). They're written to the
			// employee profile once the device confirms the user.
			let profileFields = null;
			if (body.profile != null) {
				if (typeof body.profile !== 'object' || Array.isArray(body.profile)) return ApiResponse.badRequest(res, 'Invalid profile');
				const { fields, error } = readProfile({ first_name: '', ...body.profile });
				if (error) return ApiResponse.badRequest(res, error);
				profileFields = fields;
			}

			// The name on the device follows the profile name, shortened to fit (it isn't typed
			// separately). Only a request without a profile names the user directly.
			const name = profileFields ? deviceNameFor(profileFields.FIRSTNAME, profileFields.LASTNAME) : cleanDeviceName(body.name);
			if (!name || charCount(name) > NEW_USER_RULES.nameMax) {
				return ApiResponse.badRequest(res, `Name is required (up to ${NEW_USER_RULES.nameMax} characters)`);
			}
			const readdOfId = parseInt(body.readd_of, 10) || null;
			if (readdOfId) {
				const blocker = await ZktecoModel.readdBlocker(device.IDNo, readdOfId);
				if (blocker) return ApiResponse.error(res, blocker, 409);
			}

			// Picking the ID and queueing the add happen under one lock, so two adds sent at the
			// same time get different IDs. Everyone added from the app is a regular user with no
			// password: staff punch with their fingerprint, and device admins are made on the MB160.
			const { commandId, pin } = await ZktecoModel.withAddUserLock(device.IDNo, async () => {
				const { pin: nextPin } = await ZktecoModel.nextNewUserPin(device.IDNo, readdOfId);
				const id = await AdmsService.queueCommand(
					device.IDNo,
					`Add user ${nextPin} (${name})`,
					AdmsService.buildUserUpsertCommand({ pin: nextPin, name, privilege: AdmsService.PRIVILEGE_USER, password: '' }),
					req.user?.user_id ?? null,
					{
						employeeId: readdOfId,
						profileJson: profileFields ? JSON.stringify({ fields: profileFields, userId: req.user?.user_id ?? null }) : null,
					}
				);
				return { commandId: id, pin: nextPin };
			});
			return ApiResponse.created(res, { commandId, deviceId: device.IDNo, pin }, 'User queued for the device');
		} catch (error) {
			if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
			console.error('Error creating device user:', error);
			return ApiResponse.error(res, 'Failed to add the user', 500, error.message);
		}
	}

	// POST /zkteco/device-users/:pin/fingerprint  { device_id, finger (0-9) }
	// Queues ENROLL_FP: on its next poll (≤ 10 s) the device shows its "place finger" prompt
	// for ~60 s. Works right after POST /zkteco/device-users too: commands run in order, so
	// the device creates the user first. Poll GET /zkteco/enrollments/:id for progress.
	static async startFingerprintEnrollment(req, res) {
		try {
			if (!(await canEnrollFingerprint(req))) {
				return ApiResponse.forbidden(res, 'You are not allowed to enroll fingerprints on the attendance device');
			}
			const scope = resolveBranchScope(req);
			const device = await getScopedDevice(scope, parseInt(req.body?.device_id, 10));

			const pin = String(req.params.pin || '').trim();
			const finger = Number(req.body?.finger);
			if (!NEW_USER_RULES.pin.test(pin)) return ApiResponse.badRequest(res, 'Invalid User ID');
			if (!Number.isInteger(finger) || finger < 0 || finger > FINGER_MAX) {
				return ApiResponse.badRequest(res, 'Choose a finger');
			}
			// On the device, or its add command still on the way.
			if (!(await ZktecoModel.isPinTaken(device.IDNo, pin))) {
				return ApiResponse.error(res, `User ID ${pin} is not on this device`, 404);
			}
			// The device rejects re-scanning an enrolled finger as a duplicate (Return=4), even
			// for the same user, so it has to be removed first (DELETE .../fingerprints/:finger).
			if (await ZktecoModel.hasFingerprint(device.IDNo, pin, finger)) {
				return ApiResponse.error(res, 'This finger is already enrolled. Remove it first to enroll it again.', 409);
			}
			const active = await ZktecoModel.getActiveEnrollment(device.IDNo);
			if (active) {
				return ApiResponse.error(
					res,
					'The device is already waiting for a fingerprint. Finish or cancel that one first.',
					409,
					{ commandId: active.IDNo }
				);
			}

			const commandId = await AdmsService.queueCommand(
				device.IDNo,
				`Enroll fingerprint ${finger} for user ${pin}`,
				AdmsService.buildFingerprintEnrollCommand({ pin, finger }),
				req.user?.user_id ?? null
			);
			return ApiResponse.created(res, { commandId }, 'Fingerprint enrollment sent to the device');
		} catch (error) {
			if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
			console.error('Error starting fingerprint enrollment:', error);
			return ApiResponse.error(res, 'Failed to start fingerprint enrollment', 500, error.message);
		}
	}

	// DELETE /zkteco/device-users/:pin/fingerprints/:finger?branch_id=&device_id=
	// Queues DATA DELETE FINGERTMP. Once the device confirms, the template is removed here too
	// (admsService.applyCommandResult) and the finger can be enrolled again.
	static async removeFingerprint(req, res) {
		try {
			if (!(await canEnrollFingerprint(req))) {
				return ApiResponse.forbidden(res, 'You are not allowed to manage fingerprints on the attendance device');
			}
			const scope = resolveBranchScope(req);
			const device = await getScopedDevice(scope, parseInt(req.query.device_id, 10));

			const pin = String(req.params.pin || '').trim();
			const finger = Number(req.params.finger);
			if (!NEW_USER_RULES.pin.test(pin)) return ApiResponse.badRequest(res, 'Invalid User ID');
			if (!Number.isInteger(finger) || finger < 0 || finger > FINGER_MAX) {
				return ApiResponse.badRequest(res, 'Invalid finger');
			}
			if (!(await ZktecoModel.hasFingerprint(device.IDNo, pin, finger))) {
				return ApiResponse.error(res, 'This finger is not enrolled', 404);
			}

			const commandId = await AdmsService.queueCommand(
				device.IDNo,
				`Remove fingerprint ${finger} for user ${pin}`,
				AdmsService.buildFingerprintRemoveCommand({ pin, finger }),
				req.user?.user_id ?? null
			);
			return ApiResponse.success(res, { commandId }, 'Fingerprint removal sent to the device');
		} catch (error) {
			if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
			console.error('Error removing fingerprint:', error);
			return ApiResponse.error(res, 'Failed to remove the fingerprint', 500, error.message);
		}
	}

	// GET /zkteco/enrollments/:id?branch_id=  (fingerprint enroll or remove command)
	static async getEnrollment(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const enrollment = await ZktecoModel.getEnrollment(parseInt(req.params.id, 10), scope);
			if (!enrollment) return ApiResponse.error(res, 'Enrollment not found', 404);
			return ApiResponse.success(res, enrollment, 'Enrollment retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'enrollment');
		}
	}

	// DELETE /zkteco/enrollments/:id?branch_id=  (only while the device hasn't picked it up)
	static async cancelEnrollment(req, res) {
		try {
			if (!(await canEnrollFingerprint(req))) {
				return ApiResponse.forbidden(res, 'You are not allowed to manage fingerprint enrollment');
			}
			const scope = resolveBranchScope(req);
			const enrollment = await ZktecoModel.getEnrollment(parseInt(req.params.id, 10), scope);
			if (!enrollment) return ApiResponse.error(res, 'Enrollment not found', 404);
			if (!(await ZktecoModel.cancelPendingCommand(enrollment.IDNo))) {
				return ApiResponse.error(
					res,
					'The device already has this request. Press the back button on the device, or wait about a minute for it to time out.',
					409
				);
			}
			return ApiResponse.success(res, { cancelled: true }, 'Enrollment cancelled');
		} catch (error) {
			return handleError(res, error, 'enrollment');
		}
	}

	// DELETE /zkteco/device-users/:pin?branch_id=&device_id=
	// Queues DATA DELETE USERINFO (verified on the MB160: removes the user with their fingerprints,
	// face and card). When the device confirms, the row is soft-deleted (admsService.applyCommandResult):
	// past punches keep the name, credentials and templates are erased.
	static async deleteDeviceUser(req, res) {
		try {
			if (!(await canDeleteDeviceUser(req))) {
				return ApiResponse.forbidden(res, 'You are not allowed to remove users from the attendance device');
			}
			const scope = resolveBranchScope(req);
			const device = await getScopedDevice(scope, parseInt(req.query.device_id, 10));

			// Any PIN the device has (device-created users aren't bound by NEW_USER_RULES).
			const pin = String(req.params.pin || '').trim();
			if (!/^\d{1,32}$/.test(pin)) return ApiResponse.badRequest(res, 'Invalid User ID');

			const user = await ZktecoModel.getActiveDeviceUser(device.IDNo, pin);
			if (!user) return ApiResponse.error(res, `User ID ${pin} is not on this device`, 404);
			if (await ZktecoModel.getPendingUserChange(device.IDNo, pin)) {
				return ApiResponse.error(res, 'This user has a change or removal waiting for the device. Wait for it, or cancel it, first.', 409);
			}
			// Without an admin, anyone can open the device menu.
			if (ZktecoModel.isAdminPrivilege(user.PRIVILEGE) && (await ZktecoModel.countOtherAdmins(device.IDNo, pin)) === 0) {
				return ApiResponse.error(
					res,
					"This is the device's only admin. Make another user an admin on the device first: without one, anyone can open the device menu.",
					409
				);
			}
			if (await ZktecoModel.getActiveEnrollment(device.IDNo)) {
				return ApiResponse.error(res, 'The device is busy with a fingerprint enrollment. Finish or cancel it first.', 409);
			}

			const commandId = await AdmsService.queueCommand(
				device.IDNo,
				`Remove user ${pin} (${user.NAME || 'no name'})`,
				ZktecoModel.userDeleteCommand(pin),
				req.user?.user_id ?? null
			);
			return ApiResponse.created(res, { commandId }, 'Removal sent to the device');
		} catch (error) {
			if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
			console.error('Error removing device user:', error);
			return ApiResponse.error(res, 'Failed to remove the user', 500, error.message);
		}
	}

	// DELETE /zkteco/user-commands/:id?branch_id=  (an add or removal the device hasn't picked up yet)
	static async cancelUserCommand(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const command = await ZktecoModel.getUserCommand(parseInt(req.params.id, 10), scope);
			if (!command) return ApiResponse.error(res, 'Request not found', 404);
			const allowed =
				command.KIND === 'delete'
					? await canDeleteDeviceUser(req)
					: command.KIND === 'edit'
						? await canEditDeviceUser(req)
						: await canCreateDeviceUser(req);
			if (!allowed) return ApiResponse.forbidden(res, 'You are not allowed to cancel this request');
			if (!(await ZktecoModel.cancelPendingCommand(command.IDNo))) {
				return ApiResponse.error(res, 'The device already has this request, so it can no longer be cancelled.', 409);
			}
			return ApiResponse.success(res, { cancelled: true }, 'Request cancelled');
		} catch (error) {
			return handleError(res, error, 'request');
		}
	}

	// ---- Punches (zk_attendance_logs): device punches and manual punches share these endpoints ----

	// POST /zkteco/attendance-logs?branch_id=  { employee_id, punch_dt: 'YYYY-MM-DD HH:mm:ss', status (0 time-in | 1 time-out), reason }
	// A forgotten time-in/out added in the app (SOURCE = 'manual'). A reason is required.
	static async createManualPunch(req, res) {
		try {
			if (!(await canAddPunch(req))) return ApiResponse.forbidden(res, 'You are not allowed to add punches');
			const scope = resolveBranchScope(req);
			const person = await ZktecoModel.getEmployeeOnDevice(parseInt(req.body?.employee_id, 10));
			if (!person || !Number(person.ACTIVE) || !inScope(scope, person.DEVICE_BRANCH_ID)) {
				return ApiResponse.error(res, 'Employee not found', 404);
			}

			const punchDt = String(req.body?.punch_dt ?? '').trim();
			const status = Number(req.body?.status);
			const reason = cleanReason(req.body?.reason);
			if (!reason) return ApiResponse.badRequest(res, 'Give a reason for adding the punch');
			const problem = await punchError({ punchDt, status, duplicateOf: { employeeId: person.IDNo } });
			if (problem) return ApiResponse.badRequest(res, problem);

			const id = await ZktecoModel.insertManualPunch(
				{ employeeId: person.IDNo, branchId: person.DEVICE_BRANCH_ID, punchDt, status, reason },
				req.user?.user_id ?? null
			);
			emitPunchChange({ DEVICE_ID: person.ZK_DEVICE_ID, BRANCH_ID: person.DEVICE_BRANCH_ID });
			return ApiResponse.created(res, { id }, 'Punch added');
		} catch (error) {
			if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
			console.error('Error adding punch:', error);
			return ApiResponse.error(res, 'Failed to add the punch', 500, error.message);
		}
	}

	// PATCH /zkteco/attendance-logs/:id?branch_id=  { punch_dt: 'YYYY-MM-DD HH:mm:ss', status, reason }
	// A device punch is corrected (its own record never changes, and setting the device's values
	// back clears the edit); a manual punch is simply changed. A reason is required for every change
	// except putting a device punch back to what the device recorded. It replaces the previous one,
	// so an old reason is never left on a new change.
	static async updateAttendanceLog(req, res) {
		try {
			if (!(await canEditPunch(req))) return ApiResponse.forbidden(res, 'You are not allowed to edit punches');
			const scope = resolveBranchScope(req);
			const punch = await ZktecoModel.getAttendanceLog(parseInt(req.params.id, 10), scope);
			if (!punch) return ApiResponse.error(res, 'Punch not found', 404);
			if (Number(punch.IS_DELETED)) return ApiResponse.error(res, 'Restore this punch before editing it', 409);

			const punchDt = String(req.body?.punch_dt ?? '').trim();
			const status = Number(req.body?.status);
			const reason = cleanReason(req.body?.reason);
			const userId = req.user?.user_id ?? null;
			const REASON_REQUIRED = 'Give a reason for the change';

			if (punch.SOURCE === 'manual') {
				if (!reason) return ApiResponse.badRequest(res, REASON_REQUIRED);
				const problem = await punchError({
					punchDt,
					status,
					current: [punch.PUNCH_STATUS],
					duplicateOf: { employeeId: punch.EMPLOYEE_ID, excludeId: punch.IDNo },
				});
				if (problem) return ApiResponse.badRequest(res, problem);
				await ZktecoModel.updateManualPunch(punch.IDNo, { punchDt, status, reason }, userId);
			} else {
				// Time-in / Time-out, or the type it has now or had on the device.
				const problem = await punchError({
					punchDt,
					status,
					current: [punch.PUNCH_STATUS_NEW ?? punch.PUNCH_STATUS, punch.PUNCH_STATUS ?? 255],
				});
				if (problem) return ApiResponse.badRequest(res, problem);
				const punchDtNew = punchDt === punch.PUNCH_DT ? null : punchDt;
				const punchStatusNew = status === (punch.PUNCH_STATUS ?? 255) ? null : status;
				const backToDevice = punchDtNew === null && punchStatusNew === null;
				if (!backToDevice && !reason) return ApiResponse.badRequest(res, REASON_REQUIRED);
				await ZktecoModel.correctDevicePunch(punch.IDNo, { punchDtNew, punchStatusNew, reason }, userId);
			}
			emitPunchChange(punch);
			return ApiResponse.success(res, { id: punch.IDNo }, 'Punch updated');
		} catch (error) {
			if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
			console.error('Error editing punch:', error);
			return ApiResponse.error(res, 'Failed to edit the punch', 500, error.message);
		}
	}

	// DELETE /zkteco/attendance-logs/:id?branch_id=  { reason }
	// Soft delete: the punch is left out of attendance (and "Show deleted" lists it) until restored.
	// A reason is required; restoring needs none (it keeps the delete's reason).
	static async deleteAttendanceLog(req, res) {
		return ZktecoController.setPunchDeleted(req, res, true);
	}

	// POST /zkteco/attendance-logs/:id/restore?branch_id=
	static async restoreAttendanceLog(req, res) {
		return ZktecoController.setPunchDeleted(req, res, false);
	}

	static async setPunchDeleted(req, res, deleted) {
		try {
			if (!(await canDeletePunch(req))) {
				return ApiResponse.forbidden(res, 'You are not allowed to delete or restore punches');
			}
			const scope = resolveBranchScope(req);
			const punch = await ZktecoModel.getAttendanceLog(parseInt(req.params.id, 10), scope);
			if (!punch) return ApiResponse.error(res, 'Punch not found', 404);
			const reason = deleted ? cleanReason(req.body?.reason) : null;
			if (deleted && !reason) return ApiResponse.badRequest(res, 'Give a reason for deleting the punch');
			// Restoring a manual punch must not make a second punch at the same time.
			if (
				!deleted &&
				punch.SOURCE === 'manual' &&
				(await ZktecoModel.punchExistsAt(punch.EMPLOYEE_ID, punch.EFFECTIVE_DT, punch.IDNo))
			) {
				return ApiResponse.error(res, 'This person already has another punch at that exact time', 409);
			}
			// Edits are kept either way, so a restored punch comes back as it was.
			await ZktecoModel.setPunchDeleted(punch.IDNo, deleted, reason, req.user?.user_id ?? null);
			emitPunchChange(punch);
			return ApiResponse.success(res, { id: punch.IDNo, deleted }, deleted ? 'Punch deleted' : 'Punch restored');
		} catch (error) {
			if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
			console.error('Error changing punch:', error);
			return ApiResponse.error(res, 'Failed to update the punch', 500, error.message);
		}
	}

	// GET /zkteco/events?branch_id=  (Server-Sent Events)
	// Sends `change` { type: attendance|users|commands|device, deviceId } as the device
	// pushes data, so open pages re-fetch right away instead of waiting for a poll.
	static streamEvents(req, res) {
		let scope;
		try {
			scope = resolveBranchScope(req);
		} catch (error) {
			return handleError(res, error, 'events');
		}

		initSse(res);
		sendSse(res, 'ready', { ok: true });

		const unsubscribe = onZkChange((evt) => {
			if (scope && !scope.includes(Number(evt.branchId))) return;
			sendSse(res, 'change', { type: evt.type, deviceId: evt.deviceId });
		});
		// Comment lines keep proxies from closing an idle stream.
		const heartbeat = setInterval(() => {
			if (!res.writableEnded) res.write(': ping\n\n');
		}, SSE_HEARTBEAT_MS);

		req.on('close', () => {
			clearInterval(heartbeat);
			unsubscribe();
		});
	}
}

module.exports = ZktecoController;
