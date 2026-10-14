// A trip, its timeline and a trip list are only readable by the rider or driver they belong to.
// In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-trip-read-scope-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

// the controller reads trips through the legacy Trip model; point it at the in-memory trip rows
const modelPath = require.resolve(path.join(__dirname, '..', 'models', 'tripModel.js'));
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true,
  exports: { Trip: db.TripDetails, TRIP_STATUSES: ['REQUESTED', 'ACCEPTED', 'COMPLETED', 'CANCELLED_BY_USER'] }
};
const { getTrip, getTripTimeline } = require('../controllers/rideController');

const run = async (handler, req) => {
  let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await handler(req, res);
  return out;
};

const seed = async () => {
  db.TripDetails.rows.length = 0;
  await db.TripDetails.create({
    trip_id: 'amt_1', request_id: 'R1', user_id: 'rider1', driver_id: 'driver1', status: 'COMPLETED',
    pickup: { address: 'A' }, drop: { address: 'B' }, fare: 100
  });
};
const as = (actorId, role) => ({ params: { tripId: 'amt_1' }, authActorId: actorId, authRole: role });

test('the rider and the driver of a trip can read it', async () => {
  await seed();
  assert.equal((await run(getTrip, as('rider1', 'user'))).code ?? 200, 200);
  assert.equal((await run(getTrip, as('driver1', 'driver'))).code ?? 200, 200);
});

test('another rider or driver cannot read it', async () => {
  await seed();
  assert.equal((await run(getTrip, as('rider2', 'user'))).code, 403);
  assert.equal((await run(getTrip, as('driver2', 'driver'))).code, 403);
});

test('the timeline is scoped the same way', async () => {
  await seed();
  assert.equal((await run(getTripTimeline, as('rider2', 'user'))).code, 403);
  assert.equal((await run(getTripTimeline, as('rider1', 'user'))).code ?? 200, 200);
});

test('an unknown trip is not found', async () => {
  await seed();
  const r = await run(getTrip, { params: { tripId: 'nope' }, authActorId: 'rider1', authRole: 'user' });
  assert.equal(r.code, 404);
});
