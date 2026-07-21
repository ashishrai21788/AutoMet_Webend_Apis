/**
 * Shared JWT auth for REST and Socket.IO.
 *
 * AUTH_ENFORCEMENT / SOCKET_AUTH_ENFORCEMENT:
 *   off    — no checks (legacy behavior)
 *   warn   — validate when token present; log missing/mismatch; do not reject
 *   strict — reject 401/403 on protected routes
 */
const jwt = require('jsonwebtoken');
const { createModel } = require('../models/dynamicModel');

const VALID_MODES = new Set(['off', 'warn', 'strict']);

function normalizeMode(value, fallback = 'off') {
  const mode = String(value || fallback).trim().toLowerCase();
  return VALID_MODES.has(mode) ? mode : fallback;
}

function getRestEnforcementMode() {
  if (process.env.AUTH_ENFORCEMENT != null && String(process.env.AUTH_ENFORCEMENT).trim() !== '') {
    return normalizeMode(process.env.AUTH_ENFORCEMENT, 'strict');
  }
  return process.env.NODE_ENV === 'production' ? 'strict' : 'off';
}

function getSocketEnforcementMode() {
  return normalizeMode(process.env.SOCKET_AUTH_ENFORCEMENT, getRestEnforcementMode());
}

function isStrict(mode) {
  return mode === 'strict';
}

function isWarnOrStrict(mode) {
  return mode === 'warn' || mode === 'strict';
}

function authError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  err.authDetails = details;
  return err;
}

/**
 * Verify Bearer token and load driver/user from DB.
 * Returns { token, decoded, driver, user } or throws authError.
 */
async function authenticateRequest(req) {
  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    throw authError(401, 'Access token required', 'Authorization header missing or invalid format');
  }

  const token = authHeader.substring(7);
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw authError(500, 'Server auth misconfigured', 'JWT_SECRET is not set');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret);
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      throw authError(401, 'Invalid token', 'Token signature is invalid');
    }
    if (error.name === 'TokenExpiredError') {
      throw authError(401, 'Token expired', 'Access token has expired');
    }
    throw authError(500, 'Token verification failed', error.message);
  }

  if (decoded.driverId) {
    const DriverModel = createModel('drivers');
    const driver = await DriverModel.findOne({
      driverId: decoded.driverId,
      accessToken: token
    });
    if (!driver) {
      throw authError(401, 'Invalid or expired token', 'Driver not found or token invalidated');
    }
    return { token, decoded, driver, user: null, role: 'driver', actorId: driver.driverId };
  }

  if (decoded.userId) {
    const UserModel = createModel('users');
    const user = await UserModel.findOne({
      userId: decoded.userId,
      accessToken: token
    });
    if (!user) {
      throw authError(401, 'Invalid or expired token', 'User not found or token invalidated');
    }
    return { token, decoded, driver: null, user, role: 'user', actorId: user.userId };
  }

  throw authError(401, 'Invalid token payload', 'Token does not contain driverId or userId');
}

/**
 * Verify token from Socket.IO handshake (auth.token or Authorization header).
 */
async function authenticateSocket(handshake) {
  const tokenFromAuth = handshake?.auth?.token;
  const authHeader = handshake?.headers?.authorization || '';
  const token = tokenFromAuth || (authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null);
  if (!token) {
    throw authError(401, 'Access token required', 'Socket handshake missing token');
  }
  return authenticateRequest({ headers: { authorization: `Bearer ${token}` } });
}

function sendAuthFailure(res, err) {
  const status = err.status || 401;
  return res.status(status).json({
    success: false,
    message: err.message || 'Unauthorized',
    data: { error: err.authDetails || err.message }
  });
}

function logAuthWarn(context, message, meta = {}) {
  console.warn(`[auth:${context}] ${message}`, meta);
}

/**
 * Express middleware factory.
 * @param {{ roles?: Array<'user'|'driver'|'any'>, enforceBodyUserId?: boolean, enforceBodyDriverId?: boolean }} options
 */
