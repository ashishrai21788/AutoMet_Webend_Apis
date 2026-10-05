const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { can } = require('./adminPermissions');
const { requiredForPlatform } = require('./totp');

const ADMIN_TOKEN_TTL = process.env.ADMIN_TOKEN_TTL || '12h';

/**
 * Admin tokens are signed with a key derived from JWT_SECRET, so a driver or rider token can never pass as an
 * admin token (and the reverse), even though both come from the same secret.
 */
function adminSecret() {
  const base = process.env.JWT_SECRET;
  if (!base) {
    const err = new Error('Server auth misconfigured');
    err.status = 500;
    throw err;
  }
  return crypto.createHmac('sha256', base).update('automet-admin-v1').digest('hex');
}

/** A short-lived pass given after the password is right and before the code is checked. It opens nothing else. */
function signChallenge(admin) {
  return jwt.sign({ typ: 'admin-2fa', adminId: admin.adminId, tv: admin.tokenVersion || 0 }, adminSecret(), { expiresIn: '5m' });
}

function readChallenge(token) {
  const d = jwt.verify(String(token || ''), adminSecret());
  if (d.typ !== 'admin-2fa') throw new Error('wrong token type');
  return d;
}

function signAdminToken(admin) {
  return jwt.sign(
    { typ: 'admin', adminId: admin.adminId, role: admin.role, tenantId: admin.tenantId || null, tv: admin.tokenVersion || 0 },
    adminSecret(),
    { expiresIn: ADMIN_TOKEN_TTL }
  );
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Builds the middleware factory. `loadAdmin(adminId)` and `loadTenant(tenantId)` are injected so the checks can be
 * tested without a database.
 */
function createRequireAdmin({ loadAdmin, loadTenant }) {
  /** `options.setup`: routes the platform owner may use before two-step verification is on (profile, password, the setup itself). */
  return function requireAdmin(permission, options = {}) {
    return async function adminMiddleware(req, res, next) {
      try {
        const header = req.headers?.authorization || '';
        if (!header.startsWith('Bearer ')) throw fail(401, 'Access token required');

        let decoded;
        try {
          decoded = jwt.verify(header.substring(7), adminSecret());
        } catch (e) {
          if (e.status) throw e;
          throw fail(401, e.name === 'TokenExpiredError' ? 'Session expired, please sign in again' : 'Invalid token');
        }
        if (decoded.typ !== 'admin' || !decoded.adminId) throw fail(401, 'Invalid token');

        const admin = await loadAdmin(decoded.adminId);
        if (!admin || !admin.active || (admin.tokenVersion || 0) !== decoded.tv) {
          throw fail(401, 'Session is no longer valid, please sign in again');
        }
        if (admin.tenantId) {
          const tenant = await loadTenant(admin.tenantId);
          if (!tenant) throw fail(403, 'Client not found');
          if (tenant.status === 'suspended') throw fail(403, 'This client account is suspended');
          req.adminTenant = tenant;
        }
        if (permission && !can(admin, permission)) throw fail(403, 'Your role does not include this action');
        if (!options.setup && admin.role === 'super_admin' && !admin.totpEnabled && requiredForPlatform()) {
          const err = fail(403, 'Set up two-step verification before using the platform dashboard');
          err.code = 'TWO_FACTOR_SETUP_REQUIRED';
          throw err;
        }

        req.admin = admin;
        return next();
      } catch (err) {
        return res.status(err.status || 401).json({ success: false, message: err.message, ...(err.code ? { error: err.code } : {}), data: null });
      }
    };
  };
}

module.exports = { signAdminToken, signChallenge, readChallenge, createRequireAdmin, adminSecret };
