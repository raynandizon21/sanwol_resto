const CashReconciliationModel = require('../models/cashReconciliationModel');
const ExpenseModel = require('../models/expenseModel');
const { fetchPyCachedOptional } = require('./analyticsPyFetch');
const { resolveNetSalesFromRow } = require('../utils/analyticsSales');

const BUNDLE_PYSERVER_TIMEOUT_MS = Number(process.env.BUNDLE_PYSERVER_TIMEOUT_MS || 15000);
/** 3Core developer/testing branch — matches is3coreBranch() in src/utils/branchLogo.ts. */
const TEST_BRANCH_NAME_PATTERN = /3core/i;

function fetchPyServerOptional(path, params = {}, timeoutMs = BUNDLE_PYSERVER_TIMEOUT_MS) {
	return fetchPyCachedOptional(path, params, { timeoutMs });
}

function buildExpenseMaps(rows) {
	const expenseMap = {};
	const expenseByBranch = {};
	const makeKey = (cat, name) => `${String(cat).trim().toLowerCase()}|${String(name).trim().toLowerCase()}`;

	for (const row of rows || []) {
		const bid = Number(row.branch_id);
		if (!Number.isFinite(bid)) continue;
		if (!expenseMap[bid]) expenseMap[bid] = {};
		const key = makeKey(row.exp_cat, row.exp_name);
		const amt = Number(row.total_amount || 0);
		expenseMap[bid][key] = (expenseMap[bid][key] || 0) + amt;
		expenseByBranch[bid] = (expenseByBranch[bid] || 0) + amt;
	}

	return { expenseMap, expenseByBranch };
}

function buildSummary({ branchId, branchCards, totalExpenses }) {
	if (branchId != null && branchCards.length > 0) {
		const branch = branchCards.find((b) => String(b.id) === String(branchId));
		if (branch) {
			const totalSales = Number(branch.totalSales) || 0;
			const expenses = Number(branch.totalExpenses) || 0;
			return {
				totalSales,
				totalExpenses: expenses,
				totalRevenue: totalSales - expenses,
			};
		}
	}

	const totalSales = branchCards.reduce((s, b) => s + (Number(b.totalSales) || 0), 0);
	const expensesFromCards = branchCards.reduce((s, b) => s + (Number(b.totalExpenses) || 0), 0);
	// Match AdminDashboard: prefer sum of branch-card expenses over expense-summary alone.
	const expenses = expensesFromCards > 0 ? expensesFromCards : Number(totalExpenses) || 0;
	return {
		totalSales,
		totalExpenses: expenses,
		totalRevenue: totalSales - expenses,
	};
}

/** Prefer branch-sales.net_sales (same paid−refund formula as daily-sales); no N× Py calls. */
function buildNetSalesByBranchFromSales(branchSales) {
	const netByBranch = {};
	for (const b of branchSales || []) {
		const bid = b.branch_id;
		if (bid == null) continue;
		if (b.net_sales != null && Number.isFinite(Number(b.net_sales))) {
			netByBranch[bid] = Math.max(0, Number(b.net_sales));
		}
	}
	return netByBranch;
}

function buildMonthlyTrendFromDaily(dailySales, dailyExpenses, byDate, start, end) {
	const salesByDate = new Map();
	const expensesByDom = Array(31).fill(0);

	for (const row of dailySales || []) {
		const date = String(row.sale_date ?? '').slice(0, 10);
		if (!date || date < start || date > end) continue;
		const recon = Number(byDate?.[date] ?? 0);
		salesByDate.set(date, (salesByDate.get(date) ?? 0) + resolveNetSalesFromRow(row) + recon);
	}

	for (const [date, amt] of Object.entries(byDate || {})) {
		if (date < start || date > end) continue;
		if (!salesByDate.has(date)) salesByDate.set(date, Number(amt) || 0);
	}

	for (const row of dailyExpenses || []) {
		const date = String(row.expense_date ?? '').slice(0, 10);
		if (!date || date < start || date > end) continue;
		const dom = new Date(`${date}T12:00:00`).getDate();
		if (dom >= 1 && dom <= 31) {
			expensesByDom[dom - 1] += Number(row.total_expense ?? 0);
		}
	}

	const salesByDom = Array(31).fill(0);
	for (const [date, val] of salesByDate) {
		const dom = new Date(`${date}T12:00:00`).getDate();
		if (dom >= 1 && dom <= 31) salesByDom[dom - 1] += val;
	}

	return Array.from({ length: 31 }, (_, idx) => ({
		name: String(idx + 1),
		totalSales: salesByDom[idx],
		totalExpenses: expensesByDom[idx],
	}));
}

