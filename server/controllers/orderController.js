// ============================================
// ORDER CONTROLLER
// ============================================
// File: controllers/orderController.js
// Description: Handles order-related pages and APIs
// ============================================

const OrderModel = require('../models/orderModel');
const OrderItemsModel = require('../models/orderItemsModel');
const BillingModel = require('../models/billingModel');
const TableModel = require('../models/tableModel');
const UserBranchModel = require('../models/userBranchModel');
const NotificationModel = require('../models/notificationModel');
const InventoryDeductionService = require('../services/inventoryDeductionService');
const InventoryDeductionModel = require('../models/inventoryDeductionModel');
const socketService = require('../utils/socketService');
const ApiResponse = require('../utils/apiResponse');

class OrderController {

	static async getAll(req, res) {
		try {
			// Prioritize query param so the frontend branch selector works for admin
			const rawBranch = req.query.branch_id ?? req.body.branch_id ?? req.session?.branch_id ?? req.user?.branch_id ?? null;
			// If 'all' is passed, fetch orders for ALL branches (admin view)
			const branchId = (rawBranch === 'all' || rawBranch === '') ? null : rawBranch;
			const { start_date, end_date, limit, include_item_meta, include_stats } = req.query;
			const opts = {
				start_date: start_date || null,
				end_date: end_date || null,
				limit: limit || null,
				includeItemMeta: include_item_meta === '1' || include_item_meta === 'true',
			};
			const wantStats = include_stats === '1' || include_stats === 'true';
			const [orders, stats] = await Promise.all([
				OrderModel.getAll(branchId, opts),
				wantStats ? OrderModel.getListStats(branchId, opts) : Promise.resolve(null),
			]);
			if (wantStats) {
				return res.status(200).json({
					success: true,
					message: 'Orders retrieved successfully',
					data: orders,
					meta: { stats, limit: orders.length },
				});
			}
			return ApiResponse.success(res, orders, 'Orders retrieved successfully');
		} catch (error) {
			console.error('Error fetching orders:', error);
			return ApiResponse.error(res, 'Failed to fetch orders', 500, error.message);
		}
	}

	static async getById(req, res) {
		try {
			const { id } = req.params;
			const order = await OrderModel.getById(id);
			if (!order) {
				return ApiResponse.notFound(res, 'Order');
			}
			return ApiResponse.success(res, order, 'Order retrieved successfully');
		} catch (error) {
			console.error('Error fetching order:', error);
			return ApiResponse.error(res, 'Failed to fetch order', 500, error.message);
		}
	}

