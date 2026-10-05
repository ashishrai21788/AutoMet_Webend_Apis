/**
 * Small fixed-window rate limiter with no dependencies.
 *
 * The counters live in this process's memory, so the limit is per server instance and resets on restart. That is enough
 * to stop OTP guessing and password spraying on a single Render instance; with several instances, move the counters to
 * a shared store (Redis) and keep the same middleware interface.
 */

const stores = new Set();

function createLimiter({ name, windowMs, max, key, message }) {
  const hits = new Map(); // key -> { count, resetAt }
  stores.add(hits);

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(windowMs, 60 * 1000));
  if (sweep.unref) sweep.unref();

  const middleware = (req, res, next) => {
    if (process.env.RATE_LIMIT_DISABLED === '1') return next(); // for tests of other features that sign in many times
    let id;
    try { id = key(req); } catch { id = null; }
    if (!id) return next(); // nothing to count against (the handler will reject the request itself)

    const now = Date.now();
    let entry = hits.get(id);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(id, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        message: message || 'Too many attempts. Please wait a few minutes and try again.',
        error: 'RATE_LIMITED',
        retryAfter,
        data: null,
      });
    }
    next();
  };
  middleware.limiterName = name;
  middleware.reset = () => hits.clear();
  return middleware;
}

/** Clears every counter (used by tests). */
function resetAllLimiters() {
  for (const hits of stores) hits.clear();
}

const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/** The person an OTP or login attempt is about, taken from the body; normalised so "+91 9876" and "+919876" match. */
function subjectOf(req) {
  const b = req.body || {};
  const raw = b.driverId || b.userId || b.phoneNumber || b.phone || b.email || b.mobile || b.mobileNumber;
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw).trim().toLowerCase().replace(/[\s-]/g, '').slice(0, 80);
}

const MIN = 60 * 1000;

/** Asking for a code: costs money (SMS) and lets someone spam a phone, so it is tight per person. */
const otpSendLimiters = (scope) => [
  createLimiter({ name: `${scope}-send-ip`, windowMs: 10 * MIN, max: 30, key: (r) => `${scope}:send:ip:${clientIp(r)}` }),
  createLimiter({ name: `${scope}-send-subject`, windowMs: 10 * MIN, max: 5, key: (r) => { const s = subjectOf(r); return s && `${scope}:send:sub:${s}`; } }),
];

/** Checking a code: a six digit code has a million values, so guesses per person are kept very low. */
const otpVerifyLimiters = (scope) => [
  createLimiter({ name: `${scope}-verify-ip`, windowMs: 10 * MIN, max: 60, key: (r) => `${scope}:verify:ip:${clientIp(r)}` }),
  createLimiter({ name: `${scope}-verify-subject`, windowMs: 10 * MIN, max: 8, key: (r) => { const s = subjectOf(r); return s && `${scope}:verify:sub:${s}`; } }),
];

/** Password sign-in. The admin account also locks itself after repeated failures; this stops spraying across accounts. */
const adminLoginLimiters = () => [
  createLimiter({ name: 'admin-login-ip', windowMs: 15 * MIN, max: 30, key: (r) => `admin:login:ip:${clientIp(r)}` }),
  createLimiter({ name: 'admin-login-subject', windowMs: 15 * MIN, max: 10, key: (r) => { const s = subjectOf(r); return s && `admin:login:sub:${s}`; } }),
];

/** Forgot-password: sends email, so it is tight per address as well as per network. Reset: guesses at a 256-bit token are hopeless, but cap them anyway. */
const adminForgotLimiters = () => [
  createLimiter({ name: 'admin-forgot-ip', windowMs: 15 * MIN, max: 10, key: (r) => `admin:forgot:ip:${clientIp(r)}` }),
  createLimiter({ name: 'admin-forgot-subject', windowMs: 15 * MIN, max: 3, key: (r) => { const s = subjectOf(r); return s && `admin:forgot:sub:${s}`; } }),
];
const adminResetLimiters = () => [
  createLimiter({ name: 'admin-reset-ip', windowMs: 15 * MIN, max: 20, key: (r) => `admin:reset:ip:${clientIp(r)}` }),
];

const adminTwoFactorLimiters = () => [
  createLimiter({ name: 'admin-2fa-ip', windowMs: 15 * MIN, max: 30, key: (r) => `admin:2fa:ip:${clientIp(r)}` }),
];

module.exports = { createLimiter, resetAllLimiters, otpSendLimiters, otpVerifyLimiters, adminLoginLimiters, adminForgotLimiters, adminResetLimiters, adminTwoFactorLimiters, subjectOf, clientIp };
