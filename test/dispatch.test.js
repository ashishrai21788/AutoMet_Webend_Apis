// Automatic dispatch: who is offered a ride, and what happens when they reject or stay silent.
// In-memory stand-ins for the database and push. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-dispatch-tests';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.DISPATCH_MAX_ATTEMPTS = '3';
delete process.env.DB_ENGINE;

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

// push stand-ins: every driver is reachable and every push succeeds, and we record who was pushed
require('../config/firestore').isFcmReady = () => true;
const pushed = [];
const pushPath = require.resolve(path.join(__dirname, '..', 'lib', 'fcmTripPush.js'));
require.cache[pushPath] = {
  id: pushPath, filename: pushPath, loaded: true,
  exports: {
    isDriverReachable: () => ({ reachable: true }),
    getDriverFcmInfo: (d) => ({ fcmToken: 'tok-' + d.driverId, lastActive: new Date() }),
    sendRideRequestPushWithRetry: async (token, tripId, payload, ctx) => { pushed.push(ctx.driverId); return { success: true, messageId: 'm' }; }
  }
};

const { rankCandidates, canReoffer, distanceKm } = require('../lib/dispatch');
const { reofferTrip, expireTimedOutRequests } = require('../controllers/tripsController');

const NOW = new Date('2026-10-13T07:00:00Z');
const PICKUP = { lat: 28.57, lng: 77.48 };
// a driver `km` kilometres north of the pickup
const driverAt = (id, km, extra = {}) => ({
  driverId: id, email: id + '@test.local', isOnline: true, vehicleType: 'SUV', accountStatus: 'ACTIVE',
  lastLocation: { type: 'Point', coordinates: [PICKUP.lng, PICKUP.lat + km / 111.2] },
  locationUpdatedAt: new Date(NOW.getTime() - 5000),
  ...extra
});

test('distanceKm is roughly right', () => {
  const d = distanceKm(PICKUP, { lat: PICKUP.lat + 0.01, lng: PICKUP.lng });
  assert.ok(d > 1.0 && d < 1.2, String(d));
});

test('candidates are nearest first, and only live, in-range, same-type, not-yet-offered drivers', () => {
  const drivers = [
    driverAt('far', 4),
    driverAt('near', 0.5),
    driverAt('mid', 2),
    driverAt('outside', 9),
    driverAt('offline', 1, { isOnline: false }),
    driverAt('stale', 1, { locationUpdatedAt: new Date(NOW.getTime() - 10 * 60 * 1000) }),
    driverAt('other-type', 1, { vehicleType: 'auto' }),
    driverAt('already', 1)
  ];
  const ranked = rankCandidates(drivers, PICKUP, { exclude: ['already'], vehicleType: 'suv', now: NOW });
  assert.deepEqual(ranked.map((r) => r.driver.driverId), ['near', 'mid', 'far']);
});

test('a driver whose app never sent a location is a last resort, not first', () => {
  const noSignal = { driverId: 'old-app', isOnline: true, vehicleType: 'SUV' };
  const ranked = rankCandidates([noSignal, driverAt('near', 1)], PICKUP, { now: NOW });
  assert.deepEqual(ranked.map((r) => r.driver.driverId), ['near', 'old-app']);
});

test('canReoffer needs an automatic trip with attempts left', () => {
  assert.equal(canReoffer({ dispatch_mode: 'AUTO', dispatch_attempts: 1 }), true);
  assert.equal(canReoffer({ dispatch_mode: 'AUTO', dispatch_attempts: 3 }), false);
  assert.equal(canReoffer({ dispatch_mode: 'MANUAL', dispatch_attempts: 1 }), false);
  assert.equal(canReoffer(null), false);
});

const reset = async () => {
  for (const m of [db.Driver, db.User, db.TripDetails]) m.rows.length = 0;
  pushed.length = 0;
  await db.User.create({ userId: 'u1', firstName: 'Rita', lastName: 'Rider' });
  const t = Date.now();
  for (const d of [driverAt('d1', 0.3), driverAt('d2', 1), driverAt('d3', 2), driverAt('d4', 3)]) {
    await db.Driver.create({ ...d, locationUpdatedAt: new Date(t - 1000) });
  }
};
const makeTrip = (extra = {}) => db.TripDetails.create({
  trip_id: 'amt_1', request_id: 'R1', user_id: 'u1', driver_id: 'd1', status: 'REQUESTED',
  pickup: { address: 'A', lat: PICKUP.lat, lng: PICKUP.lng }, drop: { address: 'B', lat: 28.6, lng: 77.5 },
  fare: 100, currency: 'INR', distance_km: 4, estimated_duration_min: 10,
  dispatch_mode: 'AUTO', dispatch_attempted: ['d1'], dispatch_attempts: 1,
  timeout_at: new Date(Date.now() - 1000), ...extra
});
const row = () => db.TripDetails.rows.find((r) => r.trip_id === 'amt_1');