	static async create(req, res) {
		try {
			// Match manual-settled / admin UX: admins may set BRANCH_ID in body (e.g. receipt order, URL ?branchId=).
			// Non-admins always use session/user branch (ignore forged body.branch_id).
			const isAdmin = req.user?.permissions === 1 || req.session?.permissions === 1;
			const explicitBranchIdRaw = req.body?.BRANCH_ID ?? req.body?.branch_id ?? null;
			const sessionBranchIdRaw = req.session?.branch_id ?? req.user?.branch_id ?? req.query?.branch_id ?? null;
			const branchId =
				isAdmin &&
				explicitBranchIdRaw != null &&
				String(explicitBranchIdRaw).trim() !== '' &&
				String(explicitBranchIdRaw) !== 'all'
					? explicitBranchIdRaw
					: sessionBranchIdRaw;
			if (!branchId || String(branchId).trim() === '' || String(branchId) === 'all') {
				return ApiResponse.badRequest(res, 'Branch ID is required. Please select a branch first.');
			}

			const items = Array.isArray(req.body.ORDER_ITEMS) ? req.body.ORDER_ITEMS : (Array.isArray(req.body.items) ? req.body.items : []);
			if (items.length) {
				const validation = await InventoryDeductionService.validateOrderItemsForInventory(branchId, items);
				if (!validation.valid) {
					return res.status(200).json({
						success: false,
						error: 'Insufficient inventory for order items',
						insufficient: validation.insufficient,
					});
				}
			}

			const payload = {
				BRANCH_ID: branchId,
				ORDER_NO: String(req.body.ORDER_NO || '').trim(),
				TABLE_ID: req.body.TABLE_ID,
				ORDER_TYPE: req.body.ORDER_TYPE,
				STATUS: parseInt(req.body.STATUS) || 3,
				SUBTOTAL: parseFloat(req.body.SUBTOTAL) || 0,
				TAX_AMOUNT: parseFloat(req.body.TAX_AMOUNT) || 0,
				SERVICE_CHARGE: parseFloat(req.body.SERVICE_CHARGE) || 0,
				DISCOUNT_AMOUNT: parseFloat(req.body.DISCOUNT_AMOUNT) || 0,
				GRAND_TOTAL: parseFloat(req.body.GRAND_TOTAL) || 0,
				user_id: req.session.user_id || req.user?.user_id
			};

			if (!payload.ORDER_NO) {
				return ApiResponse.badRequest(res, 'Order number is required');
			}

			const existingOrder = await OrderModel.findLatestByOrderNo(payload.BRANCH_ID, payload.ORDER_NO);
			if (existingOrder) {
				return ApiResponse.badRequest(
					res,
					`Order #${payload.ORDER_NO} already exists. Please use a different order number.`
				);
			}

			// A table can only have one open order at a time. Creating a second one here
			// would also re-stamp the table's Room Charge onto it (see resolveServiceChargeWithRoomCharge),
			// double-billing the guest. Callers should append to the existing order instead.
			if (payload.TABLE_ID) {
				const activeTableOrder = await OrderModel.getActiveByTable(payload.BRANCH_ID, payload.TABLE_ID);
				if (activeTableOrder) {
					return res.status(409).json({
						success: false,
						error: `This table already has an active order (#${activeTableOrder.ORDER_NO}). Add items to that order instead of creating a new one.`,
						code: 'ACTIVE_ORDER_EXISTS',
						existing_order_id: activeTableOrder.IDNo,
						existing_order_no: activeTableOrder.ORDER_NO,
					});
				}
			}

			payload.SERVICE_CHARGE = await OrderModel.resolveServiceChargeWithRoomCharge(payload.TABLE_ID, req.body.SERVICE_CHARGE);
			payload.GRAND_TOTAL = OrderModel.computeGrandTotal(
				payload.SUBTOTAL,
				payload.TAX_AMOUNT,
				payload.SERVICE_CHARGE,
				payload.DISCOUNT_AMOUNT
			);

			const orderId = await OrderModel.create(payload);
			if (items.length) {
				await OrderItemsModel.createForOrder(orderId, items, req.session.user_id);
			}
			await BillingModel.createForOrder({
				branch_id: payload.BRANCH_ID,
				order_id: orderId,
				amount_due: payload.GRAND_TOTAL,
				amount_paid: 0,
				status: 3,
				user_id: req.session.user_id || req.user?.user_id
			});

			// Update table status to Occupied (2) if a table is assigned
			if (payload.TABLE_ID) {
				await TableModel.updateStatus(payload.TABLE_ID, 2);
			}

			// Get full order data with items for socket emission
			const fullOrder = await OrderModel.getById(orderId);
			const orderItems = await OrderItemsModel.getByOrderId(orderId);

			// Emit socket event for order creation
			// encoded_by lets clients tell whether THEY created this order, so the
			// "New Order Received" alert only fires for other staff, not the creator.
			socketService.emitOrderCreated(orderId, {
				order_id: orderId,
				order_no: payload.ORDER_NO,
				table_id: payload.TABLE_ID,
				floor: fullOrder?.FLOOR || null,
				status: payload.STATUS,
				grand_total: payload.GRAND_TOTAL,
				items: orderItems,
				items_count: items.length,
				encoded_by: req.session?.user_id || req.user?.user_id || null,
				branch_id: parseInt(payload.BRANCH_ID) || null
			});

			// Notify the user who created the order (branch-scoped)
			const notifyUserId = req.session?.user_id || req.user?.user_id;
			const branchIdForNotif = parseInt(payload.BRANCH_ID, 10);
			const validBranchId = Number.isFinite(branchIdForNotif) ? branchIdForNotif : 1;
			if (!notifyUserId) {
				console.warn('[ORDER] No user_id for notification (req.user?.user_id missing?). Order #' + payload.ORDER_NO);
			} else {
				try {
					const created = await NotificationModel.create({
						user_id: notifyUserId,
						branch_id: validBranchId,
						title: 'New Order',
						message: `Order #${payload.ORDER_NO} created. Total: ₱${Number(payload.GRAND_TOTAL).toLocaleString()}`,
						type: 'order',
						link: null
					});
					console.log('[ORDER] Notification created for user_id=' + notifyUserId + ', branch_id=' + validBranchId + ', order #' + payload.ORDER_NO);
					// Real-time: emit to user's socket room so bell updates immediately
					if (created && created.insertId) {
						const notificationPayload = {
							id: created.insertId,
							userId: notifyUserId,
							branchId: validBranchId,
							title: 'New Order',
							message: `Order #${payload.ORDER_NO} created. Total: ₱${Number(payload.GRAND_TOTAL).toLocaleString()}`,
							type: 'order',
							link: null,
							isRead: false,
							createdAt: (created.createdAt && created.createdAt.toISOString) ? created.createdAt.toISOString() : new Date().toISOString()
						};
						socketService.emitNotificationCreated(notifyUserId, notificationPayload);
					}
				} catch (notifErr) {
					if (notifErr.code === 'ER_NO_SUCH_TABLE' || notifErr.errno === 1146) {
						console.warn('[ORDER] Notifications table missing. Run: restoBackend/scripts/migrations/2026-02-11-notifications-table.sql');
					} else {
						console.error('[ORDER] Notification create failed:', notifErr.message || notifErr);
					}
				}
			}

			return ApiResponse.created(res, { id: orderId, order_no: payload.ORDER_NO }, 'Order created successfully');
		} catch (error) {
			console.error('Error creating order:', error);
			return ApiResponse.error(res, 'Failed to create order', 500, error.message);
		}
	}

