const { fetchPyCached } = require('./analyticsPyFetch');

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

function sumDaily(rows) {
  return (rows || []).reduce(
    (acc, row) => {
      const total = Number(row.total_sales) || 0;
      const refund = Number(row.refund) || 0;
      const discount = Number(row.discount) || 0;
      const net = Number(row.net_sales) || total - refund - discount;
      const gp = Number(row.gross_profit) || 0;
      acc.total_sales += total;
      acc.refund += refund;
      acc.discount += discount;
      acc.net_sales += net;
      acc.gross_profit += gp;
      return acc;
    },
    { total_sales: 0, refund: 0, discount: 0, net_sales: 0, gross_profit: 0 },
  );
}

function pctChange(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return c === 0 ? 0 : 100;
  return Math.round(((c - p) / p) * 1000) / 10;
}

function topMenuByNet(rows, limit = 8) {
  const map = new Map();
  for (const r of rows || []) {
    const name = String(r.goods || '').trim() || 'Unknown';
    const net =
      Number(r.netSales) ||
      (Number(r.totalSales) || 0) - (Number(r.refundAmount) || 0) - (Number(r.discounts) || 0);
    map.set(name, (map.get(name) || 0) + net);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, net_sales]) => ({ name, net_sales: Math.round(net_sales * 100) / 100 }));
}

function topCategoriesByNet(rows, limit = 8) {
  const map = new Map();
  for (const r of rows || []) {
    const name = String(r.category || r.name || '').trim() || 'Unknown';
    const net = Number(r.netSales) || Number(r.totalSales) || 0;
    map.set(name, (map.get(name) || 0) + net);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, net_sales]) => ({ name, net_sales: Math.round(net_sales * 100) / 100 }));
}

function aggregateExpenseBreakdown(rows) {
  const byName = new Map();
  for (const r of rows || []) {
    const cat = String(r.exp_cat || '').trim();
    const name = String(r.exp_name || r.exp_cat || 'Other').trim() || 'Other';
    const key = name;
    const prev = byName.get(key) || { name, category_type: cat, amount: 0, entry_count: 0 };
    prev.amount += Number(r.total_amount) || 0;
    prev.entry_count += Number(r.entry_count) || 0;
    byName.set(key, prev);
  }
  return [...byName.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 12)
    .map((x) => ({
      name: x.name,
      category_type: x.category_type,
      amount: Math.round(x.amount * 100) / 100,
      entry_count: x.entry_count,
    }));
}

function mergeExpenseBreakdownWithChange(currentRows, previousRows) {
  const prevMap = new Map();
  for (const r of aggregateExpenseBreakdown(previousRows)) {
    prevMap.set(r.name, r.amount);
  }
  return aggregateExpenseBreakdown(currentRows).map((item) => {
    const prevAmt = prevMap.get(item.name) || 0;
    return {
      ...item,
      change_pct: pctChange(item.amount, prevAmt),
    };
  });
}

function detectDrinkCategories(categories) {
  return (categories || []).filter((c) => /drink|주류|alcohol|beverage|beer|soju|wine/i.test(c.name));
}

/**
 * Build structured management context JSON for LLM (sales + expenses + comparisons).
 */
