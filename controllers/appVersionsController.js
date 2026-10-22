const { Tenant, AdminAudit } = require('../models/adminModels');
const { clearAppTenantCache } = require('../lib/appTenant');
const versions = require('../lib/appVersions');
const c = require('./fleet/common');

async function audit(req, action, meta) {
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType: 'business', targetId: req.business.tenantId, meta: meta || null, ip: req.ip || null });
  } catch (e) { console.warn('[appVersions] audit write failed:', e.message); }
}

/** GET /api/admin/business/app-versions */
exports.get = c.handle(async (req, res) => c.ok(res, { ...versions.settingsOf(req.business), defaultMessage: versions.DEFAULT_MESSAGE }));

/** PUT /api/admin/business/app-versions { rider: { minVersionCode, message, storeUrl }, driver: {...} } */
exports.update = c.handle(async (req, res) => {
  const { value, errors } = versions.validate(req.body);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  await req.data.update(Tenant, {}, { appVersions: value });
  clearAppTenantCache(); // the servers' own copy of the business is refreshed now, not after its cache runs out
  await audit(req, 'business.app_versions_updated', { rider: value.rider.minVersionCode, driver: value.driver.minVersionCode });
  return c.ok(res, { ...value, defaultMessage: versions.DEFAULT_MESSAGE });
});