function requireAuth(options = {}) {
  const roles = options.roles || ['any'];
  const mode = getRestEnforcementMode();

  return async function authMiddleware(req, res, next) {
    if (mode === 'off') {
      return next();
    }

    try {
      const auth = await authenticateRequest(req);
      req.token = auth.token;
      req.decoded = auth.decoded;
      req.driver = auth.driver;
      req.user = auth.user;
      req.authRole = auth.role;
      req.authActorId = auth.actorId;

      if (!roles.includes('any') && !roles.includes(auth.role)) {
        const msg = `This endpoint requires role: ${roles.join(' or ')}`;
        if (isStrict(mode)) {
          return sendAuthFailure(res, authError(403, msg, 'Role mismatch'));
        }
        logAuthWarn('rest', msg, { path: req.path, role: auth.role });
      }

      if (options.enforceBodyUserId) {
        const bodyUserId = req.body?.user_id != null ? String(req.body.user_id).trim() : '';
        if (bodyUserId && auth.role === 'user' && bodyUserId !== auth.actorId) {
          const msg = 'user_id does not match authenticated user';
          if (isStrict(mode)) {
            return sendAuthFailure(res, authError(403, msg, msg));
          }
          logAuthWarn('rest', msg, { path: req.path, bodyUserId, actorId: auth.actorId });
          req.body.user_id = auth.actorId;
        } else if (auth.role === 'user' && !bodyUserId) {
          req.body.user_id = auth.actorId;
        }
      }

      if (options.enforceBodyDriverId) {
        const bodyDriverId = req.body?.driver_id != null ? String(req.body.driver_id).trim() : '';
        if (bodyDriverId && auth.role === 'driver' && bodyDriverId !== auth.actorId) {
          const msg = 'driver_id does not match authenticated driver';
          if (isStrict(mode)) {
            return sendAuthFailure(res, authError(403, msg, msg));
          }
          logAuthWarn('rest', msg, { path: req.path, bodyDriverId, actorId: auth.actorId });
          req.body.driver_id = auth.actorId;
        } else if (auth.role === 'driver' && !bodyDriverId) {
          req.body.driver_id = auth.actorId;
        }
      }

      if (options.enforceBodyDriverIdCamelCase) {
        const bodyDriverId = req.body?.driverId != null ? String(req.body.driverId).trim() : '';
        if (bodyDriverId && auth.role === 'driver' && bodyDriverId !== auth.actorId) {
          const msg = 'driverId does not match authenticated driver';
          if (isStrict(mode)) {
            return sendAuthFailure(res, authError(403, msg, msg));
          }
          logAuthWarn('rest', msg, { path: req.path, bodyDriverId, actorId: auth.actorId });
          req.body.driverId = auth.actorId;
        } else if (auth.role === 'driver' && !bodyDriverId) {
          req.body.driverId = auth.actorId;
        }
      }

      if (options.enforceBodyUserIdCamelCase) {
        const bodyUserId = req.body?.userId != null ? String(req.body.userId).trim() : '';
        if (bodyUserId && auth.role === 'user' && bodyUserId !== auth.actorId) {
          const msg = 'userId does not match authenticated user';
          if (isStrict(mode)) {
            return sendAuthFailure(res, authError(403, msg, msg));
          }
          logAuthWarn('rest', msg, { path: req.path, bodyUserId, actorId: auth.actorId });
          req.body.userId = auth.actorId;
        } else if (auth.role === 'user' && !bodyUserId) {
          req.body.userId = auth.actorId;
        }
      }

      return next();
    } catch (err) {
      if (isStrict(mode)) {
        return sendAuthFailure(res, err);
      }
      if (isWarnOrStrict(mode)) {
        logAuthWarn('rest', err.message || 'Auth failed', {
          path: req.path,
          details: err.authDetails
        });
      }
      return next();
    }
  };
}

/** Optional query param enforcement for GET routes (user_id / driver_id). */
function requireQueryActor(options = {}) {
  const mode = getRestEnforcementMode();
  const param = options.param || 'user_id';
  const role = options.role || 'user';

  return async function queryAuthMiddleware(req, res, next) {
    if (mode === 'off') {
      return next();
    }

    try {
      const auth = await authenticateRequest(req);
      req.token = auth.token;
      req.decoded = auth.decoded;
      req.driver = auth.driver;
      req.user = auth.user;
      req.authRole = auth.role;
      req.authActorId = auth.actorId;

      const queryId = req.query?.[param] != null ? String(req.query[param]).trim() : '';
      if (queryId && auth.role === role && queryId !== auth.actorId) {
        const msg = `${param} does not match authenticated ${role}`;
        if (isStrict(mode)) {
          return sendAuthFailure(res, authError(403, msg, msg));
        }
        logAuthWarn('rest', msg, { path: req.path, queryId, actorId: auth.actorId });
        req.query[param] = auth.actorId;
      } else if (auth.role === role && !queryId) {
        req.query[param] = auth.actorId;
      }

      return next();
    } catch (err) {
      if (isStrict(mode)) {
        return sendAuthFailure(res, err);
      }
      logAuthWarn('rest', err.message || 'Auth failed', { path: req.path });
      return next();
    }
  };
}

