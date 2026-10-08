const ExpenseModel = require('../models/expenseModel');

class ExpenseIngestionService {
	static _stockInSourceType(resourceType) {
		return resourceType === 'material' ? 'material_stock_in_txn' : 'product_stock_in_txn';
	}

	static _toNumber(value) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	static async syncProductExpense(product, userId = null) {
		if (!product || !product.IDNo || !product.BRANCH_ID) return;
		const amount = ExpenseIngestionService._toNumber(product.PRICE) * ExpenseIngestionService._toNumber(product.STOCK);
		await ExpenseModel.upsertAutoExpense({
			branchId: product.BRANCH_ID,
			expenseDate: new Date(),
			category: 'Products',
			categoryType: 'Inventory',
			subCategory: 'Products',
			sourceType: 'product_stock_in',
			sourceRefId: String(product.IDNo),
			description: `Auto expense for product inventory: ${product.PRODUCT_NAME || 'Unknown Product'}`,
			amount,
			userId,
		});
	}

	static async syncMaterialExpense(material, userId = null) {
		if (!material || !material.IDNo || !material.BRANCH_ID) return;
		const amount = ExpenseIngestionService._toNumber(material.UNIT_COST) * ExpenseIngestionService._toNumber(material.STOCK);
		await ExpenseModel.upsertAutoExpense({
			branchId: material.BRANCH_ID,
			expenseDate: new Date(),
			category: 'Materials',
			categoryType: 'Inventory',
			subCategory: 'Materials',
			sourceType: 'material_stock_in',
			sourceRefId: String(material.IDNo),
			description: `Auto expense for material inventory: ${material.MATERIAL_NAME || 'Unknown Material'}`,
			amount,
			userId,
		});
	}

	static async disableProductExpense(productId, userId = null) {
		if (!productId) return;
		await ExpenseModel.disableAutoExpense('product_stock_in', String(productId), userId);
	}

	static async disableMaterialExpense(materialId, userId = null) {
		if (!materialId) return;
		await ExpenseModel.disableAutoExpense('material_stock_in', String(materialId), userId);
	}

	static async recordStockInExpense(stockIn, userId = null) {
		if (!stockIn || !stockIn.stockInId || !stockIn.branchId) return;
		const isMaterial = stockIn.resourceType === 'material';
		const sourceType = ExpenseIngestionService._stockInSourceType(stockIn.resourceType);
		await ExpenseModel.upsertAutoExpense({
			branchId: Number(stockIn.branchId),
			expenseDate: stockIn.stockInDate || new Date(),
			category: isMaterial ? 'Materials' : 'Products',
			categoryType: 'Inventory',
			subCategory: isMaterial ? 'Materials' : 'Products',
			sourceType,
			sourceRefId: String(stockIn.stockInId),
			description: `Stock-in: ${stockIn.resourceName || (isMaterial ? 'Material' : 'Product')} (${stockIn.qtyAdded || 0} x ${stockIn.unitCost || 0})`,
			amount: ExpenseIngestionService._toNumber(stockIn.totalCost),
			userId,
		});
	}

	static async disableStockInExpense(stockInId, resourceType = null, userId = null) {
		if (!stockInId) return;
		if (resourceType === 'material' || resourceType === 'product') {
			await ExpenseModel.disableAutoExpense(
				ExpenseIngestionService._stockInSourceType(resourceType),
				String(stockInId),
				userId
			);
			return;
		}
		await ExpenseModel.disableAutoExpense('material_stock_in_txn', String(stockInId), userId);
		await ExpenseModel.disableAutoExpense('product_stock_in_txn', String(stockInId), userId);
	}
}

module.exports = ExpenseIngestionService;
