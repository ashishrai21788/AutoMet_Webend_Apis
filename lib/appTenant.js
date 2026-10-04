/**
 * Which business a rider or driver request belongs to.
 *
 * Each business's app sends its App ID in the X-App-Id header. A request without the header belongs to the default
 * business, so the apps that exist today keep working unchanged. The result is `req.appTenant` (a tenant record, or
 * null when no default business exists yet).
 *
 *  - unknown App ID            -> 400
 *  - suspended business        -> 403 (its apps stop working; other businesses are unaffected)
 *  - database trouble while resolving the default business -> carry on with no business (never blocks existing traffic)
 *
 * Accounts are tagged with the business at sign-up (`tenantId`), and a trip can only be requested between a rider and
 * a driver of the same business (see sameBusiness).
 */
const CACHE_MS = 60 * 1000;
const cache = new Map(); // key -> { tenant, at }

function cached(key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < CACHE_MS ? hit : null;
}

async function lookup(key, query) {
  const hit = cached(key);
  if (hit) return hit.tenant;
  const tenant = await query();
  cache.set(key, { tenant: tenant || null, at: Date.now() });
  return tenant || null;
}

const models = () => require('../models/adminModels');

const defaultTenant = () => lookup('default', () => models().Tenant.findOne({ isDefault: true }).lean());
const tenantById = (id) => lookup(`id:${id}`, () => models().Tenant.findOne({ tenantId: id }).lean());

function clearAppTenantCache() {
  cache.clear();
}

async function appTenantMiddleware(req, res, next) {
  const header = req.headers['x-app-id'] ? String(req.headers['x-app-id']).trim() : '';
  try {
    if (header) {
      const tenant = await tenantById(header);
      if (!tenant) return res.status(400).json({ success: false, message: 'Unknown app', data: null });
      if (tenant.status === 'suspended') return res.status(403).json({ success: false, message: 'This app is currently unavailable', data: null });
      req.appTenant = tenant;
    } else {
      req.appTenant = await defaultTenant();
    }
    return next();
  } catch (e) {
    if (header) return res.status(503).json({ success: false, message: 'Could not verify the app. Please try again.', data: null });
    console.warn('[appTenant] default business lookup failed, continuing without one:', e.message);
    req.appTenant = null;
    return next();
  }
}

/** The business an account belongs to: its own tag, else the default business (null if there is none). */
async function effectiveTenantId(doc) {
  if (doc && doc.tenantId) return doc.tenantId;
  const def = await defaultTenant().catch(() => null);
  return def ? def.tenantId : null;
}

/** The business record an account belongs to (its own tag, else the default business). */
async function tenantForAccount(doc) {
  if (doc && doc.tenantId) return tenantById(doc.tenantId);
  return defaultTenant();
}

async function sameBusiness(a, b) {
  const [x, y] = await Promise.all([effectiveTenantId(a), effectiveTenantId(b)]);
  return x === y;
}

module.exports = { appTenantMiddleware, effectiveTenantId, tenantForAccount, sameBusiness, defaultTenant, tenantById, clearAppTenantCache };
