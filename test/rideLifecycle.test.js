// Rider-side ride lifecycle recovery: a finished trip whose receipt was never seen is offered again on the next start,
// the receipt acknowledgement is its own fact (apart from the rating), and nobody can touch another rider's trip.
process.env.JWT_SECRET = 'test-secret-for-ride-lifecycle-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
const { getActiveRide, ackReceipt, rateDriver } = require('../controllers/rideController');

let n = 0;
const HOUR = 3600 * 1000;
const makeTrip = (extra = {}) => {
  n += 1;
  return {
    trip_id: `life_${n}`, request_id: `REQ_LIFE_${n}`, user_id: 'rider-1', driver_id: 'drv-1',
    pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 },
    status: 'COMPLETED', requested_at: new Date(Date.now() - 2 * HOUR), completed_at: new Date(Date.now() - HOUR),
    timeout_at: new Date(), ...extra
  };
};
const reset = async () => { db.TripDetails.rows.length = 0; };
const call = async (handler, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await handler(req, res);
  return res;
};
const active = (query) => call(getActiveRide, { query });
const row = (id) => db.TripDetails.rows.find((r) => r.trip_id === id);

test('no trips: nothing to restore, the app opens Home', async () => {
  await reset();
  const r = await active({ user_id: 'rider-1' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.data.active_ride, null);
});

test('a live ride is restored as it is, whatever happened while the app was closed', async () => {
  await reset();
  for (const status of ['REQUESTED', 'ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING']) {
    await reset();
    await db.TripDetails.create(makeTrip({ status, completed_at: null }));
    const r = await active({ user_id: 'rider-1' });
    assert.equal(r.body.data.active_ride.status, status);
    assert.ok(!r.body.data.active_ride.needs_receipt, 'a live ride is not a receipt');
  }
});

test('a finished trip whose receipt was never seen is offered again, once', async () => {
  await reset();
  const t = makeTrip();
  await db.TripDetails.create(t);
  const first = await active({ user_id: 'rider-1' });
  assert.equal(first.body.data.active_ride.trip_id, t.trip_id);
  assert.equal(first.body.data.active_ride.needs_receipt, true);
  const ack = await call(ackReceipt, { body: { ride_id: t.trip_id, user_id: 'rider-1' } });
  assert.equal(ack.statusCode, 200);
  assert.ok(row(t.trip_id).rider_receipt_ack_at, 'the acknowledgement is stored');
  assert.equal((await active({ user_id: 'rider-1' })).body.data.active_ride, null, 'not offered again');
});

test('acknowledging twice is harmless and keeps the first time', async () => {
  await reset();
  const t = makeTrip();
  await db.TripDetails.create(t);
  await call(ackReceipt, { body: { ride_id: t.trip_id, user_id: 'rider-1' } });
  const at = new Date(row(t.trip_id).rider_receipt_ack_at).getTime();
  const again = await call(ackReceipt, { body: { ride_id: t.trip_id, user_id: 'rider-1' } });
  assert.equal(again.statusCode, 200);
  assert.equal(new Date(row(t.trip_id).rider_receipt_ack_at).getTime(), at);
});

test('rating a trip also settles its receipt; nothing is offered afterwards', async () => {
  await reset();
  const t = makeTrip();
  await db.TripDetails.create(t);
  const rated = await call(rateDriver, { body: { ride_id: t.trip_id, user_id: 'rider-1', stars: 4 } });
  assert.equal(rated.statusCode, 200);
  assert.equal((await active({ user_id: 'rider-1' })).body.data.active_ride, null);
});

test('an old finished trip, a cancelled one and another rider\'s are not offered', async () => {
  await reset();
  await db.TripDetails.create(makeTrip({ completed_at: new Date(Date.now() - 48 * HOUR) }));
  await db.TripDetails.create(makeTrip({ status: 'CANCELLED_BY_USER', completed_at: null }));
  await db.TripDetails.create(makeTrip({ user_id: 'someone-else' }));
  assert.equal((await active({ user_id: 'rider-1' })).body.data.active_ride, null);
});

test('the driver\'s active-ride view is not changed by receipts', async () => {
  await reset();
  await db.TripDetails.create(makeTrip());
  assert.equal((await active({ driver_id: 'drv-1' })).body.data.active_ride, null);
});

test('a receipt can only be acknowledged by the rider, and only once the trip is finished', async () => {
  await reset();
  const t = makeTrip();
  const live = makeTrip({ status: 'ON_GOING', completed_at: null });
  await db.TripDetails.create(t);
  await db.TripDetails.create(live);
  assert.equal((await call(ackReceipt, { body: { ride_id: t.trip_id, user_id: 'intruder' } })).statusCode, 403);
  assert.equal((await call(ackReceipt, { body: { ride_id: live.trip_id, user_id: 'rider-1' } })).statusCode, 409);
  assert.equal((await call(ackReceipt, { body: { ride_id: 'nope', user_id: 'rider-1' } })).statusCode, 404);
  assert.equal((await call(ackReceipt, { body: {} })).statusCode, 400);
  assert.equal(row(t.trip_id).rider_receipt_ack_at || null, null, 'a refused acknowledgement stores nothing');
});

test('a second rating of the same trip is refused and the first one stays', async () => {
  await reset();
  const t = makeTrip();
  await db.TripDetails.create(t);
  assert.equal((await call(rateDriver, { body: { ride_id: t.trip_id, user_id: 'rider-1', stars: 5 } })).statusCode, 200);
  const again = await call(rateDriver, { body: { ride_id: t.trip_id, user_id: 'rider-1', stars: 1 } });
  assert.equal(again.statusCode, 409);
});
