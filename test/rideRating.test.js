// The rider rates the driver once, after the trip is completed. In-memory stand-ins for the database (and the real
// PostgreSQL engine with TEST_DB=postgres). Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-ride-rating-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
const { rateDriver } = require('../controllers/rideController');

let n = 0;
const makeTrip = (extra = {}) => {
  n += 1;
  return {
    trip_id: `amt_${n}`, request_id: `REQ_${n}`, user_id: 'rider-1', driver_id: 'drv-1',
    pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 },
    status: 'COMPLETED', timeout_at: new Date(), ...extra
  };
};
const call = async (body) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await rateDriver({ body }, res);
  return res;
};
const stored = (id) => {
  const row = db.TripDetails.rows.find((r) => r.trip_id === id);
  // the in-memory stand-in keeps a dotted $set as a flat key; the real models (TEST_DB=postgres) nest it
  if (row && !row.rider_rating) row.rider_rating = { stars: row['rider_rating.stars'], comment: row['rider_rating.comment'], tags: row['rider_rating.tags'], rated_at: row['rider_rating.rated_at'] };
  return row;
};

test('a completed trip can be rated once, with stars and a comment', async () => {
  const t = makeTrip();
  await db.TripDetails.create(t);
  const r = await call({ ride_id: t.trip_id, user_id: 'rider-1', stars: 5, comment: '  Smooth and polite  ' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.data.stars, 5);
  assert.equal(r.body.data.comment, 'Smooth and polite');
  const row = stored(t.trip_id);
  assert.equal(row.rider_rating.stars, 5);
  assert.equal(row.rider_rating.comment, 'Smooth and polite');
  assert.ok(row.rider_rating.rated_at, 'the time is recorded');
});

test('a second rating of the same trip is refused and the first one stays', async () => {
  const t = makeTrip();
  await db.TripDetails.create(t);
  assert.equal((await call({ ride_id: t.trip_id, user_id: 'rider-1', stars: 4 })).statusCode, 200);
  const again = await call({ ride_id: t.trip_id, user_id: 'rider-1', stars: 1, comment: 'changed my mind' });
  assert.equal(again.statusCode, 409);
  assert.match(again.body.message, /already been rated/);
  assert.equal(stored(t.trip_id).rider_rating.stars, 4);
});

test('only the rider of the trip can rate it', async () => {
  const t = makeTrip();
  await db.TripDetails.create(t);
  const r = await call({ ride_id: t.trip_id, user_id: 'someone-else', stars: 5 });
  assert.equal(r.statusCode, 403);
  assert.ok(!stored(t.trip_id).rider_rating || !stored(t.trip_id).rider_rating.stars);
});

test('only a completed trip can be rated', async () => {
  for (const status of ['REQUESTED', 'ACCEPTED', 'ON_GOING', 'CANCELLED_BY_USER', 'NO_RESPONSE']) {
    const t = makeTrip({ status });
    await db.TripDetails.create(t);
    const r = await call({ ride_id: t.trip_id, user_id: 'rider-1', stars: 5 });
    assert.equal(r.statusCode, 409, status);
    assert.equal(r.body.data.status, status);
  }
});

test('stars must be a whole number from 1 to 5, and the comment is limited', async () => {
  const t = makeTrip();
  await db.TripDetails.create(t);
  for (const stars of [0, 6, 3.5, 'abc', null, undefined, -1]) {
    assert.equal((await call({ ride_id: t.trip_id, user_id: 'rider-1', stars })).statusCode, 400, `stars=${stars}`);
  }
  assert.equal((await call({ ride_id: t.trip_id, user_id: 'rider-1', stars: 5, comment: 'x'.repeat(301) })).statusCode, 400);
  assert.equal((await call({ user_id: 'rider-1', stars: 5 })).statusCode, 400, 'no ride id');
  assert.equal((await call({ ride_id: t.trip_id, stars: 5 })).statusCode, 400, 'no user id');
  assert.ok(!stored(t.trip_id).rider_rating || !stored(t.trip_id).rider_rating.stars, 'nothing was stored');
});

test('an unknown trip is 404, a string "4" is accepted as 4, and the comment is optional', async () => {
  assert.equal((await call({ ride_id: 'amt_missing', user_id: 'rider-1', stars: 5 })).statusCode, 404);
  const t = makeTrip();
  await db.TripDetails.create(t);
  const r = await call({ trip_id: t.trip_id, user_id: 'rider-1', stars: '4' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.data.stars, 4);
  assert.equal(r.body.data.comment, null);
});

test('quick feedback chips are saved once each; unknown ones are ignored', async () => {
  const t = makeTrip();
  await db.TripDetails.create(t);
  const r = await call({ ride_id: t.trip_id, user_id: 'rider-1', stars: 5, tags: ['Polite', 'Polite', 'Great driver', 'not a real chip', 42] });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.data.tags, ['Polite', 'Great driver']);
  assert.deepEqual(stored(t.trip_id).rider_rating.tags, ['Polite', 'Great driver']);
  const none = makeTrip(); await db.TripDetails.create(none);
  assert.deepEqual((await call({ ride_id: none.trip_id, user_id: 'rider-1', stars: 3 })).body.data.tags, [], 'no chips is fine');
});
