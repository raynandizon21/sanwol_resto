// ZKTeco MB160 attendance device: data and actions for the Attendance Logs and
// Employees pages. See docs/zkteco-mb160.md and docs/attendance.md.

import type { EmployeeProfileChanges } from './attendanceService';

// ---- Types ----

export interface ZkDevice {
  id: number;
  serialNo: string;
  name: string;
  branchId: number | null;
  branchName: string | null;
  ipAddress: string | null;
  firmware: string | null;
  /** Counts the device itself reports (INFO on each poll). */
  deviceUserCount: number | null;
  devicePunchCount: number | null;
  /** Counts stored in the app. */
  storedPunches: number;
  storedUsers: number;
  lastSeen: string | null;
  isOnline: boolean;
  active: boolean;
}

export interface AttendanceLog {
  /** Unique across both kinds of punch (device and manual IDs are separate sequences). */
  key: string;
  id: number;
  /** device = recorded by the MB160; manual = added in the app for a forgotten punch. */
  source: 'device' | 'manual';
  deviceId: number;
  deviceName: string;
  branchName: string | null;
  pin: string;
  name: string | null;
  /** Device-local wall-clock time, "YYYY-MM-DD HH:mm:ss" (with the app's correction, if any). */
  punchDt: string;
  status: number | null;
  /** What the device recorded, before any correction. */
  originalPunchDt: string;
  originalStatus: number | null;
  verifyType: number | null;
  workCode: string | null;
  receivedDt: string;
  /** false when the person was since removed from the device (the name is kept). */
  userActive: boolean | null;
  /** The person's latest device user id (same across their re-adds); null when not on the device. */
  personId: number | null;
  /** Their User ID now, when they were added again under a different one than this punch's. */
  currentPin: string | null;
  isEdited: boolean;
  isDeleted: boolean;
  correctionReason: string | null;
  correctedBy: string | null;
  correctedDt: string | null;
  /** Manual punches: who added it. */
  addedBy: string | null;
}

/** The app-only profile of a device user (sanwol_resto.employee). */
export interface EmployeeProfile {
  id: number;
  firstName: string;
  lastName: string;
  /** First and last name, or null when both are empty. */
  fullName: string | null;
  contactNo: string;
  position: string;
  address: string;
  birthdate: string;
  dateStarted: string;
  dateSeparated: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  notes: string;
}

export interface DeviceUser {
  id: number;
  deviceId: number;
  deviceName: string;
  branchName: string | null;
  pin: string;
  name: string | null;
  privilege: number | null;
  source: string;
  hasPassword: boolean;
  hasCard: boolean;
  fingerprints: number;
  hasFace: boolean;
  palms: number;
  hasPhoto: boolean;
  /** Finger numbers (0-9) that have a fingerprint enrolled. */
  fingers: number[];
  lastPunchDt: string | null;
  updatedDt: string;
  /** false = removed from the device (listed only with "Show deleted"). */
  active: boolean;
  /** For removed users: when, and who removed them from the app (null = removed on the device). */
  removedDt: string | null;
  removedBy: string | null;
  employeeId: number | null;
  profile: EmployeeProfile | null;
}

// ---- API internals ----

type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
};

type DeviceApiRecord = {
  IDNo: number;
  SERIAL_NO: string;
  BRANCH_ID: number | null;
  BRANCH_NAME: string | null;
  DEVICE_NAME: string | null;
  IP_ADDRESS: string | null;
  FIRMWARE: string | null;
  USER_COUNT: number | null;
  ATT_COUNT: number | null;
  STORED_PUNCHES: number;
  STORED_USERS: number;
  LAST_SEEN_DT: string | null;
  IS_ONLINE: number;
  ACTIVE: number;
};

type AttendanceLogApiRecord = {
  SOURCE: 'device' | 'manual';
  IDNo: number;
  DEVICE_ID: number;
  BRANCH_NAME: string | null;
  PIN: string;
  NAME: string | null;
  PUNCH_DT: string;
  PUNCH_STATUS: number | null;
  ORIGINAL_PUNCH_DT: string;
  ORIGINAL_PUNCH_STATUS: number | null;
  VERIFY_TYPE: number | null;
  WORK_CODE: string | null;
  RECEIVED_DT: string;
  USER_ACTIVE: number | null;
  PERSON_ID: number | null;
  CURRENT_PIN: string | null;
  IS_EDITED: number;
  IS_DELETED: number;
  CORRECTION_REASON: string | null;
  CORRECTED_BY_NAME: string | null;
  CORRECTED_DT: string | null;
  ADDED_BY_NAME?: string | null;
  SERIAL_NO: string;
  DEVICE_NAME: string | null;
};

