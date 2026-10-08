/**
 * Per-branch "business day" cutoff.
 *
 * A branch whose shift crosses midnight (e.g. trades 3PM -> 6AM) would otherwise
 * have an order taken at 12:30AM reported under the *next* calendar date. For
 * branches listed here a business day starts at the given Manila hour instead
 * of 00:00, i.e. with `{ <branchId>: 7 }` the business day of 2026-10-06 runs
 * 2026-10-06 07:00 -> 2026-10-07 06:59:59 (PH). Stored timestamps are never
 * altered — only how rows are bucketed into days.
 *
 * Every other branch keeps the plain calendar day (hour 0). Empty = no branch
 * has a cutoff, so every report uses plain calendar days.
 *
 * Keep in sync with pyserver/business_day.py and src/utils/businessDay.ts.
 */
const BUSINESS_DAY_START_HOURS = Object.freeze({});

/** @param {number|string|null|undefined} branchId */
function businessDayStartHour(branchId) {
	const hour = BUSINESS_DAY_START_HOURS[Number(branchId)];
	return Number.isInteger(hour) ? hour : 0;
}

/** @returns {boolean} true when at least one branch has a non-midnight cutoff. */
function hasBusinessDayBranches() {
	return Object.keys(BUSINESS_DAY_START_HOURS).length > 0;
}

/** @param {number|string|null|undefined} branchId true when this branch has a non-midnight cutoff */
function isBusinessDayBranch(branchId) {
	return businessDayStartHour(branchId) !== 0;
}

/** SQL: row belongs to a branch with a business-day cutoff. */
function businessDayBranchesSql(branchColumn) {
	const ids = Object.entries(BUSINESS_DAY_START_HOURS)
		.filter(([, hour]) => hour !== 0)
		.map(([id]) => Number(id));
	return ids.length ? `${branchColumn} IN (${ids.join(', ')})` : '1=0';
}

/** SQL: row belongs to any OTHER branch (incl. NULL) — these keep their legacy date behaviour. */
function otherBranchesSql(branchColumn) {
	const ids = Object.entries(BUSINESS_DAY_START_HOURS)
		.filter(([, hour]) => hour !== 0)
		.map(([id]) => Number(id));
	return ids.length ? `(${branchColumn} IS NULL OR ${branchColumn} NOT IN (${ids.join(', ')}))` : '1=1';
}

/**
 * SQL expression: hours to subtract from a PH-local timestamp to get the
 * business-day date of that row, chosen per row from its branch column.
 * @param {string} branchColumn e.g. 'b.BRANCH_ID' (trusted constant, never user input)
 */
function businessDayShiftHoursSql(branchColumn) {
	const whens = Object.entries(BUSINESS_DAY_START_HOURS)
		.map(([id, hour]) => `WHEN ${Number(id)} THEN ${Number(hour)}`)
		.join(' ');
	return whens ? `(CASE ${branchColumn} ${whens} ELSE 0 END)` : '0';
}

/**
 * SQL expression: a datetime column/expression as Asia/Manila (+08:00) wall-clock time,
 * with the same +8h fallback used everywhere when MySQL timezone tables are missing.
 * @param {string} expr e.g. 'o.ENCODED_DT' or 'NOW()'
 */
function phLocalDtSql(expr) {
	return `COALESCE(CONVERT_TZ(${expr}, @@session.time_zone, '+08:00'), DATE_ADD(${expr}, INTERVAL 8 HOUR))`;
}

/**
 * SQL expression for the business-day DATE of a PH-local datetime expression.
 * Falls back to a plain DATE() when no branch column is given.
 * @param {string} localDtExpr PH(+08:00) local datetime expression
 * @param {string|null} [branchColumn]
 */
function businessDateSql(localDtExpr, branchColumn = null) {
	if (!branchColumn || !hasBusinessDayBranches()) {
		return `DATE(${localDtExpr})`;
	}
	return `DATE(DATE_SUB(${localDtExpr}, INTERVAL ${businessDayShiftHoursSql(branchColumn)} HOUR))`;
}

/**
 * Branch ids grouped by cutoff hour, e.g. { 7: [3] }. Hour 0 is never listed.
 * @returns {Record<number, number[]>}
 */
function branchIdsByStartHour() {
	/** @type {Record<number, number[]>} */
	const grouped = {};
	for (const [id, hour] of Object.entries(BUSINESS_DAY_START_HOURS)) {
		if (!Number.isInteger(hour) || hour === 0) continue;
		(grouped[hour] ||= []).push(Number(id));
	}
	return grouped;
}

/**
 * Business "today" (YYYY-MM-DD, Asia/Manila) for a branch: the calendar date shifted back by the
 * branch's cutoff hours. A 7AM-cutoff branch at 01:30 on Oct 7 is still business day Oct 6.
 * @param {number|string|null|undefined} branchId
 * @param {Date} [now]
 */
function getBusinessTodayYmd(branchId, now = new Date()) {
	const shifted = new Date(now.getTime() - businessDayStartHour(branchId) * 3600 * 1000);
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'Asia/Manila',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(shifted);
	const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
	return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Builds a per-branch date condition for queries whose ORIGINAL date logic must stay untouched for
 * every non-cutoff branch (only cutoff branches may change).
 *
 * @param {object} o
 * @param {string} o.branchColumn e.g. 'b.BRANCH_ID'
 * @param {number|string|null} [o.branchId] the branch the query is filtered to, if any
 * @param {{sql: string, params: any[]}} o.legacy the original condition (no leading AND)
 * @param {(startHour: number) => {sql: string, params: any[]}} o.business condition for a cutoff
 *   branch whose business day starts at `startHour` (no leading AND)
 * @returns {{sql: string, params: any[]}} condition without a leading AND
 */
function branchAwareDayCondition({ branchColumn, branchId = null, legacy, business }) {
	const byHour = branchIdsByStartHour();
	const hours = Object.keys(byHour).map(Number);
	const hasBranch = branchId != null && branchId !== '' && String(branchId) !== 'all';
	if (!hours.length || (hasBranch && !isBusinessDayBranch(branchId))) return legacy;
	if (hasBranch) return business(businessDayStartHour(branchId));

	const arms = [];
	const params = [];
	for (const hour of hours) {
		const cond = business(hour);
		arms.push(`(${branchColumn} IN (${byHour[hour].join(', ')}) AND ${cond.sql})`);
		params.push(...cond.params);
	}
	const ids = hours.flatMap((hour) => byHour[hour]);
	arms.push(`((${branchColumn} IS NULL OR ${branchColumn} NOT IN (${ids.join(', ')})) AND ${legacy.sql})`);
	params.push(...legacy.params);
	return { sql: `(${arms.join(' OR ')})`, params };
}

module.exports = {
	BUSINESS_DAY_START_HOURS,
	businessDayStartHour,
	hasBusinessDayBranches,
	isBusinessDayBranch,
	businessDayBranchesSql,
	otherBranchesSql,
	businessDayShiftHoursSql,
	businessDateSql,
	phLocalDtSql,
	branchIdsByStartHour,
	getBusinessTodayYmd,
	branchAwareDayCondition,
};
