/** What the dashboard receives. Internal ids and hashes never leave the server. */

const publicTenant = (t) => ({
  id: t.tenantId,
  appId: t.tenantId, // the immutable business identifier
  name: t.name,
  slug: t.slug,
  appName: t.appName,
  packageName: t.packageName,
  city: t.city,
  plan: t.plan,
  status: t.status,
  brandColor: t.brandColor,
  supportEmail: t.supportEmail || '',
  supportPhone: t.supportPhone || '',
  market: t.market && t.market.country ? { country: t.market.country, currency: t.market.currency, timezone: t.market.timezone } : null,
  createdAt: new Date(t.createdAt).toISOString().slice(0, 10)
});

const publicAdmin = (a) => ({
  id: a.adminId, name: a.name, email: a.email, role: a.role, tenantId: a.tenantId || null,
  mustChangePassword: !!a.mustChangePassword, active: a.active !== false
});

const publicRegion = (r) => ({
  id: r.regionId, country: r.country, state: r.state, city: r.city, zoneName: r.zoneName, active: r.active,
  createdAt: r.createdAt, updatedAt: r.updatedAt
});

const publicCategory = (c) => ({
  id: c.categoryId, name: c.name, description: c.description || '', icon: c.icon, imageUrl: c.imageUrl || '',
  passengerCapacity: c.passengerCapacity, luggageCapacity: c.luggageCapacity ?? null, rideType: c.rideType,
  regionIds: c.regionIds || [], active: c.active, createdAt: c.createdAt, updatedAt: c.updatedAt
});

const publicFareRule = (f) => ({
  id: f.ruleId, categoryId: f.categoryId, regionId: f.regionId || null, currency: f.currency,
  baseFare: f.baseFare, perKm: f.perKm, perMinute: f.perMinute, minimumFare: f.minimumFare, bookingFee: f.bookingFee,
  waitingFreeMinutes: f.waitingFreeMinutes, waitingPerMinute: f.waitingPerMinute,
  additionalCharges: (f.additionalCharges || []).map((c) => ({ name: c.name, type: c.type, amount: c.amount })),
  taxes: (f.taxes || []).map((t) => ({ name: t.name, ratePercent: t.ratePercent, appliesTo: t.appliesTo })),
  surge: { enabled: !!f.surge?.enabled, maxMultiplier: f.surge?.maxMultiplier ?? 1 },
  active: f.active, createdAt: f.createdAt, updatedAt: f.updatedAt
});

const publicPolicy = (p) => ({
  id: p.policyId, categoryId: p.categoryId, regionId: p.regionId || null, currency: p.currency,
  rider: {
    freeCancellationMinutes: p.rider?.freeCancellationMinutes ?? 0, feeAfterWindow: p.rider?.feeAfterWindow ?? 0,
    feeAfterDriverArrived: p.rider?.feeAfterDriverArrived ?? 0, noShowFee: p.rider?.noShowFee ?? 0
  },
  driver: { penaltyFee: p.driver?.penaltyFee ?? 0, graceCancellations: p.driver?.graceCancellations ?? 0 },
  conditions: p.conditions || '', active: p.active, createdAt: p.createdAt, updatedAt: p.updatedAt
});

module.exports = { publicTenant, publicAdmin, publicRegion, publicCategory, publicFareRule, publicPolicy };
