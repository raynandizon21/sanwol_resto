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
} from './zktecoService';

// ---- Types ----

/** Per-branch rules (server/models/attendanceSettingsModel.js). */
export interface AttendanceRules {
  /** Hours a day counted as regular; more is shown as "over". */
  standardHours: number;
  /** A time-in with no time-out within this many hours is a forgotten time-out. */
  maxShiftHours: number;
}

/** worked = complete; incomplete = needs fixing; off = no punches; upcoming = future. */
export type DayStatus = 'worked' | 'incomplete' | 'on_shift' | 'off' | 'upcoming';

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
  employee: {
    employeeId: number;
    deviceId: number;
    pin: string;
    name: string | null;
    position: string | null;
    branchId: number | null;
    active: boolean;
  };
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
