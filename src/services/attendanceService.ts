// Computed attendance (basic time tracking from MB160 punches), per-branch rules, and employee profiles.
// Server: routes/attendanceRoutes.js. Rules: docs/attendance.md.

import {
  authHeaders,
  branchParam,
  buildUrl,
  handleResponse,
  mapEmployeeProfile,
  type EmployeeProfile,
  type EmployeeProfileApiRecord,
  type ScheduleMode,
} from './zktecoService';

// ---- Types ----

/**
 * When payroll periods start: twice a month (on day1 and day2), monthly (day1), weekly (on
 * `weekday`, 0 = Sunday) or every two weeks (from `anchor`, the first day of one period).
 */
export interface CutoffRule {
  type: 'semi_monthly' | 'monthly' | 'weekly' | 'biweekly';
  day1: number;
  day2: number;
  weekday: number;
  anchor: string | null;
}

/** Per-branch rules (server/models/attendanceSettingsModel.js). */
export interface AttendanceRules {
  /** Hours a day counted as regular; more is shown as "over". */
  standardHours: number;
  /** A time-in with no time-out within this many hours is a forgotten time-out. */
  maxShiftHours: number;
  /** Branch call time "HH:MM"; null = no branch schedule (nobody following it is late or absent). */
  scheduleStart: string | null;
  /** Branch end time "HH:MM"; null = no undertime. */
  scheduleEnd: string | null;
  /** Minutes after the start before a time-in is late. */
  graceMinutes: number;
  /** Weekdays the branch is closed (0 = Sunday): rest days for everyone on the branch schedule. */
  closedDays: number[];
  cutoff: CutoffRule;
}

/** The schedule a person is checked against (null = not tracked). */
export interface WorkSchedule {
  source: 'branch' | 'own';
  start: string;
  end: string | null;
  restDays: number[];
}

export type ExcuseType = 'leave' | 'day_off' | 'holiday';

/**
 * worked = complete; incomplete = needs fixing; off = no punches (and none expected); upcoming =
 * future; absent = a past work day with no punches; rest_day = a rest day or the branch is closed;
 * holiday = a branch holiday; excused = marked leave / day off / holiday for this person.
 */
export type DayStatus = 'worked' | 'incomplete' | 'on_shift' | 'off' | 'upcoming' | 'absent' | 'rest_day' | 'holiday' | 'excused';

/** Problems that keep a shift from being counted (fix the punches), then notes. */
export type DayFlag = 'missing_in' | 'missing_out' | 'long_shift' | 'inferred';

export const ISSUE_FLAGS: DayFlag[] = ['missing_in', 'missing_out', 'long_shift'];

export interface AttendanceTotals {
  /** Days with a time-in. */
  daysWorked: number;
  /** Days with counted hours (the average is over these). */
  daysWithHours: number;
  workedMinutes: number;
  regularMinutes: number;
  overMinutes: number;
  incompleteDays: number;
  absentDays: number;
  lateDays: number;
  lateMinutes: number;
  undertimeDays: number;
  undertimeMinutes: number;
  /** Days marked leave / day off / holiday for the person (branch holidays aren't counted). */
  excusedDays: number;
  averageMinutes: number;
}

export interface WorkShift {
  /** "YYYY-MM-DD HH:mm", device-local. */
  in: string | null;
  inInferred: boolean;
  out: string | null;
  outInferred: boolean;
  /** Counted minutes; null when the shift is open or needs fixing. */
  minutes: number | null;
  /** Still running (no time-out yet). */
  open: boolean;
}

export interface TimesheetPunch {
  source: 'device' | 'manual';
  id: number;
  deviceId: number;
  pin: string;
  punchDt: string;
  status: number | null;
  originalPunchDt: string;
  originalStatus: number | null;
  isEdited: boolean;
  reason: string | null;
  verifyType: number | null;
}

export interface WorkDay {
  date: string;
  status: DayStatus;
  workedMinutes: number;
  regularMinutes: number;
  overMinutes: number;
  /** A work day by the schedule (not a rest day, holiday or excused day). */
  scheduled: boolean;
  lateMinutes: number;
  undertimeMinutes: number;
  restDay: boolean;
  /** Branch holiday name. */
  holiday: string | null;
  excuse: { type: ExcuseType; note: string | null } | null;
  flags: DayFlag[];
  shifts: WorkShift[];
}

export interface SummaryEmployee {
  /** null for punches of a User ID that isn't on the device. */
  employeeId: number | null;
  deviceId: number;
  pin: string;
  name: string | null;
  position: string | null;
  branchId: number | null;
  active: boolean;
  /** Their setting (null for a User ID that isn't on the device). */
  scheduleMode: ScheduleMode | null;
  /** What they're checked against; null = not tracked (no late, undertime or absences). */
  schedule: WorkSchedule | null;
  totals: AttendanceTotals;
}

