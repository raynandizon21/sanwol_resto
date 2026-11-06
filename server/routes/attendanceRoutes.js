// ============================================
// ATTENDANCE ROUTES
// ============================================
// File: routes/attendanceRoutes.js
// Description: Computed attendance (from MB160 punches), per-branch attendance rules, and
// employee profiles for the Employees page. The frontend calls them through /data-api.
// ============================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const { getUserBranches } = require('../middleware/branchAuth');
const AttendanceController = require('../controllers/attendanceController');

// ============================================
// GET ROUTES
// ============================================

// GET - Per-person totals, daily series, staffing by hour, problems, and who is on shift now
// Query params: ?branch_id=all|X&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD (at most 366 days)
router.get('/attendance/summary', authenticate, getUserBranches, AttendanceController.getSummary);

// GET - Everyone's work days (status, hours, shifts) for the Timesheet tab. Query params as
// above, at most 62 days.
router.get('/attendance/timesheets', authenticate, getUserBranches, AttendanceController.getTimesheets);

// GET - One employee's work days with their punches. Query params as above.
router.get('/attendance/timesheet/:employeeId', authenticate, getUserBranches, AttendanceController.getTimesheet);

// GET - Attendance rules of one branch (?branch_id=X)
router.get('/attendance/settings', authenticate, getUserBranches, AttendanceController.getSettings);

// GET - Profiles of people no longer on the device (to link someone added back on the device)
router.get('/attendance/former-employees', authenticate, getUserBranches, AttendanceController.getFormerEmployees);

// GET - One employee profile
router.get('/attendance/employees/:id', authenticate, getUserBranches, AttendanceController.getEmployee);

// GET - One branch's holidays (?branch_id=X). Only people given a shift are expected on them.
router.get('/attendance/holidays', authenticate, getUserBranches, AttendanceController.getHolidays);

// GET - The Schedules page: people, their days, shift types, holidays (?branch_id=X&start_date=&end_date=, at most 62 days)
router.get('/attendance/schedule', authenticate, getUserBranches, AttendanceController.getSchedule);

// GET - One branch's shift types (?branch_id=X)
router.get('/attendance/shift-types', authenticate, getUserBranches, AttendanceController.getShiftTypes);

// ============================================
// POST / PUT / PATCH ROUTES
// ============================================

// POST - Link a device user to a former employee's profile. Body: { device_user_id, employee_id }
router.post('/attendance/employees/link', authenticate, getUserBranches, AttendanceController.linkEmployee);

// PUT - Save one branch's attendance rules (?branch_id=X)
// Body: { standardHours, maxShiftHours, graceMinutes, cutoff }
router.put('/attendance/settings', authenticate, getUserBranches, AttendanceController.updateSettings);

// POST - Add a branch holiday (?branch_id=X). Body: { date, name }
router.post('/attendance/holidays', authenticate, getUserBranches, AttendanceController.saveHoliday);

// PUT - Set people's days (?branch_id=X). Body: { cells: [{ employee_id, date }], value: { type, shift_type_id | start, end | note } }
router.put('/attendance/schedule', authenticate, getUserBranches, AttendanceController.setScheduleDays);

// POST - Copy a week onto another (?branch_id=X). Body: { from_start, to_start, overwrite, employee_ids? }
router.post('/attendance/schedule/copy-week', authenticate, getUserBranches, AttendanceController.copyScheduleWeek);

// POST / PUT - Add / edit a shift type (?branch_id=X). Body: { name, start, end, color }
router.post('/attendance/shift-types', authenticate, getUserBranches, AttendanceController.createShiftType);
router.put('/attendance/shift-types/:id', authenticate, getUserBranches, AttendanceController.updateShiftType);

// DELETE - A branch holiday (?branch_id=X)
router.delete('/attendance/holidays/:id', authenticate, getUserBranches, AttendanceController.removeHoliday);

// DELETE - A shift type (?branch_id=X); days already given it keep it
router.delete('/attendance/shift-types/:id', authenticate, getUserBranches, AttendanceController.removeShiftType);

// PATCH - Edit an employee profile (only the fields sent). Body: snake_case fields, see the controller.
router.patch('/attendance/employees/:id', authenticate, getUserBranches, AttendanceController.updateEmployee);

// ============================================
// EXPORT
// ============================================

module.exports = router;
