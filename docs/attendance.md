# Attendance and employees

How the app turns MB160 punches into attendance (hours worked per day), and how employees are managed. The device side (ADMS protocol, device users, punches, corrections) is in [zkteco-mb160.md](zkteco-mb160.md).

## Status (2026-11-05)

Punches are paired into time-in → time-out shifts and added up per day, against a standard 8-hour day. Since 2026-11-05, **optional work schedules** add late, undertime and absences: a branch schedule (call time, end time, grace period, days closed) that employees follow unless their profile has their own or "No schedule". Nothing set = basic time tracking as before (nobody is late or absent). Branch holidays and per-person marks (leave, day off, holiday) keep days from counting as absences. Cutoffs (pay periods) are set per branch. Overtime and payroll are not built (payroll is on hold); what was planned is in *Not built yet* at the end.

| Done | Not built (see the end) |
|---|---|
| **Employees** page = everyone on the MB160, one `employee` row each (profile + `ZK_` device columns) | Overtime rules, OT approval |
| Add employee with profile details; the device name follows the profile name | Holiday / rest-day pay rules, night differential |
| Hours worked per day, split into regular (up to the standard day) and "over" | Leave balances / leave types beyond the three marks |
| Late, undertime, absences against optional schedules; branch holidays; leave / day off / holiday marks | Payroll, payslips, posting to Expenses |
| **Add punch** / **Edit punch** for forgotten or wrong punches | |
| Attendance Logs **Summary**, **Timesheet** (everyone × days, cutoff buttons, CSV/PDF) and per-person **Timesheet**; cutoffs per branch | |

## Pages

