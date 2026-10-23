// The driver's trip history for a day, week or month reads only the trips from that period (and the one before it, for the
// comparison) instead of the driver's whole history, and shows exactly the trips it always did.
process.env.JWT_SECRET = 'test-secret-for-driver-history';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const S = require('../controllers/driverSummaryController');
const DT = require('../lib/driverTrips');

const DAY = 24 * 3600 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY);
const business = { tenantId: 't1', market: { currency: 'INR', timezone: 'Asia/Kolkata' } };

const run = async (query) => {
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = b; return this; } };
  await S.trips({ ownDriver: { driverId: 'D1' }, business, query, params: {}, headers: {}, ip: '1.1.1.1' }, res);
  return out;
};

const seed = async () => {
  await db.TripDetails.deleteMany({});
  let n = 0;
  const add = (over) => db.TripDetails.create({ trip_id: `T${++n}`, request_id: `rq${n}`, tenant_id: 't1', user_id: 'U1', driver_id: 'D1', category_id: 'vc1', fare: 100, currency: 'INR', payment_mode: 'CASH', status: 'COMPLETED', timeout_at: new Date(), pickup: { address: 'A', lat: 28.5, lng: 77.4 }, drop: { address: 'B', lat: 28.6, lng: 77.5 }, ...over });
  // finished and cancelled trips at many ages
  for (const d of [0.1, 0.5, 1, 2, 3, 6, 9, 13, 20, 27, 40, 90, 200, 400]) {
    await add({ requested_at: ago(d + 0.02), completed_at: ago(d) });
    await add({ requested_at: ago(d + 0.02), cancelled_at: ago(d), status: 'CANCELLED_BY_DRIVER' });
  }
  // an older record with neither moment set: it counts from when it was requested, and must never be dropped by the database bound
  await add({ trip_id: 'LEGACY_RECENT', requested_at: ago(2), completed_at: undefined });
  await add({ trip_id: 'LEGACY_OLD', requested_at: ago(300), completed_at: undefined });
  // someone else's, and a trip still in progress: never in the history
  await add({ trip_id: 'OTHER', driver_id: 'D2', completed_at: ago(1) });
  await add({ trip_id: 'LIVE', status: 'ON_GOING', requested_at: ago(0.01) });
};

/** What the range must show, worked out from the rows themselves with the long-standing exact rule. */
const expectedIds = (range) => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 5.5 * 3600 * 1000);
  const start0 = start > now ? new Date(start.getTime() - DAY) : start;
  const b = DT.rangeBounds(range, now, start0);
  return db.TripDetails.rows
    .filter((t) => t.driver_id === 'D1' && DT.HISTORY_STATUSES.includes(t.status) && DT.inWindow(t, b.from, b.to))
    .sort((x, y) => new Date(DT.happenedAt(y)) - new Date(DT.happenedAt(x)) || String(y.trip_id).localeCompare(String(x.trip_id)))
    .map((t) => t.trip_id);
};

for (const range of ['today', 'week', 'month', 'all']) {
  test(`range ${range}: the same trips as reading the whole history, and the headline counts agree`, async () => {
    await seed();
    const out = await run({ range, limit: '50' });
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 200));
    const ids = out.data.trips.map((t) => t.tripId);
    assert.deepEqual(ids, expectedIds(range).slice(0, 50));
    assert.equal(out.data.counts.all, expectedIds(range).length);
  });
}

test('the trip with neither moment set is kept when it falls in the period, and an old one is not shown for this week', async () => {
  await seed();
  const week = (await run({ range: 'week', limit: '50' })).data.trips.map((t) => t.tripId);
  assert.ok(week.includes('LEGACY_RECENT'), 'a recent record without moments is still in the week');
  assert.ok(!week.includes('LEGACY_OLD'));
  const all = (await run({ range: 'all', limit: '50' })).data.trips.map((t) => t.tripId);
  assert.ok(all.includes('LEGACY_OLD'));
  assert.ok(!all.includes('OTHER') && !all.includes('LIVE'), 'another driver\'s trip and a trip in progress are never listed');
});

test('a week only reads the recent trips from the database', async () => {
  await seed();
  const original = db.TripDetails.find;
  let read = 0;
  db.TripDetails.find = (...args) => { const q = original.apply(db.TripDetails, args); const lean = q.lean.bind(q); q.lean = async () => { const rows = await lean(); read = Math.max(read, rows.length); return rows; }; return q; };
  try {
    await run({ range: 'week', limit: '20' });
    const total = db.TripDetails.rows.filter((t) => t.driver_id === 'D1' && DT.HISTORY_STATUSES.includes(t.status)).length;
    assert.equal(total, 30, 'the seed has 30 history trips for this driver');
    assert.equal(read, 18, 'the 16 finished or cancelled in the last 14 days (the week and the one before) plus the 2 records with no moments set, not all 30');
  } finally { db.TripDetails.find = original; }
});