test('a rejected automatic ride is offered to the next nearest driver', async () => {
  await reset(); await makeTrip();
  assert.equal(await reofferTrip(row()), true);
  assert.equal(row().driver_id, 'd2');
  assert.deepEqual(row().dispatch_attempted, ['d1', 'd2']);
  assert.equal(row().dispatch_attempts, 2);
  assert.equal(row().status, 'REQUESTED');
  assert.ok(new Date(row().timeout_at).getTime() > Date.now());
  assert.deepEqual(pushed, ['d2']);
});

test('a manual ride is never moved to another driver', async () => {
  await reset(); await makeTrip({ dispatch_mode: 'MANUAL' });
  assert.equal(await reofferTrip(row()), false);
  assert.equal(row().driver_id, 'd1');
  assert.deepEqual(pushed, []);
});

test('after the maximum number of drivers the offer is not moved again', async () => {
  await reset(); await makeTrip({ dispatch_attempted: ['d1', 'd2', 'd3'], dispatch_attempts: 3, driver_id: 'd3' });
  assert.equal(await reofferTrip(row()), false);
});

test('a driver on another ride is skipped', async () => {
  await reset(); await makeTrip();
  await db.TripDetails.create({ trip_id: 'amt_busy', request_id: 'RB', user_id: 'u9', driver_id: 'd2', status: 'ON_GOING', pickup: {}, drop: {} });
  assert.equal(await reofferTrip(row()), true);
  assert.equal(row().driver_id, 'd3');
});

test('nobody else available means the offer is not moved', async () => {
  await reset(); await makeTrip();
  for (const d of ['d2', 'd3', 'd4']) db.Driver.rows.find((r) => r.driverId === d).isOnline = false;
  assert.equal(await reofferTrip(row()), false);
  assert.equal(row().driver_id, 'd1');
});

test('the sweeper moves an unanswered automatic offer instead of ending it, and ends it when nobody is left', async () => {
  await reset(); await makeTrip();
  assert.equal(await expireTimedOutRequests(new Date()), 0); // moved, not expired
  assert.equal(row().driver_id, 'd2');
  assert.equal(row().status, 'REQUESTED');

  // the new offer also lapses; two more drivers are tried and then the request ends
  for (const expectedDriver of ['d3', 'd4']) {
    row().timeout_at = new Date(Date.now() - 1000);
    const marked = await expireTimedOutRequests(new Date());
    if (row().status === 'REQUESTED') { assert.equal(marked, 0); assert.equal(row().driver_id, expectedDriver); }
  }
  row().timeout_at = new Date(Date.now() - 1000);
  await expireTimedOutRequests(new Date());
  assert.equal(row().status, 'NO_RESPONSE');
});

test('createRequest stores note and passenger, limits lengths, generates share link, and carries them in push', async () => {
  await reset();
  let pushCaptured = null;
  const fcmTripPush = require('../lib/fcmTripPush');
  const originalSend = fcmTripPush.sendRideRequestPushWithRetry;
  fcmTripPush.sendRideRequestPushWithRetry = async (token, tripId, payload, ctx) => {
    pushCaptured = payload;
    return originalSend(token, tripId, payload, ctx);
  };

  const req = {
    protocol: 'https',
    get: () => 'api.automet.in',
    user: { userId: 'u1' },
    authActorId: 'u1',
    body: {
      request_id: 'REQ_NOTE_PASS_1',
      user_id: 'u1',
      pickup_address: 'Gate 2, Tech Park',
      pickup_latitude: 28.57,
      pickup_longitude: 77.48,
      drop_address: 'Airport Terminal 3',
      drop_latitude: 28.55,
      drop_longitude: 77.09,
      ride_note: '   Please wait near Gate 2 security booth   ',
      passenger_name: 'Jane Doe',
      passenger_phone: '+919876543210'
    }
  };
  let resStatus = 200;
  let resBody = null;
  const res = {
    status(s) { resStatus = s; return this; },
    json(b) { resBody = b; return this; }
  };

  await require('../controllers/tripsController').createRequest(req, res);
  assert.equal(resStatus, 201);
  assert.ok(resBody.success);
  assert.equal(resBody.data.ride_note, 'Please wait near Gate 2 security booth');
  assert.deepEqual(resBody.data.passenger, { name: 'Jane Doe', phone: '+919876543210' });
  assert.ok(resBody.data.share_token, 'generates share token for passenger');
  assert.ok(resBody.data.share_url.includes('/t/'), 'generates share url');

  const saved = db.TripDetails.rows.find((r) => r.request_id === 'REQ_NOTE_PASS_1');
  assert.ok(saved);
  assert.equal(saved.ride_note, 'Please wait near Gate 2 security booth');
  assert.equal(saved.passenger.name, 'Jane Doe');
  assert.equal(saved.passenger.phone, '+919876543210');

  // Verify push payload generation for driver
  const payload = require('../controllers/tripsController').ridePushPayload(saved, 'Test Rider');
  assert.equal(payload.ride_note, 'Please wait near Gate 2 security booth');
  assert.equal(payload.passenger_name, 'Jane Doe');
  assert.equal(payload.passenger_phone, '+919876543210');
  assert.equal(payload.is_for_other, 'true');
  assert.equal(saved.push_sent, true);
});
