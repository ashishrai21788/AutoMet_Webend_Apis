// Demand-based surge: the ladder, demand and supply counts, when it applies, the rider protections, and the admin switch.
process.env.JWT_SECRET = 'test-secret-for-surge';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const surge = require('../lib/surge');
const { priceTrip, withSurge, priceTripWithCoupon } = require('../lib/tripPricing');
const A = require('../controllers/surgeAdminController');
const { clearAppTenantCache } = require('../lib/appTenant');

const PICKUP = { lat: 28.5746, lng: 77.4858 };
const DROP = { lat: 28.6, lng: 77.5 };
const tenant = { tenantId: 't1', market: { country: 'IN', currency: 'INR' } };
const rule = (surgeOn, max = 2) => ({
  ruleId: 'r1', categoryId: 'c1', regionId: null, regionKey: 'default', active: true, currency: 'INR', baseFare: 10, perKm: 10, perMinute: 10, minimumFare: 50, bookingFee: 0,
  waitingFreeMinutes: 3, waitingPerMinute: 1, additionalCharges: [], taxes: [], surge: { enabled: surgeOn, maxMultiplier: max }, updatedAt: new Date()
});
const config = (surgeOn, max) => ({ market: { country: 'IN', currency: 'INR' }, regions: [], categories: [{ categoryId: 'c1', name: 'VIP', active: true, regionIds: [] }], fareRules: [rule(surgeOn, max)], pricingVersion: null });
const driverAt = (id, lat, lng) => ({ driverId: id, isOnline: true, lastLocation: { type: 'Point', coordinates: [lng, lat] } });

const reset = async () => {
  for (const m of ['Tenant', 'RiderPresence', 'TripDetails', 'ServiceRegion', 'VehicleCategory', 'FareRule', 'ConfigVersion', 'AdminAudit']) db[m].rows.length = 0;
  surge.clearSurgeCache(); clearAppTenantCache();
};
const crowd = async (riders, requests = 0) => {
  const now = new Date();
  for (let i = 0; i < riders; i += 1) await db.RiderPresence.create({ userId: `U${i}`, tenantId: 't1', lat: PICKUP.lat + 0.001, lng: PICKUP.lng, lastSeen: now });
  for (let i = 0; i < requests; i += 1) await db.TripDetails.create({ trip_id: `T${i}`, request_id: `R${i}`, user_id: `X${i}`, tenant_id: 't1', status: 'REQUESTED', requested_at: now, pickup: { address: 'a', lat: PICKUP.lat, lng: PICKUP.lng }, drop: { address: 'b', lat: DROP.lat, lng: DROP.lng } });
};

test('the ladder: quiet areas never surge, and the multiplier climbs with demand per available driver', () => {
  assert.equal(surge.multiplierFor({ demand: 2, supply: 0 }), 1, 'under the minimum demand there is no surge, even with no drivers');
  assert.equal(surge.multiplierFor({ demand: 3, supply: 3 }), 1);
  assert.equal(surge.multiplierFor({ demand: 6, supply: 4 }), 1.2);
  assert.equal(surge.multiplierFor({ demand: 6, supply: 3 }), 1.5);
  assert.equal(surge.multiplierFor({ demand: 6, supply: 2 }), 2);
  assert.equal(surge.multiplierFor({ demand: 8, supply: 2 }), 2.5);
  assert.equal(surge.multiplierFor({ demand: 8, supply: 0 }), 2.5, 'no drivers counts as one: the top step');
});

test('supply counts only drivers within 3 km that have a position', () => {
  const free = [driverAt('a', 28.5750, 77.4860), driverAt('b', 28.60, 77.60), { driverId: 'c', isOnline: true }];
  assert.equal(surge.supplyNear(free, PICKUP), 1);
  assert.equal(surge.supplyNear([], PICKUP), 0);
});

test('demand counts riders with the app open and recent requests near the pickup, not far ones or old ones', async () => {
  await reset();
  await crowd(2, 1);
  await db.RiderPresence.create({ userId: 'far', tenantId: 't1', lat: 29.5, lng: 78.5, lastSeen: new Date() });
  await db.RiderPresence.create({ userId: 'old', tenantId: 't1', lat: PICKUP.lat, lng: PICKUP.lng, lastSeen: new Date(Date.now() - 20 * 60 * 1000) });
  await db.TripDetails.create({ trip_id: 'T-old', request_id: 'R-old', user_id: 'Z', tenant_id: 't1', status: 'COMPLETED', requested_at: new Date(Date.now() - 60 * 60 * 1000), pickup: { address: 'a', lat: PICKUP.lat, lng: PICKUP.lng }, drop: { address: 'b', lat: 1, lng: 1 } });
  const d = await surge.demandNear({ tenantId: 't1', pickup: PICKUP });
  assert.deepEqual([d.riders, d.requests, d.demand], [2, 1, 3]);
});

