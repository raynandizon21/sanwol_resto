// ============================================
// ATTENDANCE CONTROLLER
// ============================================
// File: controllers/attendanceController.js
// Description: Computed attendance (summary, timesheet), the Schedules page (per-day schedules
// and shift types), and the employee profiles behind the Employees page.
// Punches come from the MB160 (zk_attendance_logs); the people are employee rows with ZK_ device
// columns. See docs/attendance.md.
// ============================================

const ApiResponse = require('../utils/apiResponse');
const EmployeeModel = require('../models/employeeModel');
const ZktecoModel = require('../models/zktecoModel');
const ScheduleModel = require('../models/scheduleModel');
const AttendanceService = require('../services/attendanceService');
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
// The Schedules page (CRUD module schedules, 2026-11-06). Add or Edit: set people's days. Add /
// Edit / Delete: add / edit / remove shift types.
const canSetDays = (req) => hasCrudPermission(req, 'schedules', ['create', 'update']);
const canEditShiftTypes = (req) => hasCrudPermission(req, 'schedules', ['update']);
const canAddScheduleItems = (req) => hasCrudPermission(req, 'schedules', ['create']);
const canRemoveScheduleItems = (req) => hasCrudPermission(req, 'schedules', ['delete']);

// The Schedules page shows at most this many days (a month fits).
const MAX_SCHEDULE_DAYS = 62;
// Cells set in one request (a month for about 150 people).
const MAX_CELLS = 5000;

/** Device-local today ("YYYY-MM-DD"): edits to a shift type apply from here on. */
const deviceToday = async () => String(await ZktecoModel.deviceNow()).slice(0, 10);

/** start_date / end_date query params, both required. */
function readRange(req, maxDays) {
	const { start_date: start, end_date: end } = req.query;
	if (!isValidYmd(start) || !isValidYmd(end)) throw new HttpError(400, 'start_date and end_date must be YYYY-MM-DD');
	const problem = AttendanceService.checkRange(start, end, maxDays);
	if (problem) throw new HttpError(400, problem);
	return { start, end };
}

