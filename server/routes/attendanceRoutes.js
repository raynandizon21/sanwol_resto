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

// GET - One employee profile, with BRANCH_SCHEDULE (the branch schedule they'd follow)
router.get('/attendance/employees/:id', authenticate, getUserBranches, AttendanceController.getEmployee);

// GET - One branch's holidays (?branch_id=X). Nobody is absent on them.
router.get('/attendance/holidays', authenticate, getUserBranches, AttendanceController.getHolidays);

// ============================================
// POST / PUT / PATCH ROUTES
// ============================================

// POST - Link a device user to a former employee's profile. Body: { device_user_id, employee_id }
router.post('/attendance/employees/link', authenticate, getUserBranches, AttendanceController.linkEmployee);

// PUT - Save one branch's attendance rules (?branch_id=X)
// Body: { standardHours, maxShiftHours, graceMinutes, scheduleStart, scheduleEnd, closedDays, cutoff }
router.put('/attendance/settings', authenticate, getUserBranches, AttendanceController.updateSettings);

// POST - Add a branch holiday (?branch_id=X). Body: { date, name }
router.post('/attendance/holidays', authenticate, getUserBranches, AttendanceController.saveHoliday);

// PUT - Mark one person's day as leave, day off or holiday. Body: { employee_id, date, type, note }
router.put('/attendance/excused-days', authenticate, getUserBranches, AttendanceController.saveExcusedDay);

// DELETE - A branch holiday (?branch_id=X)
router.delete('/attendance/holidays/:id', authenticate, getUserBranches, AttendanceController.removeHoliday);

// DELETE - One person's day mark (?branch_id=&employee_id=&date=)
router.delete('/attendance/excused-days', authenticate, getUserBranches, AttendanceController.removeExcusedDay);

// PATCH - Edit an employee profile (only the fields sent). Body: snake_case fields, see the controller.
router.patch('/attendance/employees/:id', authenticate, getUserBranches, AttendanceController.updateEmployee);

// ============================================
// EXPORT
// ============================================

module.exports = router;