	/**
	 * Manual order: create order that is immediately SETTLED.
	 * This bypasses the Billing UI flow by:
	 * - creating order + order_items
	 * - validating and deducting inventory (same as CONFIRMED flow)
	 * - setting order status to SETTLED (1)
	 * - creating/updating billing record as PAID (1) with amount_paid = amount_due
	 * - recording a billing transaction row
	 * - syncing reports tables (best-effort)
	 */
	static async createManualSettled(req, res) {
		let createdOrderId = null;
		let actorUserId = req.session?.user_id || req.user?.user_id || null;
		try {
			const userId = req.session?.user_id || req.user?.user_id;
			// Branch resolution:
			// - Admin (permissions=1): allow explicit branch_id from body to override session branch.
			// - Non-admin: allow explicit branch_id ONLY if user is assigned to that branch.
			const isAdmin = req.user?.permissions === 1 || req.session?.permissions === 1;
			const explicitBranchIdRaw = req.body?.BRANCH_ID ?? req.body?.branch_id ?? null;
			const sessionBranchIdRaw = req.session?.branch_id ?? req.user?.branch_id ?? req.query?.branch_id ?? null;
			const explicitBranchId =
				explicitBranchIdRaw != null && String(explicitBranchIdRaw).trim() !== '' && String(explicitBranchIdRaw) !== 'all'
					? String(explicitBranchIdRaw).trim()
					: null;
			let resolvedBranchId = sessionBranchIdRaw;
			if (explicitBranchId) {
				if (isAdmin) {
					resolvedBranchId = explicitBranchId;
				} else if (userId) {
					// Only allow if the user is assigned to this branch.
					const branches = await UserBranchModel.getBranchesByUserId(userId);
					const allowed = Array.isArray(branches) && branches.some((b) => String(b?.IDNo) === explicitBranchId);
					if (allowed) {
						resolvedBranchId = explicitBranchId;
					}
				}
			}

			// Fallback for JWT/session payloads that don't include branch_id:
			// 1) infer from selected table
			// 2) infer from user's assigned branch
			if (!resolvedBranchId) {
				const tableIdRaw = req.body?.TABLE_ID ?? req.body?.table_id ?? null;
				if (tableIdRaw != null && String(tableIdRaw).trim() !== '') {
					const table = await TableModel.getById(tableIdRaw);
					if (table?.BRANCH_ID) resolvedBranchId = table.BRANCH_ID;
				}
			}
			if (!resolvedBranchId && userId) {
				const branches = await UserBranchModel.getBranchesByUserId(userId);
				if (Array.isArray(branches) && branches.length > 0 && branches[0]?.IDNo) {
					resolvedBranchId = branches[0].IDNo;
				}
			}

			if (!resolvedBranchId) {
				return ApiResponse.badRequest(res, 'Branch ID is required. Please select a branch first.');
			}

			const items = Array.isArray(req.body.ORDER_ITEMS)
				? req.body.ORDER_ITEMS
				: (Array.isArray(req.body.items) ? req.body.items : []);
			if (!items.length) {
				// Allow "room charge only" orders (no menu items) when the selected table has a room charge.
				const tableIdRaw = req.body?.TABLE_ID ?? req.body?.table_id ?? null;
				const tableId = tableIdRaw != null && String(tableIdRaw).trim() !== '' ? Number(tableIdRaw) : null;
				if (!tableId || !Number.isFinite(tableId)) {
					return ApiResponse.badRequest(res, 'At least one order item is required');
				}

				const table = await TableModel.getById(tableId);
				const roomCharge = table ? parseFloat(table.ROOM_CHARGE) : 0;
				if (!Number.isFinite(roomCharge) || roomCharge <= 0) {
					return ApiResponse.badRequest(res, 'At least one order item is required');
				}
			}

			actorUserId = userId || actorUserId;
			const paymentMethod = (req.body.payment_method || req.body.PAYMENT_METHOD || 'CASH');
			const paymentRef = req.body.payment_ref || req.body.PAYMENT_REF || 'Manual order (settled)';

			// Validate inventory against the full items list (same as create).
			// If there are no items (room charge only), skip validation.
			if (items.length) {
				const validation = await InventoryDeductionService.validateOrderItemsForInventory(resolvedBranchId, items);
				if (!validation.valid) {
					return res.status(200).json({
						success: false,
						error: 'Insufficient inventory for order items',
						insufficient: validation.insufficient,
					});
				}
			}

			const payload = {
				BRANCH_ID: resolvedBranchId,
				ORDER_NO: (req.body.ORDER_NO || req.body.order_no || '').trim(),
				TABLE_ID: req.body.TABLE_ID ?? req.body.table_id ?? null,
				ORDER_TYPE: req.body.ORDER_TYPE ?? req.body.order_type ?? null,
				ENCODED_DT: req.body.ENCODED_DT ?? req.body.encoded_dt ?? null,
				// Manual orders should be persisted as SETTLED immediately.
				STATUS: 1,
				SUBTOTAL: parseFloat(req.body.SUBTOTAL ?? req.body.subtotal) || 0,
				TAX_AMOUNT: parseFloat(req.body.TAX_AMOUNT ?? req.body.tax_amount) || 0,
				SERVICE_CHARGE: parseFloat(req.body.SERVICE_CHARGE ?? req.body.service_charge) || 0,
				DISCOUNT_AMOUNT: parseFloat(req.body.DISCOUNT_AMOUNT ?? req.body.discount_amount) || 0,
				GRAND_TOTAL: parseFloat(req.body.GRAND_TOTAL ?? req.body.grand_total) || 0,
				user_id: userId,
			};

			if (!payload.ORDER_NO) {
				return ApiResponse.badRequest(res, 'Order number is required');
			}

			// Same guard as create(): don't let a manual order create a second open
			// order (and a second Room Charge) for a table that already has one.
			if (payload.TABLE_ID) {
				const activeTableOrder = await OrderModel.getActiveByTable(payload.BRANCH_ID, payload.TABLE_ID);
				if (activeTableOrder) {
					return res.status(409).json({
						success: false,
						error: `This table already has an active order (#${activeTableOrder.ORDER_NO}). Add items to that order instead of creating a new one.`,
						code: 'ACTIVE_ORDER_EXISTS',
						existing_order_id: activeTableOrder.IDNo,
						existing_order_no: activeTableOrder.ORDER_NO,
					});
				}
			}

			payload.SERVICE_CHARGE = await OrderModel.resolveServiceChargeWithRoomCharge(
				payload.TABLE_ID,
				req.body.SERVICE_CHARGE ?? req.body.service_charge
			);
			payload.GRAND_TOTAL = OrderModel.computeGrandTotal(
				payload.SUBTOTAL,
				payload.TAX_AMOUNT,
				payload.SERVICE_CHARGE,
				payload.DISCOUNT_AMOUNT
			);

			// Idempotency/safety guard:
			// if the same manual order number already exists in this branch and is already
			// settled, return that record instead of creating a duplicate.
			const existingOrder = await OrderModel.findLatestByOrderNo(payload.BRANCH_ID, payload.ORDER_NO);
			if (existingOrder) {
				if (Number(existingOrder.STATUS) === 1) {
					return ApiResponse.success(
						res,
						{ id: Number(existingOrder.IDNo), order_no: payload.ORDER_NO, status: 1 },
						'Manual order already exists and is settled'
					);
				}
				return ApiResponse.badRequest(
					res,
					`Order #${payload.ORDER_NO} already exists. Please use a different order number.`
				);
			}

			// Normalize items to match expected schema in OrderItemsModel
			const itemsNormalized = items.map((it) => {
				const qty = Number(it.qty ?? it.QTY) || 1;
				const unitPrice = Number(it.unit_price ?? it.UNIT_PRICE) || 0;
				return {
					menu_id: Number(it.menu_id ?? it.MENU_ID),
					qty,
					unit_price: unitPrice,
					line_total: Number(it.line_total ?? it.LINE_TOTAL) || (qty * unitPrice),
					status: it.status != null ? Number(it.status) : 3,
					remarks: it.remarks ?? it.REMARKS ?? null,
				};
			});

			const orderId = await OrderModel.create(payload);
			createdOrderId = Number(orderId);
			await OrderItemsModel.createForOrder(orderId, itemsNormalized, userId, payload.ENCODED_DT ?? null);

			const billingEncodedDt =
				payload.ENCODED_DT != null && String(payload.ENCODED_DT).trim() !== ''
					? payload.ENCODED_DT
					: null;

			// Deduct inventory entries are created by the shared deduction flow.
			// Then align deductions to settled status for reporting consistency.
			await InventoryDeductionService.deductOnOrderConfirmed(Number(orderId), userId);
			await InventoryDeductionModel.updateStatusByOrderId(Number(orderId), 1, userId);

			// Billing: create or update to PAID
			const amountDue = Number(payload.GRAND_TOTAL) || 0;
			const existingBilling = await BillingModel.getByOrderId(orderId);
			if (existingBilling) {
				await BillingModel.updateForOrder(orderId, {
					status: 1,
					amount_due: amountDue,
					amount_paid: amountDue,
					payment_method: paymentMethod,
					payment_ref: paymentRef || null,
					encoded_dt: billingEncodedDt,
				});
			} else {
				await BillingModel.createForOrder({
					branch_id: payload.BRANCH_ID,
					order_id: orderId,
					payment_method: paymentMethod,
					amount_due: amountDue,
					amount_paid: amountDue,
					payment_ref: paymentRef || null,
					status: 1,
					user_id: userId,
					encoded_dt: billingEncodedDt,
				});
			}

			try {
				await BillingModel.recordTransaction({
					order_id: orderId,
					payment_method: paymentMethod,
					amount_paid: amountDue,
					payment_ref: paymentRef || null,
					user_id: userId,
					encoded_dt: billingEncodedDt,
				});
			} catch (e) {
				console.error('[MANUAL ORDER] Failed to record billing transaction:', e?.message || e);
			}

			// Table becomes AVAILABLE immediately (since settled)
			if (payload.TABLE_ID) {
				try {
					await TableModel.updateStatus(payload.TABLE_ID, 1);
				} catch (e) {
					console.error('[MANUAL ORDER] Failed to update table status:', e?.message || e);
				}
			}

			// Emit socket event for order creation + settled status
			try {
				const orderItems = await OrderItemsModel.getByOrderId(orderId);
				socketService.emitOrderCreated(orderId, {
					order_id: orderId,
					order_no: payload.ORDER_NO,
					table_id: payload.TABLE_ID,
					status: 1,
					grand_total: payload.GRAND_TOTAL,
					items: orderItems,
					items_count: itemsNormalized.length,
					branch_id: parseInt(payload.BRANCH_ID) || null
				});
			} catch (e) {
				console.error('[MANUAL ORDER] Socket emit failed:', e?.message || e);
			}

			return ApiResponse.created(
				res,
				{ id: orderId, order_no: payload.ORDER_NO, status: 1 },
				'Manual order created and settled successfully'
			);
		} catch (error) {
			console.error('Error creating manual settled order:', error);
			// Safety net: avoid leaving half-created manual orders stuck at CONFIRMED.
			if (createdOrderId) {
				try {
					await OrderModel.updateStatus(createdOrderId, -1, actorUserId);
					await InventoryDeductionModel.updateStatusByOrderId(createdOrderId, -1, actorUserId);
				} catch (cleanupError) {
					console.error('[MANUAL ORDER] Cleanup failed after error:', cleanupError?.message || cleanupError);
				}
			}
			return ApiResponse.error(res, 'Failed to create manual settled order', 500, error.message);
		}
	}

