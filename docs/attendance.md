# Attendance and employees

How the app turns MB160 punches into attendance (hours worked per day), and how employees are managed. The device side (ADMS protocol, device users, punches, corrections) is in [zkteco-mb160.md](zkteco-mb160.md).

## Status (2026-11-05)

Attendance is **basic time tracking**: punches are paired into time-in → time-out shifts and added up per day, against a standard 8-hour day. Sanwol's staff have no fixed schedules, so there is no late, undertime, absence or overtime computation. Payroll was planned and then put on hold. What was planned is in *Not built yet* at the end.

| Done | Not built (see the end) |
|---|---|
| **Employees** page = everyone on the MB160, one `employee` row each (profile + `ZK_` device columns) | Overtime rules, OT approval |
| Add employee with profile details; the device name follows the profile name | Late, undertime, absences (need schedules) |
| Hours worked per day, split into regular (up to the standard day) and "over" | Holidays, leaves, rest days |
| **Add punch** / **Edit punch** for forgotten or wrong punches | Payroll, payslips, posting to Expenses |
| Attendance Logs **Summary** tab (charts, problems, per-person totals) and per-person **Timesheet** | Night differential |

## Pages

- **Staff → Employees** (`/employee`; `/device-users` redirects here). Everyone on the MB160: profile name and position, role (device admins), **Fingerprints** (which fingers, plus an "Also:" note for any face, palm, card or password set on the device), last punch, added from. The panel has three tabs:
  - **Profile**: first name\*, last name, position, date hired, last day of work, contact no., birthdate, address, emergency contact and phone, notes. "Returning employee?" links someone added back *directly on the device* to their old profile (see *Profiles*).
  - **Device**: the name shown on the device (read-only; it follows the profile name) and fingerprints.
  - **Attendance**: the person's timesheet.

  Removed people (Show deleted → eye button) open with Profile and Attendance only.
- **Add employee**: User ID\*, first name\*, last name, position, date hired, then contact and other details. A line shows how the name will look on the device. Everyone is added as a regular device user with no password (staff punch with fingerprints); fingerprint enrollment is offered next.
- **Staff → Attendance Logs**, two tabs, both for the header's date range:
  - **Summary**: today (on shift now, came in, needs fixing), range tiles (hours worked, days worked, average per day, needs fixing), *Hours worked per day* (regular vs over), *People at work per day* (worked vs needs fixing), *Staffing by hour*, a *Needs fixing* list and a per-employee table. Clicking a person or a problem opens their timesheet.
  - **Punches**: the punch list, plus **Add punch** and manual punches tagged *Added manually*.
- **Timesheet** (side panel from the Summary, or the Attendance tab): a month calendar of hours worked per day, totals, and each day's shifts (`Time-in 10:02 AM → Time-out 7:15 PM · 9h 13m`), problems and punches with edit / delete / add.

Permissions (User Access → CRUD): **Employees** (key `device_users`) → Edit allows profile edits (and with them the device name); **Attendance Logs** → Add = add punches, Edit = edit punches and the attendance rules, Delete = delete/restore punches. The sidebar key for Employees is still `employee`.

## Profiles (`sanwol_resto.employee`)

- **One `employee` row per person, and it is also their device user** (since 2026-11-05): the profile columns below plus the device's `ZK_` columns (`ZK_PIN`, `ZK_NAME`, `ZK_ON_DEVICE`, …; see *Database* in [zkteco-mb160.md](zkteco-mb160.md)). Someone created on the device gets a row the moment the device reports them (named as on the device), in the same transaction (`admsService.saveUser`). Removing someone from the device keeps their row (`ZK_ON_DEVICE = 0`).
- **Add employee** sends the profile details with the device command; the row is created only once the device confirms the new user (see *Adding users from the app* in [zkteco-mb160.md](zkteco-mb160.md)). **Add again** puts the same row back on the device and updates its details.
- Someone deleted and re-created *on the device* gets a new row; **Profile → Returning employee?** (`POST /attendance/employees/link`, `ZktecoModel.mergeIntoFormerEmployee`) moves their device link and punches onto their old profile, and the new row is deactivated (`ACTIVE = 0`).
- **The name on the device follows the profile name** (`services/deviceNameSync.js`): saving a profile queues the profile name, shortened to the device's 24 characters, whenever it differs from what the device has (or will have after a pending rename). Role, card and password stay as the device has them. A pending removal skips it. A rename made on the device itself is not copied back: the profile is the source of truth, and the list shows *On device: …* when they differ. Shortening (`deviceNameFor`, server `utils/employeeProfile.js`, mirrored in `src/components/attendance/profileFields.tsx`): *First Last* → *First L.* → fewer first-name words with the initial → fewer first-name words → first word cut to 24 characters.
- Columns used: `FIRSTNAME`, `LASTNAME`, `DEPARTMENT` (shown as *Position*), `DATE_STARTED`, `DATE_SEPARATED`, `CONTACTNo`, `BIRTHDATE`, `ADDRESS`, `EMERGENCY_CONTACT_NAME/PHONE`, `NOTES`. `USER_INFO_ID` and `BRANCH_ID` are optional (kitchen staff have no login). The first version also added `EMPLOYMENT_TYPE`, `SHIFT_START`, `SHIFT_END`, `BREAK_MINUTES` and `REST_DAYS`; `EmployeeModel.ensureSchema` drops them (2026-11-04). The legacy `/employees_list` and `/employee/:id` API is untouched (it lists explicit columns, so it never returns the `ZK_` ones).
- The Profile tab and Add employee share their fields and checks (`profileFields.tsx`; server `utils/employeeProfile.js`).

