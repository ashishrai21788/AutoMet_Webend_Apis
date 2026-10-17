// Demand for drivers: riders with their app open near the driver. In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-demand';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const { computeDemand, levelFor, distanceKm } = require('../lib/demand');
const presence = require('../controllers/riderPresenceController');

const NOW = new Date('2026-10-17T10:00:00Z');
const ago = (s) => new Date(NOW.getTime() - s * 1000);
const DRIVER = { lat: 28.5746, lng: 77.4858 };
// a point roughly `km` north of the driver
const north = (km) => ({ lat: DRIVER.lat + km / 111.2, lng: DRIVER.lng });
const rider = (km, extra = {}) => ({ ...north(km), area: 'Sector 62', lastSeen: ago(30), ...extra });

test('the level follows how many riders are near the driver', () => {
  assert.equal(levelFor(0), 'NONE');
  assert.equal(levelFor(1), 'LOW');
  assert.equal(levelFor(2), 'LOW');
  assert.equal(levelFor(3), 'GOOD');
  assert.equal(levelFor(5), 'GOOD');
  assert.equal(levelFor(6), 'HIGH');
});

test('only riders seen in the last five minutes and within 3 km count as nearby', () => {
  const rows = [rider(0.5), rider(1), rider(2.5), rider(4), rider(1, { lastSeen: ago(6 * 60) })];
  const d = computeDemand(rows, DRIVER, NOW);
  assert.equal(d.ridersNearby, 3, 'the 4 km rider is too far and the 6-minute-old one is stale');
  assert.equal(d.level, 'GOOD');
  assert.equal(computeDemand([], DRIVER, NOW).level, 'NONE');
});

test('the busiest nearby spot is reported with its name and distance, and the driver is never told who the riders are', () => {
  const rows = [
    rider(0.1, { area: 'Sector 62' }),
    rider(5.0, { area: 'Gaur City Mall' }), rider(5.0, { area: 'Gaur City Mall' }), rider(5.0, { area: 'Gaur City Mall' }), rider(5.01, { area: 'Gaur City' }),
    rider(8.0, { area: 'Far Away' })
  ].map((r, i) => ({ ...r, userId: `U${i}` }));
  const d = computeDemand(rows, DRIVER, NOW);
  assert.ok(d.hotspot, 'a hotspot is found');
  assert.equal(d.hotspot.name, 'Gaur City Mall');
  assert.equal(d.hotspot.riders, 4);
  assert.ok(d.hotspot.distanceKm >= 4.9 && d.hotspot.distanceKm <= 5.1, `distance ${d.hotspot.distanceKm}`);
  assert.equal(JSON.stringify(d).includes('U1'), false, 'no rider id is in the answer');
  assert.deepEqual(Object.keys(d.hotspot).sort(), ['distanceKm', 'lat', 'lng', 'name', 'riders']);
});

test('no hotspot for a single rider, or when the busy spot is where the driver already is', () => {
  assert.equal(computeDemand([rider(4)], DRIVER, NOW).hotspot, null);
  assert.equal(computeDemand([rider(0.05), rider(0.05)], DRIVER, NOW).hotspot, null);
});

test('distance between two points is about right', () => {
  const d = distanceKm(28.5746, 77.4858, 28.6139, 77.209);
  assert.ok(d > 25 && d < 30, `Noida to Delhi ${d}`);
});

const reportAs = async (actor, role, body) => {
  const req = { authActorId: actor, authRole: role, body, params: {}, query: {}, headers: {} };
  let out;
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await presence.report(req, res);
  return out;
};

test('a rider reports their position; one row per rider; only riders may report; bad positions are refused', async () => {
  db.RiderPresence.rows.length = 0;
  db.User.rows.length = 0;
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', isDefault: true, market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } });
  await db.User.create({ userId: 'U1', phone: '+919876543210', tenantId: 't1', firstName: 'A' });
  assert.equal((await reportAs('U1', 'driver', { lat: 28.5, lng: 77.4 })).code, 403, 'a driver cannot report as a rider');
  assert.equal((await reportAs('U1', 'user', { lat: 'x', lng: 77.4 })).code, 400);
  assert.equal((await reportAs('U1', 'user', { lat: 95, lng: 77.4 })).code, 400);
  assert.equal((await reportAs('NOBODY', 'user', { lat: 28.5, lng: 77.4 })).code, 404);
  assert.equal((await reportAs('U1', 'user', { lat: 28.5, lng: 77.4, area: 'Sector 62' })).code, 200);
  assert.equal((await reportAs('U1', 'user', { lat: 28.51, lng: 77.41, area: '  Sector 63  ' })).code, 200);
  assert.equal(db.RiderPresence.rows.length, 1, 'the second report replaced the first');
  assert.equal(db.RiderPresence.rows[0].area, 'Sector 63');
  assert.equal(db.RiderPresence.rows[0].tenantId, 't1');
});

// ---- what a driver sees on a ride request: how far the pickup is, and how experienced the rider is ----
const { pickupLeg, offerExtras } = require('../lib/rideOffer');

test('the pickup leg is the driver-to-pickup distance with a road allowance, and a drive time', () => {
  const driver = { lastLocation: { type: 'Point', coordinates: [DRIVER.lng, DRIVER.lat] } };
  const leg = pickupLeg(driver, north(1));
  assert.ok(leg.km >= 1.2 && leg.km <= 1.4, `1 km straight line is about 1.3 km by road, got ${leg.km}`);
  assert.ok(leg.minutes >= 3 && leg.minutes <= 4, `drive time ${leg.minutes}`);
  assert.equal(pickupLeg({}, north(1)), null, 'no position, no leg');
  assert.equal(pickupLeg(driver, { lat: 'x', lng: 1 }), null);
});

test('offer extras carry the pickup leg and the rider\'s finished-ride count, empty when unknown', async () => {
  db.TripDetails.rows.length = 0;
  await db.TripDetails.create({ trip_id: 'T1', user_id: 'U9', status: 'COMPLETED' });
  await db.TripDetails.create({ trip_id: 'T2', user_id: 'U9', status: 'COMPLETED' });
  await db.TripDetails.create({ trip_id: 'T3', user_id: 'U9', status: 'CANCELLED_BY_USER' });
  await db.TripDetails.create({ trip_id: 'T4', user_id: 'OTHER', status: 'COMPLETED' });
  const driver = { lastLocation: { type: 'Point', coordinates: [DRIVER.lng, DRIVER.lat] } };
  const x = await offerExtras({ user_id: 'U9', pickup: north(2) }, driver);
  assert.equal(x.rider_trips, '2');
  assert.ok(Number(x.pickup_distance) > 2 && Number(x.pickup_eta_min) >= 5);
  const none = await offerExtras({ user_id: 'U9', pickup: north(2) }, {});
  assert.equal(none.pickup_distance, '');
  assert.equal(none.pickup_eta_min, '');
});
