// The rider's app acknowledges the finished-trip receipt so it is not shown again on the next start.
process.env.JWT_SECRET = 'test-secret-for-receipt-ack';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
const { ackReceipt } = require('../controllers/rideController');

const call = async (body) => {
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await ackReceipt({ body, headers: {}, ip: '1.1.1.1' }, res);
  return out;
};
const trip = (over = {}) => db.TripDetails.create({ trip_id: 'T1', request_id: 'R1', user_id: 'U1', driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), ...over });
const reset = () => { db.TripDetails.rows.length = 0; };

test('needs a ride and a rider, an existing ride, the rider\'s own ride, and a finished ride', async () => {
  reset(); await trip();
  assert.equal((await call({ ride_id: 'T1' })).code, 400);
  assert.equal((await call({ user_id: 'U1' })).code, 400);
  assert.equal((await call({ ride_id: 'NOPE', user_id: 'U1' })).code, 404);
  assert.equal((await call({ ride_id: 'T1', user_id: 'U2' })).code, 403);
  assert.equal(db.TripDetails.rows[0].rider_receipt_ack_at ?? null, null, 'a refused call records nothing');
  reset(); await trip({ status: 'ON_GOING' });
  assert.equal((await call({ ride_id: 'T1', user_id: 'U1' })).code, 409);
});

test('acknowledging records the time once; asking again is harmless and keeps the first time', async () => {
  reset(); await trip();
  assert.equal((await call({ trip_id: 'T1', user_id: 'U1' })).code, 200);
  const first = db.TripDetails.rows[0].rider_receipt_ack_at;
  assert.ok(first instanceof Date);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await call({ ride_id: 'T1', user_id: 'U1' })).code, 200);
  assert.equal(db.TripDetails.rows[0].rider_receipt_ack_at.getTime(), first.getTime());
});