	static async update(req, res) {
		try {
			const { id } = req.params;
			const oldOrder = await OrderModel.getById(id);
			if (!oldOrder) {
				return res.status(404).json({ error: 'Order not found' });
			}

			const effectiveTableId =
				req.body.TABLE_ID !== undefined && req.body.TABLE_ID !== '' && req.body.TABLE_ID != null
					? req.body.TABLE_ID
					: oldOrder.TABLE_ID;

			const payload = {
				TABLE_ID: req.body.TABLE_ID,
				ORDER_TYPE: req.body.ORDER_TYPE,
				STATUS: parseInt(req.body.STATUS) || 3,
				SUBTOTAL: parseFloat(req.body.SUBTOTAL) || 0,
				TAX_AMOUNT: parseFloat(req.body.TAX_AMOUNT) || 0,
				SERVICE_CHARGE: parseFloat(req.body.SERVICE_CHARGE) || 0,
				DISCOUNT_AMOUNT: parseFloat(req.body.DISCOUNT_AMOUNT) || 0,
				GRAND_TOTAL: parseFloat(req.body.GRAND_TOTAL) || 0,
				user_id: req.session?.user_id || req.user?.user_id
			};

			payload.SERVICE_CHARGE = await OrderModel.resolveServiceChargeWithRoomCharge(effectiveTableId, req.body.SERVICE_CHARGE);
			payload.GRAND_TOTAL = OrderModel.computeGrandTotal(
				payload.SUBTOTAL,
				payload.TAX_AMOUNT,
				payload.SERVICE_CHARGE,
				payload.DISCOUNT_AMOUNT
			);

			if (payload.STATUS === 1) {
				await InventoryDeductionModel.updateStatusByOrderId(Number(id), 1, payload.user_id);
			}
			const updated = payload.STATUS === 1 ? true : await OrderModel.update(id, payload);
			// Only replace order items if ORDER_ITEMS is explicitly provided in the request
			if (req.body.ORDER_ITEMS !== undefined) {
				const items = Array.isArray(req.body.ORDER_ITEMS) ? req.body.ORDER_ITEMS : [];
				await OrderItemsModel.replaceForOrder(id, items, req.session.user_id);
			}

			const existingBilling = await BillingModel.getByOrderId(id);
			if (existingBilling) {
				await BillingModel.updateForOrder(id, {
					amount_due: payload.GRAND_TOTAL
				});
			} else {
				const order = await OrderModel.getById(id);
				await BillingModel.createForOrder({
					branch_id: order?.BRANCH_ID,
					order_id: id,
					amount_due: payload.GRAND_TOTAL,
					status: 3,
					user_id: req.session.user_id || req.user?.user_id,
					encoded_dt: order?.ENCODED_DT ?? null,
				});
			}

			// Handle Table Status Changes
			if (payload.STATUS === 1 || payload.STATUS === -1) {
				// Order is SETTLED (1) or CANCELLED (-1) -> Set table to AVAILABLE (1)
				if (payload.TABLE_ID) {
					await TableModel.updateStatus(payload.TABLE_ID, 1);
				}
			} else {
				// Order is still active
				if (oldOrder.TABLE_ID != payload.TABLE_ID) {
					// Table changed
					if (oldOrder.TABLE_ID) {
						await TableModel.updateStatus(oldOrder.TABLE_ID, 1); // Set old table to AVAILABLE
					}
					if (payload.TABLE_ID) {
						await TableModel.updateStatus(payload.TABLE_ID, 2); // Set new table to OCCUPIED
					}
				} else if (payload.TABLE_ID) {
					// Same table, ensure it's OCCUPIED
					await TableModel.updateStatus(payload.TABLE_ID, 2);
				}
			}

			// Get updated order data with items for socket emission
			const updatedOrder = await OrderModel.getById(id);
			const orderItems = await OrderItemsModel.getByOrderId(id);

			// Emit socket event for order update
			socketService.emitOrderUpdate(id, {
				order_id: id,
				order_no: updatedOrder.ORDER_NO,
				table_id: updatedOrder.TABLE_ID,
				order_type: updatedOrder.ORDER_TYPE,
				floor: updatedOrder.FLOOR || null,
				status: updatedOrder.STATUS,
				grand_total: updatedOrder.GRAND_TOTAL,
				items: orderItems
			});

			return ApiResponse.success(res, null, 'Order updated successfully');
		} catch (error) {
			console.error('Error updating order:', error);
			return ApiResponse.error(res, 'Failed to update order', 500, error.message);
		}
	}