test('a fare rule with surge off is priced normally and costs no demand or supply lookups', async () => {
  await reset(); await crowd(10);
  let loaded = 0;
  const trip = await withSurge(config(false), { pickup: PICKUP, drop: DROP, categoryId: 'c1' }, { tenant, userId: 'U9', surge: { mode: 'estimate', loadFreeDrivers: async () => { loaded += 1; return []; } } });
  assert.equal(loaded, 0);
  assert.equal(trip.surgeMultiplier, undefined);
});

test('with surge on and demand, the estimate carries a surge line, capped by the rule maximum', async () => {
  await reset(); await crowd(8); // 8 riders, no drivers: ratio 8, top step 2.5
  const ctx = { tenant, userId: 'U9', surge: { mode: 'estimate', loadFreeDrivers: async () => [] } };
  const normal = priceTrip(config(true, 3), { pickup: PICKUP, drop: DROP, categoryId: 'c1' }).estimate;
  const uncapped = priceTrip(config(true, 3), await withSurge(config(true, 3), { pickup: PICKUP, drop: DROP, categoryId: 'c1' }, ctx)).estimate;
  assert.equal(uncapped.surge_multiplier, 2.5);
  assert.ok(uncapped.breakdown.lines.some((l) => l.key === 'surge'));
  assert.ok(uncapped.fare > normal.fare * 2, 'the ride charge is multiplied');
  surge.clearSurgeCache();
  const capped = priceTrip(config(true, 1.5), await withSurge(config(true, 1.5), { pickup: PICKUP, drop: DROP, categoryId: 'c1' }, ctx)).estimate;
  assert.equal(capped.surge_multiplier, 1.5, 'the rule maximum wins');
  assert.equal(normal.surge_multiplier, 1);
});

test('the multiplier for a spot is held for a minute so estimate and booking agree', async () => {
  await reset(); await crowd(8);
  let calls = 0;
  const ctx = { tenant, userId: 'U9', surge: { mode: 'estimate', loadFreeDrivers: async () => { calls += 1; return []; } } };
  const a = await surge.surgeAt({ tenant, pickup: PICKUP, categoryId: 'c1', freeDrivers: [] });
  await crowd(0); await db.RiderPresence.create({ userId: 'late', tenantId: 't1', lat: PICKUP.lat, lng: PICKUP.lng, lastSeen: new Date() });
  const b = await surge.surgeAt({ tenant, pickup: PICKUP, categoryId: 'c1', freeDrivers: [] });
  assert.equal(b.multiplier, a.multiplier);
  assert.equal(b.demand, a.demand, 'the held value is returned, not a fresh count');
  const later = await surge.surgeAt({ tenant, pickup: PICKUP, categoryId: 'c1', freeDrivers: [], now: new Date(Date.now() + 61 * 1000) });
  assert.equal(later.demand, a.demand + 1, 'after a minute it is counted again');
  void ctx; void calls;
});

test('a rider is never charged more than the multiplier they were shown', async () => {
  await reset(); await crowd(8);
  const est = { tenant, userId: 'U9', surge: { mode: 'estimate', loadFreeDrivers: async () => [driverAt('a', PICKUP.lat, PICKUP.lng), driverAt('b', PICKUP.lat, PICKUP.lng), driverAt('c', PICKUP.lat, PICKUP.lng), driverAt('d', PICKUP.lat, PICKUP.lng)] } }; // ratio 2: x1.5
  const shown = await withSurge(config(true, 3), { pickup: PICKUP, drop: DROP, categoryId: 'c1' }, est);
  assert.equal(shown.surgeMultiplier, 1.5);
  // demand jumps and the held value expires before the rider books
  await db.RiderPresence.create({ userId: 'x1', tenantId: 't1', lat: PICKUP.lat, lng: PICKUP.lng, lastSeen: new Date() });
  surge.clearSurgeCache();
  const nobodyFree = { tenant, userId: 'U9', surge: { mode: 'book', loadFreeDrivers: async () => [] } }; // now ratio 9: x2.5 on its own
  // clearSurgeCache also cleared the quote, so the first booking sees the full current value ...
  assert.equal((await withSurge(config(true, 3), { pickup: PICKUP, drop: DROP, categoryId: 'c1' }, nobodyFree)).surgeMultiplier, 2.5);
  // ... and with the quote in place the same rider is held to what they saw
  surge.clearSurgeCache();
  await withSurge(config(true, 3), { pickup: PICKUP, drop: DROP, categoryId: 'c1' }, est);
  surge.rememberQuote({ tenantId: 't1', userId: 'U9', categoryId: 'c1', pickup: PICKUP, multiplier: 1.5 });
  // drop only the held demand figure, keep the quote
  const held = await withSurge(config(true, 3), { pickup: PICKUP, drop: DROP, categoryId: 'c1' }, nobodyFree);
  assert.equal(held.surgeMultiplier, 1.5, 'booked at the quoted 1.5, not the current higher value');
  const other = await withSurge(config(true, 3), { pickup: PICKUP, drop: DROP, categoryId: 'c1' }, { ...nobodyFree, userId: 'someone-else' });
  assert.ok(other.surgeMultiplier >= 1.5, 'a rider with no quote gets the current multiplier');
  assert.equal(surge.quotedMultiplier({ tenantId: 't1', userId: 'U9', categoryId: 'c1', pickup: PICKUP, current: 1 }), 1, 'a lower current multiplier benefits the rider');
});