async function buildBranchChartsForAll(branchCards, start_date, end_date) {
	const branchChartsById = {};
	const branches = branchCards || [];

	async function loadBranchChart(branch) {
		const branchId = branch.id;
		const hasActivity =
			(Number(branch.totalSales) || 0) > 0 || (Number(branch.totalExpenses) || 0) > 0;
		if (!hasActivity) {
			branchChartsById[String(branchId)] = { trendMonthly: [], topProducts: [] };
			return;
		}

		const pyParams = { start_date, end_date, branch_id: String(branchId) };
		const [dailySalesRes, dailyExpensesRes, topSellingRes, recon] = await Promise.all([
			fetchPyServerOptional('/api/analytics/daily-sales', pyParams),
			fetchPyServerOptional('/api/analytics/daily-expenses', pyParams),
			fetchPyServerOptional('/api/analytics/top-selling', { ...pyParams, limit: '5' }),
			CashReconciliationModel.aggregatesForRange(branchId, start_date, end_date).catch(() => ({
				total: 0,
				byDate: {},
			})),
		]);

		const dailySales = dailySalesRes?.data?.data || [];
		const dailyExpenses = dailyExpensesRes?.data?.data || [];
		const topSelling = topSellingRes?.data?.data || [];
		const byDate = recon?.byDate && typeof recon.byDate === 'object' ? recon.byDate : {};

		branchChartsById[String(branchId)] = {
			trendMonthly: buildMonthlyTrendFromDaily(
				dailySales,
				dailyExpenses,
				byDate,
				start_date,
				end_date,
			),
			topProducts: (topSelling || []).slice(0, 5).map((item) => ({
				name: item.MENU_NAME || '',
				sales: item.total_quantity,
			})),
		};
	}

	const queue = [...branches];
	const workerCount = Math.min(4, Math.max(1, queue.length));
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (queue.length > 0) {
				const branch = queue.shift();
				if (branch) await loadBranchChart(branch);
			}
		}),
	);

	return branchChartsById;
}

/**
 * Single server-side bundle for admin dashboard (summary + branch cards + charts data).
 */
