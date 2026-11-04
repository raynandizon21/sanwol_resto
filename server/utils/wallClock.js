// Date/time text checks with no Date/timezone conversion (device-local wall-clock values).
// Pure (no DB), so helpers that only validate can be unit-tested.

const PUNCH_DT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Is "YYYY-MM-DD HH:mm:ss" a real calendar date/time? */
function isValidWallClock(dt) {
	if (!PUNCH_DT_RE.test(dt)) return false;
	const [y, mo, d, h, mi, s] = dt.split(/[- :]/).map(Number);
	const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
	return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth && h <= 23 && mi <= 59 && s <= 59;
}

/** Is "YYYY-MM-DD" a real calendar date? */
const isValidYmd = (ymd) => YMD.test(String(ymd)) && isValidWallClock(`${ymd} 00:00:00`);

module.exports = { YMD, isValidWallClock, isValidYmd };
