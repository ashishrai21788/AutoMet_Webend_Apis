const { Tenant, AdminAudit } = require('../models/adminModels');
const { clearAppTenantCache } = require('../lib/appTenant');
const { digitsOf } = require('../lib/riderInvoice');
const tolls = require('../lib/tolls');
const c = require('./fleet/common');

const currencyOf = (req) => (req.business.market && req.business.market.currency) || 'INR';

async function audit(req, action, meta) {
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType: 'business', targetId: req.business.tenantId, meta: meta || null, ip: req.ip || null });
  } catch (e) { console.warn('[tolls] audit write failed:', e.message); }
}

const shape = (req, s) => ({ enabled: s.enabled, maxToll: s.maxTollMinor / 10 ** digitsOf(currencyOf(req)), currency: currencyOf(req) });

/** GET /api/admin/business/toll-settings */
exports.get = c.handle(async (req, res) => c.ok(res, shape(req, tolls.settingsOf(req.business))));

/** PUT /api/admin/business/toll-settings { enabled, maxToll } (major units) */
exports.update = c.handle(async (req, res) => {
  const { value, errors } = tolls.validateSettings(req.body, req.business);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  await req.data.update(Tenant, {}, { tollSettings: value });
  clearAppTenantCache();
  await audit(req, 'business.toll_settings_updated', { enabled: value.enabled, maxTollMinor: value.maxTollMinor });
  await require('./configHistoryController').track(req, 'business.toll_settings_updated', { tollSettings: value });
  return c.ok(res, shape(req, value));
});
