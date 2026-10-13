// One driver, one trip at a time: the server refuses a second booking and a second accept for a busy driver.
// In-memory stand-ins and (TEST_DB=postgres) the real PostgreSQL engine. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-driver-busy-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
const { findDriverConflict } = require('../lib/driverBusy');
const { driverResponse } = require('../controllers/tripsController');

let n = 0;
const make = (extra = {}) => {
  n += 1;
  return {
    trip_id: `busy_${n}`, request_id: `REQ_BUSY_${n}`, user_id: `rider-${n}`, driver_id: 'drv-1',
    pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 },
    status: 'REQUESTED', timeout_at: new Date(Date.now() + 60_000), ...extra
  };
};
const reset = async () => { if (typeof db.TripDetails.deleteMany === 'function') await db.TripDetails.deleteMany({}); else db.TripDetails.rows.length = 0; };
const call = async (handler, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await handler(req, res);
  return res;
};

test('a driver with an accepted or running trip is busy; finished or cancelled trips do not count', async () => {
  for (const status of ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING']) {
    await reset();
    await db.TripDetails.create(make({ status }));
    const c = await findDriverConflict(db.TripDetails, 'drv-1');
    assert.ok(c, `${status} must block`);
    assert.equal(c.status, status);
  }
  for (const status of ['COMPLETED', 'CANCELLED_BY_USER', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE', 'REJECTED', 'NO_RESPONSE']) {
    await reset();
    await db.TripDetails.create(make({ status }));
    assert.equal(await findDriverConflict(db.TripDetails, 'drv-1', { includePending: true }), null, `${status} must not block`);
  }
});

test('another rider\'s live pending request blocks a new request, an expired one does not', async () => {
  await reset();
  await db.TripDetails.create(make({ status: 'REQUESTED', timeout_at: new Date(Date.now() + 30_000) }));
  assert.ok(await findDriverConflict(db.TripDetails, 'drv-1', { includePending: true }));
  assert.equal(await findDriverConflict(db.TripDetails, 'drv-1'), null, 'pending alone never blocks an accept');
  await reset();
  await db.TripDetails.create(make({ status: 'REQUESTED', timeout_at: new Date(Date.now() - 5_000) }));
  assert.equal(await findDriverConflict(db.TripDetails, 'drv-1', { includePending: true }), null);
});

test('the trip being accepted is not its own conflict, and other drivers are unaffected', async () => {
  await reset();
  const t = make({ status: 'ACCEPTED' });
  await db.TripDetails.create(t);
  assert.equal(await findDriverConflict(db.TripDetails, 'drv-1', { exceptTripId: t.trip_id }), null);
  assert.equal(await findDriverConflict(db.TripDetails, 'drv-2'), null);
});

test('a driver already on a ride cannot accept a second one', async () => {
  await reset();
  const running = make({ status: 'ON_GOING', user_id: 'rider-A' });
  const second = make({ status: 'REQUESTED', user_id: 'rider-B' });
  await db.TripDetails.create(running);
  await db.TripDetails.create(second);
  const res = await call(driverResponse, { body: { trip_id: second.trip_id, driver_id: 'drv-1', response: 'ACCEPTED' }, authActorId: 'drv-1', authRole: 'driver' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'DRIVER_BUSY');
  const row = db.TripDetails.rows.find((r) => r.trip_id === second.trip_id);
  assert.equal(row.status, 'REQUESTED', 'the second trip was not accepted');
});

test('a free driver accepts normally', async () => {
  await reset();
  const t = make();
  await db.TripDetails.create(t);
  const res = await call(driverResponse, { body: { trip_id: t.trip_id, driver_id: 'drv-1', response: 'ACCEPTED' }, authActorId: 'drv-1', authRole: 'driver' });
  assert.equal(res.statusCode, 200);
  assert.equal(db.TripDetails.rows.find((r) => r.trip_id === t.trip_id).status, 'ACCEPTED');
});
