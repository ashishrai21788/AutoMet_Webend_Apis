const { resolveTenantScope } = require('./tenantScope');
const { isSuperAdmin } = require('./adminPermissions');
const { forTenant, forTenantWithUntagged } = require('./tenantData');

/**
 * Picks the business a request works on, after requireAdmin has authenticated the caller.
 *  - the business is named by the X-App-Id header;
 *  - resolveTenantScope checks that this caller may use it (a business user can only ever use their own; a different
 *    appId is a 403, whatever the request says);
 *  - the super admin must name one.
 * Sets req.business (the tenant record) and req.data (queries bound to that appId).
 */
function createBusinessContext({ loadTenant }) {
  return async function businessContext(req, res, next) {
    try {
      // The platform owner manages businesses (their existence, plans and billing), not their daily operations. Even if a route's
      // permission check were ever loosened, a super admin can never reach a business's drivers, trips, prices or documents here.
      if (isSuperAdmin(req.admin)) {
        return res.status(403).json({ success: false, message: "The platform owner does not operate businesses. A business's own admins manage its drivers, trips and settings.", error: 'PLATFORM_ROLE', data: null });
      }
      const requested = req.headers['x-app-id'] ? String(req.headers['x-app-id']).trim() : null;
      const appId = resolveTenantScope(req.admin, requested);
      if (!appId) {
        return res.status(400).json({ success: false, message: 'Select a business first (X-App-Id header)', data: null });
      }
      const tenant = req.adminTenant && req.adminTenant.tenantId === appId ? req.adminTenant : await loadTenant(appId);
      if (!tenant) return res.status(404).json({ success: false, message: 'Business not found', data: null });
      req.business = tenant;
      req.data = forTenant(appId);
      req.legacyData = forTenantWithUntagged(tenant); // drivers and riders, which may predate tenant tagging
      return next();
    } catch (err) {
      return res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Could not resolve the business', data: null });
    }
  };
}

module.exports = { createBusinessContext };
