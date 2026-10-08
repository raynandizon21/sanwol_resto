/**
 * Net sales = total_sales - refund - discount (matches branch dashboard & Sales Analytics).
 */
function resolveNetSalesFromRow(row) {
	if (!row || typeof row !== 'object') return 0;
	const netRaw = row.net_sales;
	if (netRaw != null && Number.isFinite(Number(netRaw))) {
		return Math.max(0, Number(netRaw));
	}
	const total = Number(row.total_sales ?? row.revenue ?? 0) || 0;
	const refund = Number(row.refund ?? 0) || 0;
	const discount = Number(row.discount ?? 0) || 0;
	return Math.max(0, total - refund - discount);
}

function sumNetSalesFromDailyRows(rows) {
	return (rows || []).reduce((sum, row) => sum + resolveNetSalesFromRow(row), 0);
}

module.exports = {
	resolveNetSalesFromRow,
	sumNetSalesFromDailyRows,
};
