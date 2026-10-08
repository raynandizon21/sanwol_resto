/**
 * Sargable Asia/Manila (+08:00) inclusive day-range predicates.
 * CONVERT_TZ / DATE_ADD are applied to *constants* so MySQL can use indexes
 * on the raw datetime column (unlike DATE(CONVERT_TZ(column, ...)) ).
 */

const { branchIdsByStartHour } = require('./businessDay');

/**
 * One `column >= start AND column < end+1day` pair, with both bounds moved
 * forward by `shiftHours` (0 = plain calendar days). Placeholders: start,
 * start, end, end.
 */
function rangePredicate(column, shiftHours) {
	const shift = (expr) => (shiftHours ? `DATE_ADD(${expr}, INTERVAL ${Number(shiftHours)} HOUR)` : expr);
	const startLocal = shift(`CONCAT(?, ' 00:00:00')`);
	const endLocal = shift(`DATE_ADD(CONCAT(?, ' 00:00:00'), INTERVAL 1 DAY)`);
	return `${column} >= COALESCE(
			CONVERT_TZ(${startLocal}, '+08:00', @@session.time_zone),
			DATE_SUB(${startLocal}, INTERVAL 8 HOUR)
		) AND ${column} < COALESCE(
			CONVERT_TZ(${endLocal}, '+08:00', @@session.time_zone),
			DATE_SUB(${endLocal}, INTERVAL 8 HOUR)
		)`;
}

/**
 * @param {string} column e.g. 'b.ENCODED_DT' or 'o.ENCODED_DT'
 * @param {string|null|undefined} startDate YYYY-MM-DD
 * @param {string|null|undefined} endDate YYYY-MM-DD
 * @param {string|null} [branchColumn] e.g. 'b.BRANCH_ID'. When given, branches with a
 *   business-day cutoff (see businessDay.js) use their shifted range and every other
 *   branch keeps the calendar day. Omit it to keep the plain calendar-day behaviour.
 * @returns {{ sql: string, params: string[] }}
 */
function phLocalDayRangeFilter(column, startDate, endDate, branchColumn = null) {
	const start = startDate != null ? String(startDate).slice(0, 10) : '';
	const end = endDate != null ? String(endDate).slice(0, 10) : '';
	if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
		return { sql: '', params: [] };
	}

	const byHour = branchColumn ? branchIdsByStartHour() : {};
	const hours = Object.keys(byHour).map(Number);
	if (!hours.length) {
		return { sql: ` AND ${rangePredicate(column, 0)}`, params: [start, start, end, end] };
	}

	const arms = [];
	const params = [];
	const configuredIds = [];
	for (const hour of hours) {
		const ids = byHour[hour];
		configuredIds.push(...ids);
		arms.push(`(${branchColumn} IN (${ids.join(', ')}) AND ${rangePredicate(column, hour)})`);
		params.push(start, start, end, end);
	}
	arms.push(
		`((${branchColumn} IS NULL OR ${branchColumn} NOT IN (${configuredIds.join(', ')})) AND ${rangePredicate(column, 0)})`
	);
	params.push(start, start, end, end);

	return { sql: ` AND (${arms.join(' OR ')})`, params };
}

/**
 * Range condition for the business-day branches ONLY : `(branch IN (<ids>) AND <shifted range>)`.
 * Other branches are not matched at all, so the caller can combine this with its own legacy
 * condition for them and leave their behaviour byte-for-byte unchanged.
 * @returns {{ sql: string, params: string[] }} sql has no leading AND; '' when no branch has a cutoff or dates are malformed
 */
function businessDayOnlyRangeFilter(column, startDate, endDate, branchColumn) {
	const start = startDate != null ? String(startDate).slice(0, 10) : '';
	const end = endDate != null ? String(endDate).slice(0, 10) : '';
	if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
		return { sql: '', params: [] };
	}
	const byHour = branchIdsByStartHour();
	const arms = [];
	const params = [];
	for (const [hour, ids] of Object.entries(byHour)) {
		arms.push(`(${branchColumn} IN (${ids.join(', ')}) AND ${rangePredicate(column, Number(hour))})`);
		params.push(start, start, end, end);
	}
	return { sql: arms.length ? `(${arms.join(' OR ')})` : '', params };
}

module.exports = { phLocalDayRangeFilter, businessDayOnlyRangeFilter };
