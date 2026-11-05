// ============================================
// EMPLOYEE PROFILE HELPERS
// ============================================
// File: utils/employeeProfile.js
// Description: Validation of employee profile fields (Employees → Profile, and Add employee) and
// the name sent to the MB160, shared by the attendance and ZKTeco controllers.
// See docs/attendance.md.
// ============================================

const { isValidYmd } = require('./wallClock');

// The MB160 shows about 24 characters of a user's name (docs/zkteco-mb160.md).
const SCHEDULE_MODES = ['branch', 'own', 'none'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const DEVICE_NAME_MAX = 24;

const text = (value, max) => {
	const s = String(value ?? '').replace(/\s+/g, ' ').trim();
	return s ? s.slice(0, max) : null;
};

/**
 * Body (snake_case) -> employee columns. Only fields present in the body are returned, so the
 * page can save one section at a time. `current` is the saved profile ({} for a new one), used
 * to check the dates against the one not being changed. Returns { fields } or { error }.
 */
function readProfile(body, current = {}) {
	const fields = {};
	const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
	const strings = [
		['first_name', 'FIRSTNAME', 100],
		['last_name', 'LASTNAME', 100],
		['contact_no', 'CONTACTNo', 20],
		['position', 'DEPARTMENT', 50],
		['address', 'ADDRESS', 255],
		['emergency_contact_name', 'EMERGENCY_CONTACT_NAME', 100],
		['emergency_contact_phone', 'EMERGENCY_CONTACT_PHONE', 20],
		['notes', 'NOTES', 255],
	];
	for (const [key, column, max] of strings) if (has(key)) fields[column] = text(body[key], max);
	if (has('first_name') && !fields.FIRSTNAME) return { error: 'First name is required' };

	for (const [key, column] of [['birthdate', 'BIRTHDATE'], ['date_started', 'DATE_STARTED'], ['date_separated', 'DATE_SEPARATED']]) {
		if (!has(key)) continue;
		const value = body[key] || null;
		if (value && !isValidYmd(value)) return { error: 'Dates must be YYYY-MM-DD' };
		fields[column] = value;
	}
	// Work schedule: the branch's (default), their own, or none (not tracked for late or absences).
	if (has('schedule_mode')) {
		if (!SCHEDULE_MODES.includes(body.schedule_mode)) return { error: `schedule_mode must be one of ${SCHEDULE_MODES.join(', ')}` };
		fields.SCHEDULE_MODE = body.schedule_mode;
	}
	for (const [key, column] of [['schedule_start', 'SCHEDULE_START'], ['schedule_end', 'SCHEDULE_END']]) {
		if (!has(key)) continue;
		const value = body[key] || null;
		if (value && !HHMM.test(value)) return { error: 'Times must be HH:MM' };
		fields[column] = value;
	}
	if (has('schedule_rest_days')) {
		const days = Array.isArray(body.schedule_rest_days) ? body.schedule_rest_days : [];
		if (days.some((d) => !/^[0-6]$/.test(String(d)))) return { error: 'Rest days must be weekdays 0-6' };
		const unique = [...new Set(days.map(Number))].sort();
		if (unique.length === 7) return { error: 'Leave at least one work day' };
		fields.SCHEDULE_REST_DAYS = unique.length ? unique.join(',') : null;
	}
	const mode = has('schedule_mode') ? fields.SCHEDULE_MODE : current.SCHEDULE_MODE;
	const start = has('schedule_start') ? fields.SCHEDULE_START : current.SCHEDULE_START;
	const end = has('schedule_end') ? fields.SCHEDULE_END : current.SCHEDULE_END;
	if (mode === 'own' && !start) return { error: 'Set a start time for their own schedule' };
	if (mode === 'own' && end && end === start) return { error: 'The end time must differ from the start time' };

	const started = has('date_started') ? fields.DATE_STARTED : current.DATE_STARTED;
	const separated = has('date_separated') ? fields.DATE_SEPARATED : current.DATE_SEPARATED;
	if (started && separated && separated < started) return { error: 'The last day of work is before the hire date' };
	return { fields };
}

/** Text the device can store as a name: no tabs, line breaks or control characters, single spaces. */
const cleanDeviceName = (value) =>
	String(value ?? '')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/** The first `max` characters (whole characters, so an emoji or accent is never cut in half). */
const firstChars = (s, max) => Array.from(s).slice(0, max).join('').trim();
const charCount = (s) => Array.from(s).length;

/**
 * The name shown on the device, from the profile name, always 1–24 characters when a name is
 * given. The first that fits: "First Last"; "First L." (last-name initial); fewer first-name
 * words with the initial ("Maria Clara R."); fewer first-name words alone; the first word cut
 * to 24 characters. Keep in sync with deviceNameFor in src/components/attendance/profileFields.tsx.
 */
function deviceNameFor(firstName, lastName) {
	const first = cleanDeviceName(firstName);
	const last = cleanDeviceName(lastName);
	if (!first) return firstChars(last, DEVICE_NAME_MAX);
	const fits = (s) => charCount(s) <= DEVICE_NAME_MAX;
	const full = last ? `${first} ${last}` : first;
	if (fits(full)) return full;
	const words = first.split(' ');
	const initial = last ? ` ${Array.from(last)[0]}.` : '';
	for (const suffix of initial ? [initial, ''] : ['']) {
		for (let n = words.length; n >= 1; n -= 1) {
			const candidate = `${words.slice(0, n).join(' ')}${suffix}`;
			if (fits(candidate)) return candidate;
		}
	}
	return firstChars(words[0], DEVICE_NAME_MAX);
}

module.exports = {
	DEVICE_NAME_MAX,
	readProfile,
	cleanDeviceName,
	deviceNameFor,
	charCount,
};
