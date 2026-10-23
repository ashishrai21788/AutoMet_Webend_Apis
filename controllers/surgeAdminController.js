/**
 * Surge pricing in the admin dashboard (Pricing).
 *
 *   GET /api/admin/business/surge           whether surge is paused, and what the multiplier is right now in each area that has a
 *                                           fare rule with surge switched on (demand and supply behind it included)
 *   PUT /api/admin/business/surge-settings  { paused }  stop all surge at once (fares go back to the normal rule)
 *
 * Which rules may surge, and by how much at most, is set per fare rule (Pricing & Fare Rules). The multiplier itself comes from
 * the demand around a pickup (lib/surge.js).
 */
const { Tenant, AdminAudit } = require('../models/adminModels');
const { ServiceRegion, VehicleCategory, FareRule } = require('../models/businessModels');
const { TripDetails } = require('../models/tripDetailsModel');
const { createModel } = require('../models/dynamicModel');
const { effectiveTenantId } = require('../lib/appTenant');
const { clearAppTenantCache } = require('../lib/appTenant');
const surge = require('../lib/surge');
const configHistory = require('./configHistoryController');
const c = require('./fleet/common');

async function freeDriversOfBusiness(tenantId) {
  const online = await createModel('drivers').find({ isOnline: true }).limit(500).lean();
  const mine = [];
  for (const d of online) if ((await effectiveTenantId(d)) === tenantId) mine.push(d);
  if (!mine.length) return [];
  const busy = await TripDetails.find({ driver_id: { $in: mine.map((d) => d.driverId) }, status: { $in: ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'] } }).select('driver_id').lean();
  const busyIds = new Set(busy.map((t) => t.driver_id));
  return mine.filter((d) => !busyIds.has(d.driverId));
}

exports.get = c.handle(async (req, res) => {
  const tenant = req.business;
  const settings = surge.settingsOf(tenant);
  const [regions, categories, rules] = await Promise.all([req.data.find(ServiceRegion).lean(), req.data.find(VehicleCategory).lean(), req.data.find(FareRule, { active: true }).lean()]);
  const ruleList = rules.filter((r) => r.surge && r.surge.enabled).map((r) => ({
    categoryId: r.categoryId, category: (categories.find((x) => x.categoryId === r.categoryId) || {}).name || 'Unknown', regionId: r.regionId || null,
    area: r.regionId ? ((regions.find((x) => x.regionId === r.regionId) || {}).city || 'Region') : 'All regions (default)', maxMultiplier: r.surge.maxMultiplier
  }));
  let areas = [];
  if (ruleList.length && !settings.paused) {
    const free = await freeDriversOfBusiness(tenant.tenantId);
    for (const reg of regions.filter((x) => x.active && x.center && Number.isFinite(x.center.lat) && Number.isFinite(x.center.lng))) {
      for (const cat of categories.filter((x) => x.active && (x.regionIds || []).includes(reg.regionId))) {
        const rule = rules.find((r) => r.categoryId === cat.categoryId && r.regionId === reg.regionId) || rules.find((r) => r.categoryId === cat.categoryId && !r.regionId);
        if (!rule || !rule.surge || !rule.surge.enabled) continue;
        const at = await surge.surgeAt({ tenant, pickup: { lat: reg.center.lat, lng: reg.center.lng }, categoryId: cat.categoryId, freeDrivers: free });
        areas.push({ regionId: reg.regionId, area: `${reg.city}${reg.zoneName && reg.zoneName !== 'All areas' ? ` (${reg.zoneName})` : ''}`, categoryId: cat.categoryId, category: cat.name, multiplier: Math.min(at.multiplier, Number(rule.surge.maxMultiplier) || 1), demand: at.demand, supply: at.supply });
      }
    }
  }
  return c.ok(res, { paused: settings.paused, rules: ruleList, areas, ladder: surge.LADDER.map(([ratio, multiplier]) => ({ ratio, multiplier })).reverse(), minDemand: surge.MIN_DEMAND, nearKm: surge.NEAR_KM });
});

exports.update = c.handle(async (req, res) => {
  const paused = !!(req.body && req.body.paused);
  const before = surge.settingsOf(req.business).paused;
  if (before === paused) return c.ok(res, { paused });
  await req.data.update(Tenant, {}, { surgeSettings: { paused } });
  clearAppTenantCache();
  surge.clearSurgeCache();
  await configHistory.track(req, 'business.surge_settings_updated', { surgeSettings: { paused } });
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action: paused ? 'surge.paused' : 'surge.resumed', targetType: 'business', targetId: req.business.tenantId, meta: { paused }, ip: req.ip || null });
  } catch (e) { console.warn('[surge] audit write failed:', e.message); }
  return c.ok(res, { paused });
});
