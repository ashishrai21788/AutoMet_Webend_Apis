// Driver location heartbeat: the pure rules, the real heartbeat handler over HTTP, and the stale-driver sweeper.
// In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-driver-location-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createFakeDb } = require('./helpers/fakeDb');
const { jsonBodyParser } = require('../lib/jsonBody');

const db = createFakeDb();
db.install();
const { appTenantMiddleware, clearAppTenantCache } = require('../lib/appTenant');
const { clearRegionCache } = require('../lib/regionCache');
const { heartbeat } = require('../controllers/driverLocationController');
const { sweepStaleDrivers } = require('../services/driverPresenceSweeper');
const { validateHeartbeat, presenceOf, shouldGoOffline, locationUpdate, positionOf, config } = require('../lib/driverLocation');

const CFG = { freshSeconds: 60, staleOfflineSeconds: 180, nextHeartbeatSeconds: 10, maxAccuracyMeters: 1000 };
const NOW = new Date(); // the heartbeat tests stamp real server time, so the sweeper test must share the clock
const secondsAgo = (s) => new Date(NOW.getTime() - s * 1000);

// ---------- pure rules ----------

test('validation: coordinates, no GPS fix, accuracy, heading and speed', () => {
  const ok = validateHeartbeat({ lat: 18.52, lng: 73.85, accuracy: 12.4, heading: 90.2, speedMps: 10 }, CFG);
  assert.deepEqual(ok.value, { lat: 18.52, lng: 73.85, accuracyMeters: 12, heading: 90, speedKph: 36 });
  assert.deepEqual(validateHeartbeat({ latitude: '18.5', longitude: '73.8' }, CFG).value, { lat: 18.5, lng: 73.8 }, 'strings and the long names are accepted');
  assert.ok(validateHeartbeat({ lat: 91, lng: 0.5 }, CFG).errors.lat);
  assert.ok(validateHeartbeat({ lat: 10, lng: 181 }, CFG).errors.lng);
  assert.ok(validateHeartbeat({}, CFG).errors.lat);
  assert.ok(validateHeartbeat({ lat: 'abc', lng: 1 }, CFG).errors.lat);
  assert.match(validateHeartbeat({ lat: 0, lng: 0 }, CFG).errors.lat, /GPS fix/, '0,0 is a missing fix');
  assert.ok(validateHeartbeat({ lat: 1, lng: 1, accuracy: 5000 }, CFG).errors.accuracy, 'too imprecise');
  assert.ok(validateHeartbeat({ lat: 1, lng: 1, accuracy: -1 }, CFG).errors.accuracy);
  assert.ok(validateHeartbeat({ lat: 1, lng: 1, heading: 400 }, CFG).errors.heading);
  assert.ok(validateHeartbeat({ lat: 1, lng: 1, speedMps: 500 }, CFG).errors.speedMps);
});

test('the stored position is GeoJSON with longitude first, and reads back as lat/lng', () => {
  const u = locationUpdate({ lat: 18.52, lng: 73.85, accuracyMeters: 8 }, { regionId: 'rg', now: NOW });
  assert.deepEqual(u.lastLocation, { type: 'Point', coordinates: [73.85, 18.52] });
  assert.equal(u.locationRegionId, 'rg');
  assert.equal(u.locationUpdatedAt, NOW);
  assert.equal(u.lastActive, NOW);
  assert.deepEqual(positionOf(u), { lat: 18.52, lng: 73.85 });
  assert.equal(positionOf({}), null);
  assert.equal(positionOf({ lastLocation: { coordinates: [] } }), null);
});

test('presence: live, stale, no signal and offline', () => {
  const online = (extra) => ({ isOnline: true, lastLocation: { type: 'Point', coordinates: [73.8, 18.5] }, ...extra });
  assert.deepEqual(presenceOf(online({ locationUpdatedAt: secondsAgo(5) }), NOW, CFG), { state: 'LIVE', ageSeconds: 5 });
  assert.equal(presenceOf(online({ locationUpdatedAt: secondsAgo(60) }), NOW, CFG).state, 'LIVE', 'exactly at the limit is still live');
  assert.equal(presenceOf(online({ locationUpdatedAt: secondsAgo(61) }), NOW, CFG).state, 'STALE');
  assert.equal(presenceOf({ isOnline: true }, NOW, CFG).state, 'NO_SIGNAL', 'an app that never sent a heartbeat');
  assert.equal(presenceOf({ isOnline: true, locationUpdatedAt: secondsAgo(5) }, NOW, CFG).state, 'NO_SIGNAL', 'a time without a position is not a signal');
  assert.equal(presenceOf(online({ isOnline: false, locationUpdatedAt: secondsAgo(5) }), NOW, CFG).state, 'OFFLINE');
  assert.equal(presenceOf(null, NOW, CFG).state, 'OFFLINE');
});