export interface AttendanceSummary {
  range: { start: string; end: string };
  now: string;
  today: {
    date: string;
    onShift: { employeeId: number; name: string | null; pin: string; since: string | null }[];
    cameIn: number;
    needsFixing: number;
  };
  employees: SummaryEmployee[];
  daily: { date: string; regularMinutes: number; overMinutes: number; people: number; incomplete: number }[];
  /** People at work at each hour, averaged over the days someone worked (`days` of them so far). */
  hourly: { hour: number; average: number; days: number }[];
  issues: { employeeId: number | null; name: string | null; pin: string; date: string; flags: DayFlag[] }[];
  totals: AttendanceTotals;
}

export interface Timesheet {
  employee: Omit<SummaryEmployee, 'totals' | 'employeeId'> & { employeeId: number };
  rules: AttendanceRules;
  now: string;
  days: (WorkDay & { punches: TimesheetPunch[] })[];
  totals: AttendanceTotals;
}

/** One person's row of the Timesheet tab. */
export interface TimesheetsEmployee extends Omit<SummaryEmployee, 'totals'> {
  /** The standard day of the person's branch (hours counted as regular). */
  standardHours: number;
  days: WorkDay[];
  totals: AttendanceTotals;
}

/** Everyone's days for the Timesheet tab (at most MAX_TIMESHEETS_DAYS days). */
export interface Timesheets {
  range: { start: string; end: string };
  now: string;
  /** The scope's cutoff (`mixed`: its branches differ, so this is the default). */
  cutoff: CutoffRule & { mixed: boolean };
  employees: TimesheetsEmployee[];
  totals: AttendanceTotals;
}

/** Longest range the Timesheet tab takes (one column per day; the server checks the same). */
export const MAX_TIMESHEETS_DAYS = 62;

export interface FormerEmployee {
  id: number;
  name: string | null;
  position: string | null;
  dateStarted: string | null;
  dateSeparated: string | null;
}

/** Profile fields as the API takes them; only the ones sent are changed. */
export interface EmployeeProfileChanges {
  first_name?: string;
  last_name?: string;
  contact_no?: string;
  position?: string;
  address?: string;
  birthdate?: string;
  date_started?: string;
  date_separated?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  notes?: string;
  schedule_mode?: ScheduleMode;
  schedule_start?: string;
  schedule_end?: string;
  schedule_rest_days?: number[];
}

export interface BranchSchedule {
  start: string | null;
  end: string | null;
  closedDays: number[];
  graceMinutes: number;
}

export interface Holiday {
  id: number;
  date: string;
  name: string;
}

type Branch = string | number | null | undefined;

// ---- API ----

export const getAttendanceSummary = async (branchId: Branch, startDate: string, endDate: string): Promise<AttendanceSummary> => {
  const response = await fetch(
    buildUrl('/attendance/summary', { branch_id: branchParam(branchId), start_date: startDate, end_date: endDate }),
    { headers: authHeaders() },
  );
  return handleResponse<AttendanceSummary>(response);
};

export const getTimesheet = async (
  branchId: Branch,
  employeeId: number,
  startDate: string,
  endDate: string,
): Promise<Timesheet> => {
  const response = await fetch(
    buildUrl(`/attendance/timesheet/${employeeId}`, { branch_id: branchParam(branchId), start_date: startDate, end_date: endDate }),
    { headers: authHeaders() },
  );
  return handleResponse<Timesheet>(response);
};

export const getTimesheets = async (branchId: Branch, startDate: string, endDate: string): Promise<Timesheets> => {
  const response = await fetch(
    buildUrl('/attendance/timesheets', { branch_id: branchParam(branchId), start_date: startDate, end_date: endDate }),
    { headers: authHeaders() },
  );
  return handleResponse<Timesheets>(response);
};

export const getAttendanceRules = async (branchId: Branch): Promise<{ rules: AttendanceRules; canEdit: boolean }> => {
  const response = await fetch(buildUrl('/attendance/settings', { branch_id: branchParam(branchId) }), {
    headers: authHeaders(),
  });
  return handleResponse<{ rules: AttendanceRules; canEdit: boolean }>(response);
};

export const saveAttendanceRules = async (branchId: Branch, rules: AttendanceRules): Promise<void> => {
  const response = await fetch(buildUrl('/attendance/settings', { branch_id: branchParam(branchId) }), {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(rules),
  });
  await handleResponse<unknown>(response);
};

