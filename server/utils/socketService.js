// ============================================
// SOCKET SERVICE
// ============================================
// File: utils/socketService.js
// Description: Socket.io service for real-time order updates
// ============================================

let io = null;
const SOCKET_LOG_EMITS = String(process.env.SOCKET_LOG_EMITS || '').toLowerCase() === 'true';
const SOCKET_LOG_CONNECTIONS = String(process.env.SOCKET_LOG_CONNECTIONS || '').toLowerCase() !== 'false';

function normalizeBranchId(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

// Resolve the branch an order belongs to. Prefer whatever the caller put in the
// payload; otherwise look it up by order id so every emit can be branch-scoped
// even when the controller didn't pass branch info.
async function resolveBranchId(orderId, orderData) {
  const fromPayload = orderData && normalizeBranchId(orderData.branch_id ?? orderData.BRANCH_ID);
  if (fromPayload != null) return fromPayload;
  try {
    // Lazy require: orderModel -> tableModel -> socketService is a require
    // cycle, so pull it in at call time (everything is loaded by then).
    const OrderModel = require('../models/orderModel');
    const order = await OrderModel.getById(orderId);
    return order ? normalizeBranchId(order.BRANCH_ID) : null;
  } catch (e) {
    console.warn(`[SOCKET] Could not resolve branch for order ${orderId}: ${e?.message || e}`);
    return null;
  }
}

// Role rooms to emit an order event to. New clients join their per-branch room
// (`cashier_3`); older clients that don't send a branch join the shared room
// (`cashier`). Emitting to both means: new clients are branch-isolated, and no
// client — old or new — ever misses an event, whatever the deploy order.
function roleRooms(branchId) {
  const rooms = ['kitchen', 'cashier', 'waiter'];
  if (branchId != null) {
    rooms.push(`kitchen_${branchId}`, `cashier_${branchId}`, `waiter_${branchId}`);
  }
  return rooms;
}

async function emitOrderEvent(event, orderId, orderData) {
  if (!io) {
    console.warn('[SOCKET] Socket.io not initialized');
    return;
  }
  const branchId = await resolveBranchId(orderId, orderData);
  const payload = {
    order_id: orderId,
    branch_id: branchId,
    order: orderData,
    timestamp: new Date().toISOString(),
  };

  // Per-order subscribers (any branch) still get it.
  io.to(`order_${orderId}`).emit(event, payload);
  for (const room of roleRooms(branchId)) {
    io.to(room).emit(event, payload);
  }

  if (SOCKET_LOG_EMITS) {
    console.log(`[SOCKET] Emitted ${event} for order ${orderId} (branch ${branchId ?? 'unknown'})`);
  }
}

// Initialize socket.io
function initializeSocket(server) {
  const { Server } = require('socket.io');

  io = new Server(server, {
    cors: {
      origin: "*", // Allow all origins for now (can be restricted in production)
      methods: ["GET", "POST"],
      credentials: true
    },
    transports: ['websocket', 'polling']
  });

  io.on('connection', (socket) => {
    if (SOCKET_LOG_CONNECTIONS) {
      console.log(`[SOCKET] Client connected: ${socket.id}`);
    }

    // Handle order room joining
    socket.on('join_order', (orderId) => {
      const room = `order_${orderId}`;
      socket.join(room);
      if (SOCKET_LOG_CONNECTIONS) {
        console.log(`[SOCKET] Client ${socket.id} joined room: ${room}`);
      }
    });

    // Handle order room leaving
    socket.on('leave_order', (orderId) => {
      const room = `order_${orderId}`;
      socket.leave(room);
      if (SOCKET_LOG_CONNECTIONS) {
        console.log(`[SOCKET] Client ${socket.id} left room: ${room}`);
      }
    });

    // Role rooms. Clients pass their branch id so we can keep each branch's
    // realtime traffic separate; the un-suffixed room is kept only as a
    // backwards-compatible fallback for older clients.
    const joinRole = (role) => (branchId) => {
      const bid = normalizeBranchId(branchId);
      if (bid != null) {
        socket.join(`${role}_${bid}`);
      } else {
        socket.join(role);
      }
      if (SOCKET_LOG_CONNECTIONS) {
        console.log(`[SOCKET] Client ${socket.id} joined ${role} room (branch ${bid ?? 'shared'})`);
      }
    };
    const leaveRole = (role) => (branchId) => {
      const bid = normalizeBranchId(branchId);
      socket.leave(bid != null ? `${role}_${bid}` : role);
      if (SOCKET_LOG_CONNECTIONS) {
        console.log(`[SOCKET] Client ${socket.id} left ${role} room (branch ${bid ?? 'shared'})`);
      }
    };

    socket.on('join_kitchen', joinRole('kitchen'));
    socket.on('leave_kitchen', leaveRole('kitchen'));
    socket.on('join_cashier', joinRole('cashier'));
    socket.on('leave_cashier', leaveRole('cashier'));
    socket.on('join_waiter', joinRole('waiter'));
    socket.on('leave_waiter', leaveRole('waiter'));

    // Handle user room joining (for real-time notifications)
    socket.on('join_user', (userId) => {
      if (userId != null && userId !== '') {
        const room = `user_${userId}`;
        socket.join(room);
        if (SOCKET_LOG_CONNECTIONS) {
          console.log(`[SOCKET] Client ${socket.id} joined user room: ${room}`);
        }
      }
    });

    socket.on('disconnect', () => {
      if (SOCKET_LOG_CONNECTIONS) {
        console.log(`[SOCKET] Client disconnected: ${socket.id}`);
      }
    });
  });

  if (SOCKET_LOG_CONNECTIONS) {
    console.log('[SOCKET] Socket.io server initialized');
  }
  return io;
}

// Emit order update event
function emitOrderUpdate(orderId, orderData) {
  emitOrderEvent('order_updated', orderId, orderData).catch((e) =>
    console.error(`[SOCKET] emitOrderUpdate failed: ${e?.message || e}`));
}

// Emit order created event
function emitOrderCreated(orderId, orderData) {
  emitOrderEvent('order_created', orderId, orderData).catch((e) =>
    console.error(`[SOCKET] emitOrderCreated failed: ${e?.message || e}`));
}

// Emit order items added event
function emitOrderItemsAdded(orderId, orderData) {
  emitOrderEvent('order_items_added', orderId, orderData).catch((e) =>
    console.error(`[SOCKET] emitOrderItemsAdded failed: ${e?.message || e}`));
}

// Emit table updated event
function emitTableUpdated(tableData, action = 'updated') {
  if (!io) {
    console.warn('[SOCKET] Socket.io not initialized');
    return;
  }

  const tableId = tableData.id || tableData.table_id || tableData.IDNo;
  const branchId = normalizeBranchId(tableData.branch_id ?? tableData.BRANCH_ID);
  const payload = {
    table_id: tableId,
    branch_id: branchId,
    table: tableData,
    action,
    timestamp: new Date().toISOString()
  };

  if (branchId != null) {
    io.to(`kitchen_${branchId}`).emit('table_updated', payload);
    io.to(`cashier_${branchId}`).emit('table_updated', payload);
    io.to(`waiter_${branchId}`).emit('table_updated', payload);
  } else {
    io.emit('table_updated', payload);
  }
  if (SOCKET_LOG_EMITS) {
    console.log(`[SOCKET] Emitted table_updated (${action}) for table: ${tableId} (branch ${branchId ?? 'unknown'})`);
  }
}

// Emit new notification to a specific user (restoadmin bell)
function emitNotificationCreated(userId, notification) {
  if (!io) {
    console.warn('[SOCKET] Socket.io not initialized');
    return;
  }
  const room = `user_${userId}`;
  io.to(room).emit('notification_new', notification);
  if (SOCKET_LOG_EMITS) {
    console.log(`[SOCKET] Emitted notification_new to room: ${room}`);
  }
}

// Get socket.io instance
function getIO() {
  return io;
}

module.exports = {
  initializeSocket,
  emitOrderUpdate,
  emitOrderCreated,
  emitOrderItemsAdded,
  emitTableUpdated,
  emitNotificationCreated,
  getIO
};