	static async getItems(req, res) {
		try {
			const { id } = req.params;
			const items = await OrderItemsModel.getByOrderId(id);
			return ApiResponse.success(res, items, 'Order items retrieved successfully');
		} catch (error) {
			console.error('Error fetching line items:', error);
			return ApiResponse.error(res, 'Failed to fetch order items', 500, error.message);
		}
	}

	static async updateItemStatus(req, res) {
		try {
			const { id } = req.params;
			const { status } = req.body;
			const user_id = req.session.user_id || req.user?.user_id;

			// Get order_id before updating
			const pool = require('../config/db');
			const [itemRows] = await pool.execute('SELECT ORDER_ID FROM order_items WHERE IDNo = ?', [id]);

			const updated = await OrderItemsModel.updateStatus(id, status, user_id);
			if (!updated) {
				return res.status(404).json({ error: 'Item not found' });
			}

			// Get order_id from the item to emit socket event
			if (itemRows.length > 0 && itemRows[0].ORDER_ID) {
				const orderId = itemRows[0].ORDER_ID;
				const order = await OrderModel.getById(orderId);
				const orderItems = await OrderItemsModel.getByOrderId(orderId);

				// Emit socket event for order update (item status changed)
				socketService.emitOrderUpdate(orderId, {
					order_id: orderId,
					order_no: order.ORDER_NO,
					table_id: order.TABLE_ID,
					status: order.STATUS,
					grand_total: order.GRAND_TOTAL,
					items: orderItems
				});
			}

			return ApiResponse.success(res, null, 'Item status updated successfully');
		} catch (error) {
			console.error('Error updating item status:', error);
			return ApiResponse.error(res, 'Failed to update item status', 500, error.message);
		}
	}

	// Get single order item by ID
	static async getOrderItemById(req, res) {
		try {
			const { id } = req.params;
			const pool = require('../config/db');
			const [rows] = await pool.execute(`
				SELECT 
					oi.IDNo,
					oi.ORDER_ID,
					oi.MENU_ID,
					m.MENU_NAME,
					oi.QTY,
					oi.UNIT_PRICE,
					oi.LINE_TOTAL,
					oi.STATUS,
					oi.REMARKS,
					oi.ENCODED_DT,
					oi.EDITED_DT,
					u.FIRSTNAME AS PREPARED_BY
				FROM order_items oi
				LEFT JOIN menu m ON m.IDNo = oi.MENU_ID
				LEFT JOIN user_info u ON u.IDNo = oi.EDITED_BY
				WHERE oi.IDNo = ?
			`, [id]);

			if (rows.length === 0) {
				return ApiResponse.notFound(res, 'Order item');
			}

			return ApiResponse.success(res, rows[0], 'Order item retrieved successfully');
		} catch (error) {
			console.error('Error fetching order item:', error);
			return ApiResponse.error(res, 'Failed to fetch order item', 500, error.message);
		}
	}