/** Scheduler/admin secret for cron endpoints (not mobile JWT). */
function requireSchedulerSecret(req, res, next) {
  const expected = process.env.SCHEDULER_SECRET;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        success: false,
        message: 'Scheduler endpoints disabled — set SCHEDULER_SECRET',
        data: null
      });
    }
    return next();
  }
  const provided = req.headers['x-scheduler-secret'] || req.body?.scheduler_secret;
  if (provided !== expected) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden',
      data: { error: 'Invalid scheduler secret' }
    });
  }
  return next();
}

/** GET /rides/active and /rides/details — caller supplies user_id OR driver_id. */
function requireRideScopeQuery(req, res, next) {
  const mode = getRestEnforcementMode();
  if (mode === 'off') {
    return next();
  }

  const queryUserId = req.query?.user_id != null ? String(req.query.user_id).trim() : '';
  const queryDriverId = req.query?.driver_id != null ? String(req.query.driver_id).trim() : '';

  return authenticateRequest(req)
    .then((auth) => {
      req.token = auth.token;
      req.decoded = auth.decoded;
      req.driver = auth.driver;
      req.user = auth.user;
      req.authRole = auth.role;
      req.authActorId = auth.actorId;

      if (auth.role === 'user') {
        if (queryDriverId && !queryUserId) {
          const msg = 'Users must query with user_id';
          if (isStrict(mode)) return sendAuthFailure(res, authError(403, msg, msg));
          logAuthWarn('rest', msg, { path: req.path });
        }
        if (queryUserId && queryUserId !== auth.actorId) {
          const msg = 'user_id does not match authenticated user';
          if (isStrict(mode)) return sendAuthFailure(res, authError(403, msg, msg));
          logAuthWarn('rest', msg, { path: req.path, queryUserId, actorId: auth.actorId });
          req.query.user_id = auth.actorId;
        } else if (!queryUserId) {
          req.query.user_id = auth.actorId;
        }
      } else if (auth.role === 'driver') {
        if (queryUserId && !queryDriverId) {
          const msg = 'Drivers must query with driver_id';
          if (isStrict(mode)) return sendAuthFailure(res, authError(403, msg, msg));
          logAuthWarn('rest', msg, { path: req.path });
        }
        if (queryDriverId && queryDriverId !== auth.actorId) {
          const msg = 'driver_id does not match authenticated driver';
          if (isStrict(mode)) return sendAuthFailure(res, authError(403, msg, msg));
          logAuthWarn('rest', msg, { path: req.path, queryDriverId, actorId: auth.actorId });
          req.query.driver_id = auth.actorId;
        } else if (!queryDriverId) {
          req.query.driver_id = auth.actorId;
        }
      }

      return next();
    })
    .catch((err) => {
      if (isStrict(mode)) {
        return sendAuthFailure(res, err);
      }
      logAuthWarn('rest', err.message || 'Auth failed', { path: req.path });
      return next();
    });
}

/** Block generic CRUD on sensitive collections — use named routes instead. */
const BLOCKED_DYNAMIC_COLLECTIONS = new Set(['drivers', 'users', 'admins']);

function blockSensitiveDynamicCrud(req, res, next) {
  const collection = String(req.params.collectionName || '').trim().toLowerCase();
  if (!BLOCKED_DYNAMIC_COLLECTIONS.has(collection)) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: `Generic CRUD on /${collection} is disabled. Use dedicated /api/${collection}/* routes.`,
    data: { collection, method: req.method }
  });
}

module.exports = {
  authenticateRequest,
  authenticateSocket,
  requireAuth,
  requireQueryActor,
  requireRideScopeQuery,
  requireSchedulerSecret,
  blockSensitiveDynamicCrud,
  getRestEnforcementMode,
  getSocketEnforcementMode
};