/** A single branch from ?branch_id= (schedules are per branch, so "All branches" doesn't apply). */
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

	// GET /attendance/timesheets?branch_id=&start_date=&end_date= (everyone, for the Timesheet tab)
	static async getTimesheets(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const { start, end } = readRange(req, AttendanceService.MAX_TIMESHEETS_DAYS);
			const sheets = await AttendanceService.getTimesheets(scope, start, end);
			return ApiResponse.success(res, sheets, 'Timesheets retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'timesheets');
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

	// ---- Schedules page ----

	// GET /attendance/schedule?branch_id=X&start_date=&end_date=  (at most 62 days)
	// Everyone on the branch's device (and people removed from it who have days in the range), their
	// days, the branch's shift types, and what the caller may change.
	static async getSchedule(req, res) {
		try {
			const branchId = requireOneBranch(req);
			const { start, end } = readRange(req, MAX_SCHEDULE_DAYS);
			const people = await AttendanceService.loadPeople([branchId]);
			const dayMaps = await ScheduleModel.getDayMaps([...people.keys()], start, end);
			const employees = [];
			const days = [];
			for (const person of people.values()) {
				const map = dayMaps.get(person.employeeId);
				// People excluded from schedules and attendance (Profile) aren't listed.
				if (person.excludeFromAttendance || (!person.active && !map?.size)) continue;
				employees.push({
					employeeId: person.employeeId,
					name: person.name,
					position: person.position,
					active: person.active,
					hired: person.profile?.DATE_STARTED || null,
					separated: person.profile?.DATE_SEPARATED || null,
				});
				map?.forEach((entry, date) => days.push({ employeeId: person.employeeId, date, ...entry }));
			}
			const [shiftTypes, today, canSet, canAdd, canEdit, canRemove] = await Promise.all([
				ScheduleModel.listShiftTypes(branchId, { includeInactive: true }),
				deviceToday(),
				canSetDays(req),
				canAddScheduleItems(req),
				canEditShiftTypes(req),
				canRemoveScheduleItems(req),
			]);
			return ApiResponse.success(
				res,
				{
					branchId,
					range: { start, end },
					today,
					employees,
					days,
					shiftTypes,
					permissions: { setDays: canSet, add: canAdd, edit: canEdit, remove: canRemove },
				},
				'Schedule retrieved successfully'
			);
		} catch (error) {
			return handleError(res, error, 'schedule');
		}
	}

	// PUT /attendance/schedule?branch_id=X  { cells: [{ employee_id, date }], value }
	// value: { type: 'shift', shift_type_id } | { type: 'shift', start, end } (custom times)
	//      | { type: 'day_off' } | { type: 'leave' | 'absent', note } | { type: 'clear' }
	static async setScheduleDays(req, res) {
		try {
			if (!(await canSetDays(req))) return ApiResponse.forbidden(res, 'You are not allowed to change schedules');
			const branchId = requireOneBranch(req);
			const { value, error } = ScheduleModel.validateDayValue(req.body?.value);
			if (error) return ApiResponse.badRequest(res, error);
			const raw = Array.isArray(req.body?.cells) ? req.body.cells : [];
			if (!raw.length) return ApiResponse.badRequest(res, 'Choose at least one day');
			if (raw.length > MAX_CELLS) return ApiResponse.badRequest(res, `Choose at most ${MAX_CELLS} days at a time`);
			const people = await AttendanceService.loadPeople([branchId]);
			const seen = new Set();
			const cells = [];
			for (const c of raw) {
				const employeeId = Number(c?.employee_id);
				if (!people.has(employeeId)) return ApiResponse.error(res, 'Employee not found in this branch', 404);
				if (people.get(employeeId).excludeFromAttendance) {
					return ApiResponse.badRequest(res, `${people.get(employeeId).name || 'This person'} is excluded from schedules and attendance (Profile)`);
				}
				if (!isValidYmd(c?.date)) return ApiResponse.badRequest(res, 'Dates must be YYYY-MM-DD');
				const key = `${employeeId}|${c.date}`;
				if (seen.has(key)) continue;
				seen.add(key);
				cells.push({ employeeId, date: c.date });
			}
			let shiftType = null;
			if (value.type === 'shift' && value.shiftTypeId) {
				shiftType = await ScheduleModel.getShiftType(branchId, value.shiftTypeId);
				if (!shiftType || !shiftType.active) return ApiResponse.error(res, 'That shift no longer exists', 404);
			}
			const changed = await ScheduleModel.setDays(cells, value, req.user?.user_id ?? null, shiftType);
			// Open schedules and attendance pages reload.
			emitZkChange('attendance', { IDNo: null, BRANCH_ID: branchId });
			return ApiResponse.success(res, { changed }, 'Schedule saved');
		} catch (error) {
			return handleError(res, error, 'schedule');
		}
	}

	// GET /attendance/shift-types?branch_id=X  (active ones; seeded with Sanwol's the first time)
	static async getShiftTypes(req, res) {
		try {
			const branchId = requireOneBranch(req);
			return ApiResponse.success(res, await ScheduleModel.listShiftTypes(branchId), 'Shift types retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'shift types');
		}
	}

	// POST /attendance/shift-types?branch_id=X  { name, start, end, color }
	static async createShiftType(req, res) {
		try {
			if (!(await canAddScheduleItems(req))) return ApiResponse.forbidden(res, 'You are not allowed to add shifts');
			const branchId = requireOneBranch(req);
			const { value, error } = ScheduleModel.validateShiftType(req.body);
			if (error) return ApiResponse.badRequest(res, error);
			await ScheduleModel.listShiftTypes(branchId); // seeds first, so the seeded names count
			if (await ScheduleModel.nameTaken(branchId, value.name)) return ApiResponse.error(res, 'A shift with this name already exists', 409);
			const id = await ScheduleModel.createShiftType(branchId, value, req.user?.user_id ?? null);
			emitZkChange('attendance', { IDNo: null, BRANCH_ID: branchId });
			return ApiResponse.created(res, { id, shiftTypes: await ScheduleModel.listShiftTypes(branchId) }, 'Shift added');
		} catch (error) {
			return handleError(res, error, 'shift type');
		}
	}

	// PUT /attendance/shift-types/:id?branch_id=X  { name, start, end, color }
	// New times apply to days given this shift from today on; earlier days keep theirs.
	static async updateShiftType(req, res) {
		try {
			if (!(await canEditShiftTypes(req))) return ApiResponse.forbidden(res, 'You are not allowed to edit shifts');
			const branchId = requireOneBranch(req);
			const id = parseInt(req.params.id, 10);
			const current = await ScheduleModel.getShiftType(branchId, id);
			if (!current || !current.active) return ApiResponse.error(res, 'Shift not found', 404);
			const { value, error } = ScheduleModel.validateShiftType(req.body);
			if (error) return ApiResponse.badRequest(res, error);
			if (await ScheduleModel.nameTaken(branchId, value.name, id)) return ApiResponse.error(res, 'A shift with this name already exists', 409);
			const updatedDays = await ScheduleModel.updateShiftType(branchId, id, value, await deviceToday(), req.user?.user_id ?? null);
			emitZkChange('attendance', { IDNo: null, BRANCH_ID: branchId });
			return ApiResponse.success(res, { updatedDays, shiftTypes: await ScheduleModel.listShiftTypes(branchId) }, 'Shift saved');
		} catch (error) {
			return handleError(res, error, 'shift type');
		}
	}

	// DELETE /attendance/shift-types/:id?branch_id=X  (days already given it keep it)
	static async removeShiftType(req, res) {
		try {
			if (!(await canRemoveScheduleItems(req))) return ApiResponse.forbidden(res, 'You are not allowed to remove shifts');
			const branchId = requireOneBranch(req);
			const id = parseInt(req.params.id, 10);
			const current = await ScheduleModel.getShiftType(branchId, id);
			if (!current || !current.active) return ApiResponse.error(res, 'Shift not found', 404);
			const upcomingDays = await ScheduleModel.removeShiftType(branchId, id, await deviceToday(), req.user?.user_id ?? null);
			emitZkChange('attendance', { IDNo: null, BRANCH_ID: branchId });
			return ApiResponse.success(res, { upcomingDays, shiftTypes: await ScheduleModel.listShiftTypes(branchId) }, 'Shift removed');
		} catch (error) {
			return handleError(res, error, 'shift type');
		}
	}

	// GET /attendance/former-employees?branch_id=  (profiles of people no longer on the device)
	static async getFormerEmployees(req, res) {
		try {
			const scope = resolveBranchScope(req);
			const rows = await ZktecoModel.getFormerEmployees(scope);
			const list = rows.map((p) => ({
				IDNo: p.IDNo,
				NAME: AttendanceService.fullName(p, p.ZK_NAME),
				DEPARTMENT: p.DEPARTMENT,
				DATE_STARTED: p.DATE_STARTED,
				DATE_SEPARATED: p.DATE_SEPARATED,
			}));
			return ApiResponse.success(res, list, 'Former employees retrieved successfully');
		} catch (error) {
			return handleError(res, error, 'former employees');
		}
	}

	// POST /attendance/employees/link?branch_id=  { employee_id, former_employee_id }
	// For someone added back directly on the device (who got a new profile, employee_id): their
	// device link and punches move onto their old profile, and the new profile is removed.
	static async linkEmployee(req, res) {
		try {
			if (!(await canEditProfile(req))) return ApiResponse.forbidden(res, 'You are not allowed to edit employees');
			const scope = resolveBranchScope(req);
			const user = await ZktecoModel.getEmployeeOnDevice(parseInt(req.body?.employee_id, 10));
			if (!user || !Number(user.ACTIVE) || !inScope(scope, user.DEVICE_BRANCH_ID)) {
				return ApiResponse.error(res, 'Employee not found', 404);
			}
			if (!Number(user.ZK_ON_DEVICE)) return ApiResponse.badRequest(res, 'This user is no longer on the device');
			const formerId = parseInt(req.body?.former_employee_id, 10);
			const former = await ZktecoModel.getFormerEmployees(scope);
			if (!former.some((p) => Number(p.IDNo) === formerId)) {
				return ApiResponse.error(res, 'That profile is not a former employee in this branch', 409);
			}
			await ZktecoModel.mergeIntoFormerEmployee(Number(user.IDNo), formerId, req.user?.user_id ?? null);
			const evt = { IDNo: user.ZK_DEVICE_ID, BRANCH_ID: user.DEVICE_BRANCH_ID };
			emitZkChange('users', evt);
			emitZkChange('attendance', evt);
			return ApiResponse.success(res, { employeeId: formerId }, 'Linked to the former employee');
		} catch (error) {
			if (error instanceof HttpError) return ApiResponse.error(res, error.message, error.status);
			console.error('Error linking employee:', error);
			return ApiResponse.error(res, 'Failed to link the employee', 500, error.message);
		}
	}
}

module.exports = AttendanceController;
