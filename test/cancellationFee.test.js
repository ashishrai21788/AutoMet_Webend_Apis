// What the rider owes for cancelling after the driver accepted comes from the business's own cancellation policy.
process.env.JWT_SECRET = 'test-secret-for-cancellation-fee-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');
const { policyFor, riderCancelFee } = require('../lib/cancellationFee');

const MIN = 60000;
const policy = { categoryId: 'vc1', regionId: null, currency: 'INR', rider: { freeCancellationMinutes: 2, feeAfterWindow: 30, feeAfterDriverArrived: 50 } };
const trip = (extra = {}) => ({ category_id: 'vc1', region_id: null, status: 'DRIVER_ON_THE_WAY', responded_at: new Date(Date.now() - 5 * MIN), ...extra });

test('inside the free window there is no fee; after it, the policy fee', () => {
  assert.equal(riderCancelFee(policy, trip({ responded_at: new Date(Date.now() - 1 * MIN) })).fee, 0);
  const late = riderCancelFee(policy, trip());
  assert.equal(late.fee, 30);
  assert.equal(late.reason, 'AFTER_FREE_WINDOW');
  assert.equal(late.currency, 'INR');
});

test('once the driver has arrived the arrival fee applies, even inside the window', () => {
  const r = riderCancelFee(policy, trip({ status: 'ARRIVED', responded_at: new Date(Date.now() - 30 * 1000) }));
  assert.equal(r.fee, 50);
  assert.equal(r.reason, 'DRIVER_ARRIVED');
});

test('no policy, no rider section, or a ride that is not yet accepted: nothing is charged', () => {
  assert.equal(riderCancelFee(null, trip()).fee, 0);
  assert.equal(riderCancelFee({ rider: null }, trip()).fee, 0);
  assert.equal(riderCancelFee(policy, trip({ status: 'REQUESTED' })).fee, 0);
  assert.equal(riderCancelFee(policy, trip({ status: 'ON_GOING' })).fee, 0, 'a ride that started is not cancelled this way');
});

test('a policy with a zero fee charges nothing', () => {
  assert.equal(riderCancelFee({ ...policy, rider: { freeCancellationMinutes: 0, feeAfterWindow: 0, feeAfterDriverArrived: 0 } }, trip({ status: 'ARRIVED' })).fee, 0);
});

test('the region\'s policy wins over the general one, and only the trip\'s category counts', () => {
  const general = { ...policy, policyId: 'g' };
  const regional = { ...policy, policyId: 'r', regionId: 'rg1', rider: { ...policy.rider, feeAfterWindow: 99 } };
  const other = { ...policy, policyId: 'o', categoryId: 'vc2' };
  assert.equal(policyFor([general, regional, other], { category_id: 'vc1', region_id: 'rg1' }).policyId, 'r');
  assert.equal(policyFor([general, regional, other], { category_id: 'vc1', region_id: 'rg9' }).policyId, 'g');
  assert.equal(policyFor([other], { category_id: 'vc1' }), null);
  assert.equal(policyFor(undefined, { category_id: 'vc1' }), null);
});

// through the real cancel handler
const db = createFakeDb();
db.install();
const { cancelRideByUser } = require('../controllers/rideController');
const call = async (req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await cancelRideByUser(req, res);
  return res;
};
const rowOf = (id) => db.TripDetails.rows.find((r) => r.trip_id === id);