	// Update single order item
	static async updateOrderItem(req, res) {
		try {
			const { id } = req.params;
			const { qty, unit_price, status, remarks } = req.body;
			const user_id = req.session.user_id || req.user?.user_id;

			const pool = require('../config/db');

			// Get existing item
			const [itemRows] = await pool.execute('SELECT * FROM order_items WHERE IDNo = ?', [id]);
			if (itemRows.length === 0) {
				return ApiResponse.notFound(res, 'Order item');
			}

			const existingItem = itemRows[0];
			const orderId = existingItem.ORDER_ID;

			// Calculate new line total
			const oldQty = Number(existingItem.QTY) || 0;
			const newQty = qty !== undefined ? parseFloat(qty) : oldQty;
			const newUnitPrice = unit_price !== undefined ? parseFloat(unit_price) : existingItem.UNIT_PRICE;
			const newLineTotal = newQty * newUnitPrice;

			const orderForInventory = await OrderModel.getById(orderId);
			const isConfirmed = orderForInventory && Number(orderForInventory.STATUS) === 2;
			const qtyChanged = Number(newQty) !== oldQty;
			const qtyDelta = Number(newQty) - oldQty;
			const isIncrease = qtyDelta > 0;

			// Align with create order:
			// - Kapag CONFIRMED at TUMAAS ang qty -> validate ADDITIONAL qty lang vs stock, then adjust inventory
			// - Kapag CONFIRMED at BUMABA ang qty -> huwag mag-validate; ibalik lang ang sobra sa inventory
			if (qtyChanged) {
				if (isConfirmed) {
					if (isIncrease) {
						// Validate inventory for the *extra* qty only (delta), similar to create order
						const itemsForValidation = [
							{
								menu_id: existingItem.MENU_ID,
								qty: qtyDelta,
							},
						];
						const validation = await InventoryDeductionService.validateOrderItemsForInventory(
							Number(orderForInventory.BRANCH_ID),
							itemsForValidation
						);
						if (!validation.valid) {
							return res.status(200).json({
								success: false,
								error: 'Insufficient inventory for order items',
								insufficient: validation.insufficient,
							});
						}
					}
					// Reverse this item's deductions (add stock back); pagkatapos ng update, magde-deduct tayo ulit
					await InventoryDeductionService.reverseOnOrderItemDeleted(Number(id), user_id);
				} else {
					// Pending / other statuses: inventory not yet deducted.
					// Validate FULL order (all items with updated qty) so total requirement never exceeds stock.
					const allItems = await OrderItemsModel.getByOrderId(orderId);
					const qtyPerMenu = new Map();
					for (const item of allItems) {
						const menuId = Number(item.MENU_ID);
						let q = Number(item.QTY) || 0;
						if (item.IDNo === Number(id)) {
							// use new qty for this row
							q = Number(newQty) || 0;
						}
						if (!Number.isFinite(menuId) || menuId <= 0 || q <= 0) continue;
						qtyPerMenu.set(menuId, (qtyPerMenu.get(menuId) || 0) + q);
					}
					const itemsForValidation = Array.from(qtyPerMenu.entries()).map(([menu_id, qty]) => ({
						menu_id,
						qty,
					}));
					const validation = await InventoryDeductionService.validateOrderItemsForInventory(
						Number(orderForInventory.BRANCH_ID),
						itemsForValidation
					);
					if (!validation.valid) {
						return res.status(200).json({
							success: false,
							error: 'Insufficient inventory for order items',
							insufficient: validation.insufficient,
						});
					}
				}
			}

			// Update order item
			const updateQuery = `
				UPDATE order_items SET
					QTY = ?,
					UNIT_PRICE = ?,
					LINE_TOTAL = ?,
					STATUS = ?,
					REMARKS = ?,
					EDITED_BY = ?,
					EDITED_DT = CURRENT_TIMESTAMP
				WHERE IDNo = ?
			`;
			await pool.execute(updateQuery, [
				newQty,
				newUnitPrice,
				newLineTotal,
				status !== undefined ? status : existingItem.STATUS,
				remarks !== undefined ? remarks : existingItem.REMARKS,
				user_id,
				id
			]);

			// Deduct inventory for this item with new qty (same flow as create order → confirm)
			if (isConfirmed && qtyChanged) {
				await InventoryDeductionService.deductForOrderItem(Number(orderId), Number(id), user_id);
			}

			// Recalculate order totals
			const [allItems] = await pool.execute('SELECT LINE_TOTAL FROM order_items WHERE ORDER_ID = ?', [orderId]);
			const newSubtotal = allItems.reduce((sum, item) => sum + parseFloat(item.LINE_TOTAL || 0), 0);

			const order = await OrderModel.getById(orderId);
			const taxAmount = parseFloat(order.TAX_AMOUNT || 0);
			const serviceCharge = parseFloat(order.SERVICE_CHARGE || 0);
			const discountAmount = parseFloat(order.DISCOUNT_AMOUNT || 0);
			const newGrandTotal = newSubtotal + taxAmount + serviceCharge - discountAmount;

			// Update order totals
			await OrderModel.update(orderId, {
				TABLE_ID: order.TABLE_ID,
				ORDER_TYPE: order.ORDER_TYPE,
				STATUS: order.STATUS,
				SUBTOTAL: newSubtotal,
				TAX_AMOUNT: taxAmount,
				SERVICE_CHARGE: serviceCharge,
				DISCOUNT_AMOUNT: discountAmount,
				GRAND_TOTAL: newGrandTotal,
				user_id: user_id
			});

			// Update billing if exists
			const BillingModel = require('../models/billingModel');
			const existingBilling = await BillingModel.getByOrderId(orderId);
			if (existingBilling) {
				await BillingModel.updateForOrder(orderId, {
					amount_due: newGrandTotal
				});
			}

			// Emit socket event
			const orderItems = await OrderItemsModel.getByOrderId(orderId);
			socketService.emitOrderUpdate(orderId, {
				order_id: orderId,
				order_no: order.ORDER_NO,
				table_id: order.TABLE_ID,
				status: order.STATUS,
				grand_total: newGrandTotal,
				items: orderItems
			});

			return ApiResponse.success(res, {
				item_id: parseInt(id),
				new_subtotal: newSubtotal,
				new_grand_total: newGrandTotal
			}, 'Order item updated successfully');
		} catch (error) {
			console.error('Error updating order item:', error);
			return ApiResponse.error(res, 'Failed to update order item', 500, error.message);
		}
	}

