// ============================================
// ATTENDANCE CONTROLLER
// ============================================
// File: controllers/attendanceController.js
// Description: Computed attendance (summary, timesheet), per-branch attendance rules, and the
// app-only employee profiles behind the Employees page. Punches come from the MB160
// (zkteco DB); profiles and rules live in sanwol_resto. See docs/attendance.md.
// ============================================

const ApiResponse = require('../utils/apiResponse');
const EmployeeModel = require('../models/employeeModel');
const ZktecoModel = require('../models/zktecoModel');
const AttendanceSettingsModel = require('../models/attendanceSettingsModel');
const AttendanceService = require('../services/attendanceService');
const EmployeeLinkService = require('../services/employeeLinkService');
const { emitZkChange } = require('../services/zktecoEvents');
const {
	HttpError,
	resolveBranchScope,
	inScope,
	hasCrudPermission,
	handleError,
	isValidYmd,
} = require('../utils/zktecoHttp');
const { readProfile } = require('../utils/employeeProfile');
const { syncDeviceName } = require('../services/deviceNameSync');

// Profile edits are part of managing people on the Employees page (CRUD module device_users).
const canEditProfile = (req) => hasCrudPermission(req, 'device_users', ['update']);
const canEditRules = (req) => hasCrudPermission(req, 'attendance_logs', ['update']);

/** start_date / end_date query params, both required. */
function readRange(req) {
	const { start_date: start, end_date: end } = req.query;
	if (!isValidYmd(start) || !isValidYmd(end)) throw new HttpError(400, 'start_date and end_date must be YYYY-MM-DD');
	const problem = AttendanceService.checkRange(start, end);
	if (problem) throw new HttpError(400, problem);
	return { start, end };
}

/** A single branch from ?branch_id= (rules are per branch, so "All branches" doesn't apply). */
function requireOneBranch(req) {
	const scope = resolveBranchScope(req);
	if (!scope || scope.length !== 1) throw new HttpError(400, 'Choose a branch');
	return scope[0];
}

/** The profile (with its person data) if it belongs to someone in the caller's scope. */
async function getScopedPerson(scope, employeeId) {
	const people = await AttendanceService.loadPeople(scope);
	const person = people.get(Number(employeeId));
	if (!person || !person.profile || !Number(person.profile.ACTIVE)) throw new HttpError(404, 'Employee not found');
	return person;
}

class AttendanceController {
	// GET /attendance/summary?branch_id=&start_date=&end_date=
	static async getSummary(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const { start, end } = readRange(req);
			const summary = await AttendanceService.getSummary(scope, start, end);
			return ApiResponse.success(res, summary, 'Attendance summary retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'attendance summary');
		}
	}

	// GET /attendance/timesheet/:employeeId?branch_id=&start_date=&end_date=
	static async getTimesheet(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const { start, end } = readRange(req);
			const sheet = await AttendanceService.getTimesheet(scope, parseInt(req.params.employeeId, 10), start, end);
			if (!sheet) return ApiResponse.error(res, 'Employee not found', 404);
			return ApiResponse.success(res, sheet, 'Timesheet retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'timesheet');
		}
	}

