// Computed attendance (time tracking from MB160 punches), per-day schedules (Schedules page), shift
// types, holidays, per-branch rules, and employee profiles.
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
  /** Minutes after a shift's start before a time-in is late. */
  graceMinutes: number;
  cutoff: CutoffRule;
}

/** Off-duty days set on the Schedules page. */
export type OffDutyType = 'day_off' | 'leave' | 'absent';

/** A day's shift: a shift type (name and color), or custom times (name and color null). */
export interface DayShift {
  shiftTypeId: number | null;
  name: string | null;
  color: string | null;
  /** "HH:MM"; an end at or before the start is the next day's. */
  start: string;
  end: string;
}

/**
 * worked = complete; incomplete = needs fixing; off = no punches and not scheduled; upcoming =
 * future (or today, not in yet); absent = a past shift with no punches, or recorded absent;
 * rest_day = a day off; holiday = a branch holiday with no shift; excused = on leave.
 */
export type DayStatus = 'worked' | 'incomplete' | 'on_shift' | 'off' | 'upcoming' | 'absent' | 'rest_day' | 'holiday' | 'excused';

/** Problems that keep a shift from being counted (fix the punches), then notes. */
export type DayFlag = 'missing_in' | 'missing_out' | 'long_shift' | 'inferred' | 'marked_absent';

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
  /** Days on leave. */
  excusedDays: number;
  /** Days with a shift on their schedule. */
  scheduledDays: number;
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
  /** They had a shift (expected to work). */
  scheduled: boolean;
  /** The day's shift from the Schedules page, or null. */
  shift: DayShift | null;
  /** Off duty that day (day off, leave, recorded absence), or null. */
  offDuty: { type: OffDutyType; note: string | null } | null;
  lateMinutes: number;
  undertimeMinutes: number;
  /** Branch holiday name. */
  holiday: string | null;
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
  /** Excluded from schedules and attendance (a system or IT account, not staff). */
  exclude_from_attendance?: boolean;
}

export interface Holiday {
  id: number;
  date: string;
  name: string;
}

/** A branch's named shift (Opening 10:00–19:00, ...). */
export interface ShiftType {
  id: number;
  name: string;
  start: string;
  end: string;
  color: string;
  /** false = removed from the list (days already given it keep it). */
  active: boolean;
}

/** One person's entry on one date of the Schedules page. */
export type ScheduleEntry =
  | ({ type: 'shift' } & DayShift)
  | { type: OffDutyType; note: string | null };

export interface ScheduleEmployee {
  employeeId: number;
  pin: string;
  name: string | null;
  position: string | null;
  /** false = removed from the device (listed only when they have days in the range). */
  active: boolean;
  /** Hire date and last day of work ("YYYY-MM-DD"); shifts outside them aren't expected. */
  hired: string | null;
  separated: string | null;
}

/** The Schedules page's data for one branch and range. */
export interface ScheduleData {
  branchId: number;
  range: { start: string; end: string };
  /** Device-local today. */
  today: string;
  employees: ScheduleEmployee[];
  days: ({ employeeId: number; date: string } & ScheduleEntry)[];
  /** Active and removed (removed ones only to show names). */
  shiftTypes: ShiftType[];
  holidays: { date: string; name: string }[];
  permissions: { setDays: boolean; add: boolean; edit: boolean; remove: boolean };
}

/** What to put in schedule cells. */
export type ScheduleValue =
  | { type: 'shift'; shift_type_id: number }
  | { type: 'shift'; start: string; end: string }
  | { type: OffDutyType; note?: string }
  | { type: 'clear' };

/** Longest range the Schedules page loads at once (the server checks the same). */
export const MAX_SCHEDULE_DAYS = 62;

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

type HolidayRow = { IDNo: number; HOLIDAY_DATE: string; NAME: string };
const mapHolidays = (rows: HolidayRow[] | undefined): Holiday[] =>
  (rows || []).map((r) => ({ id: r.IDNo, date: r.HOLIDAY_DATE, name: r.NAME }));

/** One branch's holidays, newest first, and whether the caller may add / remove them. */
export const getHolidays = async (branchId: Branch): Promise<{ holidays: Holiday[]; canAdd: boolean; canRemove: boolean }> => {
  const response = await fetch(buildUrl('/attendance/holidays', { branch_id: branchParam(branchId) }), { headers: authHeaders() });
  const data = await handleResponse<{ holidays: HolidayRow[]; canAdd: boolean; canRemove: boolean }>(response);
  return { holidays: mapHolidays(data.holidays), canAdd: data.canAdd, canRemove: data.canRemove };
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

// ---- Schedules page ----

export const getSchedule = async (branchId: Branch, startDate: string, endDate: string): Promise<ScheduleData> => {
  const response = await fetch(
    buildUrl('/attendance/schedule', { branch_id: branchParam(branchId), start_date: startDate, end_date: endDate }),
    { headers: authHeaders() },
  );
  return handleResponse<ScheduleData>(response);
};

/** Sets every cell to `value` (one request for a whole drag). */
export const setScheduleDays = async (
  branchId: Branch,
  cells: { employeeId: number; date: string }[],
  value: ScheduleValue,
): Promise<{ changed: number }> => {
  const response = await fetch(buildUrl('/attendance/schedule', { branch_id: branchParam(branchId) }), {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ cells: cells.map((c) => ({ employee_id: c.employeeId, date: c.date })), value }),
  });
  return handleResponse<{ changed: number }>(response);
};

/** Copies 7 days from `fromStart` onto the 7 days from `toStart` (only empty days unless `overwrite`). */
export const copyScheduleWeek = async (
  branchId: Branch,
  fromStart: string,
  toStart: string,
  overwrite: boolean,
  employeeIds?: number[],
): Promise<{ written: number }> => {
  const response = await fetch(buildUrl('/attendance/schedule/copy-week', { branch_id: branchParam(branchId) }), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_start: fromStart, to_start: toStart, overwrite, employee_ids: employeeIds }),
  });
  return handleResponse<{ written: number }>(response);
};

export type ShiftTypeInput = { name: string; start: string; end: string; color: string };

export const createShiftType = async (branchId: Branch, input: ShiftTypeInput): Promise<ShiftType[]> => {
  const response = await fetch(buildUrl('/attendance/shift-types', { branch_id: branchParam(branchId) }), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await handleResponse<{ shiftTypes: ShiftType[] }>(response)).shiftTypes;
};

/** Saves a shift type. New times apply to days from today on (`updatedDays` of them). */
export const updateShiftType = async (
  branchId: Branch,
  id: number,
  input: ShiftTypeInput,
): Promise<{ shiftTypes: ShiftType[]; updatedDays: number }> => {
  const response = await fetch(buildUrl(`/attendance/shift-types/${id}`, { branch_id: branchParam(branchId) }), {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<{ shiftTypes: ShiftType[]; updatedDays: number }>(response);
};

/** Removes a shift type from the list (days already given it keep it). */
export const removeShiftType = async (branchId: Branch, id: number): Promise<ShiftType[]> => {
  const response = await fetch(buildUrl(`/attendance/shift-types/${id}`, { branch_id: branchParam(branchId) }), {
    method: 'DELETE',
    headers: authHeaders(),
  });
  return (await handleResponse<{ shiftTypes: ShiftType[] }>(response)).shiftTypes;
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
