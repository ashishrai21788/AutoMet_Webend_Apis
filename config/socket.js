/**
 * Socket.IO server for real-time ride events.
 * Emits: ride_request_received, ride_request_accepted, ride_request_rejected, ride_request_timeout, ride_cancelled_by_user
 */
const {
  authenticateSocket,
  getSocketEnforcementMode
} = require('../lib/authMiddleware');

let io = null;

function socketAuthMiddleware(socket, next) {
  const mode = getSocketEnforcementMode();
  if (mode === 'off') {
    return next();
  }

  authenticateSocket(socket.handshake)
    .then((auth) => {
      socket.data.actor = { role: auth.role, id: auth.actorId };
      socket.data.authenticated = true;
      return next();
    })
    .catch((err) => {
      if (mode === 'strict') {
        return next(new Error(err.message || 'Unauthorized'));
      }
      console.warn('[Socket] auth warn:', err.message, { socketId: socket.id });
      socket.data.authenticated = false;
      return next();
    });
}

function initSocket(httpServer) {
  if (io) return io;
  try {
    const { Server } = require('socket.io');
    io = new Server(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
      path: '/socket.io'
    });

    io.use(socketAuthMiddleware);

    io.on('connection', (socket) => {
      const actor = socket.data.actor;
      if (actor?.role && actor?.id) {
        socket.join(`${actor.role}:${actor.id}`);
        if (process.env.NODE_ENV === 'development') {
          console.log('[Socket] Authenticated client joined room:', `${actor.role}:${actor.id}`);
        }
      } else if (process.env.NODE_ENV === 'development') {
        console.log('[Socket] Client connected (unauthenticated):', socket.id);
      }

      socket.on('join_driver', (driverId) => {
        const mode = getSocketEnforcementMode();
        if (mode === 'off') {
          if (driverId && typeof driverId === 'string') {
            socket.join(`driver:${driverId.trim()}`);
          }
          return;
        }
        if (!socket.data.authenticated || socket.data.actor?.role !== 'driver') {
          console.warn('[Socket] join_driver rejected: unauthenticated or wrong role');
          return;
        }
        if (driverId && String(driverId).trim() !== socket.data.actor.id) {
          console.warn('[Socket] join_driver rejected: id mismatch', {
            requested: driverId,
            actor: socket.data.actor.id
          });
          return;
        }
        socket.join(`driver:${socket.data.actor.id}`);
      });

      socket.on('join_user', (userId) => {
        const mode = getSocketEnforcementMode();
        if (mode === 'off') {
          if (userId && typeof userId === 'string') {
            socket.join(`user:${userId.trim()}`);
          }
          return;
        }
        if (!socket.data.authenticated || socket.data.actor?.role !== 'user') {
          console.warn('[Socket] join_user rejected: unauthenticated or wrong role');
          return;
        }
        if (userId && String(userId).trim() !== socket.data.actor.id) {
          console.warn('[Socket] join_user rejected: id mismatch', {
            requested: userId,
            actor: socket.data.actor.id
          });
          return;
        }
        socket.join(`user:${socket.data.actor.id}`);
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