test('cancelling after the free window stores and returns the business\'s fee; cancelling before accept costs nothing', async () => {
  await db.CancellationPolicy.create({ tenantId: 'app_x', policyId: 'p1', categoryId: 'vc1', regionKey: 'ALL', currency: 'INR', rider: { freeCancellationMinutes: 2, feeAfterWindow: 30, feeAfterDriverArrived: 50 } });
  const base = { user_id: 'rider-1', driver_id: 'drv-1', tenant_id: 'app_x', category_id: 'vc1', pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 }, timeout_at: new Date() };
  await db.TripDetails.create({ ...base, trip_id: 'fee_1', request_id: 'REQ_FEE_1', status: 'DRIVER_ON_THE_WAY', responded_at: new Date(Date.now() - 6 * MIN) });
  const late = await call({ body: { ride_id: 'fee_1', user_id: 'rider-1', cancel_stage: 'after_accept' }, authActorId: 'rider-1', authRole: 'user' });
  assert.equal(late.statusCode, 200);
  assert.equal(late.body.cancellation_fee, 30);
  assert.equal(rowOf('fee_1').cancellation_fee, 30);

  await db.TripDetails.create({ ...base, trip_id: 'fee_2', request_id: 'REQ_FEE_2', status: 'REQUESTED' });
  const early = await call({ body: { ride_id: 'fee_2', user_id: 'rider-1', cancel_stage: 'before_accept' }, authActorId: 'rider-1', authRole: 'user' });
  assert.equal(early.body.cancellation_fee, 0);

  await db.TripDetails.create({ ...base, trip_id: 'fee_3', request_id: 'REQ_FEE_3', status: 'ACCEPTED', responded_at: new Date(Date.now() - 20 * 1000) });
  const free = await call({ body: { ride_id: 'fee_3', user_id: 'rider-1', cancel_stage: 'after_accept' }, authActorId: 'rider-1', authRole: 'user' });
  assert.equal(free.body.cancellation_fee, 0, 'inside the free window');
});

// the rider's trip list hides requests that never had a driver (analytics only)
test('a rider\'s list shows accepted, running, completed and cancelled-after-accept rides, not searching / no-driver / declined ones', async () => {
  const { listTrips } = require('../controllers/rideController');
  const base = { user_id: 'rider-9', driver_id: 'drv-9', tenant_id: 'app_x', category_id: 'vc1', pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 }, timeout_at: new Date() };
  const seed = [
    ['l_req', 'REQUESTED'], ['l_nor', 'NO_RESPONSE'], ['l_rej', 'REJECTED'], ['l_rejr', 'REJECTED_WITH_REASON'],
    ['l_cu_early', 'CANCELLED_BY_USER'], ['l_cd_early', 'CANCELLED_BY_DRIVER'],
    ['l_acc', 'ACCEPTED', true], ['l_run', 'ON_GOING', true], ['l_done', 'COMPLETED', true],
    ['l_cu_late', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE', true], ['l_cd_late', 'CANCELLED_BY_DRIVER', true], ['l_cu_ok', 'CANCELLED_BY_USER', true]
  ];
  for (const [id, status, answered] of seed) {
    await db.TripDetails.create({ ...base, trip_id: id, request_id: 'R_' + id, status, responded_at: answered ? new Date() : null });
  }
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await listTrips({ query: { user_id: 'rider-9' } }, res);
  const ids = res.body.data.map((t) => t.trip_id).sort();
  assert.deepEqual(ids, ['l_acc', 'l_cd_late', 'l_cu_late', 'l_cu_ok', 'l_done', 'l_run'].sort());
  // the driver's own list is untouched
  const dres = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await listTrips({ query: { driver_id: 'drv-9' } }, dres);
  assert.equal(dres.body.data.length, seed.length);
});

test('the trip list pages: a stable order, has_more, and a next_skip that never repeats or skips a trip', async () => {
  const { listTrips } = require('../controllers/rideController');
  const base = { user_id: 'rider-pg', driver_id: 'drv-pg', tenant_id: 'app_x', category_id: 'vc1', pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 }, timeout_at: new Date(), status: 'COMPLETED', responded_at: new Date() };
  for (let i = 0; i < 25; i++) {
    await db.TripDetails.create({ ...base, trip_id: 'pg_' + String(i).padStart(2, '0'), request_id: 'R_pg_' + i, requested_at: new Date(Date.UTC(2026, 9, 1, 0, i)) });
  }
  const get = async (skip) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
    await listTrips({ query: { user_id: 'rider-pg', limit: '10', skip: String(skip) } }, res);
    return res.body;
  };
  const seen = [];
  let skip = 0;
  let pages = 0;
  for (;;) {
    const page = await get(skip);
    seen.push(...page.data.map((t) => t.trip_id));
    pages++;
    if (!page.has_more) break;
    skip = page.next_skip;
    assert.ok(pages < 10, 'paging must end');
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25, 'no trip repeated across pages');
  assert.equal(seen[0], 'pg_24', 'newest first');
  assert.equal(seen[24], 'pg_00');
});
