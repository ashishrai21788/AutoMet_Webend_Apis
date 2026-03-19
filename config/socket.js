/**
 * Socket.IO server for real-time ride events.
 * Emits: ride_request_received, ride_request_accepted, ride_request_rejected, ride_request_timeout, ride_cancelled_by_user
 */
let io = null;

function initSocket(httpServer) {
  if (io) return io;
  try {
    const { Server } = require('socket.io');
    io = new Server(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
      path: '/socket.io'
    });
    io.on('connection', (socket) => {
      if (process.env.NODE_ENV === 'development') {
        console.log('[Socket] Client connected:', socket.id);
      }
      socket.on('join_driver', (driverId) => {
        if (driverId && typeof driverId === 'string') {
          socket.join(`driver:${driverId.trim()}`);
        }
      });
      socket.on('join_user', (userId) => {
        if (userId && typeof userId === 'string') {
          socket.join(`user:${userId.trim()}`);
        }
      });
      socket.on('disconnect', () => {
        if (process.env.NODE_ENV === 'development') {
          console.log('[Socket] Client disconnected:', socket.id);
        }
      });
    });
    console.log('✅ Socket.IO attached to HTTP server');
    return io;
  } catch (err) {
    console.warn('⚠️  Socket.IO not available (install socket.io):', err.message);
    return null;
  }
}

function getIO() {
  return io;
}

/**
 * Emit to driver room: driver:{driver_id}
 */
function emitToDriver(driverId, event, payload) {
  if (io) {
    io.to(`driver:${driverId}`).emit(event, payload);
  }
}

/**
 * Emit to user room: user:{user_id}
 */
function emitToUser(userId, event, payload) {
  if (io) {
    io.to(`user:${userId}`).emit(event, payload);
  }
}

module.exports = { initSocket, getIO, emitToDriver, emitToUser };
