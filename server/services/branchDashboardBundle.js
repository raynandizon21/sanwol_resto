const OrderModel = require('../models/orderModel');
const CashReconciliationModel = require('../models/cashReconciliationModel');
const ReportsModel = require('../models/reportsModel');
const ExpenseModel = require('../models/expenseModel');
const { fetchPyCachedOptional } = require('./analyticsPyFetch');
const { resolveNetSalesFromRow, sumNetSalesFromDailyRows } = require('../utils/analyticsSales');

/** Per-call cap for dashboard bundle — keep under client timeout; retries use 2×. */
const BUNDLE_PYSERVER_TIMEOUT_MS = Number(process.env.BUNDLE_PYSERVER_TIMEOUT_MS || 12000);

function fetchPyServerOptional(path, params = {}, timeoutMs = BUNDLE_PYSERVER_TIMEOUT_MS) {
	return fetchPyCachedOptional(path, params, { timeoutMs });
}

const TOP_CATEGORY_COLORS = ['#0f172a', '#2563eb', '#f97316', '#16a34a', '#7c3aed', '#e11d48'];
const DEFAULT_TRENDING_IMAGE =
	'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?q=80&w=800&auto=format&fit=crop';

function toYmd(d) {
	return (
		d.getFullYear() +
		'-' +
		String(d.getMonth() + 1).padStart(2, '0') +
		'-' +
		String(d.getDate()).padStart(2, '0')
	);
}

function parseIsoDate(iso) {
	if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(String(iso).slice(0, 10))) return null;
	const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
	return Number.isNaN(d.getTime()) ? null : d;
}

function eachDateKeyInclusive(startYmd, endYmd) {
	const start = parseIsoDate(startYmd);
	const end = parseIsoDate(endYmd);
	if (!start || !end || start.getTime() > end.getTime()) return [];
	const keys = [];
	const cur = new Date(start.getTime());
	const endMs = end.getTime();
	while (cur.getTime() <= endMs) {
		keys.push(toYmd(cur));
		cur.setDate(cur.getDate() + 1);
	}
	return keys;
}

