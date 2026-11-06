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
	// Excluded from schedules and attendance (a system or IT account, not staff).
	if (has('exclude_from_attendance')) {
		const v = body.exclude_from_attendance;
		if (![true, false, 0, 1, '0', '1'].includes(v)) return { error: 'exclude_from_attendance must be true or false' };
		fields.EXCLUDE_FROM_ATTENDANCE = v === true || v === 1 || v === '1' ? 1 : 0;
	}

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