	// Add items to existing order (additional order items)
	static async addItemsToOrder(req, res) {
		try {
			const { id: orderId } = req.params;
			const user_id = req.session.user_id || req.user?.user_id;
			const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
			if (!rawItems.length) {
				return ApiResponse.badRequest(res, 'At least one order item is required');
			}
			const order = await OrderModel.getById(orderId);
			if (!order) {
				return ApiResponse.notFound(res, 'Order');
			}
			if (Number(order.STATUS) === 1 || Number(order.STATUS) === -1) {
				return ApiResponse.badRequest(res, 'Cannot add items to settled or cancelled order');
			}
			const branchId = Number(order.BRANCH_ID);
			const itemsNormalized = rawItems.map((item) => {
				const qty = Number(item.qty) || 1;
				const unit_price = Number(item.unit_price) || 0;
				return {
					menu_id: Number(item.menu_id),
					qty,
					unit_price,
					line_total: qty * unit_price,
					status: item.status != null ? Number(item.status) : 3,
				};
			});
			const existingItems = await OrderItemsModel.getByOrderId(orderId);

			// Validate inventory for additional items.
			// - For CONFIRMED orders: inventory is already deducted for existing items,
			//   so we only need to validate the *new* items.
			// - For PENDING orders: inventory has NOT been deducted yet, so we must validate
			//   the total qty = existing items + new items, to avoid over-allocating stock.
			let itemsForValidation;
			if (Number(order.STATUS) === 2) {
				itemsForValidation = itemsNormalized;
			} else {
				const qtyPerMenu = new Map();
				// existing items
				for (const it of existingItems) {
					const menuId = Number(it.MENU_ID);
					const q = Number(it.QTY) || 0;
					if (!Number.isFinite(menuId) || menuId <= 0 || q <= 0) continue;
					qtyPerMenu.set(menuId, (qtyPerMenu.get(menuId) || 0) + q);
				}
				// new items
				for (const it of itemsNormalized) {
					const menuId = Number(it.menu_id);
					const q = Number(it.qty) || 0;
					if (!Number.isFinite(menuId) || menuId <= 0 || q <= 0) continue;
					qtyPerMenu.set(menuId, (qtyPerMenu.get(menuId) || 0) + q);
				}
				itemsForValidation = Array.from(qtyPerMenu.entries()).map(([menu_id, qty]) => ({
					menu_id,
					qty,
				}));
			}

			const validation = await InventoryDeductionService.validateOrderItemsForInventory(
				branchId,
				itemsForValidation
			);
			if (!validation.valid) {
				return res.status(200).json({
					success: false,
					error: 'Insufficient inventory for order items',
					insufficient: validation.insufficient,
				});
			}
			const existingSubtotal = existingItems.reduce((sum, i) => sum + parseFloat(i.LINE_TOTAL || 0), 0);
			const newItemsTotal = itemsNormalized.reduce((sum, i) => sum + i.line_total, 0);
			await OrderItemsModel.createForOrder(orderId, itemsNormalized, user_id);
			// When CONFIRMED, deduct inventory for each new item (new rows are last by IDNo)
			if (Number(order.STATUS) === 2) {
				const allItemsNow = await OrderItemsModel.getByOrderId(orderId);
				const newCount = itemsNormalized.length;
				const newItemRows = [...allItemsNow]
					.sort((a, b) => Number(b.IDNo) - Number(a.IDNo))
					.slice(0, newCount);
				for (const row of newItemRows) {
					await InventoryDeductionService.deductForOrderItem(Number(orderId), Number(row.IDNo), user_id);
				}
			}
			const newSubtotal = Number((existingSubtotal + newItemsTotal).toFixed(2));
			const taxAmount = parseFloat(order.TAX_AMOUNT || 0);
			const serviceCharge = parseFloat(order.SERVICE_CHARGE || 0);
			const discountAmount = parseFloat(order.DISCOUNT_AMOUNT || 0);
			const newGrandTotal = Number((newSubtotal + taxAmount + serviceCharge - discountAmount).toFixed(2));
			await OrderModel.update(orderId, {
				TABLE_ID: order.TABLE_ID,
				ORDER_TYPE: order.ORDER_TYPE,
				STATUS: order.STATUS,
				SUBTOTAL: newSubtotal,
				TAX_AMOUNT: taxAmount,
				SERVICE_CHARGE: serviceCharge,
				DISCOUNT_AMOUNT: discountAmount,
				GRAND_TOTAL: newGrandTotal,
				user_id: user_id,
			});
			const existingBilling = await BillingModel.getByOrderId(orderId);
			if (existingBilling) {
				await BillingModel.updateForOrder(orderId, { amount_due: newGrandTotal });
			}
			const orderItems = await OrderItemsModel.getByOrderId(orderId);
			socketService.emitOrderUpdate(orderId, {
				order_id: orderId,
				order_no: order.ORDER_NO,
				table_id: order.TABLE_ID,
				status: order.STATUS,
				grand_total: newGrandTotal,
				items: orderItems,
			});
			return ApiResponse.success(res, {
				order_id: parseInt(orderId),
				order_no: order.ORDER_NO,
				items_added: itemsNormalized.length,
				new_subtotal: newSubtotal,
				new_grand_total: newGrandTotal,
			}, 'Items added to order successfully');
		} catch (error) {
			console.error('Error adding items to order:', error);
			return ApiResponse.error(res, 'Failed to add items to order', 500, error.message);
		}
	}

	// Delete single order item
	static async deleteOrderItem(req, res) {
		try {
			const { id } = req.params;
			const user_id = req.session.user_id || req.user?.user_id;

			const pool = require('../config/db');

			// Get existing item and order
			const [itemRows] = await pool.execute('SELECT * FROM order_items WHERE IDNo = ?', [id]);
			if (itemRows.length === 0) {
				return ApiResponse.notFound(res, 'Order item');
			}

			const existingItem = itemRows[0];
			const orderId = existingItem.ORDER_ID;

			// If order is CONFIRMED, reverse inventory deductions for this item before deleting
			const order = await OrderModel.getById(orderId);
			if (order && Number(order.STATUS) === 2) {
				await InventoryDeductionService.reverseOnOrderItemDeleted(Number(id), user_id);
			}

			// Delete order item
			await pool.execute('DELETE FROM order_items WHERE IDNo = ?', [id]);

			// Recalculate order totals
			const [allItems] = await pool.execute('SELECT LINE_TOTAL FROM order_items WHERE ORDER_ID = ?', [orderId]);
			const newSubtotal = allItems.reduce((sum, item) => sum + parseFloat(item.LINE_TOTAL || 0), 0);

			if (!order) {
				return ApiResponse.error(res, 'Order not found', 404);
			}
			const taxAmount = parseFloat(order.TAX_AMOUNT || 0);
			const serviceCharge = parseFloat(order.SERVICE_CHARGE || 0);
			const discountAmount = parseFloat(order.DISCOUNT_AMOUNT || 0);
			const newGrandTotal = newSubtotal + taxAmount + serviceCharge - discountAmount;

			// Update order totals
			await OrderModel.update(orderId, {
				TABLE_ID: order.TABLE_ID,
				ORDER_TYPE: order.ORDER_TYPE,
				STATUS: order.STATUS,
				SUBTOTAL: newSubtotal,
				TAX_AMOUNT: taxAmount,
				SERVICE_CHARGE: serviceCharge,
				DISCOUNT_AMOUNT: discountAmount,
				GRAND_TOTAL: newGrandTotal,
				user_id: user_id
			});

			// Update billing if exists
			const BillingModel = require('../models/billingModel');
			const existingBilling = await BillingModel.getByOrderId(orderId);
			if (existingBilling) {
				await BillingModel.updateForOrder(orderId, {
					amount_due: newGrandTotal
				});
			}

			// Emit socket event
			const orderItems = await OrderItemsModel.getByOrderId(orderId);
			socketService.emitOrderUpdate(orderId, {
				order_id: orderId,
				order_no: order.ORDER_NO,
				table_id: order.TABLE_ID,
				status: order.STATUS,
				grand_total: newGrandTotal,
				items: orderItems
			});

			return ApiResponse.success(res, null, 'Order item deleted successfully');
		} catch (error) {
			console.error('Error deleting order item:', error);
			return ApiResponse.error(res, 'Failed to delete order item', 500, error.message);
		}
	}

