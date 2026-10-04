const { ServiceRegion, VehicleCategory, FareRule } = require('../models/businessModels');
const { forTenant } = require('../lib/tenantData');
const { buildPublicConfig } = require('../lib/publicConfig');

/**
 * GET /api/v1/public/business/config
 * The business is the one the app named in X-App-Id (resolved by appTenantMiddleware); an app that names none gets the
 * default business and is told so (`resolvedBy: "default"`). No sign-in is needed: the app needs this before anyone
 * has signed in, and it only holds what the business wants riders and drivers to see.
 */
exports.businessConfig = async (req, res) => {
  try {
    const tenant = req.appTenant;
    if (!tenant) return res.status(404).json({ success: false, message: 'No business is set up yet', data: null });

    const d = forTenant(tenant.tenantId);
    const [regions, categories, fareRules] = await Promise.all([
      d.find(ServiceRegion).lean(), d.find(VehicleCategory).lean(), d.find(FareRule, { active: true }).lean()
    ]);
    const pricedCategoryIds = new Set(fareRules.map((r) => r.categoryId));
    const body = buildPublicConfig({
      tenant, regions, categories, pricedCategoryIds, resolvedBy: req.headers['x-app-id'] ? 'header' : 'default'
    });

    const etag = `"${body.version}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=60');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    return res.status(200).json({ success: true, message: 'OK', data: body });
  } catch (e) {
    console.error('[public] business config:', e.message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.', data: null });
  }
};
