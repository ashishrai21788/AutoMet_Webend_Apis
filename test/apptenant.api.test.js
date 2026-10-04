// Which business a rider/driver request belongs to, and the fare estimate endpoint using that business's rules.
// Real middleware and controller over HTTP, in-memory stand-ins for the database models.
process.env.JWT_SECRET = 'test-secret-for-apptenant-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createFakeDb } = require('./helpers/fakeDb');
const { jsonBodyParser } = require('../lib/jsonBody');

const db = createFakeDb();
db.install();
const { appTenantMiddleware, clearAppTenantCache, sameBusiness, effectiveTenantId } = require('../lib/appTenant');
const trips = require('../controllers/tripsController');
const { validateFareRuleInput } = require('../lib/fareRules');

let server;
let base;

const PUNE = { lat: 18.5204, lng: 73.8567 };
const NEAR_PUNE = { lat: 18.5304, lng: 73.8467 };
const FAR = { lat: 21.1458, lng: 79.0882 };

test.before(async () => {
  // the default business has not configured pricing, so it keeps the legacy tariff
  await db.Tenant.create({ tenantId: 'app_default', name: 'Default', slug: 'default', appName: 'D', packageName: 'in.default.app', status: 'active', isDefault: true });
  // a business with its own market, service area, category and price
  await db.Tenant.create({ tenantId: 'app_alpha', name: 'Alpha', slug: 'alpha', appName: 'A', packageName: 'com.alpha.app', status: 'active', market: { country: 'GB', currency: 'GBP', timezone: 'Europe/London' } });
  await db.Tenant.create({ tenantId: 'app_paused', name: 'Paused', slug: 'paused', appName: 'P', packageName: 'com.paused.app', status: 'suspended' });

  await db.ServiceRegion.create({ tenantId: 'app_alpha', regionId: 'rg_pune', country: 'GB', state: 'S', city: 'Pune', zoneName: 'All areas', key: 'k1', active: true, center: PUNE, radiusKm: 30 });
  await db.VehicleCategory.create({ tenantId: 'app_alpha', categoryId: 'vc_sedan', name: 'Sedan', nameKey: 'sedan', active: true, regionIds: ['rg_pune'], passengerCapacity: 4, rideType: 'economy' });
  await db.FareRule.create({
    tenantId: 'app_alpha', ruleId: 'fr_1', categoryId: 'vc_sedan', regionId: null, regionKey: 'default', currency: 'GBP', active: true,
    ...validateFareRuleInput({ baseFare: 3, perKm: 1.2, perMinute: 0.2, minimumFare: 6, bookingFee: 1, waitingFreeMinutes: 3, waitingPerMinute: 0.5, additionalCharges: [], taxes: [{ name: 'VAT', ratePercent: 20, appliesTo: 'fare_and_fees' }], surge: { enabled: false } }).value
  });

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api', appTenantMiddleware);
  app.post('/api/v1/trips/estimate', trips.estimate);
  app.get('/api/whoami', (req, res) => res.json({ tenant: req.appTenant ? req.appTenant.tenantId : null }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());
test.beforeEach(() => clearAppTenantCache());

const call = async (path, { appId, body, method = 'GET' } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(appId ? { 'X-App-Id': appId } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
};
const estimate = (appId, pickup, extra = {}) => call('/v1/trips/estimate', {
  appId, method: 'POST',
  body: { pickup_latitude: pickup.lat, pickup_longitude: pickup.lng, drop_latitude: 18.58, drop_longitude: 73.9, vehicle_type: 'sedan', ...extra }
});

test('a request without an App ID belongs to the default business', async () => {
  assert.equal((await call('/whoami')).body.tenant, 'app_default');
  assert.equal((await call('/whoami', { appId: 'app_alpha' })).body.tenant, 'app_alpha');
});

test('an unknown App ID is refused and a suspended business is switched off', async () => {
  assert.equal((await call('/whoami', { appId: 'app_nobody' })).status, 400);
  const paused = await call('/whoami', { appId: 'app_paused' });
  assert.equal(paused.status, 403);
  assert.match(paused.body.message, /unavailable/);
});

test('default business: the estimate is unchanged (legacy tariff, INR)', async () => {
  const r = await estimate(undefined, NEAR_PUNE, { vehicle_type: 'auto' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.fare_source, 'LEGACY_TARIFF');
  assert.equal(r.body.data.currency, 'INR');
  assert.ok(r.body.data.fare > 0 && r.body.data.distance_km > 0);
  assert.equal(r.body.data.breakdown, undefined);
});

test('a configured business: the estimate uses its own rules, currency and region', async () => {
  const r = await estimate('app_alpha', NEAR_PUNE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.fare_source, 'BUSINESS_RULES');
  assert.equal(d.currency, 'GBP');
  assert.equal(d.region_id, 'rg_pune');
  assert.equal(d.category_id, 'vc_sedan');
  assert.equal(d.breakdown.taxes[0].label.startsWith('VAT'), true);
  assert.equal(d.fare, d.breakdown.total);
  // total = (ride charge + fee) x 1.20, with the ride charge never below the minimum
  const ride = Math.max(6, 3 + d.distance_km * 1.2 + d.estimated_duration_min * 0.2);
  assert.ok(Math.abs(d.fare - (ride + 1) * 1.2) < 0.05, `fare ${d.fare} vs ${(ride + 1) * 1.2}`);
});

test('a configured business: outside its service area and unknown vehicle types are refused', async () => {
  const outside = await estimate('app_alpha', FAR);
  assert.equal(outside.status, 422);
  assert.equal(outside.body.error, 'OUTSIDE_SERVICE_AREA');
  const unknown = await estimate('app_alpha', NEAR_PUNE, { vehicle_type: 'helicopter' });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.error, 'CATEGORY_NOT_OFFERED');
  const byId = await estimate('app_alpha', NEAR_PUNE, { vehicle_type: 'helicopter', category_id: 'vc_sedan' });
  assert.equal(byId.status, 200);
});

test('a business only ever prices with its own configuration', async () => {
  // the default business does not get Alpha's GBP pricing even from the same spot, and Alpha does not get the legacy tariff
  const asDefault = await estimate('app_default', NEAR_PUNE);
  assert.equal(asDefault.body.data.fare_source, 'LEGACY_TARIFF');
  const asAlpha = await estimate('app_alpha', NEAR_PUNE);
  assert.equal(asAlpha.body.data.fare_source, 'BUSINESS_RULES');
});

test('an empty POST body is accepted by the estimate route (parser) and fails validation, not parsing', async () => {
  const res = await fetch(base + '/v1/trips/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /required/);
});

test('accounts belong to one business: same-business checks use the tag, untagged means the default business', async () => {
  const alphaRider = { tenantId: 'app_alpha' };
  const alphaDriver = { tenantId: 'app_alpha' };
  const defaultDriver = { tenantId: null };
  const taggedDefault = { tenantId: 'app_default' };
  assert.equal(await sameBusiness(alphaRider, alphaDriver), true);
  assert.equal(await sameBusiness(alphaRider, defaultDriver), false, 'a rider of one business cannot use another business\'s driver');
  assert.equal(await sameBusiness(defaultDriver, taggedDefault), true, 'untagged accounts are the default business');
  assert.equal(await effectiveTenantId({}), 'app_default');
});
