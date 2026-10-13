// Competing actions on one trip (rider cancels while the driver accepts, a double tap, a late completion) must never
// overwrite each other: the first valid action wins and the other is told the trip's real state.
// Each test places the competing write exactly between the handler's read of the trip and its own write.
// In-memory stand-ins, and the real PostgreSQL engine with TEST_DB=postgres. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-trip-race-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');

// The in-memory stand-in returns the live row object, so it cannot hold a stale read and these cases would pass vacuously.
// They run only on the real engine (TEST_DB=postgres), where the handler really works from a snapshot.
const realEngine = process.env.TEST_DB === 'postgres';
const test = (name, fn) => nodeTest(name, { skip: !realEngine && name.startsWith('RACE') ? 'needs the real engine (TEST_DB=postgres)' : false }, fn);
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
const { driverResponse } = require('../controllers/tripsController');
const { updateTripStatus, cancelRideByUser } = require('../controllers/rideController');

let n = 0;
const makeTrip = (extra = {}) => {
  n += 1;
  return {
    trip_id: `race_${n}`, request_id: `REQ_RACE_${n}`, user_id: 'rider-1', driver_id: 'drv-1',
    pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 },
    status: 'REQUESTED', timeout_at: new Date(Date.now() + 60_000), ...extra
  };
};
const reset = async () => {
  if (typeof db.TripDetails.deleteMany === 'function') await db.TripDetails.deleteMany({}); else db.TripDetails.rows.length = 0;
};
const statusOf = (id) => db.TripDetails.rows.find((r) => r.trip_id === id).status;
const setStatus = async (id, status) => {
  if (typeof db.TripDetails.updateOne === 'function') await db.TripDetails.updateOne({ trip_id: id }, { $set: { status } });
  else db.TripDetails.rows.find((r) => r.trip_id === id).status = status;
};
const call = async (handler, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await handler(req, res);
  return res;
};
/** After the handler's first read of the trip, another actor changes its status (the race window). */
const withCompetingWrite = async (tripId, newStatus, run) => {
  const original = db.TripDetails.findOne.bind(db.TripDetails);
  let fired = false;
  db.TripDetails.findOne = (...args) => {
    const q = original(...args);
    return {
      then: (resolve, reject) => Promise.resolve(q).then(async (doc) => {
        if (!fired && doc) { fired = true; await setStatus(tripId, newStatus); }
        return doc;
      }).then(resolve, reject),
      lean: () => q.lean(), select: () => q
    };
  };
  try { return await run(); } finally { db.TripDetails.findOne = original; }
};

test('RACE: driver accepts while the rider has just cancelled: the cancellation stands', async () => {
  await reset();
  const t = makeTrip();
  await db.TripDetails.create(t);
  const res = await withCompetingWrite(t.trip_id, 'CANCELLED_BY_USER', () =>
    call(driverResponse, { body: { trip_id: t.trip_id, driver_id: 'drv-1', response: 'ACCEPTED' }, authActorId: 'drv-1', authRole: 'driver' }));
  assert.equal(statusOf(t.trip_id), 'CANCELLED_BY_USER', 'a late accept must not resurrect a cancelled trip');
  assert.notEqual(res.body && res.body.status, 'ACCEPTED', 'the driver is not told the trip is accepted');
});

test('RACE: accept and reject at the same moment: one wins and both callers see the winner', async () => {
  await reset();
  const t = makeTrip();
  await db.TripDetails.create(t);
  const mk = (response) => call(driverResponse, { body: { trip_id: t.trip_id, driver_id: 'drv-1', response }, authActorId: 'drv-1', authRole: 'driver' });
  const [a, b] = await Promise.all([mk('ACCEPTED'), mk('REJECTED')]);
  const final = statusOf(t.trip_id);
  assert.ok(['ACCEPTED', 'REJECTED'].includes(final));
  assert.equal(a.body.status, final, 'the accept call reports the stored state');
  assert.equal(b.body.status, final, 'the reject call reports the stored state');
});

test('RACE: completing a trip that was cancelled a moment earlier does not bring it back', async () => {
  await reset();
  const t = makeTrip({ status: 'ON_GOING' });
  await db.TripDetails.create(t);
  const res = await withCompetingWrite(t.trip_id, 'CANCELLED_BY_USER_AFTER_ACCEPTANCE', () =>
    call(updateTripStatus, { params: { tripId: t.trip_id }, body: { status: 'COMPLETED', driver_id: 'drv-1' }, authActorId: 'drv-1', authRole: 'driver' }));
  assert.equal(statusOf(t.trip_id), 'CANCELLED_BY_USER_AFTER_ACCEPTANCE');
  assert.ok(res.statusCode >= 400 || (res.body && res.body.success === false), 'the driver gets a clear refusal');
});

test('RACE: a rider cancel that loses the race to an accept does not overwrite the accepted trip', async () => {
  await reset();
  const t = makeTrip();
  await db.TripDetails.create(t);
  const res = await withCompetingWrite(t.trip_id, 'ACCEPTED', () =>
    call(cancelRideByUser, { body: { ride_id: t.trip_id, user_id: 'rider-1', cancel_stage: 'before_accept' }, authActorId: 'rider-1', authRole: 'user' }));
  assert.equal(statusOf(t.trip_id), 'ACCEPTED', 'the accept already happened; a before-accept cancel must not rewrite it');
  assert.equal(res.statusCode, 409);
});

test('the ordinary, uncontested paths still work', async () => {
  await reset();
  const t = makeTrip();
  await db.TripDetails.create(t);
  const acc = await call(driverResponse, { body: { trip_id: t.trip_id, driver_id: 'drv-1', response: 'ACCEPTED' }, authActorId: 'drv-1', authRole: 'driver' });
  assert.equal(acc.statusCode, 200);
  assert.equal(statusOf(t.trip_id), 'ACCEPTED');
  const again = await call(driverResponse, { body: { trip_id: t.trip_id, driver_id: 'drv-1', response: 'ACCEPTED' }, authActorId: 'drv-1', authRole: 'driver' });
  assert.equal(again.body.success, true, 'a repeated accept is idempotent');
  assert.equal(statusOf(t.trip_id), 'ACCEPTED');
});
