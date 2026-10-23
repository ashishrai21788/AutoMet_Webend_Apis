// The driver's lifetime totals (and so the balance they can withdraw) count every completed trip, however many there are,
// and the "recent" list keeps the newest trips, not an arbitrary slice.
process.env.JWT_SECRET = 'test-secret-for-driver-lifetime';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const E = require('../controllers/driverEarningsController');
const money = require('../lib/driverMoney');

const business = { tenantId: 't1', market: { currency: 'INR', timezone: 'Asia/Kolkata', driverCommissionPercent: 10 }, payoutSettings: { commissionPercent: 10, cashWithdrawable: true } };
const req = { ownDriver: { driverId: 'D1' }, business };
const DAY = 24 * 3600 * 1000;

const seed = async (n) => {
  await db.TripDetails.deleteMany({});
  for (let i = 0; i < n; i += 1) {
    const at = new Date(Date.UTC(2026, 0, 1) + i * DAY);
    await db.TripDetails.create({
      trip_id: 'L' + i, request_id: 'r' + i, tenant_id: 't1', user_id: 'U1', driver_id: 'D1', status: 'COMPLETED', fare: 100 + i, currency: 'INR',
      payment_mode: i % 2 ? 'ONLINE' : 'CASH', tip_minor: i % 3 === 0 ? 500 : 0, requested_at: at, completed_at: at, timeout_at: at,
      pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 }
    });
  }
};

test('the lifetime totals equal the totals over all trips at once, whatever the chunk size', async () => {
  await seed(23);
  const adj = [{ kind: 'INCENTIVE', amountMinor: 5000 }, { kind: 'PENALTY', amountMinor: -2500 }, { kind: 'ADJUSTMENT', amountMinor: 700 }];
  const all = await db.TripDetails.find({ driver_id: 'D1', status: 'COMPLETED' }).lean();
  const expected = money.totals(all, business, adj);
  assert.equal(expected.trips, 23);
  for (const chunk of [1, 2, 5, 7, 23, 24, 1000]) {
    const got = await E.lifetimeTotals(req, adj, chunk);
    assert.deepEqual(got, expected, `chunk size ${chunk}`);
  }
});

test('a driver with no trips has empty totals, and only their own trips count', async () => {
  await seed(4);
  await db.TripDetails.create({ trip_id: 'OTHER', request_id: 'ro', tenant_id: 't1', user_id: 'U1', driver_id: 'D2', status: 'COMPLETED', fare: 999, currency: 'INR', timeout_at: new Date(), pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 } });
  await db.TripDetails.create({ trip_id: 'CANC', request_id: 'rc', tenant_id: 't1', user_id: 'U1', driver_id: 'D1', status: 'CANCELLED_BY_DRIVER', fare: 999, currency: 'INR', timeout_at: new Date(), pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 } });
  const mine = await E.lifetimeTotals(req, [], 3);
  assert.equal(mine.trips, 4, 'not another driver\'s trip, not a cancelled one');
  const none = await E.lifetimeTotals({ ownDriver: { driverId: 'NOBODY' }, business }, [], 3);
  assert.deepEqual([none.trips, none.totalMinor, none.currency], [0, 0, null]);
});

test('the recent list is the newest trips, newest first, and is cut from the old end', async () => {
  await seed(12);
  const recent = await E.completedTrips(req, 5);
  assert.deepEqual(recent.map((t) => t.trip_id), ['L11', 'L10', 'L9', 'L8', 'L7'], 'the newest five, not an arbitrary five');
});

test('trips beyond the recent list still count towards the lifetime total (no silent cut-off)', async () => {
  await seed(30);
  const recentOnly = money.totals(await E.completedTrips(req, 10), business, []);
  const lifetime = await E.lifetimeTotals(req, [], 4);
  assert.equal(recentOnly.trips, 10);
  assert.equal(lifetime.trips, 30, 'all 30, though only 10 are in the recent list');
  assert.ok(lifetime.totalMinor > recentOnly.totalMinor);
});
