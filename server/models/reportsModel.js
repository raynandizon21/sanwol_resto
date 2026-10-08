// ============================================
// REPORTS MODEL
// ============================================
// File: models/reportsModel.js
// Description: Database operations for reports and analytics
// ============================================

const pool = require('../config/db');
const { businessDateSql, branchAwareDayCondition } = require('../utils/businessDay');
const { phLocalDayRangeFilter } = require('../utils/phDateRange');

class ReportsModel {
	// Get revenue report by period (from billing)
	static async getRevenueReport(period = 'daily', startDate = null, endDate = null, branchId = null) {
		let dateFilter = '';
		const params = [];

		if (period === 'daily') {
			// Only business-day cutoff branches (see utils/businessDay.js) get a shifted day; every
			// other branch keeps this exact legacy condition. Same raw-column convention as before.
			const hasRange = Boolean(startDate && endDate);
			const billingCond = branchAwareDayCondition({
				branchColumn: 'b.BRANCH_ID',
				branchId,
				legacy: hasRange
					? { sql: 'b.ENCODED_DT >= ? AND b.ENCODED_DT < DATE_ADD(?, INTERVAL 1 DAY)', params: [startDate, endDate] }
					: { sql: 'DATE(b.ENCODED_DT) = CURDATE()', params: [] },
				business: (h) => (hasRange
					? { sql: `b.ENCODED_DT >= DATE_ADD(?, INTERVAL ${h} HOUR) AND b.ENCODED_DT < DATE_ADD(DATE_ADD(?, INTERVAL 1 DAY), INTERVAL ${h} HOUR)`, params: [startDate, endDate] }
					: { sql: `DATE(DATE_SUB(b.ENCODED_DT, INTERVAL ${h} HOUR)) = DATE(DATE_SUB(NOW(), INTERVAL ${h} HOUR))`, params: [] }),
			});
			dateFilter = `AND ${billingCond.sql}`;
			params.push(...billingCond.params);
		} else if (period === 'weekly') {
			if (startDate && endDate) {
				dateFilter = 'AND b.ENCODED_DT >= ? AND b.ENCODED_DT < DATE_ADD(?, INTERVAL 1 DAY)';
				params.push(startDate, endDate);
			} else {
				dateFilter = 'AND YEARWEEK(b.ENCODED_DT) = YEARWEEK(CURDATE())';
			}
		} else if (period === 'monthly') {
			if (startDate && endDate) {
				dateFilter = 'AND b.ENCODED_DT >= ? AND b.ENCODED_DT < DATE_ADD(?, INTERVAL 1 DAY)';
				params.push(startDate, endDate);
			} else {
				dateFilter = 'AND YEAR(b.ENCODED_DT) = YEAR(CURDATE()) AND MONTH(b.ENCODED_DT) = MONTH(CURDATE())';
			}
		}

		// Build billing query with grouping
		// Daily rows are bucketed by business day (only cutoff branches differ; others stay DATE()).
		const billingDateExpr = period === 'daily' ? businessDateSql('b.ENCODED_DT', 'b.BRANCH_ID') : 'DATE(b.ENCODED_DT)';
		let billingGroupBy = '';
		if (period === 'daily') {
			billingGroupBy = ` GROUP BY ${billingDateExpr}`;
		} else if (period === 'weekly') {
			billingGroupBy = ` GROUP BY YEARWEEK(b.ENCODED_DT)`;
		} else if (period === 'monthly') {
			billingGroupBy = ` GROUP BY YEAR(b.ENCODED_DT), MONTH(b.ENCODED_DT)`;
		}

		let billingQuery = `
			SELECT 
				${billingDateExpr} as date,
				SUM(b.AMOUNT_PAID) as revenue,
				COUNT(DISTINCT b.ORDER_ID) as order_count,
				AVG(b.AMOUNT_PAID) as average_order_value
			FROM billing b
			WHERE b.STATUS IN (1, 2)
			${dateFilter}
		`;

		if (branchId) {
			billingQuery += ` AND b.BRANCH_ID = ?`;
			params.push(branchId);
		}

		billingQuery += billingGroupBy;

		if (period === 'daily') {
			billingQuery += ` ORDER BY date DESC`;
		}

		const [rows] = await pool.execute(billingQuery, params);
		return rows;
	}

