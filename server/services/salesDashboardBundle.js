const CashReconciliationModel = require('../models/cashReconciliationModel');
const ReportsModel = require('../models/reportsModel');
const { fetchPyCachedOptional } = require('./analyticsPyFetch');

/** Per-call cap for dashboard bundle — avoid 15s waits on empty/slow branches. */
const BUNDLE_PYSERVER_TIMEOUT_MS = Number(process.env.BUNDLE_PYSERVER_TIMEOUT_MS || 8000);

function fetchPyServerOptional(path, params = {}, timeoutMs = BUNDLE_PYSERVER_TIMEOUT_MS) {
	return fetchPyCachedOptional(path, params, { timeoutMs });
}

function toYmd(d) {
	return (
		d.getFullYear() +
		'-' +
		String(d.getMonth() + 1).padStart(2, '0') +
		'-' +
		String(d.getDate()).padStart(2, '0')
	);
}

function previousPeriod(startDate, endDate) {
	const s = new Date(`${startDate}T00:00:00`);
	const e = new Date(`${endDate}T00:00:00`);
	if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
		return { start: startDate, end: endDate };
	}
	const days = Math.max(1, Math.round((e - s) / 86400000) + 1);
	const prevEnd = new Date(s);
	prevEnd.setDate(prevEnd.getDate() - 1);
	const prevStart = new Date(prevEnd);
	prevStart.setDate(prevStart.getDate() - (days - 1));
	return { start: toYmd(prevStart), end: toYmd(prevEnd) };
}

function normalizeSaleDateKey(raw) {
	if (raw == null) return '';
	const s = String(raw).trim();
	if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
	const d = raw instanceof Date ? raw : new Date(s.includes('T') ? s : `${s}T12:00:00`);
	if (!Number.isNaN(d.getTime())) return toYmd(d);
	return s.slice(0, 10);
}

function mapRevenueRowsToDailySales(rows) {
	return (rows || []).map((row) => {
		const total = Number(row?.revenue ?? row?.total_sales ?? 0) || 0;
		const dateKey = normalizeSaleDateKey(row?.date ?? row?.sale_date ?? '');
		return {
			sale_date: dateKey,
			total_sales: total,
			refund: 0,
			discount: 0,
			net_sales: total,
			product_cost: 0,
			gross_profit: total,
		};
	});
}

async function fetchDailySalesSeries(startDate, endDate, branchId) {
	const params = { start_date: startDate, end_date: endDate };
	if (branchId) params.branch_id = String(branchId);

	// Prefer PyServer daily-sales (gross + discount fields). SQL fallback is paid-only.
	const pyJson = await fetchPyServerOptional('/api/analytics/daily-sales', params);
	const pyRows = pyJson?.data?.data || [];
	if (Array.isArray(pyRows) && pyRows.length > 0) {
		return pyRows.map((row) => ({
			...row,
			sale_date: normalizeSaleDateKey(row?.sale_date ?? row?.date ?? ''),
		}));
	}

	return ReportsModel.getRevenueReport('daily', startDate, endDate, branchId)
		.then(mapRevenueRowsToDailySales)
		.catch(() => []);
}

function getProfitValue(row) {
	const rawProfit = Number(row?.totalRevenue ?? 0);
	if (Number.isFinite(rawProfit) && rawProfit !== 0) return rawProfit;
	const revenue = Number(row?.netSales ?? row?.totalSales ?? 0);
	const cost = Number(row?.unitCost ?? 0);
	const derived = revenue - cost;
	return Number.isFinite(derived) ? derived : 0;
}

function buildProfitDrivers(profitRows, branchSalesData, profitBranchId, branchNameFallback) {
	const driversBranchName =
		profitBranchId != null
			? (branchSalesData.find((b) => String(b.branch_id) === String(profitBranchId))?.branch_name ||
					`Branch #${profitBranchId}`)
			: branchNameFallback;

	return (profitRows || [])
		.map((row) => ({
			row,
			profit: getProfitValue(row),
			branchId:
				row?.branch_id ??
				(profitBranchId != null ? Number(profitBranchId) : null),
			branchName:
				profitBranchId != null ? driversBranchName : String(row?.branch || driversBranchName),
		}))
		.filter((x) => x.profit > 0)
		.sort((a, b) => b.profit - a.profit)
		.slice(0, 20);
}

/**
 * Single server-side bundle for Sales Analytics (replaces 6 sequential frontend calls).
 */
async function buildSalesDashboardBundle({
	start_date,
	end_date,
	branchId = null,
	profitBranchId = null,
	branchNameFallback = 'All Branches',
}) {
	const prev = previousPeriod(start_date, end_date);
	const branchParam = branchId ? String(branchId) : null;
	const profitBranchParam =
		profitBranchId != null ? String(profitBranchId) : branchParam;

	const profitParams = {
		start_date,
		end_date,
		limit: 20,
	};
	if (profitBranchParam) profitParams.branch_id = profitBranchParam;

	const branchSalesParams = { start_date, end_date };
	if (branchParam) branchSalesParams.branch_id = branchParam;

	const [
		dailySalesCurrent,
		dailySalesPrevious,
		branchSalesRes,
		reconCurrent,
		reconPrevious,
		profitRowsRes,
	] = await Promise.all([
		fetchDailySalesSeries(start_date, end_date, branchParam),
		fetchDailySalesSeries(prev.start, prev.end, branchParam),
		fetchPyServerOptional('/api/analytics/branch-sales', branchSalesParams),
		branchParam
			? CashReconciliationModel.aggregatesForRange(branchParam, start_date, end_date).catch(() => ({
					byDate: {},
					total: 0,
				}))
			: Promise.resolve({ byDate: {}, total: 0 }),
		branchParam
			? CashReconciliationModel.aggregatesForRange(branchParam, prev.start, prev.end).catch(() => ({
					byDate: {},
					total: 0,
				}))
			: Promise.resolve({ byDate: {}, total: 0 }),
		fetchPyServerOptional('/api/analytics/top-profit-drivers', profitParams),
	]);

	const branchSalesPy = branchSalesRes?.data?.data || [];
	let branchSalesData = Array.isArray(branchSalesPy) ? branchSalesPy : [];
	if (branchSalesData.length === 0) {
		try {
			branchSalesData = await ReportsModel.getSalesPerBranch(start_date, end_date, branchParam);
		} catch (err) {
			console.warn('[salesDashboardBundle] branch-sales SQL fallback:', err?.message || err);
			branchSalesData = [];
		}
	}

	const profitRows = profitRowsRes?.data?.data || [];

	return {
		dailySalesCurrent,
		dailySalesPrevious,
		branchSalesData,
		profitDriversData: buildProfitDrivers(
			profitRows,
			branchSalesData,
			profitBranchParam ? Number(profitBranchParam) : null,
			branchNameFallback,
		),
		reconAdjustCurrent: {
			byDate: reconCurrent?.byDate && typeof reconCurrent.byDate === 'object' ? reconCurrent.byDate : {},
			total: Number(reconCurrent?.total) || 0,
		},
		reconAdjustPreviousTotal: Number(reconPrevious?.total) || 0,
		previousStart: prev.start,
		previousEnd: prev.end,
	};
}

module.exports = {
	buildSalesDashboardBundle,
};