- **Staff → Employees** (`/employee`; `/device-users` redirects here). Everyone on the MB160: profile name and position, role (device admins), **Fingerprints** (which fingers, plus an "Also:" note for any face, palm, card or password set on the device), last punch, added from. The panel has four tabs:
  - **Profile**: first name\*, last name, position, date hired, last day of work, contact no., birthdate, address, emergency contact and phone, notes. "Returning employee?" links someone added back *directly on the device* to their old profile (see *Profiles*).
  - **Schedule**: *Branch schedule* (default; shows the branch's), *Own schedule* (start time\*, optional end time, rest days) or *No schedule* (never late, undertime or absent; hours still count). Switching away from *Own* keeps the saved times.
  - **Device**: the name shown on the device (read-only; it follows the profile name) and fingerprints.
  - **Attendance**: the person's timesheet.

  Removed people (Show deleted → eye button) open without the Device tab.
- **Add employee**: User ID\*, first name\*, last name, position, date hired, then contact and other details. A line shows how the name will look on the device. Everyone is added as a regular device user with no password (staff punch with fingerprints); fingerprint enrollment is offered next.
- **Staff → Attendance Logs**, three tabs, all for the header's date range:
  - **Summary**: today (on shift now, came in, needs fixing), range tiles (hours worked, days worked, average per day, needs fixing, absences, late with undertime), *Hours worked per day* (regular vs over), *People at work per day* (worked vs needs fixing), *Staffing by hour*, a *Needs fixing* list and a per-employee table (with Absent and Late). Clicking a person or a problem opens their timesheet.
  - **Timesheet**: everyone in one grid, one row per person and one column per day (at most 62 days). Each day shows its shifts (`10:02a–7:15p`), hours worked, *Late 20m* / *UT 15m*, colored by day status (worked, needs fixing, on shift); a day that needs fixing shows *Fix*, and a still-running shift ends in *now*. Days without punches show *Absent*, *Rest day*, the holiday's name or the mark (*Leave*, *Day off*, *Holiday*). Totals per person (days worked, absent, late and undertime as days · time, hours, regular, over, needs fixing) on the right, and per day (hours, people, absent) at the bottom. Hovering a name shows their schedule; *No schedule* is noted under the name. Clicking a day or a name opens that person's timesheet there. Search, *Hide people with no punches*, and period buttons that set the header range: *This cutoff*, *Last cutoff* (the branch's cutoff, see *Attendance rules*), *This week* (Monday–Sunday), *Whole month*, with ‹ › to step to the previous / next period of the same kind. Periods never end after today. With *All branches* and branches whose cutoffs differ, 1–15 / 16–end is used (a note says so). Exports (of the people shown): **CSV** with one row per day worked, absent or marked (name, User ID, position, date, status, schedule, first time-in, last time-out, all shifts, hours as `8h 30m` and as decimals for regular / over, late and undertime minutes, problems, note), and a landscape **PDF** with the grid in blocks of 8 days and a totals page.
  - **Punches**: the punch list, plus **Add punch** and manual punches tagged *Added manually*.
- **Timesheet** of one person (side panel from the Summary or the Timesheet tab, or the Employees page's Attendance tab): their schedule, a month calendar of hours worked per day (absent, rest day, holiday and excused days colored too), totals (with absent, late, undertime), and each day's shifts (`Time-in 10:02 AM → Time-out 7:15 PM · 9h 13m`), late / undertime, problems and punches with edit / delete / add. **Mark day** marks any day (also ahead of time) as *Leave*, *Day off* or *Holiday* with a note; the mark can be changed or removed.

Permissions (User Access → CRUD): **Employees** (key `device_users`) → Edit allows profile and schedule edits (and with them the device name); **Attendance Logs** → Add = add punches, Edit = edit punches, the attendance rules (schedule, cutoff, holidays) and day marks, Delete = delete/restore punches. The sidebar key for Employees is still `employee`.

## Profiles (`sanwol_resto.employee`)

- **One `employee` row per person, and it is also their device user** (since 2026-11-05): the profile columns below plus the device's `ZK_` columns (`ZK_PIN`, `ZK_NAME`, `ZK_ON_DEVICE`, …; see *Database* in [zkteco-mb160.md](zkteco-mb160.md)). Someone created on the device gets a row the moment the device reports them (named as on the device), in the same transaction (`admsService.saveUser`). Removing someone from the device keeps their row (`ZK_ON_DEVICE = 0`).
- **Add employee** sends the profile details with the device command; the row is created only once the device confirms the new user (see *Adding users from the app* in [zkteco-mb160.md](zkteco-mb160.md)). **Add again** puts the same row back on the device and updates its details.
- Someone deleted and re-created *on the device* gets a new row; **Profile → Returning employee?** (`POST /attendance/employees/link`, `ZktecoModel.mergeIntoFormerEmployee`) moves their device link, punches and day marks onto their old profile, and the new row is deactivated (`ACTIVE = 0`).
- **The name on the device follows the profile name** (`services/deviceNameSync.js`): saving a profile queues the profile name, shortened to the device's 24 characters, whenever it differs from what the device has (or will have after a pending rename). Role, card and password stay as the device has them. A pending removal skips it. A rename made on the device itself is not copied back: the profile is the source of truth, and the list shows *On device: …* when they differ. Shortening (`deviceNameFor`, server `utils/employeeProfile.js`, mirrored in `src/components/attendance/profileFields.tsx`): *First Last* → *First L.* → fewer first-name words with the initial → fewer first-name words → first word cut to 24 characters.
- Columns used: `FIRSTNAME`, `LASTNAME`, `DEPARTMENT` (shown as *Position*), `DATE_STARTED`, `DATE_SEPARATED`, `CONTACTNo`, `BIRTHDATE`, `ADDRESS`, `EMERGENCY_CONTACT_NAME/PHONE`, `NOTES`. `USER_INFO_ID` and `BRANCH_ID` are optional (kitchen staff have no login). Schedule (2026-11-05): `SCHEDULE_MODE` (`branch` default, `own`, `none`), `SCHEDULE_START`, `SCHEDULE_END` (TIME, own schedule only), `SCHEDULE_REST_DAYS` (`"0,6"`, 0 = Sunday). The first version also added `EMPLOYMENT_TYPE`, `SHIFT_START`, `SHIFT_END`, `BREAK_MINUTES` and `REST_DAYS`; `EmployeeModel.ensureSchema` still drops them (2026-11-04), which is why the schedule columns have new names. The legacy `/employees_list` and `/employee/:id` API is untouched (it lists explicit columns, so it never returns the `ZK_` ones).
- The Profile tab and Add employee share their fields and checks (`profileFields.tsx`; server `utils/employeeProfile.js`).

## The attendance engine (`server/services/attendanceEngine.js`)

Pure function (no DB): one person's punches + the branch rules (+ their schedule, the branch holidays and their day marks) → one record per day. Unit tests: `cd server && npm test` (`attendanceSchedule.test.js` covers late, undertime and absences). `services/attendanceService.js` loads the data (punches from `zk_attendance_logs`, people from `employee`, rules from `attendance_settings`, holidays and marks from `attendance_holidays` / `attendance_excused_days`), works out each person's schedule (`scheduleFor`) and runs it per person.

**Input punches** are every punch in `zk_attendance_logs`, device and manual, at its corrected time and status, deleted ones left out (`ZktecoModel.getPunchesForAttendance`). Each carries its `EMPLOYEE_ID`, set when it arrived. A day before and after the range are loaded so shifts crossing the edges are complete.

**Shifts.**
- Every punch is either **arriving** (Time-in 0, Break-in 3, OT-in 4) or **leaving** (Time-out 1, Break-out 2, OT-out 5). Whatever key staff press, time between arriving and leaving is time at work. Older punches with no state (255) alternate in / out and are flagged *inferred*.
- A time-in opens a shift; the next time-out within **Longest shift** (20 h) closes it. A time-out with no open shift is a shift with **no time-in**; a second time-in while one is open leaves the first **without a time-out**.
- The same kind of punch again within 5 minutes is a double tap: the first time-in counts, and the last time-out.
- **A shift belongs to the day of its time-in**, so 6 PM – 3 AM is one day.
- A shift still within the longest-shift window with no time-out yet is **on shift** (not a problem).

**Hours per day.**
- **Worked** = the sum of the day's complete shifts (time-in → time-out). No break is deducted: time clocked out (e.g. for lunch) simply isn't counted. Each shift is measured to the second and rounded **down** to whole minutes (08:00:59 → 17:00:00 is 8h 59m).
- **Regular** = worked, up to the **Standard day** (8 h). **Over** = the rest. Nothing is lost; "over" is where overtime rules can start later.

**Schedules, late, undertime, absences** (only for someone with a schedule; see *Attendance rules* and the Employees page's *Schedule* tab).
- A person's schedule is the **branch schedule** (call time, end time, the branch's closed days as rest days), **their own** (start, end, rest days) or **none**. Without a start time there is no schedule: nothing below applies and hours count as usual. The grace period is always the branch's.
- A **work day** is a date in their schedule that isn't a rest day, a branch holiday or a day marked for them, between their hire date and last day of work (when set).
- **Late** = the day's first time-in after the start + grace period; past the grace period it counts **from the start** (10:00 start, 15 min grace, in at 10:20 → 20 min late; at 10:15 → not late).
- **Undertime** = the day's last time-out before the end time, on a complete day (not one to fix or still running). An end time at or before the start is the next day's (18:00 – 02:00).
- **Absent** = a past work day with **no punches at all** (a day with a broken punch is *Needs fixing* instead). Today is never absent.
- Coming in on a rest day, holiday or marked day counts the hours, never late or undertime.

**Problems** (day status *Needs fixing*; the broken shift isn't counted until fixed): `missing_in`, `missing_out`, `long_shift` (a shift over 16 h: almost always a forgotten time-out joined to a later one). Note: `inferred`. Fix them with **Add punch** / **Edit punch** in the timesheet. Add punch warns when a time-out is entered before the shift's time-in (a night shift's time-out after midnight goes on the next date).

**Day statuses**: `worked`, `incomplete` (needs fixing), `on_shift`, `off` (no punches, none expected), `upcoming`, `absent`, `rest_day`, `holiday` (branch holiday), `excused` (marked; shown ahead of time too). Each day also has `scheduled`, `lateMinutes`, `undertimeMinutes`, `restDay`, `holiday` (name) and `excuse` (`{ type, note }`).

**Totals** per person: days worked (days with a time-in), hours worked, regular, over, needs fixing, absent days, late days and minutes, undertime days and minutes, excused days, and the average per day (over days with counted hours).

## Attendance rules (`sanwol_resto.attendance_settings`)

One row per branch, edited in **Attendance Logs → Summary → Attendance rules** (a specific branch must be selected). A branch without a row uses the defaults:

| Rule | Column | Default |
|---|---|---|
| Standard day (hours counted as regular) | `STANDARD_HOURS` | 8 |
| Longest shift (no time-out within this = forgotten) | `MAX_SHIFT_HOURS` | 20 |
| Call time (branch schedule start; empty = no branch schedule) | `SCHEDULE_START` | none |
| End time (empty = no undertime; needs a call time) | `SCHEDULE_END` | none |
| Grace period, minutes (also for own schedules) | `LATE_GRACE_MINUTES` | 15 |
| Closed on (rest days on the branch schedule) | `CLOSED_DAYS` (`"0,6"`, 0 = Sunday) | none |
| Cutoff type: `semi_monthly`, `monthly`, `weekly`, `biweekly` | `CUTOFF_TYPE` | `semi_monthly` |
| Semi-monthly: the two start days (1–28); monthly: the start day | `CUTOFF_DAY_1`, `CUTOFF_DAY_2` | 1, 16 |
| Weekly: start weekday (0 = Sunday) | `CUTOFF_WEEKDAY` | 1 (Monday) |
| Bi-weekly: the first day of any period (repeats every 14 days both ways) | `CUTOFF_ANCHOR` | none |

Examples: semi-monthly 1 & 16 → 1–15, 16–end; 11 & 26 → 11–25, 26–10 of the next month. The dialog previews this cutoff and the next. Period math is `src/components/attendance/timesheetPeriods.ts`; the server only stores and validates (`AttendanceSettingsModel.validate`).

**Holidays** (`attendance_holidays`: `BRANCH_ID`, `HOLIDAY_DATE`, `NAME`, `ACTIVE`; unique per branch and date) are edited in the same dialog and saved right away. Nobody in the branch is absent on them.

**Day marks** (`attendance_excused_days`: `EMPLOYEE_ID`, `WORK_DATE`, `EXCUSE_TYPE` = `leave` / `day_off` / `holiday`, `NOTE`, `ACTIVE`; one per person and date) are set from a person's timesheet (**Mark day**). Both tables soft-delete (`ACTIVE = 0`) and come back when the same date is added again (`models/attendanceCalendarModel.js`).

The first version's columns (`GRACE_MINUTES`, `OT_MODE`, `OT_MIN_MINUTES`, `OT_ROUND_MINUTES`, `DEFAULT_BREAK_MINUTES`) are dropped by `AttendanceSettingsModel.ensureSchema` (the grace period came back as `LATE_GRACE_MINUTES`). Changing a rule, a holiday, a mark or a schedule recomputes everything on the fly (attendance is never stored).

## Manual punches and punch types (`zk_attendance_logs`, `SOURCE = 'manual'`)

For a forgotten punch: **Attendance Logs → Punches → Add punch**, or **Add punch** on a timesheet day (it suggests the missing type). A reason is required. They're rows of `zk_attendance_logs` with `SOURCE = 'manual'`, no `DEVICE_ID`/`PIN`, and the person's `EMPLOYEE_ID` (so PIN reuse can't move them). They show in the punch list as *Added manually* (verified by "Entered in the app"), count like device punches, and are edited, deleted (soft) and restored through the same endpoints as device punches. A manual punch can't share the exact time of another of that person's counted punches.

**A reason is required** to add, edit or delete any punch (device or manual). Only setting a device punch back to the device's record and restoring a deleted punch need none.

The app sets only **Time-in / Time-out** (adding, and editing any punch). Editing can also keep the type a punch already has (e.g. an OT-in recorded by the device), so an edit never forces a change of type. The server enforces the same.

*Device setting to consider:* the MB160's punch-state keys can usually be limited to Time-in and Time-out (on the device, around Personalize → Shortcut Keys; check the exact menu). Not required: the other keys count as arriving or leaving anyway.

## API

| Method | Path | |
|---|---|---|
| GET | `/attendance/summary?branch_id&start_date&end_date` | Summary (max 366 days) |
| GET | `/attendance/timesheets?branch_id&start_date&end_date` | Everyone's days (status, hours, shifts, late, undertime, marks; no punches), each person's `schedule`, totals and the scope's `cutoff`, for the Timesheet tab (max 62 days). Same people as the summary |
| GET | `/attendance/timesheet/:employeeId?branch_id&start_date&end_date` | One person's days with punches |
| GET / PUT | `/attendance/settings?branch_id=X` | Rules of one branch (`{ standardHours, maxShiftHours, graceMinutes, scheduleStart, scheduleEnd, closedDays, cutoff: { type, day1, day2, weekday, anchor } }`) |
| GET / POST | `/attendance/holidays?branch_id=X` | One branch's holidays / add one `{ date, name }` (a date that has one is renamed) |
| DELETE | `/attendance/holidays/:id?branch_id=X` | Remove a holiday |
| PUT / DELETE | `/attendance/excused-days?branch_id` | Mark a day `{ employee_id, date, type, note }` / remove (`?employee_id&date`). Attendance Logs → Edit |
| GET / PATCH | `/attendance/employees/:id?branch_id` | Profile (GET adds `BRANCH_SCHEDULE`; PATCH: snake_case fields incl. `schedule_mode`, `schedule_start`, `schedule_end`, `schedule_rest_days` (array); only those sent change; the response's `DEVICE_RENAME` is the device name queued, if any) |
| GET | `/attendance/former-employees?branch_id` | People removed from the device whose profile is active |
| POST | `/attendance/employees/link?branch_id` | `{ employee_id (their new row), former_employee_id }` |
| POST | `/zkteco/attendance-logs` | Add a manual punch `{ employee_id, punch_dt, status, reason }`. Edit / delete / restore use the punch endpoints in [zkteco-mb160.md](zkteco-mb160.md) |

`GET /zkteco/device-users` returns one row per employee (`IDNo` = `EMPLOYEE_ID` = `employee.IDNo`) with `PROFILE`, and `GET /zkteco/attendance-logs` includes manual punches (`SOURCE = 'manual'`). There is no separate rename endpoint: the device name changes through the profile.

## Files

| File | Role |
|---|---|
| `server/services/attendanceEngine.js` | The rules above (pure). Tests: `server/tests/attendanceEngine.test.js` (rules) and `attendanceHours.test.js` (hours checked against randomly generated work sessions) |
| `server/services/attendanceService.js` | Loads punches/profiles/rules, runs the engine (`computeEveryone`), builds the summary, the Timesheet tab (`getTimesheets`) and one person's timesheet |
| `server/services/deviceNameSync.js` | Device name follows the profile name |
| `server/utils/employeeProfile.js` | Profile validation and the device-name shortening. Tests: `server/tests/employeeProfile.test.js` |
| `server/models/attendanceSettingsModel.js` | Per-branch rules (hours, schedule, cutoff) |
| `server/models/attendanceCalendarModel.js` | Branch holidays and per-person day marks |
| `server/models/employeeModel.js` | Profile schema migration and profile queries (legacy methods kept). The `ZK_` columns are added by `zktecoModel.js` |
| `server/models/zktecoModel.js` | People on the device (`getPeople`, `getFormerEmployees`, `mergeIntoFormerEmployee`) and punches |
| `server/controllers/attendanceController.js`, `server/routes/attendanceRoutes.js` | `/attendance/*` |
| `server/utils/zktecoHttp.js`, `server/utils/wallClock.js` | Branch scope and CRUD permission checks; date/time text checks |
| `src/services/attendanceService.ts` | Frontend client |
| `src/components/attendance/Employees.tsx`, `EmployeePanel.tsx`, `EmployeeProfileForm.tsx`, `AddDeviceUserPanel.tsx`, `profileFields.tsx` | Employees page |
| `src/components/attendance/AttendanceSummary.tsx`, `Timesheet.tsx`, `AttendanceRulesDialog.tsx`, `attendanceShared.tsx` | Summary, one person's timesheet, rules, display helpers |
| `src/components/attendance/AttendanceTimesheets.tsx`, `timesheetPeriods.ts` | Timesheet tab (grid, CSV/PDF export) and its period / cutoff math |
| `src/components/attendance/EmployeeScheduleForm.tsx`, `ExcuseDayDialog.tsx` | Employees → Schedule tab; Mark day |
| `src/components/attendance/PunchDialogs.tsx` | Edit / delete / **add** punch |

## Not built yet / ideas for later

Planned in October 2026 for a payroll build that is on hold (the senior will extend attendance step by step). Kept here so the decisions aren't lost; none of it exists in the code now.

- **Overtime.** Sanwol's practice wasn't known, so three per-branch modes were designed: *OT punches only* (OT-in → OT-out pairs), *time past the standard day or schedule*, and *any* (pairs when used, else a late time-out). Plus a minimum OT (30 min), rounding down to 30-minute blocks, and an optional OT approval step. Today's "over the standard day" figure is the natural starting point.
- **Schedules, late, undertime, absences.** Built 2026-11-05 (see *Schedules, late, undertime, absences* above), optional per branch and per person.
- **Breaks.** An automatic unpaid break (60 min on days over 5 h, less any time clocked out) was built and removed; today break time is simply time clocked out.
- **PH pay rules** (each an on/off setting with an editable multiplier): regular holiday worked 200% / unworked 100%; special day worked 130%; rest day 130%; night differential +10% for 10 PM – 6 AM. Rest days and branch holidays exist now (schedules); holidays would need a regular / special type.
- **Payroll.** Pay types hourly / daily / monthly, enabled per branch; cutoff per branch (built 2026-11-05 as an attendance rule); government deductions (SSS, PhilHealth, Pag-IBIG, withholding tax) computed from editable rules with per-employee overrides and a choice of which cutoff they come from (check current rates with an accountant); a "Pay" tab behind a `payroll` permission; payroll runs (draft → review → finalize → mark paid), payslip PDFs, a register, and a lock on punch edits in a finalized period.
- **Expenses.** Paying staff posts net pay to Expenses (category "4. 급여 및 복지 / Labor, Benefits"), one expense per payment batch by default or per employee; cash advances deducted from later payslips; a 13th-month report; per-punch correction history.
- **Open questions for Sanwol** at the time: how staff punch overtime; whether everyone is paid on one day; which cutoff and pay types; who maintains deduction rates; leave types and which 2026 holidays apply (national + Pampanga/Angeles).