test('a booking prices with the surge; the coupon discount applies to the surged total', async () => {
  await reset(); await crowd(8);
  const ctx = { tenant, userId: 'U9', code: '', surge: { mode: 'book', loadFreeDrivers: async () => [] } };
  const r = await priceTripWithCoupon(config(true, 2), { pickup: PICKUP, drop: DROP, categoryId: 'c1' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.estimate.surge_multiplier, 2);
  assert.ok(r.estimate.breakdown.lines.some((l) => l.key === 'surge' && l.amount > 0));
});

const admin = async (fn, { body = {} } = {}) => {
  const business = JSON.parse(JSON.stringify(await db.Tenant.findOne({ tenantId: 't1' }).lean()));
  const scope = (f = {}) => ({ ...f, tenantId: 't1' });
  const req = { body, params: {}, query: {}, ip: '1.1.1.1', business, admin: { adminId: 'A1', email: 'a@t.local' }, data: { find: (M, f) => M.find(scope(f)), update: (M, f, v) => M.findOneAndUpdate(scope(f), { $set: v }, { new: true }) } };
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};

test('pausing surge stops it at once, is audited, and shows in the settings history; resuming brings it back', async () => {
  await reset(); await crowd(8);
  await db.Tenant.create({ tenantId: 't1', slug: 'u', packageName: 'in.u.app', name: 'u', appName: 'u', isDefault: true, market: { country: 'IN', currency: 'INR' } });
  assert.equal((await surge.surgeAt({ tenant, pickup: PICKUP, categoryId: 'c1', freeDrivers: [] })).multiplier, 2.5);
  const r = await admin(A.update, { body: { paused: true } });
  assert.equal(r.code, 200);
  assert.equal(db.Tenant.rows[0].surgeSettings.paused, true);
  const paused = await surge.surgeAt({ tenant: db.Tenant.rows[0], pickup: PICKUP, categoryId: 'c1', freeDrivers: [] });
  assert.deepEqual([paused.multiplier, paused.paused], [1, true]);
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'surge.paused'));
  assert.ok(db.ConfigVersion.rows.some((v) => v.changed.includes('surge')));
  assert.equal((await admin(A.update, { body: { paused: false } })).code, 200);
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'surge.resumed'));
});

test('the dashboard status lists each area with surge on, with the multiplier and the demand and supply behind it', async () => {
  await reset(); await crowd(8);
  await db.Tenant.create({ tenantId: 't1', slug: 'u', packageName: 'in.u.app', name: 'u', appName: 'u', isDefault: true, market: { country: 'IN', currency: 'INR' } });
  await db.ServiceRegion.create({ regionId: 'r1', tenantId: 't1', key: 'noida', city: 'Noida', state: 'UP', zoneName: 'All areas', active: true, center: PICKUP, radiusKm: 20 });
  await db.VehicleCategory.create({ categoryId: 'c1', tenantId: 't1', name: 'VIP', nameKey: 'vip', regionIds: ['r1'], active: true });
  await db.FareRule.create({ ...rule(true, 2), tenantId: 't1', regionKey: 'default' });
  const r = await admin(A.get);
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 300));
  const d = r.body.data;
  assert.equal(d.paused, false);
  assert.equal(d.rules.length, 1);
  assert.equal(d.areas.length, 1);
  assert.equal(d.areas[0].multiplier, 2, 'the live multiplier is capped by the rule maximum');
  assert.equal(d.areas[0].demand, 8);
  assert.ok(d.ladder.length === 4);
});