test('sweeper rule: only an online driver that has sent heartbeats before and gone quiet', () => {
  assert.equal(shouldGoOffline({ isOnline: true, locationUpdatedAt: secondsAgo(181) }, NOW, CFG), true);
  assert.equal(shouldGoOffline({ isOnline: true, locationUpdatedAt: secondsAgo(180) }, NOW, CFG), false);
  assert.equal(shouldGoOffline({ isOnline: true }, NOW, CFG), false, 'an app without heartbeats is never forced offline');
  assert.equal(shouldGoOffline({ isOnline: false, locationUpdatedAt: secondsAgo(999) }, NOW, CFG), false);
});

test('settings can be tuned with environment variables and ignore nonsense', () => {
  process.env.DRIVER_LOCATION_FRESH_SECONDS = '30';
  process.env.DRIVER_STALE_OFFLINE_SECONDS = 'abc';
  assert.equal(config().freshSeconds, 30);
  assert.equal(config().staleOfflineSeconds, 180);
  delete process.env.DRIVER_LOCATION_FRESH_SECONDS;
  delete process.env.DRIVER_STALE_OFFLINE_SECONDS;
});

// ---------- the heartbeat over HTTP ----------

let server;
let base;
const row = (id) => db.Driver.rows.find((d) => d.driverId === id);

