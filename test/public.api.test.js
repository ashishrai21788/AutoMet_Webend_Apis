// The public business config the rider and driver apps read at start. Real middleware and controller over HTTP,
// in-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-public-config-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createFakeDb } = require('./helpers/fakeDb');
const { jsonBodyParser } = require('../lib/jsonBody');

const db = createFakeDb();
db.install();
const { appTenantMiddleware, clearAppTenantCache } = require('../lib/appTenant');
const publicRoutes = require('../routes/publicRoutes');
const { buildPublicConfig } = require('../lib/publicConfig');
const { validateBusinessSettings } = require('../lib/businessValidation');

let server;
let base;

test.before(async () => {
  await db.Tenant.create({ tenantId: 'app_default', name: 'Default Co', slug: 'default', appName: 'Default', packageName: 'in.default', status: 'active', isDefault: true });
  await db.Tenant.create({
    tenantId: 'app_alpha', name: 'Alpha Rides', slug: 'alpha', appName: 'Alpha Go', packageName: 'com.alpha', status: 'active', brandColor: '#112233',
    logoUrl: 'https://cdn.example/alpha.png', supportEmail: 'help@alpha.test', supportPhone: '+911234567890',
    market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }, rideSettings: { requireEligibleDrivers: true },
    verificationRequirements: { driver: { ADDRESS_PROOF: true } }
  });
  await db.Tenant.create({ tenantId: 'app_beta', name: 'Beta Cabs', slug: 'beta', appName: 'Beta', packageName: 'com.beta', status: 'trial', market: { country: 'GB', currency: 'GBP', timezone: 'Europe/London' } });
  await db.Tenant.create({ tenantId: 'app_paused', name: 'Paused', slug: 'paused', appName: 'P', packageName: 'com.paused', status: 'suspended' });

  const region = (tenantId, regionId, city, active = true) => db.ServiceRegion.create({ tenantId, regionId, country: 'IN', state: 'S', city, zoneName: 'All areas', key: regionId, active, center: { lat: 12.97, lng: 77.59 }, radiusKm: 15 });
  await region('app_alpha', 'rg_blr', 'Bengaluru');
  await region('app_alpha', 'rg_old', 'Mysuru', false);
  await region('app_beta', 'rg_lon', 'London');

  const cat = (tenantId, categoryId, name, regionIds, active = true) => db.VehicleCategory.create({ tenantId, categoryId, name, nameKey: name.toLowerCase(), active, regionIds, passengerCapacity: 4, rideType: 'economy', description: '', icon: 'car', imageUrl: '' });
  await cat('app_alpha', 'vc_sedan', 'Sedan', ['rg_blr', 'rg_old']);
  await cat('app_alpha', 'vc_bike', 'Bike', ['rg_blr']); // no price yet
  await cat('app_alpha', 'vc_van', 'Van', ['rg_old']); // only an inactive region
  await cat('app_alpha', 'vc_gone', 'Retired', ['rg_blr'], false);
  await cat('app_beta', 'vc_taxi', 'Taxi', ['rg_lon']);
  const rule = (tenantId, categoryId, ruleId) => db.FareRule.create({ tenantId, ruleId, categoryId, regionId: null, regionKey: 'default', currency: 'INR', baseFare: 40, perKm: 12, perMinute: 1, minimumFare: 50, bookingFee: 5, waitingFreeMinutes: 3, waitingPerMinute: 1, active: true });
  await rule('app_alpha', 'vc_sedan', 'fr_1');
  await rule('app_alpha', 'vc_van', 'fr_2');
  await rule('app_beta', 'vc_taxi', 'fr_3');

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api', appTenantMiddleware);
  app.use('/api/v1/public', publicRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/v1/public/business/config`;
});
test.after(() => server.close());
test.beforeEach(() => clearAppTenantCache());

const get = (headers = {}) => fetch(base, { headers });

test('an app that names its business gets that business, with branding, market, regions and categories', async () => {
  const res = await get({ 'X-App-Id': 'app_alpha' });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.appId, 'app_alpha');
  assert.equal(data.resolvedBy, 'header');
  assert.deepEqual(data.business, { name: 'Alpha Rides', appName: 'Alpha Go', brandColor: '#112233', logoUrl: 'https://cdn.example/alpha.png', supportEmail: 'help@alpha.test', supportPhone: '+911234567890' });
  assert.deepEqual(data.market, { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' });
  assert.deepEqual(data.regions.map((r) => r.regionId), ['rg_blr'], 'inactive regions are not listed');
  assert.deepEqual(data.regions[0].center, { lat: 12.97, lng: 77.59 });
  assert.equal(data.regions[0].radiusKm, 15);
  assert.equal(data.rideSettings.requireEligibleDrivers, true);
  assert.equal(data.serviceAvailable, true);
  assert.match(data.version, /^[0-9a-f]{16}$/);
});

test('categories: inactive ones are hidden; unpriced ones and ones with no active region are not bookable', async () => {
  const { data } = await (await get({ 'X-App-Id': 'app_alpha' })).json();
  const by = Object.fromEntries(data.vehicleCategories.map((c) => [c.categoryId, c]));
  assert.deepEqual(Object.keys(by).sort(), ['vc_bike', 'vc_sedan', 'vc_van']);
  assert.equal(by.vc_sedan.bookable, true);
  assert.deepEqual(by.vc_sedan.regionIds, ['rg_blr'], 'a deactivated region is dropped from the category');
  assert.equal(by.vc_bike.bookable, false, 'no price yet');
  assert.equal(by.vc_van.bookable, false, 'priced, but its only region is inactive');
});

test("a business sees none of another business's data", async () => {
  const { data } = await (await get({ 'X-App-Id': 'app_beta' })).json();
  assert.equal(data.business.name, 'Beta Cabs');
  assert.deepEqual(data.regions.map((r) => r.regionId), ['rg_lon']);
  assert.deepEqual(data.vehicleCategories.map((c) => c.categoryId), ['vc_taxi']);
  assert.equal(data.market.currency, 'GBP');
  const text = JSON.stringify(data);
  for (const leak of ['Alpha', 'rg_blr', 'vc_sedan', 'alpha.png', 'help@alpha.test']) assert.ok(!text.includes(leak), `no ${leak}`);
});

test('nothing private is exposed: no fare amounts, requirements, package name, tenant tags or internal ids', async () => {
  const text = JSON.stringify(await (await get({ 'X-App-Id': 'app_alpha' })).json());
  for (const secret of ['baseFare', 'perKm', 'minimumFare', 'ADDRESS_PROOF', 'verificationRequirements', 'com.alpha', 'tenantId', '_id', 'passwordHash', 'slug']) {
    assert.ok(!text.includes(secret), `must not contain ${secret}`);
  }
});

test('no App ID means the default business, and the response says so', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.appId, 'app_default');
  assert.equal(data.resolvedBy, 'default');
  assert.equal(data.serviceAvailable, false, 'the default business has not set anything up');
  assert.equal(data.market, null);
});

test('an unknown App ID is refused, and a suspended business is unavailable', async () => {
  const unknown = await get({ 'X-App-Id': 'app_nope' });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).message, 'Unknown app');
  const paused = await get({ 'X-App-Id': 'app_paused' });
  assert.equal(paused.status, 403);
});

test('the version is stable, answers If-None-Match with 304, and moves when the business changes', async () => {
  const first = await get({ 'X-App-Id': 'app_beta' });
  const etag = first.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{16}"$/);
  assert.match(first.headers.get('cache-control'), /max-age=60/);

  const again = await get({ 'X-App-Id': 'app_beta', 'If-None-Match': etag });
  assert.equal(again.status, 304);

  await db.Tenant.findOneAndUpdate({ tenantId: 'app_beta' }, { $set: { supportPhone: '+4400000000' } });
  clearAppTenantCache();
  const changed = await get({ 'X-App-Id': 'app_beta', 'If-None-Match': etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.equal((await changed.json()).data.business.supportPhone, '+4400000000');
});

test('buildPublicConfig: a business with no market, no regions and no categories is simply not available', () => {
  const cfg = buildPublicConfig({ tenant: { tenantId: 'app_x', name: 'X', appName: 'X' } });
  assert.equal(cfg.market, null);
  assert.deepEqual(cfg.regions, []);
  assert.deepEqual(cfg.vehicleCategories, []);
  assert.equal(cfg.serviceAvailable, false);
  assert.equal(cfg.business.brandColor, '#f5a300');
});

test('logo link validation: https only, empty clears it', () => {
  assert.equal(validateBusinessSettings({ logoUrl: 'https://cdn.example/a.png' }).value.logoUrl, 'https://cdn.example/a.png');
  assert.equal(validateBusinessSettings({ logoUrl: '' }).value.logoUrl, '');
  assert.ok(validateBusinessSettings({ logoUrl: 'http://cdn.example/a.png' }).errors.logoUrl);
  assert.ok(validateBusinessSettings({ logoUrl: 'javascript:alert(1)' }).errors.logoUrl);
  assert.ok(validateBusinessSettings({ logoUrl: 'https://a b' }).errors.logoUrl);
});