export type EmployeeProfileApiRecord = {
  IDNo: number;
  FIRSTNAME: string | null;
  LASTNAME: string | null;
  CONTACTNo: string | null;
  DEPARTMENT: string | null;
  ADDRESS: string | null;
  BIRTHDATE: string | null;
  DATE_STARTED: string | null;
  DATE_SEPARATED: string | null;
  EMERGENCY_CONTACT_NAME: string | null;
  EMERGENCY_CONTACT_PHONE: string | null;
  NOTES: string | null;
};

type DeviceUserApiRecord = {
  IDNo: number;
  DEVICE_ID: number;
  BRANCH_NAME: string | null;
  PIN: string;
  NAME: string | null;
  PRIVILEGE: number | null;
  SOURCE: string;
  HAS_PASSWORD: number;
  HAS_CARD: number;
  FP_COUNT: number | string;
  HAS_FACE: number | string;
  PALM_COUNT: number | string;
  HAS_PHOTO: number | string;
  FP_FINGERS: string | null;
  LAST_PUNCH_DT: string | null;
  ACTIVE: number;
  ENCODED_DT: string;
  EDITED_DT: string | null;
  EDITED_BY_NAME: string | null;
  SERIAL_NO: string;
  DEVICE_NAME: string | null;
  EMPLOYEE_ID: number | null;
  PROFILE: EmployeeProfileApiRecord | null;
};

const API_BASE = '/data-api';