async function buildManagementContext(start_date, end_date) {
  const prev = previousPeriod(start_date, end_date);
  const params = { start_date, end_date };
  const prevParams = { start_date: prev.start, end_date: prev.end };

  const [
    dailyRes,
    dailyPrevRes,
    branchRes,
    menuRes,
    categoryRes,
    paymentRes,
    expenseRes,
    expensePrevRes,
    expenseBreakRes,
    expenseBreakPrevRes,
  ] = await Promise.all([
    fetchPyCached('/api/analytics/daily-sales', params),
    fetchPyCached('/api/analytics/daily-sales', prevParams),
    fetchPyCached('/api/analytics/branch-sales', params).catch(() => ({ data: { data: [] } })),
    fetchPyCached('/api/analytics/menu-report', params),
    fetchPyCached('/api/analytics/category-report', params),
    fetchPyCached('/api/analytics/payment-report', params).catch(() => ({ data: { data: [] } })),
    fetchPyCached('/api/analytics/expense-summary', params).catch(() => ({ data: { total_expense: 0 } })),
    fetchPyCached('/api/analytics/expense-summary', prevParams).catch(() => ({ data: { total_expense: 0 } })),
    fetchPyCached('/api/analytics/expense-breakdown', params).catch(() => ({ data: { data: [] } })),
    fetchPyCached('/api/analytics/expense-breakdown', prevParams).catch(() => ({ data: { data: [] } })),
  ]);

  const salesCur = sumDaily(dailyRes?.data?.data || []);
  const salesPrev = sumDaily(dailyPrevRes?.data?.data || []);
  const expenseCur = Number(expenseRes?.data?.total_expense) || 0;
  const expensePrev = Number(expensePrevRes?.data?.total_expense) || 0;
  const netProfitCur = Math.round((salesCur.net_sales - expenseCur) * 100) / 100;
  const netProfitPrev = Math.round((salesPrev.net_sales - expensePrev) * 100) / 100;

  const menuTop = topMenuByNet(menuRes?.data?.data || [], 8);
  const categories = topCategoriesByNet(categoryRes?.data?.data || [], 8);
  const drinkCats = detectDrinkCategories(categories);
  const expenseItems = mergeExpenseBreakdownWithChange(
    expenseBreakRes?.data?.data || [],
    expenseBreakPrevRes?.data?.data || [],
  );

  const branchRows = branchRes?.data?.data || [];
  const paymentRows = (paymentRes?.data?.data || []).map((p) => ({
    type: String(p.paymentType || p.payment_type || '—'),
    amount: Number(p.paymentAmount) || Number(p.amount) || 0,
  }));

  return {
    period: { start: start_date, end: end_date, label: `${start_date} to ${end_date}` },
    previous_period: prev,
    kpi: {
      revenue_net_sales: salesCur.net_sales,
      revenue_gross_sales: salesCur.total_sales,
      gross_profit: salesCur.gross_profit,
      expenses: expenseCur,
      net_profit: netProfitCur,
      refund: salesCur.refund,
      discount: salesCur.discount,
    },
    kpi_previous: {
      revenue_net_sales: salesPrev.net_sales,
      expenses: expensePrev,
      net_profit: netProfitPrev,
      gross_profit: salesPrev.gross_profit,
    },
    comparisons: {
      revenue_net_sales_pct: pctChange(salesCur.net_sales, salesPrev.net_sales),
      expenses_pct: pctChange(expenseCur, expensePrev),
      net_profit_pct: pctChange(netProfitCur, netProfitPrev),
      gross_profit_pct: pctChange(salesCur.gross_profit, salesPrev.gross_profit),
    },
    sales_breakdown: {
      top_menu: menuTop,
      top_categories: categories,
      drink_categories: drinkCats,
      by_branch: [...branchRows]
        .sort((a, b) => (Number(b.total_sales) || 0) - (Number(a.total_sales) || 0))
        .slice(0, 8)
        .map((b) => ({
          name: b.branch_name,
          total_sales: Number(b.total_sales) || 0,
          orders: Number(b.order_count) || 0,
        })),
      payment_mix: paymentRows.slice(0, 6),
    },
    expense_breakdown: {
      total: expenseCur,
      items: expenseItems,
    },
    context: {
      industry_benchmark: null,
      season_note: null,
      one_time_cost_notes: [],
      data_gaps: [
        'No industry percentile in system — do not invent industry rankings.',
        'No tourist vs local customer split — do not claim unless in notes.',
        'Labor/wages not isolated unless present in expense category names.',
      ],
    },
    raw_daily_sales: (dailyRes?.data?.data || []).slice(-14).map((d) => ({
      date: String(d.sale_date).slice(0, 10),
      net_sales: Number(d.net_sales) || 0,
    })),
  };
}

function briefChartTitles(locale) {
  const ko = locale === 'ko';
  const fil = locale === 'fil';
  if (ko) {
    return {
      trend: '일별 순매출',
      category: '카테고리별 매출',
      menu: '인기 메뉴',
      expense: '비용 항목',
      branch: '지점별 매출',
    };
  }
  if (fil) {
    return { trend: 'Araw-araw na net sales', category: 'Sales by category', menu: 'Top menu', expense: 'Gastos', branch: 'Sales by branch' };
  }
  return {
    trend: 'Daily net sales',
    category: 'Sales by category',
    menu: 'Top menu (net sales)',
    expense: 'Expense breakdown',
    branch: 'Sales by branch',
  };
}

function buildManagementBriefCharts(ctx, locale) {
  const titles = briefChartTitles(locale);
  const ko = locale === 'ko';
  const netLabel = ko ? '순매출' : 'Net sales';
  const expLabel = ko ? '비용' : 'Expense';
  const charts = [];

  const daily = ctx.raw_daily_sales || [];
  if (daily.length > 0) {
    charts.push({
      type: 'line',
      title: titles.trend,
      labels: daily.map((d) => d.date.slice(5)),
      series: [{ name: netLabel, data: daily.map((d) => d.net_sales) }],
    });
  }

  const cats = ctx.sales_breakdown?.top_categories || [];
  if (cats.length > 0) {
    charts.push({
      type: 'bar',
      title: titles.category,
      labels: cats.map((c) => c.name),
      series: [{ name: netLabel, data: cats.map((c) => c.net_sales) }],
    });
  }

  const menu = ctx.sales_breakdown?.top_menu || [];
  if (menu.length > 0) {
    charts.push({
      type: 'bar',
      title: titles.menu,
      labels: menu.slice(0, 6).map((m) => m.name),
      series: [{ name: netLabel, data: menu.slice(0, 6).map((m) => m.net_sales) }],
    });
  }

  const expItems = ctx.expense_breakdown?.items || [];
  if (expItems.length > 0) {
    charts.push({
      type: 'bar',
      title: titles.expense,
      labels: expItems.slice(0, 6).map((e) => e.name),
      series: [{ name: expLabel, data: expItems.slice(0, 6).map((e) => e.amount) }],
    });
  }

  return charts;
}

module.exports = {
  buildManagementContext,
  buildManagementBriefCharts,
  pctChange,
};