	// GET /attendance/settings?branch_id=X
	static async getSettings(req, res) {
		try {
			const branchId = requireOneBranch(req);
			const rules = await AttendanceSettingsModel.getRules(branchId);
			return ApiResponse.success(res, { branchId, rules, canEdit: await canEditRules(req) }, 'Attendance rules retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'attendance rules');
		}
	}

	// PUT /attendance/settings?branch_id=X  { standardHours, maxShiftHours }
	static async updateSettings(req, res) {
		try {
			if (!(await canEditRules(req))) return ApiResponse.forbidden(res, 'You are not allowed to change attendance rules');
			const branchId = requireOneBranch(req);
			const { rules, error } = AttendanceSettingsModel.validate(req.body || {});
			if (error) return ApiResponse.badRequest(res, error);
			await AttendanceSettingsModel.saveRules(branchId, rules, req.user?.user_id ?? null);
			// Open summaries recompute with the new rules.
			emitZkChange('attendance', { IDNo: null, BRANCH_ID: branchId });
			return ApiResponse.success(res, { branchId, rules }, 'Attendance rules saved');
		} catch (error) {
			return handleError(res, error, 'attendance rules');
		}
	}

	// GET /attendance/employees/:id?branch_id=
	static async getEmployee(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const person = await getScopedPerson(scope, req.params.id);
			return ApiResponse.success(res, person.profile, 'Employee retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'employee');
		}
	}

	// PATCH /attendance/employees/:id?branch_id=  (snake_case profile fields; only those sent are changed)
	static async updateEmployee(req, res) {
		try {
			if (!(await canEditProfile(req))) return ApiResponse.forbidden(res, 'You are not allowed to edit employees');
			const scope = resolveBranchScope(req);
			const person = await getScopedPerson(scope, req.params.id);
			const { fields, error } = readProfile(req.body || {}, person.profile);
			if (error) return ApiResponse.badRequest(res, error);
			if (Object.keys(fields).length === 0) return ApiResponse.badRequest(res, 'Nothing to change');
			await EmployeeModel.updateProfile(person.employeeId, fields, req.user?.user_id ?? null);
			const profile = await EmployeeModel.getProfileById(person.employeeId);
			// The name on the device follows the profile name.
			let deviceRename = null;
			if (person.active && ('FIRSTNAME' in fields || 'LASTNAME' in fields)) {
				deviceRename = await syncDeviceName(
					{ deviceId: person.deviceId, pin: person.pin, firstName: profile.FIRSTNAME, lastName: profile.LASTNAME },
					req.user?.user_id ?? null
				);
			}
			// Names show on the Employees page and in attendance; a queued rename in "Sending to device".
			emitZkChange('users', { IDNo: person.deviceId, BRANCH_ID: person.branchId });
			emitZkChange('attendance', { IDNo: person.deviceId, BRANCH_ID: person.branchId });
			if (deviceRename?.queued) emitZkChange('commands', { IDNo: person.deviceId, BRANCH_ID: person.branchId });
			return ApiResponse.success(
				res,
				{ ...profile, DEVICE_RENAME: deviceRename?.queued ? deviceRename.name : null },
				'Employee saved'
			);
		} catch (error) {
			if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
			console.error('Error saving employee:', error);
			return ApiResponse.error(res, 'Failed to save the employee', 500, error.message);
		}
	}

	// GET /attendance/former-employees?branch_id=  (profiles of people no longer on the device)
	static async getFormerEmployees(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const rows = await EmployeeLinkService.getFormerEmployees(scope);
			const list = rows.map((p) => ({
				IDNo: p.IDNo,
				NAME: AttendanceService.fullName(p, null),
				DEPARTMENT: p.DEPARTMENT,
				DATE_STARTED: p.DATE_STARTED,
				DATE_SEPARATED: p.DATE_SEPARATED,
			}));
			return ApiResponse.success(res, list, 'Former employees retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'former employees');
		}
	}

	// POST /attendance/employees/link?branch_id=  { device_user_id, employee_id }
	// For someone added back directly on the device: their new device user gets their old profile
	// (and its attendance history). The profile created for the new user is removed.
	static async linkEmployee(req, res) {
		try {
			if (!(await canEditProfile(req))) return ApiResponse.forbidden(res, 'You are not allowed to edit employees');
			const scope = resolveBranchScope(req);
			const user = await ZktecoModel.getDeviceUserById(parseInt(req.body?.device_user_id, 10));
			if (!user || !inScope(scope, user.BRANCH_ID)) return ApiResponse.error(res, 'Device user not found', 404);
			if (!Number(user.ACTIVE)) return ApiResponse.badRequest(res, 'This user is no longer on the device');
			const employeeId = parseInt(req.body?.employee_id, 10);
			const former = await EmployeeLinkService.getFormerEmployees(scope);
			if (!former.some((p) => Number(p.IDNo) === employeeId)) {
				return ApiResponse.error(res, 'That profile is not a former employee in this branch', 409);
			}
			await EmployeeLinkService.relinkDeviceUser(user, employeeId, req.user?.user_id ?? null);
			emitZkChange('users', { IDNo: user.DEVICE_ID, BRANCH_ID: user.BRANCH_ID });
			emitZkChange('attendance', { IDNo: user.DEVICE_ID, BRANCH_ID: user.BRANCH_ID });
			return ApiResponse.success(res, { employeeId }, 'Linked to the former employee');
		} catch (error) {
			if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
			console.error('Error linking employee:', error);
			return ApiResponse.error(res, 'Failed to link the employee', 500, error.message);
		}
	}
}

module.exports = AttendanceController;
