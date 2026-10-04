/**
 * Platform overview for the super admin: one row per business with its size, activity and setup progress, plus platform
 * totals and integration status. Aggregated counts only: no rider, driver, trip or document is exposed, and opening a
 * business's own screens still goes through the normal business context.
 */
const { Tenant, AdminUser } = require('../models/adminModels');
const { ServiceRegion, VehicleCategory, FareRule, SetupProgress } = require('../models/businessModels');
const { TripDetails } = require('../models/tripDetailsModel');
const { createModel } = require('../models/dynamicModel');
const { computeSetup } = require('../lib/businessSetup');
const { startOfDay } = require('../lib/timeZone');
const { ONGOING } = require('../lib/adminDashboard');
const { integrationStatus } = require('../lib/integrationStatus');
const c = require('./fleet/common');

const DAY = 24 * 60 * 60 * 1000;
const MAX_ROWS = 20000;

exports.overview = c.handle(async (req, res) => {
  const tenants = await Tenant.find({}).sort({ createdAt: 1 }).lean();
  const defaultId = (tenants.find((t) => t.isDefault) || {}).tenantId || null;
  const keyOf = (v) => v || defaultId; // records with no tag belong to the default business
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 6 * DAY);
  const ids = tenants.map((t) => t.tenantId);
  const inList = { tenantId: { $in: ids } };

  const [regions, categories, fareRules, progress, admins, drivers, riders, trips] = await Promise.all([
    ServiceRegion.find(inList).select('tenantId active center radiusKm').lean(), VehicleCategory.find(inList).select('tenantId active').lean(),
    FareRule.find(inList).select('tenantId categoryId active').lean(), SetupProgress.find(inList).lean(),
    AdminUser.find({ tenantId: { $in: ids }, active: true }).select('tenantId').lean(),
    createModel('drivers').find({}).select('tenantId isOnline accountStatus').limit(MAX_ROWS).lean(),
    createModel('users').find({}).select('tenantId createdAt').limit(MAX_ROWS).lean(),
    TripDetails.find({ requested_at: { $gte: weekAgo } }).select('tenant_id status requested_at').limit(MAX_ROWS).lean()
  ]);

  const rows = new Map(tenants.map((t) => [t.tenantId, {
    appId: t.tenantId, name: t.name, appName: t.appName, status: t.status, plan: t.plan, isDefault: !!t.isDefault, createdAt: t.createdAt,
    tz: (t.market && t.market.timezone) || 'UTC',
    drivers: { total: 0, online: 0, suspended: 0 }, riders: { total: 0, newThisWeek: 0 }, admins: 0,
    trips: { requestedToday: 0, active: 0, searching: 0, last7Days: 0 }
  }]));
  for (const d of drivers) { const r = rows.get(keyOf(d.tenantId)); if (!r) continue; r.drivers.total++; if (d.isOnline) r.drivers.online++; if (d.accountStatus === 'SUSPENDED') r.drivers.suspended++; }
  for (const u of riders) { const r = rows.get(keyOf(u.tenantId)); if (!r) continue; r.riders.total++; if (u.createdAt && new Date(u.createdAt) >= weekAgo) r.riders.newThisWeek++; }
  for (const a of admins) { const r = rows.get(a.tenantId); if (r) r.admins++; }
  const dayStarts = new Map([...rows.values()].map((r) => [r.appId, startOfDay(now, r.tz)]));
  for (const t of trips) {
    const r = rows.get(keyOf(t.tenant_id));
    if (!r) continue;
    r.trips.last7Days++;
    if (new Date(t.requested_at) >= dayStarts.get(r.appId)) r.trips.requestedToday++;
    if (ONGOING.includes(t.status)) r.trips.active++;
    if (t.status === 'REQUESTED') r.trips.searching++;
  }

  const mine = (list, id) => list.filter((x) => x.tenantId === id);
  const items = tenants.map((t) => {
    const r = rows.get(t.tenantId);
    const setup = computeSetup({
      market: t.market && t.market.country ? t.market : null, regions: mine(regions, t.tenantId), categories: mine(categories, t.tenantId),
      fareRules: mine(fareRules, t.tenantId), completedAt: (mine(progress, t.tenantId)[0] || {}).completedAt || null
    });
    const { tz, ...out } = r;
    return { ...out, setup: { percent: setup.percent, complete: setup.complete, nextStep: setup.nextStep ? setup.nextStep.title : null } };
  });

  const sum = (pick) => items.reduce((n, i) => n + pick(i), 0);
  return c.ok(res, {
    totals: {
      businesses: items.length, active: items.filter((i) => i.status === 'active').length, trial: items.filter((i) => i.status === 'trial').length,
      suspended: items.filter((i) => i.status === 'suspended').length, setupComplete: items.filter((i) => i.setup.complete).length,
      drivers: sum((i) => i.drivers.total), driversOnline: sum((i) => i.drivers.online), riders: sum((i) => i.riders.total),
      tripsToday: sum((i) => i.trips.requestedToday), activeTrips: sum((i) => i.trips.active), tripsLast7Days: sum((i) => i.trips.last7Days)
    },
    businesses: items,
    integrations: integrationStatus(),
    partial: drivers.length >= MAX_ROWS || riders.length >= MAX_ROWS || trips.length >= MAX_ROWS,
    generatedAt: now.toISOString()
  });
});
