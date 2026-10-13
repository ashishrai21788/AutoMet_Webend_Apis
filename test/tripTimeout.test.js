// Ride requests the driver never answered are expired by a sweeper, once, and never touch anything else.
// In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-trip-timeout-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
const { expireTimedOutRequests } = require('../controllers/tripsController');
const { sweepTimedOutRequests, startTripTimeoutSweeper, stopTripTimeoutSweeper } = require('../services/tripTimeoutSweeper');

const NOW = new Date('2026-10-13T07:00:00Z');
const at = (seconds) => new Date(NOW.getTime() + seconds * 1000);
let n = 0;
const trip = (extra) => { n += 1; return { request_id: 'REQ_' + n, user_id: 'u' + n, driver_id: 'd' + n, pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 }, ...extra }; };
const seed = async (rows) => {
  if (typeof db.TripDetails.deleteMany === 'function') await db.TripDetails.deleteMany({}); else db.TripDetails.rows.length = 0;
  for (const r of rows) await db.TripDetails.create(trip(r));
};
const setStatus = async (id, status) => { if (typeof db.TripDetails.updateOne === 'function') await db.TripDetails.updateOne({ trip_id: id }, { $set: { status } }); else db.TripDetails.rows.find((r) => r.trip_id === id).status = status; };
const statusOf = (id) => db.TripDetails.rows.find((r) => r.trip_id === id).status;

test('a REQUESTED trip past its window becomes NO_RESPONSE', async () => {
  await seed([{ trip_id: 'amt_1', request_id: 'REQ_1', user_id: 'u1', driver_id: 'd1', status: 'REQUESTED', timeout_at: at(-5) }]);
  assert.equal(await expireTimedOutRequests(NOW), 1);
  const row = db.TripDetails.rows.find((r) => r.trip_id === 'amt_1');
  assert.equal(row.status, 'NO_RESPONSE');
  assert.equal(row.driver_response, 'NO_RESPONSE');
});

test('only expired REQUESTED trips are touched', async () => {
  await seed([
    { trip_id: 'a', status: 'REQUESTED', timeout_at: at(30) },          // still waiting
    { trip_id: 'b', status: 'ACCEPTED', timeout_at: at(-60) },          // answered in time
    { trip_id: 'c', status: 'COMPLETED', timeout_at: at(-600) },
    { trip_id: 'd', status: 'CANCELLED_BY_USER', timeout_at: at(-60) },
    { trip_id: 'e', status: 'REQUESTED', timeout_at: at(-1) }           // expired
  ]);
  assert.equal(await expireTimedOutRequests(NOW), 1);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(statusOf), ['REQUESTED', 'ACCEPTED', 'COMPLETED', 'CANCELLED_BY_USER', 'NO_RESPONSE']);
});

test('running it again changes nothing (each trip is expired once)', async () => {
  await seed([{ trip_id: 'x', status: 'REQUESTED', timeout_at: at(-10) }]);
  assert.equal(await expireTimedOutRequests(NOW), 1);
  assert.equal(await expireTimedOutRequests(NOW), 0);
  assert.equal(statusOf('x'), 'NO_RESPONSE');
});

test('a trip answered while the sweep is running is left alone', async () => {
  await seed([{ trip_id: 'race', request_id: 'R', user_id: 'u', driver_id: 'd', status: 'REQUESTED', timeout_at: at(-10) }]);
  // the driver accepts between the sweeper reading the list and claiming the trip
  const claim = db.TripDetails.findOneAndUpdate.bind(db.TripDetails);
  db.TripDetails.findOneAndUpdate = async (filter, update, options) => {
    await setStatus('race', 'ACCEPTED');
    return claim(filter, update, options);
  };
  try {
    assert.equal(await expireTimedOutRequests(NOW), 0);
  } finally {
    db.TripDetails.findOneAndUpdate = claim;
  }
  assert.equal(statusOf('race'), 'ACCEPTED');
});

test('a failing notification does not undo the expiry', async () => {
  await seed([{ trip_id: 'n', request_id: 'R', user_id: 'u', driver_id: 'd', status: 'REQUESTED', timeout_at: at(-10) }]);
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(await expireTimedOutRequests(NOW), 1); } finally { console.warn = warn; }
  assert.equal(statusOf('n'), 'NO_RESPONSE');
});

test('the sweeper entry point uses the same rule, and can be started and stopped', async () => {
  await seed([{ trip_id: 's', status: 'REQUESTED', timeout_at: new Date(Date.now() - 1000) }]);
  assert.equal(await sweepTimedOutRequests(), 1);
  assert.equal(statusOf('s'), 'NO_RESPONSE');
  startTripTimeoutSweeper({ intervalMs: 1 << 20 }); // a long interval: it must not fire during the test
  startTripTimeoutSweeper({ intervalMs: 1 << 20 }); // a second start is ignored
  stopTripTimeoutSweeper();
});
