// ============================================
// BILLING CONTROLLER
// ============================================
// File: controllers/billingController.js
// Description: Handles billing operations and APIs
// ============================================

const BillingModel = require('../models/billingModel');
const OrderModel = require('../models/orderModel');
const TableModel = require('../models/tableModel');
const OrderItemsModel = require('../models/orderItemsModel');
const InventoryDeductionModel = require('../models/inventoryDeductionModel');
const ReportsModel = require('../models/reportsModel');
const socketService = require('../utils/socketService');
const ApiResponse = require('../utils/apiResponse');

class BillingController {

	static async getAll(req, res) {
		try {
			let branchId = null;

			// Admin (permissions = 1): by default can see ALL branches,
			// but respect explicit branch_id when provided.
			const isAdmin = req.user?.permissions === 1 || req.session?.permissions === 1;
			if (isAdmin) {
				const raw = req.query.branch_id || req.body.branch_id || null;
				branchId = raw === 'all' || raw === '' ? null : raw;
			} else {
				// Non-admin: always scoped to their branch (session/user),
				// optionally narrowed further by explicit branch_id if provided.
				const raw =
					req.query.branch_id ||
					req.body.branch_id ||
					req.session?.branch_id ||
					req.user?.branch_id ||
					null;
				branchId = raw === 'all' || raw === '' ? null : raw;
			}

			const { start_date, end_date, limit, include_stats } = req.query;
			const opts = {
				start_date: start_date || null,
				end_date: end_date || null,
				limit: limit || null,
			};
			const wantStats = include_stats === '1' || include_stats === 'true';
			const [billings, stats] = await Promise.all([
				BillingModel.getAll(branchId, opts),
				wantStats ? BillingModel.getListStats(branchId, opts) : Promise.resolve(null),
			]);
			if (wantStats) {
				return res.status(200).json({
					success: true,
					message: 'Billing records retrieved successfully',
					data: billings,
					meta: { stats, limit: billings.length },
				});
			}
			return ApiResponse.success(res, billings, 'Billing records retrieved successfully');
		} catch (error) {
			console.error('Error fetching billing records:', error);
			return ApiResponse.error(res, 'Failed to fetch billing records', 500, error.message);
		}
	}

	static async getByOrderId(req, res) {
		try {
			const { orderId } = req.params;
			const billing = await BillingModel.getByOrderId(orderId);
			if (!billing) {
				return ApiResponse.notFound(res, 'Billing record');
			}
			return ApiResponse.success(res, billing, 'Billing record retrieved successfully');
		} catch (error) {
			console.error('Error fetching billing record:', error);
			return ApiResponse.error(res, 'Failed to fetch billing record', 500, error.message);
		}
	}

	static async getPaymentHistory(req, res) {
		try {
			const { orderId } = req.params;
			const rows = await BillingModel.getPaymentHistory(orderId);
			return ApiResponse.success(res, rows, 'Payment history retrieved successfully');
		} catch (error) {
			console.error('Error fetching payment history:', error);
			return ApiResponse.error(res, 'Failed to fetch payment history', 500, error.message);
		}
	}

	static async updateBilling(req, res) {
		try {
			const { id } = req.params; // ORDER_ID
			const {
				payment_method,
				amount_paid, // Ito ang bagong bayad (e.g., 70)
				payment_ref
			} = req.body;

			const billing = await BillingModel.getByOrderId(id);
			if (!billing) {
				return ApiResponse.notFound(res, 'Billing record');
			}

			const amountPaidNow = parseFloat(amount_paid) || 0;
			const currentTotalPaid = parseFloat(billing.AMOUNT_PAID) || 0;
			const newTotalPaid = currentTotalPaid + amountPaidNow;
			const amountDue = parseFloat(billing.AMOUNT_DUE);

			// Auto-calculate Status base sa balance
			let newStatus = 3; // Unpaid
			if (newTotalPaid >= amountDue) {
				newStatus = 1; // Paid
			} else if (newTotalPaid > 0) {
				newStatus = 2; // Partial
			}

			// 1. I-update ang main billing record (Accumulate Amount Paid)
			await BillingModel.updateForOrder(id, {
				payment_method: payment_method || billing.PAYMENT_METHOD,
				amount_paid: newTotalPaid,
				payment_ref: payment_ref || billing.PAYMENT_REF,
				status: newStatus
			});

			// 2. I-record ang transaction history
			await BillingModel.recordTransaction({
				order_id: id,
				payment_method: payment_method || billing.PAYMENT_METHOD || 'CASH',
				amount_paid: amountPaidNow,
				payment_ref: payment_ref,
				user_id: req.session.user_id
			});

			// 3. CONNECTED TABLES LOGIC:
			const order = await OrderModel.getById(id);
			if (order) {
				if (newStatus === 1) {
					// FULLY PAID: Mark Order as SETTLED (1), update inventory_deductions, and Table as AVAILABLE (1)
					await InventoryDeductionModel.updateStatusByOrderId(Number(id), 1, req.session.user_id);
					await OrderModel.updateStatus(id, 1, req.session.user_id);
					if (order.TABLE_ID) {
						await TableModel.updateStatus(order.TABLE_ID, 1);
					}
				} else if (newStatus === 2) {
					// PARTIAL PAID: Mark Order as CONFIRMED (2)
					await OrderModel.updateStatus(id, 2, req.session.user_id);
				}

				// Emit socket event for order status update
				const updatedOrder = await OrderModel.getById(id);
				const orderItems = await OrderItemsModel.getByOrderId(id);
				socketService.emitOrderUpdate(id, {
					order_id: id,
					order_no: updatedOrder.ORDER_NO,
					table_id: updatedOrder.TABLE_ID,
					order_type: updatedOrder.ORDER_TYPE,
					status: updatedOrder.STATUS,
					grand_total: updatedOrder.GRAND_TOTAL,
					items: orderItems
				});
			}

			return ApiResponse.success(res, { status: newStatus }, 'Billing record updated successfully');
		} catch (error) {
			console.error('Error updating billing record:', error);
			return ApiResponse.error(res, 'Failed to update billing record', 500, error.message);
		}
	}

	// Create billing record manually (standalone)
	static async create(req, res) {
		try {
			const {
				order_id,
				payment_method,
				amount_due,
				amount_paid,
				payment_ref,
				status
			} = req.body;

			if (!order_id) {
				return ApiResponse.badRequest(res, 'Order ID is required');
			}

			// Check if billing already exists for this order
			const existing = await BillingModel.getByOrderId(order_id);
			if (existing) {
				return ApiResponse.error(res, 'Billing record already exists for this order', 409);
			}

			// Get order to get branch_id
			const order = await OrderModel.getById(order_id);
			if (!order) {
				return ApiResponse.notFound(res, 'Order');
			}

			const user_id = req.session.user_id || req.user?.user_id;

			await BillingModel.createForOrder({
				branch_id: order.BRANCH_ID,
				order_id: order_id,
				payment_method: payment_method || 'CASH',
				amount_due: amount_due || order.GRAND_TOTAL || 0,
				amount_paid: amount_paid || 0,
				payment_ref: payment_ref || null,
				status: status || 3,
				user_id: user_id,
				encoded_dt: order.ENCODED_DT || null,
			});

			return ApiResponse.created(res, { order_id: parseInt(order_id) }, 'Billing record created successfully');
		} catch (error) {
			console.error('Error creating billing record:', error);
			return ApiResponse.error(res, 'Failed to create billing record', 500, error.message);
		}
	}
}

module.exports = BillingController;
