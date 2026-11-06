// Run: cd server && npm test
// Checks hours worked against an independent answer: random "true" work sessions are turned
// into punches (with double taps, any arriving/leaving key, seconds, night shifts), and the
// engine's hours per day must equal the hours of the sessions themselves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAttendance } = require('../services/attendanceEngine');

const IN_KEYS = [0, 3, 4]; // Time-in, Break-in, OT-in
const OUT_KEYS = [1, 2, 5]; // Time-out, Break-out, OT-out
const START = Date.UTC(2026, 9, 1); // 2026-10-01 00:00 (wall clock, no timezone)
const DAYS = 21;

/** Small deterministic PRNG so failures are reproducible. */
function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pad = (n) => String(n).padStart(2, '0');
/** ms since epoch (wall clock) -> "YYYY-MM-DD HH:mm:ss" */
const fmt = (ms) => {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const ymd = (ms) => fmt(ms).slice(0, 10);

/**
 * Random sessions: 1–3 per working day (split shifts, lunch out/in), 30 min – 15 h long (under
 * the 16 h "long shift" check), sometimes crossing midnight, at least 15 min apart.
 */
function makeSessions(rand) {
	const sessions = [];
	let cursor = START + 6 * 3600e3;
	while (cursor < START + DAYS * 86400e3) {
		// Whole seconds, like the device records them.
		const length = Math.floor((30 + rand() * (15 * 60 - 30)) * 60) * 1e3;
		const start = Math.floor(cursor / 1e3) * 1e3 + Math.floor(rand() * 59) * 1e3;
		const end = start + length;
		sessions.push({ start, end });
		// Next session: a short gap (split shift) or the next day.
		cursor = end + (rand() < 0.4 ? (15 + rand() * 120) * 60e3 : (8 + rand() * 20) * 3600e3);
	}
	return sessions;
}

/** Punches for a session: a few taps of an arriving key at the start, of a leaving key at the end. */
function punchesFor(session, rand, { dropIn = false, dropOut = false } = {}) {
	const out = [];
	const pick = (keys) => keys[Math.floor(rand() * keys.length)];
	if (!dropIn) {
		out.push({ dt: fmt(session.start), status: pick(IN_KEYS) });
		// Double taps within 5 minutes after the first time-in (the first counts).
		if (rand() < 0.3) out.push({ dt: fmt(session.start + Math.floor(rand() * 290) * 1e3), status: pick(IN_KEYS) });
	}
	if (!dropOut) {
		// Double taps within 5 minutes before the last time-out (the last counts).
		if (rand() < 0.3) out.push({ dt: fmt(session.end - Math.floor(1 + rand() * 290) * 1e3), status: pick(OUT_KEYS) });
		out.push({ dt: fmt(session.end), status: pick(OUT_KEYS) });
	}
	return out;
}

const shuffle = (list, rand) => {
	const a = [...list];
	for (let i = a.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rand() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
};

function run(punches) {
	return computeAttendance({
		punches,
		startYmd: ymd(START),
		endYmd: ymd(START + (DAYS + 1) * 86400e3),
		now: '2027-01-01 00:00:00',
	});
}

test('random complete sessions: hours per day equal the sessions (200 runs)', () => {
	for (let seed = 1; seed <= 200; seed += 1) {
		const rand = rng(seed);
		const sessions = makeSessions(rand);
		const punches = shuffle(
			sessions.flatMap((s) => punchesFor(s, rand)),
			rand
		);
		const expected = new Map();
		for (const s of sessions) {
			const day = ymd(s.start);
			expected.set(day, (expected.get(day) || 0) + Math.floor((s.end - s.start) / 60e3));
		}
		const { days, totals } = run(punches);
		for (const d of days) {
			const want = expected.get(d.date) || 0;
			assert.equal(d.workedMinutes, want, `seed ${seed} ${d.date}`);
			// No shifts scheduled: every hour is regular.
			assert.equal(d.regularMinutes, want, `seed ${seed} ${d.date} regular`);
			assert.equal(d.overMinutes, 0, `seed ${seed} ${d.date} over`);
			assert.deepEqual(d.flags, [], `seed ${seed} ${d.date} flags`);
		}
		const total = [...expected.values()].reduce((a, b) => a + b, 0);
		assert.equal(totals.workedMinutes, total, `seed ${seed} total`);
		assert.equal(totals.incompleteDays, 0);
	}
});

test('random sessions with one forgotten punch: only that shift is left out, and its day is flagged', () => {
	for (let seed = 1; seed <= 200; seed += 1) {
		const rand = rng(1000 + seed);
		const sessions = makeSessions(rand);
		const broken = Math.floor(rand() * sessions.length);
		const dropIn = rand() < 0.5;
		const punches = sessions.flatMap((s, i) => punchesFor(s, rand, i === broken ? { dropIn, dropOut: !dropIn } : {}));
		const expected = new Map();
		sessions.forEach((s, i) => {
			if (i === broken) return;
			const day = ymd(s.start);
			expected.set(day, (expected.get(day) || 0) + Math.floor((s.end - s.start) / 60e3));
		});
		// A missing time-in is flagged on the day of the time-out; a missing time-out on the day of the time-in.
		const flaggedDay = dropIn ? ymd(sessions[broken].end) : ymd(sessions[broken].start);
		const flag = dropIn ? 'missing_in' : 'missing_out';
		const { days } = run(punches);
		for (const d of days) {
			assert.equal(d.workedMinutes, expected.get(d.date) || 0, `seed ${seed} ${d.date}`);
			if (d.date === flaggedDay) {
				assert.ok(d.flags.includes(flag), `seed ${seed} ${d.date} should have ${flag}`);
				assert.equal(d.status, 'incomplete');
			} else {
				assert.deepEqual(d.flags, [], `seed ${seed} ${d.date} flags`);
			}
		}
	}
});

// Hand-worked cases, the kind staff will actually produce.
const day = (punches) =>
	computeAttendance({
		punches: punches.map(([dt, status]) => ({ dt, status })),
		startYmd: '2026-10-05',
		endYmd: '2026-10-06',
		now: '2026-10-27 12:00:00',
	}).days;

test('hand-worked: seconds are exact and each shift rounds down', () => {
	const [d] = day([['2026-10-05 08:00:59', 0], ['2026-10-05 17:00:00', 1]]);
	assert.equal(d.workedMinutes, 539); // 8h 59m 01s
	const [e] = day([['2026-10-05 08:00:00', 0], ['2026-10-05 12:00:30', 1], ['2026-10-05 13:00:10', 0], ['2026-10-05 17:00:50', 1]]);
	assert.equal(e.workedMinutes, 240 + 240); // 4h 0m 30s + 4h 0m 40s
});

test('hand-worked: a typical restaurant day with a split shift', () => {
	// 10:00–14:30 (4h 30m), then 17:00–23:15 (6h 15m) = 10h 45m, all regular (no shift that day).
	const [d] = day([
		['2026-10-05 09:58:12', 0],
		['2026-10-05 14:30:40', 1],
		['2026-10-05 16:59:05', 0],
		['2026-10-05 23:15:00', 1],
	]);
	assert.equal(d.workedMinutes, 272 + 375); // 4h 32m 28s + 6h 15m 55s
	assert.equal(d.regularMinutes, 647);
	assert.equal(d.overMinutes, 0);
});

test('hand-worked: closing shift past midnight counts on the starting day', () => {
	const [d, next] = day([['2026-10-05 16:00:00', 0], ['2026-10-06 01:30:00', 1]]);
	assert.equal(d.workedMinutes, 570);
	assert.equal(next.workedMinutes, 0);
});