test.before(async () => {
  await db.Tenant.create({ tenantId: 'app_def', name: 'Default', slug: 'def', appName: 'D', packageName: 'in.def', status: 'active', isDefault: true });
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha', slug: 'a', appName: 'A', packageName: 'com.a', status: 'active', market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } });
  await db.Tenant.create({ tenantId: 'app_b', name: 'Beta', slug: 'b', appName: 'B', packageName: 'com.b', status: 'active' });
  await db.ServiceRegion.create({ tenantId: 'app_a', regionId: 'rg_pune', country: 'IN', state: 'MH', city: 'Pune', zoneName: 'All areas', key: 'pune', active: true, center: { lat: 18.52, lng: 73.85 }, radiusKm: 25 });
  const driver = (driverId, tenantId, extra = {}) => db.Driver.create({ driverId, tenantId, firstName: driverId, lastName: 'D', email: `${driverId}@x.test`, phone: `+91${driverId}`, passwordHash: 'x', isOnline: true, accountStatus: 'ACTIVE', ...extra });
  await driver('drv_a', 'app_a');
  await driver('drv_b', 'app_b');
  await driver('drv_old', null); // before businesses: the default business
  await driver('drv_susp', 'app_a', { accountStatus: 'SUSPENDED' });

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api', appTenantMiddleware);
  app.post('/api/drivers/location', heartbeat); // sign-in is not what is under test here
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => { clearAppTenantCache(); clearRegionCache(); });

const beat = async (body, headers = {}) => {
  const res = await fetch(base + '/api/drivers/location', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('heartbeat stores the position, finds the region and tells the app what to do next', async () => {
  const r = await beat({ driverId: 'drv_a', lat: 18.53, lng: 73.86, accuracy: 9, heading: 180, speedMps: 5 }, { 'X-App-Id': 'app_a' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.region.regionId, 'rg_pune');
  assert.equal(r.body.data.inServiceArea, true);
  assert.equal(r.body.data.nextHeartbeatSeconds, 10);
  assert.equal(r.body.data.isOnline, true);
  assert.equal(r.body.data.available.ok, true);
  const d = row('drv_a');
  assert.deepEqual(d.lastLocation, { type: 'Point', coordinates: [73.86, 18.53] });
  assert.equal(d.locationRegionId, 'rg_pune');
  assert.equal(d.locationAccuracyM, 9);
  assert.equal(d.locationSpeedKph, 18);
  assert.ok(Date.now() - new Date(d.locationUpdatedAt).getTime() < 5000, 'the server time is stored, not the phone clock');
});

test('a position outside every service area is stored and reported as outside', async () => {
  const r = await beat({ driverId: 'drv_a', lat: 28.61, lng: 77.2 }, { 'X-App-Id': 'app_a' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.region, null);
  assert.equal(r.body.data.inServiceArea, false);
  assert.equal(row('drv_a').locationRegionId, null);
});

test('a business with no service area drawn has nothing to be outside of', async () => {
  const r = await beat({ driverId: 'drv_b', lat: 28.61, lng: 77.2 }, { 'X-App-Id': 'app_b' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.inServiceArea, null);
});

test('bad input is refused and nothing is stored; an imprecise fix is retryable', async () => {
  const before = row('drv_old').locationUpdatedAt;
  const bad = await beat({ driverId: 'drv_old', lat: 120, lng: 5 });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.lat);
  const nofix = await beat({ driverId: 'drv_old', lat: 0, lng: 0 });
  assert.equal(nofix.status, 400);
  const fuzzy = await beat({ driverId: 'drv_old', lat: 18.5, lng: 73.8, accuracy: 4000 });
  assert.equal(fuzzy.status, 422);
  assert.equal(fuzzy.body.error, 'LOCATION_TOO_INACCURATE');
  assert.equal(row('drv_old').locationUpdatedAt, before, 'nothing changed');
  assert.equal((await beat({ lat: 18.5, lng: 73.8 })).status, 400, 'no driver named');
  assert.equal((await beat({ driverId: 'nobody', lat: 18.5, lng: 73.8 })).status, 404);
});

test('an app can only report for its own business', async () => {
  assert.equal((await beat({ driverId: 'drv_b', lat: 18.5, lng: 73.8 }, { 'X-App-Id': 'app_a' })).status, 403, "Alpha's app cannot move Beta's driver");
  assert.equal((await beat({ driverId: 'drv_a', lat: 18.5, lng: 73.8 }, { 'X-App-Id': 'app_b' })).body.error, 'WRONG_APP');
  assert.equal((await beat({ driverId: 'drv_a', lat: 18.5, lng: 73.8 }, { 'X-App-Id': 'app_none' })).status, 400, 'unknown business');
  assert.equal((await beat({ driverId: 'drv_old', lat: 18.5, lng: 73.8 })).status, 200, 'no header: the default business, which owns the untagged driver');
});

test('a suspended driver is not tracked and is taken offline', async () => {
  const r = await beat({ driverId: 'drv_susp', lat: 18.5, lng: 73.8 }, { 'X-App-Id': 'app_a' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'DRIVER_ACCOUNT_NOT_ACTIVE');
  assert.equal(r.body.shouldGoOffline, true);
  assert.equal(row('drv_susp').isOnline, false);
  assert.equal(row('drv_susp').lastLocation, undefined, 'no position was stored');
});

// ---------- the sweeper ----------

test('sweeper takes quiet drivers offline, leaves the rest, and writes a timeline entry', async () => {
  const tenantId = 'app_a';
  const driver = (driverId, extra) => db.Driver.create({ driverId, tenantId, firstName: driverId, lastName: 'S', email: `${driverId}@s.test`, phone: `+91${driverId}`, passwordHash: 'x', isOnline: true, accountStatus: 'ACTIVE', ...extra });
  await driver('sw_quiet', { locationUpdatedAt: secondsAgo(600) });
  await driver('sw_fresh', { locationUpdatedAt: secondsAgo(20) });
  await driver('sw_nosignal', {}); // an older app that never sent a heartbeat
  await driver('sw_off', { isOnline: false, locationUpdatedAt: secondsAgo(900) });
  await driver('sw_legacy', { tenantId: null, locationUpdatedAt: secondsAgo(600) }); // untagged: default business

  const result = await sweepStaleDrivers({ now: NOW, cfg: CFG });
  // the heartbeat tests above left "now"-stamped positions, so only the two seeded quiet drivers count
  assert.equal(result.wentOffline, 2);
  assert.equal(row('sw_quiet').isOnline, false);
  assert.equal(row('sw_quiet').wentOfflineReason, 'NO_LOCATION_SIGNAL');
  assert.equal(row('sw_legacy').isOnline, false);
  assert.equal(row('sw_fresh').isOnline, true);
  assert.equal(row('sw_nosignal').isOnline, true, 'never forced offline');
  const entries = db.EntityHistory.rows.filter((e) => e.kind === 'PRESENCE');
  assert.deepEqual(entries.map((e) => [e.subjectId, e.tenantId, e.action]).sort(), [['sw_legacy', 'app_def', 'WENT_OFFLINE_NO_SIGNAL'], ['sw_quiet', 'app_a', 'WENT_OFFLINE_NO_SIGNAL']]);
  assert.match(entries[0].reason, /No location update for more than 3 minutes/);
  assert.deepEqual(await sweepStaleDrivers({ now: NOW, cfg: CFG }), { wentOffline: 0 }, 'a second run finds nothing');
});