async function buildAdminDashboardBundle({
	start_date,
	end_date,
	branchId = null,
	period = 'monthly',
	include_branch_charts = false,
	mode = 'full',
}) {
	const modeKey = String(mode || '').toLowerCase();
	const slim = modeKey === 'compare' || modeKey === 'slim';
	/** Trend-chart bar drill: ranked branch list only — skip breakdown/rent/salary/recon. */
	const drill = modeKey === 'drill';
	const pyParams = { start_date, end_date };
	if (branchId != null && String(branchId).trim() !== '') {
		pyParams.branch_id = String(branchId);
	}

	const branchSalesParams = { start_date, end_date };
	const trendParams = { ...pyParams, period: String(period || 'monthly') };

	// Single parallel wave — faster wall-clock than sequential phases.
	// Compare/slim mode skips trend + top-selling (unused by Branch Comparison panel).
	// Drill mode: branch-sales + MySQL expense totals only (bar → branch list).
	const [
		branchSalesRes,
		topSellingRes,
		expenseBreakdownRes,
		trendRes,
		reconByBranch,
		rentSalaryByBranch,
		nodeExpenseByBranch,
	] = await Promise.all([
		fetchPyServerOptional('/api/analytics/branch-sales', branchSalesParams),
		slim || drill
			? Promise.resolve(null)
			: fetchPyServerOptional('/api/analytics/top-selling', { ...pyParams, limit: '5' }),
		drill
			? Promise.resolve(null)
			: fetchPyServerOptional('/api/analytics/expense-breakdown', pyParams),
		slim || drill
			? Promise.resolve(null)
			: fetchPyServerOptional('/api/analytics/performance-trend', trendParams),
		drill
			? Promise.resolve({})
			: CashReconciliationModel.totalsByBranchForRange(start_date, end_date).catch(() => ({})),
		drill
			? Promise.resolve({ rent: {}, salary: {} })
			: ExpenseModel.getRentSalaryByBranch(start_date, end_date).catch((err) => {
					console.warn('[adminDashboardBundle] getRentSalaryByBranch failed:', err?.message || err);
					return { rent: {}, salary: {} };
				}),
		ExpenseModel.getTotalsByBranch(start_date, end_date).catch((err) => {
			console.warn('[adminDashboardBundle] getTotalsByBranch failed:', err?.message || err);
			return {};
		}),
	]);

	const scopedBranchIdForFilter =
		branchId != null && String(branchId).trim() !== '' ? Number(branchId) : null;
	const rawBranchSales = branchSalesRes?.data?.data || [];
	// 3Core is the developer/testing branch — drop it from "All Branches" aggregates
	// unless it's the branch explicitly being viewed. Mirrors is3coreBranch() in the frontend.
	const branchSales = rawBranchSales.filter(
		(b) =>
			!TEST_BRANCH_NAME_PATTERN.test(String(b.branch_name || '')) ||
			Number(b.branch_id) === scopedBranchIdForFilter,
	);
	const topSelling = topSellingRes?.data?.data || [];
	const expenseBreakdown = expenseBreakdownRes?.data?.data || [];
	const expenseSummary = {
		total_expense: Object.values(nodeExpenseByBranch || {}).reduce(
			(s, v) => s + (Number(v) || 0),
			0,
		),
	};

	const { expenseMap, expenseByBranch } = buildExpenseMaps(expenseBreakdown);

	// Prefer branch-sales net_sales (paid − refund); fallback to gross total_sales.
	const netSalesByBranch = buildNetSalesByBranchFromSales(branchSales);

	const branchCardsData = (branchSales || []).map((b) => {
		const netFromBranch = netSalesByBranch[b.branch_id];
		const posBase =
			netFromBranch != null && netFromBranch > 0
				? netFromBranch
				: Number(b.total_sales || 0);
		const reconTotal = Number(reconByBranch[b.branch_id] ?? 0) || 0;
		const fromPy = Number(expenseByBranch[b.branch_id]) || 0;
		const fromNode = Number(nodeExpenseByBranch?.[b.branch_id]) || 0;
		// Prefer the fuller total — py breakdown can be partial/empty for some ranges.
		const totalExpenses = Math.max(fromPy, fromNode);
		return {
			id: b.branch_id,
			name: b.branch_name,
			totalSales: posBase + reconTotal,
			reportSalesPos: posBase,
			/** Gross POS total_sales — same basis as performance-trend / Total Sales chart. */
			reportSalesGross: Number(b.total_sales || 0),
			reconTotal,
			totalExpenses,
			totalOrders: b.order_count,
		};
	});

	const branchRevenueDistribution = (branchSales || []).map((b) => ({
		name: b.branch_name,
		value: netSalesByBranch[b.branch_id] || Number(b.total_sales || 0),
	}));

	const topProductsData =
		slim || drill
			? []
			: (topSelling || []).slice(0, 5).map((item) => ({
					name: item.MENU_NAME || '',
					sales: item.total_quantity,
				}));

	const trendData =
		slim || drill
			? []
			: (trendRes?.data?.data || []).map((r) => ({
					name: String(r.name ?? ''),
					totalSales: Number(r.totalSales || 0),
					totalExpenses: Number(r.totalExpenses || 0),
					...(r.sale_date ? { date: String(r.sale_date).slice(0, 10) } : {}),
				}));

	// Retry trend alone if the parallel wave timed out (full mode only).
	let finalTrendData = trendData;
	if (!slim && !drill && finalTrendData.length === 0) {
		const retryRes = await fetchPyServerOptional(
			'/api/analytics/performance-trend',
			trendParams,
			BUNDLE_PYSERVER_TIMEOUT_MS * 2,
		);
		finalTrendData = (retryRes?.data?.data || []).map((r) => ({
			name: String(r.name ?? ''),
			totalSales: Number(r.totalSales || 0),
			totalExpenses: Number(r.totalExpenses || 0),
			...(r.sale_date ? { date: String(r.sale_date).slice(0, 10) } : {}),
		}));
	}

	const scopedBranchId =
		branchId != null && String(branchId).trim() !== '' ? Number(branchId) : null;
	const summary = buildSummary({
		branchId: Number.isFinite(scopedBranchId) ? scopedBranchId : null,
		branchCards: branchCardsData,
		totalExpenses: Number(expenseSummary?.total_expense) || 0,
	});

	const branchChartsById =
		!slim && !drill && include_branch_charts
			? await buildBranchChartsForAll(branchCardsData, start_date, end_date)
			: {};

	return {
		summary,
		branchCardsData,
		branchRevenueDistribution,
		topProductsData,
		expenseCategoryByBranch: expenseMap,
		expenseRentByBranch: rentSalaryByBranch?.rent || {},
		expenseSalaryByBranch: rentSalaryByBranch?.salary || {},
		trendData: finalTrendData,
		trendPeriod: String(period || 'monthly'),
		branchChartsById,
	};
}

module.exports = { buildAdminDashboardBundle };