	// Update order status directly
	static async updateStatus(req, res) {
		try {
			const { id } = req.params;
			const { status } = req.body;
			const user_id = req.session.user_id || req.user?.user_id;

			if (!status && status !== 0) {
				return ApiResponse.badRequest(res, 'Status is required');
			}

			const order = await OrderModel.getById(id);
			if (!order) {
				return ApiResponse.notFound(res, 'Order');
			}

			const parsedStatus = parseInt(status);
			let updated = false;
			if (parsedStatus === 2) {
				// CONFIRMED: deduct menu_ingredients from inventory, record in inventory_deductions
				await InventoryDeductionService.deductOnOrderConfirmed(Number(id), user_id);
				updated = await OrderModel.updateStatus(id, parsedStatus, user_id);
			} else if (parsedStatus === -1) {
				// CANCELLED: reverse deductions (add stock back, mark inventory_deductions ACTIVE=0)
				await InventoryDeductionService.reverseOnOrderCancelled(Number(id), user_id);
				updated = await OrderModel.updateStatus(id, parsedStatus, user_id);
			} else {
				// SETTLED (1): reflect in inventory_deductions STATUS = 1
				if (parsedStatus === 1) {
					await InventoryDeductionModel.updateStatusByOrderId(Number(id), parsedStatus, user_id);
				}
				// PENDING (3), etc: just update order status
				updated = await OrderModel.updateStatus(id, parsedStatus, user_id);
			}
			if (!updated) {
				return ApiResponse.error(res, 'Failed to update order status', 500);
			}

			// Handle table status if order is settled or cancelled
			const TableModel = require('../models/tableModel');
			if (parsedStatus === 1 || parsedStatus === -1) {
				// Order is SETTLED (1) or CANCELLED (-1) -> Set table to AVAILABLE (1)
				if (order.TABLE_ID) {
					await TableModel.updateStatus(order.TABLE_ID, 1);
				}
			}

			// Emit socket event
			const updatedOrder = await OrderModel.getById(id);
			const orderItems = await OrderItemsModel.getByOrderId(id);
			socketService.emitOrderUpdate(id, {
				order_id: id,
				order_no: updatedOrder.ORDER_NO,
				table_id: updatedOrder.TABLE_ID,
				status: updatedOrder.STATUS,
				grand_total: updatedOrder.GRAND_TOTAL,
				items: orderItems
			});

			return ApiResponse.success(res, { order_id: parseInt(id), status: parsedStatus }, 'Order status updated successfully');
		} catch (error) {
			console.error('Error updating order status:', error);
			return ApiResponse.error(res, 'Failed to update order status', 500, error.message);
		}
	}

	static async updateEncodedDt(req, res) {
		try {
			const { id } = req.params;
			const encodedRaw = req.body?.ENCODED_DT ?? req.body?.encoded_dt ?? req.body?.encodedDt ?? null;
			const encodedDt = OrderModel.normalizeEncodedDt(encodedRaw);
			if (!encodedDt) {
				return ApiResponse.badRequest(res, 'ENCODED_DT is required (YYYY-MM-DD HH:MM:SS)');
			}

			const order = await OrderModel.getById(id);
			if (!order) {
				return ApiResponse.notFound(res, 'Order');
			}
			if (req.orderMetaBranchId != null && Number(order.BRANCH_ID) !== Number(req.orderMetaBranchId)) {
				return ApiResponse.forbidden(res, 'You can only modify orders from your assigned branch');
			}

			const userId = req.session?.user_id || req.user?.user_id || null;
			const updated = await OrderModel.updateEncodedDtCascade(id, encodedDt, userId);
			const refreshed = await OrderModel.getById(id);

			socketService.emitOrderUpdate(id, {
				order_id: id,
				order_no: refreshed?.ORDER_NO,
				encoded_dt: encodedDt,
			});

			return ApiResponse.success(
				res,
				{ order_id: parseInt(id, 10), order_no: refreshed?.ORDER_NO, encoded_dt: encodedDt, updated },
				'Order encoded date updated successfully'
			);
		} catch (error) {
			if (error?.code === 'ORDER_NO_CONFLICT') {
				return ApiResponse.badRequest(res, `${error.message}. Cannot move this order to that date.`);
			}
			console.error('Error updating order encoded date:', error);
			return ApiResponse.error(res, 'Failed to update encoded date', 500, error.message);
		}
	}

	static async softDelete(req, res) {
		try {
			const { id } = req.params;
			const order = await OrderModel.getById(id);
			if (!order) {
				return ApiResponse.notFound(res, 'Order');
			}
			if (req.orderMetaBranchId != null && Number(order.BRANCH_ID) !== Number(req.orderMetaBranchId)) {
				return ApiResponse.forbidden(res, 'You can only modify orders from your assigned branch');
			}

			const userId = req.session?.user_id || req.user?.user_id || null;
			const updated = await OrderModel.softDeleteCascade(id, userId);

			socketService.emitOrderUpdate(id, {
				order_id: id,
				order_no: order.ORDER_NO,
				status: -2,
			});

			return ApiResponse.success(
				res,
				{ order_id: parseInt(id, 10), status: -2, updated },
				'Order soft-deleted successfully'
			);
		} catch (error) {
			console.error('Error soft-deleting order:', error);
			return ApiResponse.error(res, 'Failed to soft-delete order', 500, error.message);
		}
	}
}

module.exports = OrderController;