export const updateEmployeeProfile = async (
  branchId: Branch,
  employeeId: number,
  changes: EmployeeProfileChanges,
): Promise<{ profile: EmployeeProfile; deviceRename: string | null }> => {
  const response = await fetch(buildUrl(`/attendance/employees/${employeeId}`, { branch_id: branchParam(branchId) }), {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  const row = await handleResponse<EmployeeProfileApiRecord & { DEVICE_RENAME: string | null }>(response);
  // DEVICE_RENAME: the new name queued for the device when the profile name changed.
  return { profile: mapEmployeeProfile(row), deviceRename: row.DEVICE_RENAME ?? null };
};

/** One profile, with the branch schedule the person would follow. */
export const getEmployeeProfile = async (
  branchId: Branch,
  employeeId: number,
): Promise<{ profile: EmployeeProfile; branchSchedule: BranchSchedule }> => {
  const response = await fetch(buildUrl(`/attendance/employees/${employeeId}`, { branch_id: branchParam(branchId) }), {
    headers: authHeaders(),
  });
  const row = await handleResponse<EmployeeProfileApiRecord & { BRANCH_SCHEDULE: BranchSchedule }>(response);
  return { profile: mapEmployeeProfile(row), branchSchedule: row.BRANCH_SCHEDULE };
};

type HolidayRow = { IDNo: number; HOLIDAY_DATE: string; NAME: string };
const mapHolidays = (rows: HolidayRow[] | undefined): Holiday[] =>
  (rows || []).map((r) => ({ id: r.IDNo, date: r.HOLIDAY_DATE, name: r.NAME }));

/** One branch's holidays, newest first. */
export const getHolidays = async (branchId: Branch): Promise<{ holidays: Holiday[]; canEdit: boolean }> => {
  const response = await fetch(buildUrl('/attendance/holidays', { branch_id: branchParam(branchId) }), { headers: authHeaders() });
  const data = await handleResponse<{ holidays: HolidayRow[]; canEdit: boolean }>(response);
  return { holidays: mapHolidays(data.holidays), canEdit: data.canEdit };
};

/** Adds a branch holiday (a date that has one is renamed). Returns the new list. */
export const saveHoliday = async (branchId: Branch, date: string, name: string): Promise<Holiday[]> => {
  const response = await fetch(buildUrl('/attendance/holidays', { branch_id: branchParam(branchId) }), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, name }),
  });
  return mapHolidays((await handleResponse<{ holidays: HolidayRow[] }>(response)).holidays);
};

export const removeHoliday = async (branchId: Branch, id: number): Promise<Holiday[]> => {
  const response = await fetch(buildUrl(`/attendance/holidays/${id}`, { branch_id: branchParam(branchId) }), {
    method: 'DELETE',
    headers: authHeaders(),
  });
  return mapHolidays((await handleResponse<{ holidays: HolidayRow[] }>(response)).holidays);
};

/** Marks one person's day as leave, day off or holiday (not an absence). */
export const saveExcusedDay = async (
  branchId: Branch,
  employeeId: number,
  date: string,
  type: ExcuseType,
  note: string,
): Promise<void> => {
  const response = await fetch(buildUrl('/attendance/excused-days', { branch_id: branchParam(branchId) }), {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: employeeId, date, type, note }),
  });
  await handleResponse<unknown>(response);
};

export const removeExcusedDay = async (branchId: Branch, employeeId: number, date: string): Promise<void> => {
  const response = await fetch(
    buildUrl('/attendance/excused-days', { branch_id: branchParam(branchId), employee_id: String(employeeId), date }),
    { method: 'DELETE', headers: authHeaders() },
  );
  await handleResponse<unknown>(response);
};

export const getFormerEmployees = async (branchId: Branch): Promise<FormerEmployee[]> => {
  const response = await fetch(buildUrl('/attendance/former-employees', { branch_id: branchParam(branchId) }), {
    headers: authHeaders(),
  });
  const rows = await handleResponse<
    { IDNo: number; NAME: string | null; DEPARTMENT: string | null; DATE_STARTED: string | null; DATE_SEPARATED: string | null }[]
  >(response);
  return (rows || []).map((r) => ({
    id: r.IDNo,
    name: r.NAME,
    position: r.DEPARTMENT,
    dateStarted: r.DATE_STARTED,
    dateSeparated: r.DATE_SEPARATED,
  }));
};

/**
 * Someone added back directly on the device got a new profile (`employeeId`): their device link
 * and punches move onto their former profile (`formerEmployeeId`), and the new one is removed.
 */
export const linkFormerEmployee = async (branchId: Branch, employeeId: number, formerEmployeeId: number): Promise<void> => {
  const response = await fetch(buildUrl('/attendance/employees/link', { branch_id: branchParam(branchId) }), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: employeeId, former_employee_id: formerEmployeeId }),
  });
  await handleResponse<unknown>(response);
};
