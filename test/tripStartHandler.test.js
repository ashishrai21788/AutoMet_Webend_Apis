// Starting a trip through the real handler with the start code switched on (TRIP_START_OTP=on).
process.env.JWT_SECRET = 'test-secret-for-trip-start-handler';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.TRIP_START_OTP = 'on';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
const { updateTripStatus } = require('../controllers/rideController');
const otp = require('../lib/tripStartOtp');

let n = 0;
const arrivedTrip = () => {
  n += 1;
  return {
    trip_id: `start_${n}`, request_id: `REQ_START_${n}`, user_id: 'rider-1', driver_id: 'drv-1',
    pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 },
    status: 'ARRIVED', responded_at: new Date('2026-10-13T10:00:00Z'), timeout_at: new Date()
  };
};
const row = (id) => db.TripDetails.rows.find((r) => r.trip_id === id);
const start = async (trip, body) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await updateTripStatus({ params: { tripId: trip.trip_id }, body: { status: 'ON_GOING', driver_id: 'drv-1', ...body }, authActorId: 'drv-1', authRole: 'driver' }, res);
  return res;
};

test('without the code the trip does not start', async () => {
  const t = arrivedTrip(); await db.TripDetails.create(t);
  const res = await start(t, {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'OTP_REQUIRED');
  assert.equal(row(t.trip_id).status, 'ARRIVED');
});

test('a wrong code is refused and counted; the right code starts the trip', async () => {
  const t = arrivedTrip(); await db.TripDetails.create(t);
  const good = otp.codeFor(t);
  const wrong = good === '0000' ? '1111' : '0000';
  const bad = await start(t, { otp: wrong });
  assert.equal(bad.statusCode, 403);
  assert.equal(bad.body.error, 'OTP_INVALID');
  assert.equal(row(t.trip_id).status, 'ARRIVED');
  assert.equal(row(t.trip_id).start_otp_attempts, 1);
  const ok = await start(t, { otp: good });
  assert.equal(ok.statusCode, 200);
  assert.equal(row(t.trip_id).status, 'ON_GOING');
});

test('after five wrong codes even the right one is refused', async () => {
  const t = arrivedTrip(); await db.TripDetails.create(t);
  const good = otp.codeFor(t);
  const wrong = good === '0000' ? '1111' : '0000';
  for (let i = 0; i < otp.MAX_ATTEMPTS; i += 1) await start(t, { otp: wrong });
  const res = await start(t, { otp: good });
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'OTP_LOCKED');
  assert.equal(row(t.trip_id).status, 'ARRIVED');
});

test('other status steps do not ask for the code', async () => {
  const t = arrivedTrip(); t.status = 'DRIVER_ON_THE_WAY'; await db.TripDetails.create(t);
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await updateTripStatus({ params: { tripId: t.trip_id }, body: { status: 'ARRIVED', driver_id: 'drv-1' }, authActorId: 'drv-1', authRole: 'driver' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(row(t.trip_id).status, 'ARRIVED');
});