function fillRevenueDataGaps(points, startYmd, endYmd, expenseByDate, reconByDate) {
	const rangeKeys = eachDateKeyInclusive(startYmd, endYmd);
	if (rangeKeys.length === 0) return points;
	const byDate = new Map();
	for (const p of points || []) {
		const k = p.date?.slice(0, 10);
		if (k) byDate.set(k, p);
	}
	return rangeKeys.map((key) => {
		const existing = byDate.get(key);
		if (existing) return existing;
		const d = parseIsoDate(key);
		return {
			name: d ? String(d.getDate()) : key,
			date: key,
			income: Number(reconByDate[key] ?? 0),
			expense: expenseByDate.get(key) ?? 0,
		};
	});
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

async function fetchDailySalesSeries(startDate, endDate, branchId, options = {}) {
	const { sqlOnly = false } = options;
	const params = { start_date: startDate, end_date: endDate };
	if (branchId) params.branch_id = String(branchId);

	const sqlPromise = ReportsModel.getRevenueReport('daily', startDate, endDate, branchId)
		.then(mapRevenueRowsToDailySales)
		.catch(() => []);

	if (sqlOnly) return sqlPromise;

	// True parallel: SQL fallback + PyServer analytics in one wave.
	const [sqlRows, pyJson] = await Promise.all([
		sqlPromise,
		fetchPyServerOptional('/api/analytics/daily-sales', params),
	]);
	const pyRows = pyJson?.data?.data || [];
	if (Array.isArray(pyRows) && pyRows.length > 0) return pyRows;
	return sqlRows;
}

function buildDashboardData({
	start,
	end,
	branchId,
	dailySales,
	dailyOrders,
	dailyExpenses,
	expenseSummary,
	branchSales,
	reconAgg,
}) {
	const reconByDate = reconAgg?.byDate && typeof reconAgg.byDate === 'object' ? reconAgg.byDate : {};
	const reconPeriodTotal = Number(reconAgg?.total) || 0;

	const branchItem = (branchSales || []).find((b) => String(b.branch_id) === String(branchId));

	const totalSalesFromDaily = sumNetSalesFromDailyRows(dailySales);
	const totalSalesFromBranch = branchItem ? Number(branchItem.total_sales || 0) : 0;

	const totalExpensesFromSummary = Number(expenseSummary?.total_expense) || 0;
	const totalExpensesFromDaily = (dailyExpenses || []).reduce(
		(sum, item) => sum + Number(item.total_expense || 0),
		0,
	);
	const totalExpenses = totalExpensesFromSummary || totalExpensesFromDaily;

	const totalOrdersFromBranch = branchItem?.order_count ?? 0;
	const totalOrdersFromDaily = (dailyOrders || []).reduce(
		(sum, item) => sum + Number(item.order_count || 0),
		0,
	);
	const totalOrders = totalOrdersFromBranch || totalOrdersFromDaily;

	const expenseByDate = new Map();
	for (const e of dailyExpenses || []) {
		expenseByDate.set(e.expense_date, Number(e.total_expense || 0));
	}

	const saleDatesWithPosRow = new Set(
		(dailySales || []).map((item) => normalizeSaleDateKey(item.sale_date)),
	);

	let revenueData = [];
	if ((dailySales || []).length > 0) {
		revenueData = dailySales.map((item) => {
			const key = normalizeSaleDateKey(item.sale_date);
			const dailyExpense = expenseByDate.get(key) ?? expenseByDate.get(item.sale_date) ?? 0;
			const reconDay = Number(reconByDate[key] ?? 0);
			const d = new Date(item.sale_date);
			return {
				name: Number.isNaN(d.getTime()) ? item.sale_date : String(d.getDate()),
				date: key,
				income: resolveNetSalesFromRow(item) + reconDay,
				expense: dailyExpense,
			};
		});
		for (const [dateKey, raw] of Object.entries(reconByDate)) {
			const recon = Number(raw) || 0;
			if (recon <= 0 || saleDatesWithPosRow.has(dateKey)) continue;
			const d = new Date(`${dateKey}T12:00:00`);
			revenueData.push({
				name: Number.isNaN(d.getTime()) ? dateKey : String(d.getDate()),
				date: dateKey,
				income: recon,
				expense: expenseByDate.get(dateKey) ?? 0,
			});
		}
		revenueData.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
	} else if (totalExpenses > 0 || reconPeriodTotal > 0) {
		if (reconPeriodTotal > 0) {
			for (const [dateKey, raw] of Object.entries(reconByDate)) {
				const recon = Number(raw) || 0;
				if (recon <= 0) continue;
				const d = new Date(`${dateKey}T12:00:00`);
				revenueData.push({
					name: Number.isNaN(d.getTime()) ? dateKey : String(d.getDate()),
					date: dateKey,
					income: recon,
					expense: expenseByDate.get(dateKey) ?? 0,
				});
			}
			revenueData.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
		}
		if (revenueData.length === 0) {
			const d = new Date(`${start}T12:00:00`);
			revenueData = [
				{
					name: Number.isNaN(d.getTime()) ? start : String(d.getDate()),
					date: start,
					income: 0,
					expense: totalExpenses,
				},
			];
		}
	}

	const aggregateExpenseOnlyFallback =
		(dailySales || []).length === 0 &&
		revenueData.length === 1 &&
		(revenueData[0]?.income ?? 0) === 0 &&
		Math.abs((revenueData[0]?.expense ?? 0) - totalExpenses) < 1e-6;

	if (revenueData.length > 0 && !aggregateExpenseOnlyFallback) {
		revenueData = fillRevenueDataGaps(revenueData, start, end, expenseByDate, reconByDate);
	}

	const totalSalesFromSeries = revenueData.reduce((s, p) => s + Number(p.income || 0), 0);
	const totalSales =
		revenueData.length > 0 && !aggregateExpenseOnlyFallback
			? totalSalesFromSeries
			: (totalSalesFromDaily || totalSalesFromBranch) + reconPeriodTotal;
	const totalProfit = totalSales - totalExpenses;

	const last7Days = (dailyOrders || []).slice(-7);
	const ordersOverview = last7Days.map((item) => {
		const d = new Date(item.sale_date);
		return {
			name: Number.isNaN(d.getTime())
				? item.sale_date
				: d.toLocaleDateString('en-US', { weekday: 'short' }),
			date: item.sale_date,
			orders: item.order_count,
		};
	});

	return {
		stats: {
			totalOrders,
			totalSales,
			totalExpenses,
			totalProfit,
		},
		revenueData,
		ordersOverview,
	};
}

/** Phase 1 — SQL-only probes (~100–300ms). Used for fast empty detection before PyServer. */
async function fetchBranchDashboardPhase1({ branchId, start_date, end_date }) {
	const branchParam = branchId ? String(branchId) : null;

	const [dailySalesResult, reconResult, recentOrdersResult, expenseTotalResult] =
		await Promise.allSettled([
			fetchDailySalesSeries(start_date, end_date, branchParam, { sqlOnly: true }),
			branchParam
				? CashReconciliationModel.aggregatesForRange(branchParam, start_date, end_date)
				: Promise.resolve({ byDate: {}, total: 0 }),
			branchParam
				? OrderModel.getAll(branchParam, {
						start_date,
						end_date,
						limit: 5,
						includeItemMeta: true,
					})
				: Promise.resolve([]),
			// SQL probe only — avoid burning a PyServer slot before phase 2.
			ExpenseModel.getTotalsByBranch(start_date, end_date).catch(() => ({})),
		]);

	const dailySales =
		dailySalesResult.status === 'fulfilled' ? dailySalesResult.value : [];
	const reconAgg =
		reconResult.status === 'fulfilled'
			? reconResult.value
			: { byDate: {}, total: 0 };
	const recentOrders =
		recentOrdersResult.status === 'fulfilled' ? recentOrdersResult.value : [];
	const expenseByBranch =
		expenseTotalResult.status === 'fulfilled' ? expenseTotalResult.value || {} : {};
	const expenseTotal = branchParam
		? Number(expenseByBranch[Number(branchParam)] ?? expenseByBranch[branchParam] ?? 0) || 0
		: Object.values(expenseByBranch).reduce((s, v) => s + (Number(v) || 0), 0);
	const expenseSummary = { total_expense: expenseTotal };

	const phase1HadErrors =
		dailySalesResult.status === 'rejected' ||
		reconResult.status === 'rejected' ||
		recentOrdersResult.status === 'rejected' ||
		expenseTotalResult.status === 'rejected';

	const hasSales = (dailySales || []).some((d) => resolveNetSalesFromRow(d) > 0);
	const hasRecon = Number(reconAgg?.total || 0) > 0;
	const hasRecentOrders = (recentOrders || []).length > 0;
	const hasExpenses = expenseTotal > 0;
	const hasActivity = hasSales || hasRecon || hasRecentOrders || hasExpenses;

	return {
		branchParam,
		dailySales,
		reconAgg,
		recentOrders,
		expenseSummary,
		phase1HadErrors,
		hasActivity,
	};
}

/** Fast probe — tells frontend whether to show skeleton (activity) or empty shell immediately. */
async function probeBranchDashboardActivity({ branchId, start_date, end_date }) {
	const phase1 = await fetchBranchDashboardPhase1({ branchId, start_date, end_date });
	return {
		hasActivity: phase1.phase1HadErrors ? true : phase1.hasActivity,
	};
}

/**
 * Single server-side bundle for branch Dashboard (replaces ~10 frontend HTTP calls).
 */
async function buildBranchDashboardBundle({ branchId, start_date, end_date }) {
	const phase1 = await fetchBranchDashboardPhase1({ branchId, start_date, end_date });
	const {
		branchParam,
		dailySales,
		reconAgg,
		recentOrders,
		expenseSummary: phase1ExpenseSummary,
		phase1HadErrors,
		hasActivity,
	} = phase1;

	const pyParams = { start_date, end_date };
	if (branchParam) pyParams.branch_id = branchParam;

	const recentOrderItemsMeta = Object.fromEntries(
		(recentOrders || []).map((o) => [
			String(o.IDNo),
			{
				lineCount: Number(o.item_line_count ?? 0),
				totalQty: Number(o.item_total_qty ?? 0),
			},
		]),
	);

	// Empty branch: skip slow PyServer analytics only when phase 1 succeeded and found no activity.
	if (!phase1HadErrors && !hasActivity) {
		return {
			dashboardData: buildDashboardData({
				start: start_date,
				end: end_date,
				branchId: branchParam,
				dailySales: dailySales || [],
				dailyOrders: [],
				dailyExpenses: [],
				expenseSummary: { total_expense: 0 },
				branchSales: [],
				reconAgg,
			}),
			topCategories: [],
			trendingMenusData: [],
			recentOrders: recentOrders || [],
			recentOrderItemsMeta,
		};
	}

	// Always fetch PyServer daily-sales for gross totals (paid + discount).
	// Phase-1 SQL uses AMOUNT_PAID only and must not skip the analytics call.
	// Skip expense-summary — derive from daily-expenses (or phase-1 SQL totals).
	const [
		dailySalesPyRes,
		dailyOrdersRes,
		dailyExpensesRes,
		branchSalesRes,
		categoryRes,
		topSellingRes,
	] = await Promise.all([
		fetchPyServerOptional('/api/analytics/daily-sales', { ...pyParams, lightweight: '1' }),
		fetchPyServerOptional('/api/analytics/daily-orders', pyParams),
		fetchPyServerOptional('/api/analytics/daily-expenses', pyParams),
		fetchPyServerOptional('/api/analytics/branch-sales', pyParams),
		fetchPyServerOptional('/api/analytics/category-report', { ...pyParams, limit: 5 }),
		fetchPyServerOptional('/api/analytics/top-selling', { ...pyParams, limit: 5 }),
	]);

	const dailyOrders = dailyOrdersRes?.data?.data || [];
	let dailyExpenses = dailyExpensesRes?.data?.data || [];
	const expenseFromDaily = (dailyExpenses || []).reduce(
		(sum, item) => sum + (Number(item.total_expense) || 0),
		0,
	);
	let expenseSummary =
		expenseFromDaily > 0
			? { total_expense: expenseFromDaily }
			: phase1ExpenseSummary || { total_expense: 0 };
	const branchSales = branchSalesRes?.data?.data || [];
	const pyDailySales = dailySalesPyRes?.data?.data || [];
	const hasPySales =
		Array.isArray(pyDailySales) &&
		pyDailySales.some((d) => Number(d.total_sales ?? d.net_sales ?? 0) > 0);
	const dailySalesForDashboard = hasPySales
		? pyDailySales
		: pyDailySales.length > 0
			? pyDailySales
			: dailySales;

	let categoryRows = categoryRes?.data?.data || [];
	let topSellingRows = topSellingRes?.data?.data || [];
	let finalDailyOrders = dailyOrders;

	// Sales present but companion endpoints timed out under load — retry missing ones once.
	const hasSalesSignal =
		(dailySalesForDashboard || []).some((d) => Number(d.total_sales ?? d.net_sales ?? 0) > 0) ||
		(branchSales || []).some((b) => Number(b.total_sales ?? b.net_sales ?? 0) > 0);
	if (hasSalesSignal) {
		const retryMs = BUNDLE_PYSERVER_TIMEOUT_MS * 2;
		const retries = [];
		if (!finalDailyOrders.length) {
			retries.push(
				fetchPyServerOptional('/api/analytics/daily-orders', pyParams, retryMs).then((res) => {
					finalDailyOrders = res?.data?.data || finalDailyOrders;
				}),
			);
		}
		if (
			!(Number(expenseSummary?.total_expense) > 0) &&
			!(dailyExpenses || []).some((e) => Number(e.total_expense) > 0)
		) {
			retries.push(
				fetchPyServerOptional('/api/analytics/daily-expenses', pyParams, retryMs).then((dayRes) => {
					dailyExpenses = dayRes?.data?.data || dailyExpenses;
					const fromDaily = (dailyExpenses || []).reduce(
						(sum, item) => sum + (Number(item.total_expense) || 0),
						0,
					);
					if (fromDaily > 0) expenseSummary = { total_expense: fromDaily };
				}),
			);
		}
		if (!categoryRows.length) {
			retries.push(
				fetchPyServerOptional('/api/analytics/category-report', pyParams, retryMs).then((res) => {
					categoryRows = res?.data?.data || categoryRows;
				}),
			);
		}
		if (!topSellingRows.length) {
			retries.push(
				fetchPyServerOptional('/api/analytics/top-selling', { ...pyParams, limit: 5 }, retryMs).then(
					(res) => {
						topSellingRows = res?.data?.data || topSellingRows;
					},
				),
			);
		}
		if (retries.length) await Promise.all(retries);
	}

	// Orders still missing after retry — branch-sales carries order_count aggregate.
	if (
		hasSalesSignal &&
		!(finalDailyOrders || []).some((d) => Number(d.order_count) > 0) &&
		!(branchSales || []).some((b) => Number(b.order_count) > 0)
	) {
		const branchSalesRetry = await fetchPyServerOptional(
			'/api/analytics/branch-sales',
			pyParams,
			BUNDLE_PYSERVER_TIMEOUT_MS * 2,
		);
		if (branchSalesRetry?.data?.data?.length) {
			branchSales.splice(0, branchSales.length, ...branchSalesRetry.data.data);
		}
	}

	const dashboardData = buildDashboardData({
		start: start_date,
		end: end_date,
		branchId: branchParam,
		dailySales: dailySalesForDashboard,
		dailyOrders: finalDailyOrders,
		dailyExpenses,
		expenseSummary,
		branchSales,
		reconAgg,
	});

	const topCategories = (categoryRows || []).slice(0, 5).map((row, i) => ({
		name: row.category || 'Uncategorized',
		value: row.netSales ?? 0,
		color: TOP_CATEGORY_COLORS[i % TOP_CATEGORY_COLORS.length],
	}));

	const trendingMenusData = (topSellingRows || []).slice(0, 5).map((r, idx) => ({
		key: String(r.IDNo ?? idx),
		name: r.MENU_NAME || '',
		category: r.category || 'Uncategorized',
		totalQty: Number(r.total_quantity ?? 0),
		netSales: Number(r.total_revenue ?? 0),
		image: DEFAULT_TRENDING_IMAGE,
	}));

	return {
		dashboardData,
		topCategories,
		trendingMenusData,
		recentOrders: recentOrders || [],
		recentOrderItemsMeta,
	};
}

module.exports = { buildBranchDashboardBundle, probeBranchDashboardActivity };
