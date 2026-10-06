// Live map and driver presence in the dashboard API: who is on the map, how fresh they are, what shows in the driver
// list and detail, the statistics and the alerts. In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-live-map-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');
const { createFakeDb } = require('./helpers/fakeDb');
const { createMemoryStorage } = require('./helpers/memoryStorage');
const { jsonBodyParser } = require('../lib/jsonBody');

const db = createFakeDb();
db.install();
require('../lib/privateStorage').setBackend(createMemoryStorage());
const adminRoutes = require('../routes/adminRoutes');

const secondsAgo = (s) => new Date(Date.now() - s * 1000);
const day = (n) => new Date(Date.now() + n * 86400000);
const pt = (lat, lng) => ({ type: 'Point', coordinates: [lng, lat] });

let server;
let base;
const ctx = {};

test.before(async () => {
  // The fixtures say "10 seconds ago" and the assertions check the age. Freeze the clock so those agree however slow the
  // database is (over a network the set-up alone takes a minute, which would age every location).
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const market = { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' };
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha', slug: 'a', appName: 'A', packageName: 'com.a', status: 'active', market });
  await db.Tenant.create({ tenantId: 'app_b', name: 'Beta', slug: 'b', appName: 'B', packageName: 'com.b', status: 'active', market });
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: bcrypt.hashSync(pw, 4) });
  await mk('u_a', 'admin@a.test', 'client_admin', 'app_a', 'password-a-admin');
  await mk('u_a_sup', 'support@a.test', 'support', 'app_a', 'password-a-supp');
  await mk('u_b', 'admin@b.test', 'client_admin', 'app_b', 'password-b-admin');

  await db.ServiceRegion.create({ tenantId: 'app_a', regionId: 'rg_a', country: 'IN', state: 'MH', city: 'Pune', zoneName: 'All areas', key: 'pune', active: true, center: { lat: 18.52, lng: 73.85 }, radiusKm: 25 });
  await db.ServiceRegion.create({ tenantId: 'app_a', regionId: 'rg_x', country: 'IN', state: 'MH', city: 'Nashik', zoneName: 'All areas', key: 'nashik', active: true }); // no area: not drawn
  await db.VehicleCategory.create({ tenantId: 'app_a', categoryId: 'vc_a', name: 'Sedan', nameKey: 'sedan', active: true, regionIds: ['rg_a'], passengerCapacity: 4, rideType: 'economy' });
  await db.Vehicle.create({ tenantId: 'app_a', vehicleId: 'veh_1', registrationNumber: 'MH12AB1', registrationKey: 'MH12AB1', make: 'Toyota', model: 'Etios', categoryId: 'vc_a', passengerCapacity: 4, operatingRegionId: 'rg_a', status: 'ACTIVE', verificationStatus: 'APPROVED', verificationExpiresAt: day(90) });
  await db.DriverVehicleAssignment.create({ tenantId: 'app_a', assignmentId: 'as_1', driverId: 'live1', vehicleId: 'veh_1', active: true });

  const driver = (driverId, tenantId, extra = {}) => db.Driver.create({
    driverId, tenantId, firstName: driverId, lastName: 'D', email: `${driverId}@x.test`, phone: `+91${driverId}`, passwordHash: 'x',
    isOnline: true, accountStatus: 'ACTIVE', operatingRegionId: 'rg_a', eligibleCategoryId: 'vc_a', ...extra
  });
  const verified = { driverVerificationStatus: 'APPROVED', verificationExpiresAt: day(90) };
  await driver('live1', 'app_a', { ...verified, lastLocation: pt(18.53, 73.86), locationUpdatedAt: secondsAgo(8), locationHeading: 90, locationSpeedKph: 30, locationRegionId: 'rg_a' });
  await driver('live2', 'app_a', { lastLocation: pt(18.5, 73.8), locationUpdatedAt: secondsAgo(20), locationRegionId: 'rg_a' }); // not verified, no vehicle
  await driver('stale1', 'app_a', { lastLocation: pt(18.55, 73.9), locationUpdatedAt: secondsAgo(120) });
  await driver('nosig1', 'app_a'); // online, an app version that never sends a location
  await driver('off1', 'app_a', { isOnline: false, lastLocation: pt(18.4, 73.7), locationUpdatedAt: secondsAgo(4000) });
  await driver('b_live', 'app_b', { lastLocation: pt(19.0, 72.8), locationUpdatedAt: secondsAgo(5) });

  const trip = (id, tenantId, status, driverId, extra = {}) => db.TripDetails.create({
    trip_id: id, request_id: id, user_id: 'usr', driver_id: driverId, tenant_id: tenantId, status,
    pickup: { address: 'FC Road', lat: 18.52, lng: 73.84 }, drop: { address: 'Airport', lat: 18.58, lng: 73.91 }, fare: 250, currency: 'INR',
    requested_at: secondsAgo(300), timeout_at: new Date(), ...extra
  });
  await trip('T_on', 'app_a', 'ON_GOING', 'live1');
  await trip('T_search', 'app_a', 'REQUESTED', 'live2');
  await trip('T_done', 'app_a', 'COMPLETED', 'live1');
  await trip('T_b', 'app_b', 'ON_GOING', 'b_live');

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => (await (await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  ctx.admin = await login('admin@a.test', 'password-a-admin');
  ctx.support = await login('support@a.test', 'password-a-supp');
  ctx.b = await login('admin@b.test', 'password-b-admin');
});
test.after(() => { server.close(); mock.timers.reset(); });

const get = async (path, { token = ctx.admin, appId = 'app_a' } = {}) => {
  const res = await fetch(base + '/api/admin' + path, { headers: { Authorization: `Bearer ${token}`, 'X-App-Id': appId } });
  return { status: res.status, body: await res.json() };
};

test('live map: online drivers with a position, how fresh, eligibility, vehicle and current trip', async () => {
  const r = await get('/business/live-map');
  assert.equal(r.status, 200);
  const { data } = r.body;
  const by = Object.fromEntries(data.drivers.map((d) => [d.id, d]));
  assert.deepEqual(Object.keys(by).sort(), ['live1', 'live2', 'stale1'], 'offline, other-business and no-position drivers are not placed');

  assert.equal(by.live1.presence, 'LIVE');
  assert.deepEqual([by.live1.lat, by.live1.lng], [18.53, 73.86]);
  assert.equal(by.live1.heading, 90);
  assert.equal(by.live1.eligible, true);
  assert.deepEqual(by.live1.vehicle, { plate: 'MH12AB1', label: 'Toyota Etios' });
  assert.equal(by.live1.currentTripId, 'T_on');
  assert.equal(by.live1.regionName, 'Pune');
  assert.ok(by.live1.ageSeconds >= 8 && by.live1.ageSeconds < 15);

  assert.equal(by.live2.presence, 'LIVE');
  assert.equal(by.live2.eligible, false);
  assert.ok(by.live2.eligibilityReasons.includes('DRIVER_NOT_VERIFIED'));
  assert.equal(by.live2.vehicle, null);
  assert.equal(by.live2.currentTripId, null);

  assert.equal(by.stale1.presence, 'STALE');
  assert.ok(by.stale1.ageSeconds >= 120);
});

test('live map: counts, active trips, service areas, and the freshness rules the page should show', async () => {
  const { data } = (await get('/business/live-map')).body;
  assert.deepEqual(data.counts, { live: 2, stale: 1, noSignal: 1, eligibleLive: 1, online: 4, activeTrips: 1, searching: 1 });
  assert.deepEqual(data.trips.map((t) => t.id).sort(), ['T_on', 'T_search'], 'completed and other-business trips are not listed');
  const on = data.trips.find((t) => t.id === 'T_on');
  assert.equal(on.driverId, 'live1');
  assert.deepEqual(on.pickup, { address: 'FC Road', lat: 18.52, lng: 73.84 });
  assert.deepEqual(data.regions, [{ id: 'rg_a', name: 'Pune', center: { lat: 18.52, lng: 73.85 }, radiusKm: 25 }], 'only regions with an area can be drawn');
  assert.equal(data.freshSeconds, 60);
  assert.equal(data.refreshSeconds, 10);
  assert.equal(data.partial, false);
});

test('live map: another business sees only its own drivers, and access is checked', async () => {
  const b = (await get('/business/live-map', { token: ctx.b, appId: 'app_b' })).body.data;
  assert.deepEqual(b.drivers.map((d) => d.id), ['b_live']);
  assert.deepEqual(b.trips.map((t) => t.id), ['T_b']);
  assert.equal(b.regions.length, 0);
  assert.equal((await get('/business/live-map', { token: ctx.b, appId: 'app_a' })).status, 403);
  assert.equal((await get('/business/live-map', { token: ctx.support })).status, 200, 'support can see the map');
  assert.equal((await fetch(base + '/api/admin/business/live-map')).status, 401);
});

test('driver list and detail carry presence, last seen and the current trip', async () => {
  const list = (await get('/business/drivers?pageSize=50')).body.data.items;
  const by = Object.fromEntries(list.map((d) => [d.id, d]));
  assert.equal(by.live1.presence, 'LIVE');
  assert.equal(by.live1.online, true);
  assert.equal(by.live1.currentTripId, 'T_on');
  assert.deepEqual(by.live1.position, { lat: 18.53, lng: 73.86 });
  assert.equal(by.stale1.presence, 'STALE');
  assert.equal(by.nosig1.presence, 'NO_SIGNAL');
  assert.equal(by.nosig1.position, null);
  assert.equal(by.off1.presence, 'OFFLINE');
  assert.equal(by.off1.online, false);
  assert.ok(by.off1.lastSeenAt, 'last seen is the last location even when offline');
  assert.equal(by.live2.currentTripId, null, 'a trip still searching is not "on a trip"');
  assert.ok(!('b_live' in by), "another business's driver is not listed");

  const d = (await get('/business/drivers/live1')).body.data;
  assert.equal(d.presence, 'LIVE');
  assert.equal(d.currentTripId, 'T_on');
  assert.equal(d.online, true);
  assert.ok(d.locationAgeSeconds >= 8);
});

test('statistics split online drivers into live, stale and no signal', async () => {
  const s = (await get('/business/stats')).body.data;
  assert.equal(s.drivers.online, 4);
  assert.equal(s.drivers.onlineLive, 2);
  assert.equal(s.drivers.onlineStale, 1);
  assert.equal(s.drivers.onlineNoSignal, 1);
  assert.ok(!s.notAvailable.includes('driver last-seen'), 'last-seen is now recorded');
});

test('alerts: stale locations are a warning, drivers who share no location are information', async () => {
  const { alerts } = (await get('/business/alerts')).body.data;
  const stale = alerts.find((a) => a.id === 'drivers.stale_location');
  assert.equal(stale.severity, 'warning');
  assert.deepEqual(stale.items.map((i) => i.id), ['stale1']);
  assert.match(stale.items[0].detail, /Last location 2 min ago/);
  assert.equal(stale.link, '/live-map');
  const none = alerts.find((a) => a.id === 'drivers.no_location_signal');
  assert.equal(none.severity, 'info');
  assert.deepEqual(none.items.map((i) => i.id), ['nosig1']);
});