	// Get order reports
	static async getOrderReport(startDate = null, endDate = null, branchId = null, status = null) {
		let dateFilter = '';
		const params = [];

		if (startDate && endDate) {
			dateFilter = 'AND DATE(o.ENCODED_DT) BETWEEN ? AND ?';
			params.push(startDate, endDate);
		} else {
			dateFilter = 'AND DATE(o.ENCODED_DT) = CURDATE()';
		}

		let query = `
			SELECT 
				DATE(o.ENCODED_DT) as date,
				COUNT(DISTINCT o.IDNo) as total_orders,
				COUNT(oi.IDNo) as total_items,
				SUM(o.GRAND_TOTAL) as total_revenue,
				AVG(o.GRAND_TOTAL) as average_order_value,
				SUM(CASE WHEN o.STATUS = 1 THEN 1 ELSE 0 END) as settled_orders,
				SUM(CASE WHEN o.STATUS = 2 THEN 1 ELSE 0 END) as confirmed_orders,
				SUM(CASE WHEN o.STATUS = 3 THEN 1 ELSE 0 END) as pending_orders
			FROM orders o
			LEFT JOIN order_items oi ON oi.ORDER_ID = o.IDNo
			WHERE 1=1
			${dateFilter}
		`;

		if (branchId) {
			query += ` AND o.BRANCH_ID = ?`;
			params.push(branchId);
		}

		if (status !== null && status !== undefined) {
			query += ` AND o.STATUS = ?`;
			params.push(status);
		}

		query += ` GROUP BY DATE(o.ENCODED_DT) ORDER BY date DESC`;

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	// Get most popular menu items
	static async getPopularMenuItems(startDate = null, endDate = null, branchId = null, limit = 10) {
		let dateFilter = '';
		const params = [];

		if (startDate && endDate) {
			dateFilter = 'AND DATE(o.ENCODED_DT) BETWEEN ? AND ?';
			params.push(startDate, endDate);
		} else {
			dateFilter = 'AND DATE(o.ENCODED_DT) = CURDATE()';
		}

		let query = `
			SELECT 
				m.IDNo,
				m.MENU_NAME,
				m.MENU_PRICE,
				SUM(oi.QTY) as total_quantity,
				COUNT(DISTINCT oi.ORDER_ID) as order_count,
				SUM(oi.LINE_TOTAL) as total_revenue
			FROM order_items oi
			INNER JOIN orders o ON o.IDNo = oi.ORDER_ID
			INNER JOIN menu m ON m.IDNo = oi.MENU_ID
			WHERE 1=1
			${dateFilter}
		`;

		if (branchId) {
			query += ` AND o.BRANCH_ID = ?`;
			params.push(branchId);
		}

		query += `
			GROUP BY m.IDNo, m.MENU_NAME, m.MENU_PRICE
			ORDER BY total_quantity DESC
			LIMIT ?
		`;
		params.push(limit);

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	// Get daily sales by product for chart (last N days)
	// Returns daily revenue breakdown for top products
	// Only includes paid orders (joins with billing table)
	// Uses order date (o.ENCODED_DT) for daily grouping
	static async getDailySalesByProduct(startDate = null, endDate = null, branchId = null, limit = 5) {
		let dateFilter = '';
		const params = [];

		// Convert to Asia/Manila timezone (UTC+8) for accurate date extraction
		// This ensures orders created on Feb 19 in local time show as Feb 19, not Feb 18
		const localTimeField = `COALESCE(
			CONVERT_TZ(o.ENCODED_DT, @@session.time_zone, '+08:00'),
			DATE_ADD(o.ENCODED_DT, INTERVAL 8 HOUR)
		)`;

		if (startDate && endDate) {
			// Use DATE() with timezone adjustment to ensure proper date comparison
			// Convert to local time (UTC+8 for Philippines) before extracting date
			dateFilter = `AND DATE(${localTimeField}) >= DATE(?) AND DATE(${localTimeField}) <= DATE(?)`;
			params.push(startDate, endDate);
		} else {
			// Default to last 30 days
			const end = new Date();
			const start = new Date();
			start.setDate(start.getDate() - 29);
			dateFilter = `AND DATE(${localTimeField}) >= DATE(?) AND DATE(${localTimeField}) <= DATE(?)`;
			params.push(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
		}

		// First, get top N products by total revenue (only paid orders)
		let topProductsQuery = `
			SELECT 
				m.IDNo,
				m.MENU_NAME
			FROM order_items oi
			INNER JOIN orders o ON o.IDNo = oi.ORDER_ID
			INNER JOIN billing b ON b.ORDER_ID = o.IDNo
			INNER JOIN menu m ON m.IDNo = oi.MENU_ID
			WHERE b.STATUS = 1
			${dateFilter}
		`;

		const topProductsParams = [...params];
		if (branchId && branchId !== 'all') {
			topProductsQuery += ` AND o.BRANCH_ID = ?`;
			topProductsParams.push(branchId);
		}

		topProductsQuery += `
			GROUP BY m.IDNo, m.MENU_NAME
			ORDER BY SUM(oi.LINE_TOTAL) DESC
			LIMIT ?
		`;
		topProductsParams.push(limit);

		const [topProducts] = await pool.execute(topProductsQuery, topProductsParams);

		if (!topProducts || topProducts.length === 0) {
			return [];
		}

		const productIds = topProducts
			.map(p => p && p.IDNo ? parseInt(p.IDNo, 10) : null)
			.filter(id => id !== null && !isNaN(id));

		if (productIds.length === 0) {
			return [];
		}

		const placeholders = productIds.map(() => '?').join(',');

		// Get daily sales for these top products (only paid orders)
		// Group by order date (o.ENCODED_DT) to match the date filter
		// Convert to local time (UTC+8 for Philippines) before extracting date
		// Use DATE_FORMAT to return string 'YYYY-MM-DD' instead of Date object
		// This ensures orders created on Feb 19 show as Feb 19, not Feb 18
		let query = `
			SELECT 
				DATE_FORMAT(${localTimeField}, '%Y-%m-%d') as date,
				m.IDNo as menu_id,
				m.MENU_NAME,
				COALESCE(SUM(oi.LINE_TOTAL), 0) as daily_revenue
			FROM order_items oi
			INNER JOIN orders o ON o.IDNo = oi.ORDER_ID
			INNER JOIN billing b ON b.ORDER_ID = o.IDNo
			INNER JOIN menu m ON m.IDNo = oi.MENU_ID
			WHERE b.STATUS = 1
			AND m.IDNo IN (${placeholders})
			${dateFilter}
		`;

		const dailyParams = [...productIds, ...params];
		if (branchId && branchId !== 'all') {
			query += ` AND o.BRANCH_ID = ?`;
			dailyParams.push(branchId);
		}

		query += `
			GROUP BY DATE(${localTimeField}), m.IDNo, m.MENU_NAME
			ORDER BY date ASC, m.IDNo ASC
		`;

		const [rows] = await pool.execute(query, dailyParams);
		return rows;
	}

	/**
	 * Fast single-item analytics (Node SQL — not PyServer menu-report).
	 * One daily series query covering all comparison windows + 6-month chart.
	 */
	static async getMenuItemAnalytics({ goods, branchId = null, rangeStart, rangeEnd }) {
		const goodsName = String(goods || '').trim();
		if (!goodsName || !rangeStart || !rangeEnd) {
			return { daily: [] };
		}

		const localDt = `COALESCE(
			CONVERT_TZ(b.ENCODED_DT, @@session.time_zone, '+08:00'),
			DATE_ADD(b.ENCODED_DT, INTERVAL 8 HOUR)
		)`;

		const isRoomCharge = /^room\s*charge$/i.test(goodsName);
		const hasBranch = branchId != null && branchId !== '' && String(branchId) !== 'all';
		const branchSql = hasBranch ? ' AND b.BRANCH_ID = ?' : '';

		let query;
		let execParams;

		if (isRoomCharge) {
			query = `
				SELECT
					DATE_FORMAT(${localDt}, '%Y-%m-%d') AS sale_date,
					COUNT(DISTINCT o.IDNo) AS qty,
					COALESCE(SUM(o.SERVICE_CHARGE), 0) AS amount
				FROM orders o
				INNER JOIN billing b
					ON b.ORDER_ID = o.IDNo
					AND b.STATUS IN (1, 2)
					AND b.STATUS NOT IN (-1, -2)
					AND o.STATUS NOT IN (-1, -2)
				WHERE DATE(${localDt}) BETWEEN DATE(?) AND DATE(?)
				${branchSql}
				GROUP BY DATE_FORMAT(${localDt}, '%Y-%m-%d')
				ORDER BY sale_date ASC
			`;
			execParams = hasBranch
				? [rangeStart, rangeEnd, Number(branchId)]
				: [rangeStart, rangeEnd];
		} else {
			query = `
				SELECT
					DATE_FORMAT(${localDt}, '%Y-%m-%d') AS sale_date,
					COALESCE(SUM(oi.QTY), 0) AS qty,
					COALESCE(SUM(oi.LINE_TOTAL), 0) AS amount
				FROM orders o
				INNER JOIN billing b
					ON b.ORDER_ID = o.IDNo
					AND b.STATUS IN (1, 2)
					AND b.STATUS NOT IN (-1, -2)
					AND o.STATUS NOT IN (-1, -2)
				INNER JOIN order_items oi ON oi.ORDER_ID = o.IDNo
				INNER JOIN menu m ON m.IDNo = oi.MENU_ID
				WHERE DATE(${localDt}) BETWEEN DATE(?) AND DATE(?)
				  AND LOWER(TRIM(m.MENU_NAME)) = LOWER(TRIM(?))
				${branchSql}
				GROUP BY DATE_FORMAT(${localDt}, '%Y-%m-%d')
				ORDER BY sale_date ASC
			`;
			execParams = hasBranch
				? [rangeStart, rangeEnd, goodsName, Number(branchId)]
				: [rangeStart, rangeEnd, goodsName];
		}

		const [rows] = await pool.execute(query, execParams);
		return {
			daily: (rows || []).map((r) => ({
				sale_date: String(r.sale_date).slice(0, 10),
				qty: Number(r.qty) || 0,
				amount: Number(r.amount) || 0,
			})),
		};
	}

	// Get table utilization report
	static async getTableUtilizationReport(startDate = null, endDate = null, branchId = null) {
		let dateFilter = '';
		const params = [];

		if (startDate && endDate) {
			dateFilter = 'AND DATE(o.ENCODED_DT) BETWEEN ? AND ?';
			params.push(startDate, endDate);
		} else {
			dateFilter = 'AND DATE(o.ENCODED_DT) = CURDATE()';
		}

		let query = `
			SELECT 
				rt.IDNo,
				rt.TABLE_NUMBER,
				rt.CAPACITY,
				COUNT(DISTINCT o.IDNo) as order_count,
				SUM(o.GRAND_TOTAL) as total_revenue,
				AVG(o.GRAND_TOTAL) as average_order_value,
				SUM(CASE WHEN o.STATUS = 1 THEN 1 ELSE 0 END) as settled_count
			FROM restaurant_tables rt
			LEFT JOIN orders o ON o.TABLE_ID = rt.IDNo
			WHERE rt.ACTIVE = 1
			${dateFilter}
		`;

		if (branchId) {
			query += ` AND rt.BRANCH_ID = ?`;
			params.push(branchId);
		}

		query += ` GROUP BY rt.IDNo, rt.TABLE_NUMBER, rt.CAPACITY ORDER BY order_count DESC`;

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	// Get employee performance report
	static async getEmployeePerformanceReport(startDate = null, endDate = null, branchId = null, employeeId = null) {
		let dateFilter = '';
		const params = [];

		if (startDate && endDate) {
			dateFilter = 'AND DATE(o.ENCODED_DT) BETWEEN ? AND ?';
			params.push(startDate, endDate);
		} else {
			dateFilter = 'AND DATE(o.ENCODED_DT) = CURDATE()';
		}

		let query = `
			SELECT 
				u.IDNo as user_id,
				u.USERNAME,
				u.FIRSTNAME,
				u.LASTNAME,
				CONCAT(u.FIRSTNAME, ' ', u.LASTNAME) as fullname,
				COUNT(DISTINCT o.IDNo) as orders_created,
				SUM(o.GRAND_TOTAL) as total_sales,
				AVG(o.GRAND_TOTAL) as average_order_value,
				COUNT(DISTINCT DATE(o.ENCODED_DT)) as days_active
			FROM user_info u
			INNER JOIN orders o ON o.ENCODED_BY = u.IDNo
			WHERE u.ACTIVE = 1
			${dateFilter}
		`;

		if (branchId) {
			query += ` AND o.BRANCH_ID = ?`;
			params.push(branchId);
		}

		if (employeeId) {
			query += ` AND u.IDNo = ?`;
			params.push(employeeId);
		}

		query += ` GROUP BY u.IDNo, u.USERNAME, u.FIRSTNAME, u.LASTNAME ORDER BY total_sales DESC`;

		const [rows] = await pool.execute(query, params);
		return rows;
	}

	// Get sales hourly summary from paid orders; refunds come from billing.REFUND.
	static async getSalesHourlySummary(startDate = null, endDate = null, branchId = null) {
		const orderParams = [];
		let orderDateFilter = '';
		let orderBranchFilter = '';

		if (startDate && endDate) {
			orderDateFilter = 'AND DATE(o.ENCODED_DT) BETWEEN ? AND ?';
			orderParams.push(startDate, endDate);
		}

		if (branchId) {
			orderBranchFilter = 'AND o.BRANCH_ID = ?';
			orderParams.push(branchId);
		}

		const ordersQuery = `
			SELECT
				DATE_FORMAT(o.ENCODED_DT, '%Y-%m-%d %H:00:00') as hour,
				COALESCE(SUM(o.GRAND_TOTAL), 0) as total_sales,
				COALESCE(SUM(b.REFUND), 0) as refund,
				COALESCE(SUM(o.DISCOUNT_AMOUNT), 0) as discount,
				COALESCE(SUM(o.GRAND_TOTAL - COALESCE(o.DISCOUNT_AMOUNT, 0) - COALESCE(b.REFUND, 0)), 0) as net_sales,
				COALESCE(SUM(o.SUBTOTAL), 0) as product_unit_price,
				COALESCE(SUM(o.GRAND_TOTAL - COALESCE(o.DISCOUNT_AMOUNT, 0) - COALESCE(b.REFUND, 0)), 0) as gross_profit
			FROM orders o
			INNER JOIN billing b ON b.ORDER_ID = o.IDNo
			WHERE b.STATUS = 1
			${orderDateFilter}
			${orderBranchFilter}
			GROUP BY DATE_FORMAT(o.ENCODED_DT, '%Y-%m-%d %H:00:00')
			ORDER BY hour DESC
		`;
		const [rows] = await pool.execute(ordersQuery, orderParams);

		return rows.map((row) => ({
			hour: row.hour,
			total_sales: parseFloat(row.total_sales) || 0,
			refund: parseFloat(row.refund) || 0,
			discount: parseFloat(row.discount) || 0,
			net_sales: parseFloat(row.net_sales) || 0,
			product_unit_price: parseFloat(row.product_unit_price) || 0,
			gross_profit: parseFloat(row.gross_profit) || 0,
		}));
	}

	// Get discount report from paid orders.
	// Columns: name, discount_applied (orders with a discount), point_discount_amount (total discount)
	static async getDiscountReport(startDate = null, endDate = null, branchId = null) {
		const orderParams = [];
		let orderDateFilter = '';
		let orderBranchFilter = '';

		if (startDate && endDate) {
			orderDateFilter = 'AND DATE(o.ENCODED_DT) BETWEEN ? AND ?';
			orderParams.push(startDate, endDate);
		}

		if (branchId) {
			orderBranchFilter = 'AND o.BRANCH_ID = ?';
			orderParams.push(branchId);
		}

		const ordersQuery = `
			SELECT
				COALESCE(SUM(o.DISCOUNT_AMOUNT), 0) as total_discount,
				COUNT(DISTINCT o.IDNo) as total_orders_with_discount
			FROM orders o
			INNER JOIN billing b ON b.ORDER_ID = o.IDNo
			WHERE b.STATUS = 1 AND o.DISCOUNT_AMOUNT > 0
			${orderDateFilter}
			${orderBranchFilter}
		`;
		const [orderRows] = await pool.execute(ordersQuery, orderParams);
		const totalDiscount = parseFloat(orderRows[0]?.total_discount || 0);
		if (totalDiscount <= 0) return [];

		return [{
			name: 'Total Discount',
			discount_applied: parseInt(orderRows[0]?.total_orders_with_discount || 0),
			point_discount_amount: totalDiscount,
		}];
	}

	// Get sales by category report based on live orders only
	// Columns: category, sales_quantity, total_sales, refund_quantity, refund_amount, discounts, net_sales
	// Accepts start_date, end_date, branch_id for future extension when view has those columns
	static async getSalesCategoryReport(startDate = null, endDate = null, branchId = null) {
		const params = [];
		const orderParams = [];
		let orderDateFilter = '';
		let orderBranchFilter = '';

		if (startDate && endDate) {
			orderDateFilter = 'AND DATE(o.ENCODED_DT) BETWEEN ? AND ?';
			orderParams.push(startDate, endDate);
		}

		if (branchId) {
			orderBranchFilter = 'AND o.BRANCH_ID = ?';
			orderParams.push(branchId);
		}

		// Get data from actual orders (paid orders only)
		// This is the source of truth for orders within the date range
		const ordersQuery = `
			SELECT 
				COALESCE(c.CAT_NAME, 'Uncategorized') as category,
				COALESCE(SUM(oi.QTY), 0) as sales_quantity,
				COALESCE(SUM(oi.LINE_TOTAL), 0) as total_sales,
				0 as refund_quantity,
				0 as refund_amount,
				COALESCE(SUM(
					CASE 
						WHEN o.SUBTOTAL > 0 THEN (oi.LINE_TOTAL * o.DISCOUNT_AMOUNT / o.SUBTOTAL)
						ELSE 0
					END
				), 0) as discounts,
				COALESCE(SUM(
					oi.LINE_TOTAL - CASE 
						WHEN o.SUBTOTAL > 0 THEN (oi.LINE_TOTAL * o.DISCOUNT_AMOUNT / o.SUBTOTAL)
						ELSE 0
					END
				), 0) as net_sales
			FROM orders o
			INNER JOIN billing b ON b.ORDER_ID = o.IDNo
			INNER JOIN order_items oi ON oi.ORDER_ID = o.IDNo
			INNER JOIN menu m ON m.IDNo = oi.MENU_ID
			LEFT JOIN categories c ON c.IDNo = m.CATEGORY_ID
			WHERE b.STATUS = 1
			${orderDateFilter}
			${orderBranchFilter}
			GROUP BY COALESCE(c.CAT_NAME, 'Uncategorized')
		`;
		const [orderRows] = await pool.execute(ordersQuery, orderParams);

		const dataMap = new Map();

		// Add/merge actual orders data
		orderRows.forEach(row => {
			const category = row.category || 'Uncategorized';
			if (!dataMap.has(category)) {
				dataMap.set(category, {
					category: category,
					sales_quantity: 0,
					total_sales: 0,
					refund_quantity: 0,
					refund_amount: 0,
					discounts: 0,
					net_sales: 0
				});
			}
			const data = dataMap.get(category);
			data.sales_quantity += parseInt(row.sales_quantity) || 0;
			data.total_sales += parseFloat(row.total_sales) || 0;
			data.refund_quantity += parseInt(row.refund_quantity) || 0;
			data.refund_amount += parseFloat(row.refund_amount) || 0;
			data.discounts += parseFloat(row.discounts) || 0;
			data.net_sales += parseFloat(row.net_sales) || 0;
		});

		// Convert map to array and sort by category
		const result = Array.from(dataMap.values()).sort((a, b) => {
			return a.category.localeCompare(b.category);
		});

		return result;
	}

	// Get goods sales report based on live orders only
	// Columns: id, goods, category, sales_quantity, discounts, net_sales, unit_cost, total_revenue, created_at, updated_at
	// Joins with categories table to get category name instead of ID
	// Note: Category IDs from old system (10009, 10004, etc.) don't match new system IDs (21-44)
	// So we match by looking up menu items to find their categories
	static async getGoodsSalesReport(startDate = null, endDate = null, branchId = null) {
		try {
			const orderParams = [];
			let orderDateFilter = '';
			let orderBranchFilter = '';

			if (startDate && endDate) {
				orderDateFilter = 'AND DATE(o.ENCODED_DT) BETWEEN ? AND ?';
				orderParams.push(startDate, endDate);
			}

			if (branchId) {
				orderBranchFilter = 'AND o.BRANCH_ID = ?';
				orderParams.push(branchId);
			}

			// Get data from actual orders (paid orders only)
			const ordersQuery = `
				SELECT 
					m.MENU_NAME as goods,
					COALESCE(c.CAT_NAME, 'Uncategorized') as category,
					COALESCE(SUM(oi.QTY), 0) as sales_quantity,
					COALESCE(SUM(oi.LINE_TOTAL), 0) as total_sales,
					0 as refund_quantity,
					0 as refund_amount,
					COALESCE(SUM(
						CASE 
							WHEN o.SUBTOTAL > 0 THEN (oi.LINE_TOTAL * o.DISCOUNT_AMOUNT / o.SUBTOTAL)
							ELSE 0
						END
					), 0) as discounts,
					COALESCE(SUM(
						oi.LINE_TOTAL - CASE 
							WHEN o.SUBTOTAL > 0 THEN (oi.LINE_TOTAL * o.DISCOUNT_AMOUNT / o.SUBTOTAL)
							ELSE 0
						END
					), 0) as net_sales,
					0 as unit_cost,
					COALESCE(SUM(
						oi.LINE_TOTAL - CASE 
							WHEN o.SUBTOTAL > 0 THEN (oi.LINE_TOTAL * o.DISCOUNT_AMOUNT / o.SUBTOTAL)
							ELSE 0
						END
					), 0) as total_revenue
				FROM orders o
				INNER JOIN billing b ON b.ORDER_ID = o.IDNo
				INNER JOIN order_items oi ON oi.ORDER_ID = o.IDNo
				INNER JOIN menu m ON m.IDNo = oi.MENU_ID
				LEFT JOIN categories c ON c.IDNo = m.CATEGORY_ID
				WHERE b.STATUS = 1
				${orderDateFilter}
				${orderBranchFilter}
				GROUP BY m.MENU_NAME, COALESCE(c.CAT_NAME, 'Uncategorized')
			`;
			const [orderRows] = await pool.execute(ordersQuery, orderParams);

			// Merge rows by goods name
			const dataMap = new Map();
			orderRows.forEach(row => {
				const goods = (row.goods || '').trim();
				if (!goods) return;
				if (!dataMap.has(goods)) {
					dataMap.set(goods, {
						id: null,
						goods: goods,
						category: row.category || 'Uncategorized',
						sales_quantity: 0,
						total_sales: 0,
						refund_quantity: 0,
						refund_amount: 0,
						discounts: 0,
						net_sales: 0,
						unit_cost: 0,
						total_revenue: 0,
						created_at: null
					});
				}
				const data = dataMap.get(goods);
				data.sales_quantity += parseInt(row.sales_quantity) || 0;
				data.total_sales += parseFloat(row.total_sales) || 0;
				data.refund_quantity += parseInt(row.refund_quantity) || 0;
				data.refund_amount += parseFloat(row.refund_amount) || 0;
				data.discounts += parseFloat(row.discounts) || 0;
				data.net_sales += parseFloat(row.net_sales) || 0;
				data.unit_cost += parseFloat(row.unit_cost) || 0;
				data.total_revenue += parseFloat(row.total_revenue) || 0;
			});

			// Convert map to array
			const allRows = Array.from(dataMap.values());

			const [menuItems] = await pool.execute(`
				SELECT m.MENU_NAME, c.CAT_NAME
				FROM menu m
				LEFT JOIN categories c ON c.IDNo = m.CATEGORY_ID
				WHERE m.ACTIVE = 1 AND c.CAT_NAME IS NOT NULL
			`);

			const goodsToCategoryMap = new Map();
			menuItems.forEach(item => {
				if (item.MENU_NAME && item.CAT_NAME) {
					const normalizedMenuName = item.MENU_NAME.trim().toLowerCase();
					const normalizedCategoryName = item.CAT_NAME.trim().replace(/\s+/g, ' ');
					goodsToCategoryMap.set(normalizedMenuName, normalizedCategoryName);
					goodsToCategoryMap.set(item.MENU_NAME.trim(), normalizedCategoryName);
				}
			});

			const [categories] = await pool.execute(`
				SELECT IDNo, CAT_NAME FROM categories WHERE ACTIVE = 1
			`);
			const categoryIdMap = new Map();
			categories.forEach(cat => {
				categoryIdMap.set(cat.IDNo.toString(), cat.CAT_NAME);
			});

			const mappedRows = allRows.map(row => {
				let categoryName = row.category;
				const goodsName = (row.goods || '').trim();

				if (categoryName && /^[0-9]+$/.test(categoryName.trim())) {
					if (goodsName && goodsToCategoryMap.has(goodsName)) {
						categoryName = goodsToCategoryMap.get(goodsName);
					} else if (goodsName) {
						const normalizedGoodsName = goodsName.toLowerCase();
						if (goodsToCategoryMap.has(normalizedGoodsName)) {
							categoryName = goodsToCategoryMap.get(normalizedGoodsName);
						} else {
							for (const [menuName, catName] of goodsToCategoryMap.entries()) {
								if (normalizedGoodsName.includes(menuName.toLowerCase()) ||
									menuName.toLowerCase().includes(normalizedGoodsName)) {
									categoryName = catName;
									break;
								}
							}
						}
					}
					if (/^[0-9]+$/.test(categoryName.trim()) && categoryIdMap.has(categoryName.trim())) {
						categoryName = categoryIdMap.get(categoryName.trim());
					}
				} else if (categoryName && !/^[0-9]+$/.test(categoryName.trim())) {
					categoryName = categoryName.trim().replace(/\s+/g, ' ');
					categoryName = categoryName.replace(/\s*-\s+/g, '-').replace(/\s+-\s*/g, '-');
				}

				return {
					...row,
					category: categoryName || 'Uncategorized'
				};
			});

			return mappedRows;
		} catch (error) {
			console.error('Error in getGoodsSalesReport:', error);
			throw error;
		}
	}

	// Get total sales per branch (from billing)
	static async getSalesPerBranch(startDate = null, endDate = null, branchId = null) {
		let dateFilterBilling = '';
		let branchFilterBilling = '';
		const billingParams = [];

		if (startDate && endDate) {
			// Cutoff branches only: business-day range; every other branch keeps the legacy DATE() condition.
			const billingCond = branchAwareDayCondition({
				branchColumn: 'b.BRANCH_ID',
				branchId,
				legacy: { sql: 'DATE(b.ENCODED_DT) >= ? AND DATE(b.ENCODED_DT) <= ?', params: [startDate, endDate] },
				business: (h) => ({
					sql: `b.ENCODED_DT >= DATE_ADD(?, INTERVAL ${h} HOUR) AND b.ENCODED_DT < DATE_ADD(DATE_ADD(?, INTERVAL 1 DAY), INTERVAL ${h} HOUR)`,
					params: [startDate, endDate],
				}),
			});
			dateFilterBilling = `AND ${billingCond.sql}`;
			billingParams.push(...billingCond.params);
		}

		if (branchId) {
			branchFilterBilling = 'AND br.IDNo = ?';
			billingParams.push(branchId);
		}

		// Get gross sales from billing + orders (paid + discount)
		const billingQuery = `
			SELECT 
				br.IDNo as branch_id,
				br.BRANCH_NAME as branch_name,
				br.BRANCH_CODE as branch_code,
				COALESCE(SUM(b.AMOUNT_PAID + COALESCE(o.DISCOUNT_AMOUNT, 0)), 0) as total_sales,
				COUNT(DISTINCT b.ORDER_ID) as order_count,
				CASE 
					WHEN COUNT(DISTINCT b.ORDER_ID) > 0 THEN COALESCE(SUM(b.AMOUNT_PAID + COALESCE(o.DISCOUNT_AMOUNT, 0)), 0) / COUNT(DISTINCT b.ORDER_ID)
					ELSE 0
				END as avg_order_value
			FROM branches br
			LEFT JOIN billing b ON b.BRANCH_ID = br.IDNo AND b.STATUS IN (1, 2) ${dateFilterBilling}
			LEFT JOIN orders o ON o.IDNo = b.ORDER_ID AND o.STATUS NOT IN (-1, -2)
			WHERE br.ACTIVE = 1 ${branchFilterBilling}
			GROUP BY br.IDNo, br.BRANCH_NAME, br.BRANCH_CODE
			ORDER BY total_sales DESC
		`;

		const [billingRows] = await pool.execute(billingQuery, billingParams);

		return billingRows.map((row) => ({
			branch_id: row.branch_id,
			branch_name: row.branch_name,
			branch_code: row.branch_code,
			total_sales: parseFloat(row.total_sales) || 0,
			order_count: parseInt(row.order_count) || 0,
			avg_order_value: parseFloat(row.avg_order_value) || 0,
		}));
	}

	/**
	 * Daily sales broken out by branch (day × branch).
	 * Fallback when PyServer daily-per-branch is unavailable.
	 */
	static async getDailySalesPerBranch(startDate = null, endDate = null, branchId = null) {
		const billingLocalDt = `COALESCE(
			CONVERT_TZ(b.ENCODED_DT, @@session.time_zone, '+08:00'),
			DATE_ADD(b.ENCODED_DT, INTERVAL 8 HOUR)
		)`;

		const saleDay = businessDateSql(billingLocalDt, 'b.BRANCH_ID');

		let dateFilter = '';
		const params = [];
		if (startDate && endDate) {
			// Same PH range as before for every branch; cutoff branches alone get their business-day shift.
			const range = phLocalDayRangeFilter('b.ENCODED_DT', startDate, endDate, 'b.BRANCH_ID');
			dateFilter = range.sql;
			params.push(...range.params);
		}

		let branchFilter = '';
		if (branchId) {
			branchFilter = 'AND br.IDNo = ?';
			params.push(branchId);
		}

		const query = `
			SELECT
				br.IDNo AS branch_id,
				br.BRANCH_NAME AS branch_name,
				DATE_FORMAT(${saleDay}, '%Y-%m-%d') AS sale_date,
				DAYNAME(${saleDay}) AS day_name,
				COALESCE(SUM(b.AMOUNT_PAID + COALESCE(o.DISCOUNT_AMOUNT, 0)), 0) AS total_sales,
				COALESCE(SUM(COALESCE(b.REFUND, 0)), 0) AS refund,
				COALESCE(SUM(COALESCE(o.DISCOUNT_AMOUNT, 0)), 0) AS discount,
				COALESCE(SUM(b.AMOUNT_PAID - COALESCE(b.REFUND, 0)), 0) AS net_sales,
				COUNT(DISTINCT b.ORDER_ID) AS order_count
			FROM branches br
			INNER JOIN billing b ON b.BRANCH_ID = br.IDNo AND b.STATUS IN (1, 2) ${dateFilter}
			INNER JOIN orders o ON o.IDNo = b.ORDER_ID AND o.STATUS NOT IN (-1, -2)
			WHERE br.ACTIVE = 1 ${branchFilter}
			GROUP BY br.IDNo, br.BRANCH_NAME, ${saleDay}
			HAVING sale_date IS NOT NULL
			ORDER BY br.BRANCH_NAME, sale_date
		`;

		const [rows] = await pool.execute(query, params);
		return (rows || []).map((row) => ({
			branch_id: Number(row.branch_id),
			branch_name: String(row.branch_name || ''),
			sale_date: String(row.sale_date || '').slice(0, 10),
			day_name: String(row.day_name || ''),
			total_sales: Number(row.total_sales) || 0,
			refund: Number(row.refund) || 0,
			discount: Number(row.discount) || 0,
			net_sales: Number(row.net_sales) || 0,
			order_count: Number(row.order_count) || 0,
		}));
	}

	// Get least selling menu items (items with fewest orders, excluding zero) from paid orders.
	static async getLeastSellingItems(startDate = null, endDate = null, branchId = null, limit = 5) {
		try {
			let orderDateFilter = '';
			let orderBranchFilter = '';
			const orderParams = [];

			if (startDate && endDate) {
				orderDateFilter = 'AND DATE(o.ENCODED_DT) BETWEEN ? AND ?';
				orderParams.push(startDate, endDate);
			}
			if (branchId) {
				orderBranchFilter = 'AND o.BRANCH_ID = ?';
				orderParams.push(branchId);
			}

			const ordersQuery = `
				SELECT 
					m.MENU_NAME as name,
					COALESCE(c.CAT_NAME, 'Uncategorized') as category,
					COALESCE(SUM(oi.QTY), 0) as total_quantity,
					COALESCE(SUM(oi.LINE_TOTAL), 0) as total_revenue,
					m.MENU_PRICE
				FROM orders o
				INNER JOIN billing b ON b.ORDER_ID = o.IDNo
				INNER JOIN order_items oi ON oi.ORDER_ID = o.IDNo
				INNER JOIN menu m ON m.IDNo = oi.MENU_ID
				LEFT JOIN categories c ON c.IDNo = m.CATEGORY_ID
				WHERE b.STATUS = 1
				${orderDateFilter}
				${orderBranchFilter}
				GROUP BY m.IDNo, m.MENU_NAME, m.MENU_PRICE, c.CAT_NAME
				HAVING total_quantity > 0
			`;

			const [orderRows] = await pool.execute(ordersQuery, orderParams);

			// Merge rows by product name
			const dataMap = new Map();
			orderRows.forEach(row => {
				const name = (row.name || '').trim();
				if (!name) return;
				if (!dataMap.has(name)) {
					dataMap.set(name, {
						name,
						category: row.category || 'Uncategorized',
						total_quantity: 0,
						total_revenue: 0,
						price: parseFloat(row.MENU_PRICE) || 0,
					});
				}
				const data = dataMap.get(name);
				data.total_quantity += parseInt(row.total_quantity) || 0;
				data.total_revenue += parseFloat(row.total_revenue) || 0;
				if (row.MENU_PRICE) data.price = parseFloat(row.MENU_PRICE) || data.price;
			});

			// Convert to array, filter > 0, sort by least quantity, limit
			const result = Array.from(dataMap.values())
				.filter(item => item.total_quantity > 0)
				.sort((a, b) => a.total_quantity - b.total_quantity || a.total_revenue - b.total_revenue)
				.slice(0, limit)
				.map((item, idx) => ({
					IDNo: idx + 1,
					MENU_NAME: item.name,
					MENU_PRICE: item.price,
					category: item.category,
					total_quantity: item.total_quantity,
					order_count: item.total_quantity,
					total_revenue: item.total_revenue,
				}));

			return result;
		} catch (error) {
			console.error('Error in getLeastSellingItems:', error);
			throw error;
		}
	}
}

module.exports = ReportsModel;