export const buildUrl = (path: string, params?: Record<string, string>) => {
  const url = new URL(`${window.location.origin}${API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });
  }
  return url.toString();
};

export const authHeaders = (): Record<string, string> => {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

export const handleResponse = async <T,>(response: Response): Promise<T> => {
  const json = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Request failed');
  }
  return json.data;
};

const deviceLabel = (name: string | null, serialNo: string) => (name ? `${name} (${serialNo})` : serialNo);

const mapDevice = (row: DeviceApiRecord): ZkDevice => ({
  id: row.IDNo,
  serialNo: row.SERIAL_NO,
  name: row.DEVICE_NAME || row.SERIAL_NO,
  branchId: row.BRANCH_ID,
  branchName: row.BRANCH_NAME,
  ipAddress: row.IP_ADDRESS,
  firmware: row.FIRMWARE,
  deviceUserCount: row.USER_COUNT,
  devicePunchCount: row.ATT_COUNT,
  storedPunches: Number(row.STORED_PUNCHES) || 0,
  storedUsers: Number(row.STORED_USERS) || 0,
  lastSeen: row.LAST_SEEN_DT,
  isOnline: Boolean(Number(row.IS_ONLINE)),
  active: Boolean(Number(row.ACTIVE)),
});

const mapAttendanceLog = (row: AttendanceLogApiRecord): AttendanceLog => ({
  key: `${row.SOURCE}:${row.IDNo}`,
  id: row.IDNo,
  source: row.SOURCE,
  deviceId: row.DEVICE_ID,
  deviceName: deviceLabel(row.DEVICE_NAME, row.SERIAL_NO),
  branchName: row.BRANCH_NAME,
  pin: row.PIN,
  name: row.NAME,
  punchDt: row.PUNCH_DT,
  status: row.PUNCH_STATUS,
  originalPunchDt: row.ORIGINAL_PUNCH_DT,
  originalStatus: row.ORIGINAL_PUNCH_STATUS,
  verifyType: row.VERIFY_TYPE,
  workCode: row.WORK_CODE,
  receivedDt: row.RECEIVED_DT,
  userActive: row.USER_ACTIVE == null ? null : Boolean(Number(row.USER_ACTIVE)),
  personId: row.PERSON_ID,
  currentPin: row.CURRENT_PIN,
  isEdited: Boolean(Number(row.IS_EDITED)),
  isDeleted: Boolean(Number(row.IS_DELETED)),
  correctionReason: row.CORRECTION_REASON,
  correctedBy: row.CORRECTED_BY_NAME,
  correctedDt: row.CORRECTED_DT,
  addedBy: row.ADDED_BY_NAME ?? null,
});

export const mapEmployeeProfile = (row: EmployeeProfileApiRecord): EmployeeProfile => {
  const firstName = row.FIRSTNAME ?? '';
  const lastName = row.LASTNAME ?? '';
  return {
    id: row.IDNo,
    firstName,
    lastName,
    fullName: [firstName, lastName].map((v) => v.trim()).filter(Boolean).join(' ') || null,
    contactNo: row.CONTACTNo ?? '',
    position: row.DEPARTMENT ?? '',
    address: row.ADDRESS ?? '',
    birthdate: row.BIRTHDATE ?? '',
    dateStarted: row.DATE_STARTED ?? '',
    dateSeparated: row.DATE_SEPARATED ?? '',
    emergencyContactName: row.EMERGENCY_CONTACT_NAME ?? '',
    emergencyContactPhone: row.EMERGENCY_CONTACT_PHONE ?? '',
    notes: row.NOTES ?? '',
  };
};

const mapDeviceUser = (row: DeviceUserApiRecord): DeviceUser => ({
  id: row.IDNo,
  deviceId: row.DEVICE_ID,
  deviceName: deviceLabel(row.DEVICE_NAME, row.SERIAL_NO),
  branchName: row.BRANCH_NAME,
  pin: row.PIN,
  name: row.NAME,
  privilege: row.PRIVILEGE,
  source: row.SOURCE,
  hasPassword: Boolean(Number(row.HAS_PASSWORD)),
  hasCard: Boolean(Number(row.HAS_CARD)),
  fingerprints: Number(row.FP_COUNT) || 0,
  hasFace: Boolean(Number(row.HAS_FACE)),
  palms: Number(row.PALM_COUNT) || 0,
  hasPhoto: Boolean(Number(row.HAS_PHOTO)),
  // Each finger once (a finger can have both an FP and a BIODATA template), only real FIDs 0-9,
  // in the device's order (left hand 0-4, then right 5-9).
  fingers: [
    ...new Set(
      String(row.FP_FINGERS ?? '')
        .split(',')
        .filter((v) => v !== '')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 9),
    ),
  ].sort((a, b) => a - b),
  lastPunchDt: row.LAST_PUNCH_DT,
  updatedDt: row.EDITED_DT || row.ENCODED_DT,
  active: Boolean(Number(row.ACTIVE)),
  removedDt: Number(row.ACTIVE) ? null : row.EDITED_DT,
  removedBy: Number(row.ACTIVE) ? null : row.EDITED_BY_NAME,
  employeeId: row.EMPLOYEE_ID,
  profile: row.PROFILE ? mapEmployeeProfile(row.PROFILE) : null,
});

/** "all" (or empty) = every branch the user can see. */
export const branchParam = (branchId: string | number | null | undefined) =>
  branchId == null || branchId === '' ? 'all' : String(branchId);

// ---- Public API ----

export const getZkDevices = async (branchId?: string | number | null): Promise<ZkDevice[]> => {
  const response = await fetch(buildUrl('/zkteco/devices', { branch_id: branchParam(branchId) }), {
    headers: authHeaders(),
  });
  const data = await handleResponse<DeviceApiRecord[]>(response);
  return (data || []).map(mapDevice);
};

export const getAttendanceLogs = async (params: {
  branchId?: string | number | null;
  startDate?: string;
  endDate?: string;
  /** Soft-deleted punches too (shown greyed out with Restore). */
  includeDeleted?: boolean;
}): Promise<{ logs: AttendanceLog[]; truncatedAt: number | null }> => {
  const response = await fetch(
    buildUrl('/zkteco/attendance-logs', {
      branch_id: branchParam(params.branchId),
      start_date: params.startDate || '',
      end_date: params.endDate || '',
      include_deleted: params.includeDeleted ? '1' : '',
    }),
    { headers: authHeaders() },
  );
  // Set when the range has more punches than the server returns (newest first).
  const truncatedAt = Number(response.headers.get('X-Result-Truncated')) || null;
  const data = await handleResponse<AttendanceLogApiRecord[]>(response);
  return { logs: (data || []).map(mapAttendanceLog), truncatedAt };
};

export const getDeviceUsers = async (
  branchId?: string | number | null,
  options: { includeDeleted?: boolean } = {},
): Promise<DeviceUser[]> => {
  const response = await fetch(
    buildUrl('/zkteco/device-users', {
      branch_id: branchParam(branchId),
      include_deleted: options.includeDeleted ? '1' : '',
    }),
    { headers: authHeaders() },
  );
  const data = await handleResponse<DeviceUserApiRecord[]>(response);
  return (data || []).map(mapDeviceUser);
};

// ---- Adding users to the device ----

export const DEVICE_PRIVILEGE_USER = 0;
export const DEVICE_PRIVILEGE_ADMIN = 14;

/**
 * Always added as a regular user with no password (staff punch with fingerprints; device admins
 * are made on the MB160). `profile` becomes their employee profile once the device confirms them.
 */
export interface NewDeviceUser {
  deviceId?: number;
  pin: string;
  /** Only used without a profile; with one, the server makes the device name from the profile name. */
  name?: string;
  profile?: EmployeeProfileChanges;
  /** "Add again": the removed user's id; once the device confirms, that row leaves Show deleted. */
  readdOf?: number;
}

/** A user pushed from the app that the device hasn't confirmed yet, or that it rejected. */
export interface PendingDeviceUser {
  commandId: number;
  deviceId: number;
  deviceName: string;
  branchName: string | null;
  pin: string | null;
  name: string | null;
  /** add = new user; edit = changing a user's details; delete = removing a user. */
  kind: 'add' | 'edit' | 'delete';
  /** pending = waiting for the device's next poll; sent = delivered, waiting for its answer. */
  status: 'pending' | 'sent' | 'failed';
  returnCode: number | null;
  queuedDt: string;
}

type PendingDeviceUserApiRecord = {
  IDNo: number;
  DEVICE_ID: number;
  PIN: string | null;
  NAME: string | null;
  KIND: 'add' | 'edit' | 'delete';
  STATUS: 'pending' | 'sent' | 'failed';
  RETURN_CODE: number | null;
  ENCODED_DT: string;
  SERIAL_NO: string;
  DEVICE_NAME: string | null;
  BRANCH_NAME: string | null;
};

/** Queues the user for the device; it is delivered on the device's next poll (about 10 s). */
export const createDeviceUser = async (
  branchId: string | number | null | undefined,
  user: NewDeviceUser,
): Promise<{ commandId: number }> => {
  const response = await fetch(buildUrl('/zkteco/device-users', { branch_id: branchParam(branchId) }), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: user.deviceId,
      pin: user.pin,
      name: user.name ?? '',
      profile: user.profile ?? null,
      readd_of: user.readdOf ?? null,
    }),
  });
  return handleResponse<{ commandId: number }>(response);
};

export const getPendingDeviceUsers = async (
  branchId?: string | number | null,
): Promise<PendingDeviceUser[]> => {
  const response = await fetch(buildUrl('/zkteco/device-users/pending', { branch_id: branchParam(branchId) }), {
    headers: authHeaders(),
  });
  const data = await handleResponse<PendingDeviceUserApiRecord[]>(response);
  return (data || []).map((row) => ({
    commandId: row.IDNo,
    deviceId: row.DEVICE_ID,
    deviceName: deviceLabel(row.DEVICE_NAME, row.SERIAL_NO),
    branchName: row.BRANCH_NAME,
    pin: row.PIN,
    name: row.NAME,
    kind: row.KIND,
    status: row.STATUS,
    returnCode: row.RETURN_CODE,
    queuedDt: row.ENCODED_DT,
  }));
};

/**
 * Removes a user from the device (queued; delivered on its next poll). Once the device confirms,
 * the user is soft-deleted in the app: past punches keep the name, biometrics and card are erased.
 */
export const deleteDeviceUser = async (
  branchId: string | number | null | undefined,
  params: { deviceId: number; pin: string },
): Promise<{ commandId: number }> => {
  const response = await fetch(
    buildUrl(`/zkteco/device-users/${encodeURIComponent(params.pin)}`, {
      branch_id: branchParam(branchId),
      device_id: String(params.deviceId),
    }),
    { method: 'DELETE', headers: authHeaders() },
  );
  return handleResponse<{ commandId: number }>(response);
};

/** Withdraws a user add/edit/removal the device hasn't picked up yet. */
export const cancelUserCommand = async (
  branchId: string | number | null | undefined,
  commandId: number,
): Promise<void> => {
  const response = await fetch(buildUrl(`/zkteco/user-commands/${commandId}`, { branch_id: branchParam(branchId) }), {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await handleResponse<unknown>(response);
};

// ---- Correcting punches (the raw punch is never changed; see docs/zkteco-mb160.md) ----

/**
 * Punch types the app sets: Time-in (0) and Time-out (1). Attendance is basic time tracking, and
 * the device's other keys count as arriving or leaving anyway (docs/attendance.md). Editing a
 * punch can also keep the type it already has.
 */
export const APP_PUNCH_STATUSES = [0, 1] as const;

/** Sets a punch's time ("YYYY-MM-DD HH:mm:ss", device-local) and status. The original values clear the edit. */
export const updateAttendanceLog = async (
  branchId: string | number | null | undefined,
  id: number,
  changes: { punchDt: string; status: number; reason?: string },
): Promise<void> => {
  const response = await fetch(buildUrl(`/zkteco/attendance-logs/${id}`, { branch_id: branchParam(branchId) }), {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ punch_dt: changes.punchDt, status: changes.status, reason: changes.reason || '' }),
  });
  await handleResponse<unknown>(response);
};

/** Soft delete: hidden from attendance until restored. */
export const deleteAttendanceLog = async (
  branchId: string | number | null | undefined,
  id: number,
  reason?: string,
): Promise<void> => {
  const response = await fetch(buildUrl(`/zkteco/attendance-logs/${id}`, { branch_id: branchParam(branchId) }), {
    method: 'DELETE',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason || '' }),
  });
  await handleResponse<unknown>(response);
};

export const restoreAttendanceLog = async (branchId: string | number | null | undefined, id: number): Promise<void> => {
  const response = await fetch(buildUrl(`/zkteco/attendance-logs/${id}/restore`, { branch_id: branchParam(branchId) }), {
    method: 'POST',
    headers: authHeaders(),
  });
  await handleResponse<unknown>(response);
};

// ---- Manual punches: a forgotten punch added in the app (the device's punches are never changed) ----

export const createManualPunch = async (
  branchId: string | number | null | undefined,
  punch: { deviceUserId: number; punchDt: string; status: number; reason: string },
): Promise<{ id: number }> => {
  const response = await fetch(buildUrl('/zkteco/manual-punches', { branch_id: branchParam(branchId) }), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_user_id: punch.deviceUserId,
      punch_dt: punch.punchDt,
      status: punch.status,
      reason: punch.reason,
    }),
  });
  return handleResponse<{ id: number }>(response);
};

export const updateManualPunch = async (
  branchId: string | number | null | undefined,
  id: number,
  changes: { punchDt: string; status: number; reason?: string },
): Promise<void> => {
  const response = await fetch(buildUrl(`/zkteco/manual-punches/${id}`, { branch_id: branchParam(branchId) }), {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ punch_dt: changes.punchDt, status: changes.status, reason: changes.reason || '' }),
  });
  await handleResponse<unknown>(response);
};

export const deleteManualPunch = async (
  branchId: string | number | null | undefined,
  id: number,
  reason?: string,
): Promise<void> => {
  const response = await fetch(buildUrl(`/zkteco/manual-punches/${id}`, { branch_id: branchParam(branchId) }), {
    method: 'DELETE',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason || '' }),
  });
  await handleResponse<unknown>(response);
};

export const restoreManualPunch = async (branchId: string | number | null | undefined, id: number): Promise<void> => {
  const response = await fetch(buildUrl(`/zkteco/manual-punches/${id}/restore`, { branch_id: branchParam(branchId) }), {
    method: 'POST',
    headers: authHeaders(),
  });
  await handleResponse<unknown>(response);
};

// ---- Fingerprint enrollment / removal ----

/**
 * Enroll:
 * waiting: the device hasn't picked up the request yet (next poll, ≤ 10 s)
 * prompting: the device shows "place finger" (~60 s)
 * enrolled: done, template saved · timed_out: nobody scanned in time
 * duplicate: that fingerprint is already enrolled for someone (the device refuses it)
 * expired: the device never picked it up (offline) · cancelled · failed: other device code
 * Remove: waiting → removed (or cancelled / failed)
 */
export type EnrollmentState =
  | 'waiting'
  | 'prompting'
  | 'enrolled'
  | 'removed'
  | 'timed_out'
  | 'duplicate'
  | 'expired'
  | 'cancelled'
  | 'failed';

export interface Enrollment {
  commandId: number;
  kind: 'enroll' | 'remove';
  pin: string | null;
  finger: number | null;
  state: EnrollmentState;
  returnCode: number | null;
  templateReceived: boolean;
}

type EnrollmentApiRecord = {
  IDNo: number;
  KIND: 'enroll' | 'remove';
  PIN: string | null;
  FINGER: number | null;
  STATE: EnrollmentState;
  RETURN_CODE: number | null;
  FP_RECEIVED: boolean;
};

/**
 * Makes the device prompt for this finger (0-9). The finger must not be enrolled yet: the
 * device rejects re-scanning an enrolled finger, so remove it first (removeFingerprint).
 */
export const startFingerprintEnrollment = async (
  branchId: string | number | null | undefined,
  params: { deviceId: number; pin: string; finger: number },
): Promise<{ commandId: number }> => {
  const response = await fetch(
    buildUrl(`/zkteco/device-users/${encodeURIComponent(params.pin)}/fingerprint`, {
      branch_id: branchParam(branchId),
    }),
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: params.deviceId, finger: params.finger }),
    },
  );
  return handleResponse<{ commandId: number }>(response);
};

export const getEnrollment = async (
  branchId: string | number | null | undefined,
  commandId: number,
): Promise<Enrollment> => {
  const response = await fetch(buildUrl(`/zkteco/enrollments/${commandId}`, { branch_id: branchParam(branchId) }), {
    headers: authHeaders(),
  });
  const row = await handleResponse<EnrollmentApiRecord>(response);
  return {
    commandId: row.IDNo,
    kind: row.KIND,
    pin: row.PIN,
    finger: row.FINGER,
    state: row.STATE,
    returnCode: row.RETURN_CODE,
    templateReceived: Boolean(row.FP_RECEIVED),
  };
};

/** Deletes one fingerprint from the device; follow it with getEnrollment until 'removed'. */
export const removeFingerprint = async (
  branchId: string | number | null | undefined,
  params: { deviceId: number; pin: string; finger: number },
): Promise<{ commandId: number }> => {
  const response = await fetch(
    buildUrl(`/zkteco/device-users/${encodeURIComponent(params.pin)}/fingerprints/${params.finger}`, {
      branch_id: branchParam(branchId),
      device_id: String(params.deviceId),
    }),
    { method: 'DELETE', headers: authHeaders() },
  );
  return handleResponse<{ commandId: number }>(response);
};

/** Only works while the device hasn't picked the request up. */
export const cancelEnrollment = async (
  branchId: string | number | null | undefined,
  commandId: number,
): Promise<void> => {
  const response = await fetch(buildUrl(`/zkteco/enrollments/${commandId}`, { branch_id: branchParam(branchId) }), {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await handleResponse<unknown>(response);
};

// ---- Live updates ----

export type ZkChangeType = 'attendance' | 'users' | 'commands' | 'device';

/**
 * Opens the server's change stream (SSE over fetch, so the auth header is sent) and
 * reconnects with backoff until the returned function is called.
 */
export const subscribeZkChanges = (
  branchId: string | number | null | undefined,
  onChange: (type: ZkChangeType) => void,
  onConnectedChange: (connected: boolean) => void,
): (() => void) => {
  const controller = new AbortController();
  let retryMs = 2000;

  const connect = async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(buildUrl('/zkteco/events', { branch_id: branchParam(branchId) }), {
          headers: { ...authHeaders(), Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        // 401 is handled globally (authInterceptor); 403 won't fix itself by retrying.
        if (response.status === 401 || response.status === 403) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const { readSseResponse } = await import('../lib/sseClient');
        await readSseResponse(
          response,
          (event, data) => {
            if (event === 'ready') {
              retryMs = 2000;
              onConnectedChange(true);
            } else if (event === 'change') {
              const type = (data as { type?: ZkChangeType })?.type;
              if (type) onChange(type);
            }
          },
          controller.signal,
        );
      } catch {
        // network error or stream dropped; retry below
      }
      if (controller.signal.aborted) return;
      onConnectedChange(false);
      await new Promise((resolve) => window.setTimeout(resolve, retryMs));
      retryMs = Math.min(retryMs * 2, 30000);
    }
  };

  void connect();
  return () => controller.abort();
};