## The attendance engine (`server/services/attendanceEngine.js`)

Pure function (no DB): one person's punches + the branch rules → one record per day. Unit tests: `cd server && npm test`. `services/attendanceService.js` loads the data (punches from `zk_attendance_logs`, people from `employee`, rules from `attendance_settings`) and runs it per person.

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

**Problems** (day status *Needs fixing*; the broken shift isn't counted until fixed): `missing_in`, `missing_out`, `long_shift` (a shift over 16 h: almost always a forgotten time-out joined to a later one). Note: `inferred`. Fix them with **Add punch** / **Edit punch** in the timesheet. Add punch warns when a time-out is entered before the shift's time-in (a night shift's time-out after midnight goes on the next date).

**Day statuses**: `worked`, `incomplete` (needs fixing), `on_shift`, `off` (no punches), `upcoming`.

**Totals** per person: days worked (days with a time-in), hours worked, regular, over, needs fixing, and the average per day (over days with counted hours).

## Attendance rules (`sanwol_resto.attendance_settings`)

One row per branch, edited in **Attendance Logs → Summary → Attendance rules** (a specific branch must be selected). A branch without a row uses the defaults:

| Rule | Column | Default |
|---|---|---|
| Standard day (hours counted as regular) | `STANDARD_HOURS` | 8 |
| Longest shift (no time-out within this = forgotten) | `MAX_SHIFT_HOURS` | 20 |

The first version's columns (`GRACE_MINUTES`, `OT_MODE`, `OT_MIN_MINUTES`, `OT_ROUND_MINUTES`, `DEFAULT_BREAK_MINUTES`) are dropped by `AttendanceSettingsModel.ensureSchema`. Changing a rule recomputes everything on the fly (attendance is never stored).

## Manual punches and punch types (`zk_attendance_logs`, `SOURCE = 'manual'`)

For a forgotten punch: **Attendance Logs → Punches → Add punch**, or **Add punch** on a timesheet day (it suggests the missing type). A reason is required. They're rows of `zk_attendance_logs` with `SOURCE = 'manual'`, no `DEVICE_ID`/`PIN`, and the person's `EMPLOYEE_ID` (so PIN reuse can't move them). They show in the punch list as *Added manually* (verified by "Entered in the app"), count like device punches, and are edited, deleted (soft) and restored through the same endpoints as device punches. A manual punch can't share the exact time of another of that person's counted punches.

**A reason is required** to add, edit or delete any punch (device or manual). Only setting a device punch back to the device's record and restoring a deleted punch need none.

The app sets only **Time-in / Time-out** (adding, and editing any punch). Editing can also keep the type a punch already has (e.g. an OT-in recorded by the device), so an edit never forces a change of type. The server enforces the same.

*Device setting to consider:* the MB160's punch-state keys can usually be limited to Time-in and Time-out (on the device, around Personalize → Shortcut Keys; check the exact menu). Not required: the other keys count as arriving or leaving anyway.

## API

| Method | Path | |
|---|---|---|
| GET | `/attendance/summary?branch_id&start_date&end_date` | Summary (max 366 days) |
| GET | `/attendance/timesheet/:employeeId?branch_id&start_date&end_date` | One person's days with punches |
| GET / PUT | `/attendance/settings?branch_id=X` | Rules of one branch (`{ standardHours, maxShiftHours }`) |
| GET / PATCH | `/attendance/employees/:id?branch_id` | Profile (PATCH: snake_case fields; only those sent change; the response's `DEVICE_RENAME` is the device name queued, if any) |
| GET | `/attendance/former-employees?branch_id` | People removed from the device whose profile is active |
| POST | `/attendance/employees/link?branch_id` | `{ employee_id (their new row), former_employee_id }` |
| POST | `/zkteco/attendance-logs` | Add a manual punch `{ employee_id, punch_dt, status, reason }`. Edit / delete / restore use the punch endpoints in [zkteco-mb160.md](zkteco-mb160.md) |

`GET /zkteco/device-users` returns one row per employee (`IDNo` = `EMPLOYEE_ID` = `employee.IDNo`) with `PROFILE`, and `GET /zkteco/attendance-logs` includes manual punches (`SOURCE = 'manual'`). There is no separate rename endpoint: the device name changes through the profile.

## Files

| File | Role |
|---|---|
| `server/services/attendanceEngine.js` | The rules above (pure). Tests: `server/tests/attendanceEngine.test.js` (rules) and `attendanceHours.test.js` (hours checked against randomly generated work sessions) |
| `server/services/attendanceService.js` | Loads punches/profiles/rules, runs the engine, builds summary and timesheet |
| `server/services/deviceNameSync.js` | Device name follows the profile name |
| `server/utils/employeeProfile.js` | Profile validation and the device-name shortening. Tests: `server/tests/employeeProfile.test.js` |
| `server/models/attendanceSettingsModel.js` | Per-branch rules |
| `server/models/employeeModel.js` | Profile schema migration and profile queries (legacy methods kept). The `ZK_` columns are added by `zktecoModel.js` |
| `server/models/zktecoModel.js` | People on the device (`getPeople`, `getFormerEmployees`, `mergeIntoFormerEmployee`) and punches |
| `server/controllers/attendanceController.js`, `server/routes/attendanceRoutes.js` | `/attendance/*` |
| `server/utils/zktecoHttp.js`, `server/utils/wallClock.js` | Branch scope and CRUD permission checks; date/time text checks |
| `src/services/attendanceService.ts` | Frontend client |
| `src/components/attendance/Employees.tsx`, `EmployeePanel.tsx`, `EmployeeProfileForm.tsx`, `AddDeviceUserPanel.tsx`, `profileFields.tsx` | Employees page |
| `src/components/attendance/AttendanceSummary.tsx`, `Timesheet.tsx`, `AttendanceRulesDialog.tsx`, `attendanceShared.tsx` | Summary, timesheet, rules, display helpers |
| `src/components/attendance/PunchDialogs.tsx` | Edit / delete / **add** punch |

## Not built yet / ideas for later

Planned in October 2026 for a payroll build that is on hold (the senior will extend attendance step by step). Kept here so the decisions aren't lost; none of it exists in the code now.

- **Overtime.** Sanwol's practice wasn't known, so three per-branch modes were designed: *OT punches only* (OT-in → OT-out pairs), *time past the standard day or schedule*, and *any* (pairs when used, else a late time-out). Plus a minimum OT (30 min), rounding down to 30-minute blocks, and an optional OT approval step. Today's "over the standard day" figure is the natural starting point.
- **Schedules, late, undertime, absences.** Need a start time per person or per branch (e.g. a branch-wide call time) and a grace period (15 min was agreed). Without fixed schedules, absences can't be told apart from days off.
- **Breaks.** An automatic unpaid break (60 min on days over 5 h, less any time clocked out) was built and removed; today break time is simply time clocked out.
- **PH pay rules** (each an on/off setting with an editable multiplier): regular holiday worked 200% / unworked 100%; special day worked 130%; rest day 130%; night differential +10% for 10 PM – 6 AM. Rest days need a per-person "days off" setting.
- **Payroll.** Pay types hourly / daily / monthly, enabled per branch; cutoff per branch (semi-monthly 1–15 / 16–end, weekly, bi-weekly, monthly); government deductions (SSS, PhilHealth, Pag-IBIG, withholding tax) computed from editable rules with per-employee overrides and a choice of which cutoff they come from (check current rates with an accountant); a "Pay" tab behind a `payroll` permission; payroll runs (draft → review → finalize → mark paid), payslip PDFs, a register, and a lock on punch edits in a finalized period.
- **Expenses.** Paying staff posts net pay to Expenses (category "4. 급여 및 복지 / Labor, Benefits"), one expense per payment batch by default or per employee; cash advances deducted from later payslips; a 13th-month report; per-punch correction history.
- **Open questions for Sanwol** at the time: how staff punch overtime; whether everyone is paid on one day; which cutoff and pay types; who maintains deduction rates; leave types and which 2026 holidays apply (national + Pampanga/Angeles).
