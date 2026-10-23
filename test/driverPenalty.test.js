// The driver's cancellation penalty: free cancellations per day, then a fee taken from earnings; once per trip; nothing without a policy.
process.env.JWT_SECRET = 'test-secret-for-driver-penalty';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const { driverCancelPenalty } = require('../lib/cancellationFee');
const penalties = require('../lib/driverPenalty');
const rideController = require('../controllers/rideController');
const money = require('../lib/driverMoney');

const policy = (driver) => ({ categoryId: 'vc1', regionId: null, currency: 'INR', driver });

test('the free cancellations of the day come first, then each further one costs the penalty', () => {
  const p = policy({ penaltyFee: 25, graceCancellations: 2 });
  assert.deepEqual(driverCancelPenalty(p, 0), { penalty: 0, reason: null, freeLeft: 1, currency: 'INR' }, 'the first of two free ones');
  assert.equal(driverCancelPenalty(p, 1).freeLeft, 0, 'the second free one uses the last');
  assert.equal(driverCancelPenalty(p, 1).penalty, 0);
  const third = driverCancelPenalty(p, 2);
  assert.equal(third.penalty, 25);
  assert.equal(third.reason, 'AFTER_FREE_CANCELLATIONS');
  assert.equal(driverCancelPenalty(p, 9).penalty, 25);
});

test('no free cancellations means every cancellation costs; no policy, no driver section or a zero penalty costs nothing', () => {
  assert.equal(driverCancelPenalty(policy({ penaltyFee: 25, graceCancellations: 0 }), 0).penalty, 25);
  assert.equal(driverCancelPenalty(null, 5).penalty, 0);
  assert.equal(driverCancelPenalty({ currency: 'INR' }, 5).penalty, 0);
  assert.equal(driverCancelPenalty(policy({ penaltyFee: 0, graceCancellations: 0 }), 5).penalty, 0);
  assert.equal(driverCancelPenalty(policy({ penaltyFee: -5, graceCancellations: 0 }), 5).penalty, 0, 'a negative fee is never a credit');
  assert.equal(driverCancelPenalty(policy({ penaltyFee: 25 }), 0).penalty, 25, 'no grace set means none');
});

const NOW = new Date('2026-10-20T08:00:00Z'); // 13:30 in India
const reset = async (driverPolicy) => {
  for (const m of ['Tenant', 'CancellationPolicy', 'TripDetails', 'DriverAdjustment']) db[m].rows.length = 0;
  await db.Tenant.create({ tenantId: 't1', slug: 'uride', packageName: 'in.uride.app', name: 'uRide', appName: 'uRide', isDefault: true, market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } });
  if (driverPolicy) await db.CancellationPolicy.create({ tenantId: 't1', policyId: 'cp1', categoryId: 'vc1', regionId: null, regionKey: 'default', currency: 'INR', rider: {}, driver: driverPolicy, active: true });
};
const addTrip = (id, over = {}) => db.TripDetails.create({ trip_id: id, tenant_id: 't1', user_id: 'U1', driver_id: 'D1', category_id: 'vc1', status: 'DRIVER_ON_THE_WAY', ...over });
const cancel = async (id) => {
  const req = { body: { trip_id: id, driver_id: 'D1', reason: 'Vehicle problem' }, params: {}, query: {}, headers: {} };
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await rideController.cancelRideByDriver(req, res);
  return out;
};
const ledger = () => db.DriverAdjustment.rows.filter((a) => a.kind === 'PENALTY');

test('cancelling within the free ones costs nothing; the next costs the penalty, taken from earnings and noted on the trip', async () => {
  await reset({ penaltyFee: 25, graceCancellations: 1 });
  await addTrip('T1'); await addTrip('T2');
  const first = await cancel('T1');
  assert.equal(first.code, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.driver_penalty, 0);
  assert.equal(first.body.data.free_cancellations_left, 0, 'that was the last free one today');
  assert.equal(ledger().length, 0);

  const second = await cancel('T2');
  assert.equal(second.code, 200);
  assert.equal(second.body.data.driver_penalty, 25);
  assert.equal(second.body.data.driver_penalty_currency, 'INR');
  assert.equal(ledger().length, 1);
  assert.deepEqual([ledger()[0].amountMinor, ledger()[0].currency, ledger()[0].refId, ledger()[0].driverId], [-2500, 'INR', 'T2', 'D1']);
  assert.equal(db.TripDetails.rows.find((t) => t.trip_id === 'T2').driver_penalty_minor, 2500);
  assert.equal(db.TripDetails.rows.find((t) => t.trip_id === 'T1').driver_penalty_minor || 0, 0);
});

test('the penalty reduces what the driver has earned, and counts as an adjustment, not a bonus', async () => {
  await reset({ penaltyFee: 25, graceCancellations: 0 });
  await addTrip('T1');
  await cancel('T1');
  const t = money.totals([], { market: { currency: 'INR' } }, ledger());
  assert.equal(t.adjustMinor, -2500);
  assert.equal(t.incentiveMinor, 0);
  assert.equal(t.totalMinor, -2500);
});

test('charging the same trip twice takes the penalty once', async () => {
  await reset({ penaltyFee: 25, graceCancellations: 0 });
  await addTrip('T1', { status: 'CANCELLED_BY_DRIVER', cancelled_at: NOW });
  const trip = db.TripDetails.rows[0];
  const p = policy({ penaltyFee: 25, graceCancellations: 0 });
  await penalties.chargeForCancel({ trip, policy: p, now: NOW });
  await penalties.chargeForCancel({ trip, policy: p, now: NOW });
  assert.equal(ledger().length, 1);
});

test('only today counts: yesterday\'s cancellations (in the business\'s day) are forgotten, and other drivers\' do not count', async () => {
  await reset({ penaltyFee: 25, graceCancellations: 1 });
  // the business's day began at 18:30 UTC on the 19th (midnight in India); 17:00 UTC is still the 19th
  await addTrip('OLD', { status: 'CANCELLED_BY_DRIVER', cancelled_at: new Date('2026-10-19T17:00:00Z') });
  await addTrip('OTHER', { driver_id: 'D2', status: 'CANCELLED_BY_DRIVER', cancelled_at: new Date('2026-10-20T06:00:00Z') });
  await addTrip('T1', { status: 'CANCELLED_BY_DRIVER', cancelled_at: NOW });
  const r = await penalties.chargeForCancel({ trip: db.TripDetails.rows.find((t) => t.trip_id === 'T1'), policy: policy({ penaltyFee: 25, graceCancellations: 1 }), now: NOW });
  assert.equal(r.penalty, 0, 'this is the first cancellation of the day');
  await addTrip('T2', { status: 'CANCELLED_BY_DRIVER', cancelled_at: new Date(NOW.getTime() + 60000) });
  const r2 = await penalties.chargeForCancel({ trip: db.TripDetails.rows.find((t) => t.trip_id === 'T2'), policy: policy({ penaltyFee: 25, graceCancellations: 1 }), now: new Date(NOW.getTime() + 60000) });
  assert.equal(r2.penalty, 25, 'the second one today');
});

test('a business with no cancellation policy, or a trip with no business, never charges a penalty', async () => {
  await reset(null);
  await addTrip('T1'); await addTrip('T2', { tenant_id: undefined });
  assert.equal((await cancel('T1')).body.data.driver_penalty, 0);
  assert.equal((await cancel('T2')).body.data.driver_penalty, 0);
  assert.equal(ledger().length, 0);
});

test('a failure to record the penalty never stops the driver cancelling', async () => {
  await reset({ penaltyFee: 25, graceCancellations: 0 });
  await addTrip('T1');
  const original = db.DriverAdjustment.create;
  db.DriverAdjustment.create = async () => { throw new Error('ledger down'); };
  const log = console.error; console.error = () => {};
  try {
    const r = await cancel('T1');
    assert.equal(r.code, 200, 'the ride is cancelled');
    assert.equal(r.body.data.driver_penalty, 0);
    assert.equal(db.TripDetails.rows[0].status, 'CANCELLED_BY_DRIVER');
  } finally { db.DriverAdjustment.create = original; console.error = log; }
});

const preview = async (body) => {
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await rideController.driverCancelPreview({ body, params: {}, query: {}, headers: {} }, res);
  return out;
};

test('the warning before cancelling says what it would cost, changes nothing, and matches what is then charged', async () => {
  await reset({ penaltyFee: 25, graceCancellations: 1 });
  await addTrip('T1'); await addTrip('T2');
  const free = await preview({ trip_id: 'T1', driver_id: 'D1' });
  assert.deepEqual([free.code, free.body.data.applies, free.body.data.penalty, free.body.data.free_cancellations_left], [200, true, 0, 0], 'the one free cancellation');
  assert.equal(db.TripDetails.rows.find((t) => t.trip_id === 'T1').status, 'DRIVER_ON_THE_WAY', 'asking changes nothing');
  assert.equal(ledger().length, 0);
  await cancel('T1');
  const costs = await preview({ trip_id: 'T2', driver_id: 'D1' });
  assert.equal(costs.body.data.penalty, 25);
  assert.equal(costs.body.data.currency, 'INR');
  assert.equal((await cancel('T2')).body.data.driver_penalty, 25, 'what was shown is what is taken');
});

test('the warning is for the ride\'s own driver and only while the ride can still be cancelled', async () => {
  await reset({ penaltyFee: 25, graceCancellations: 0 });
  await addTrip('T1'); await addTrip('T2', { status: 'ON_GOING' });
  assert.equal((await preview({ driver_id: 'D1' })).code, 400);
  assert.equal((await preview({ trip_id: 'NOPE', driver_id: 'D1' })).code, 404);
  assert.equal((await preview({ trip_id: 'T1', driver_id: 'D9' })).code, 403);
  const started = await preview({ trip_id: 'T2', driver_id: 'D1' });
  assert.deepEqual([started.body.data.applies, started.body.data.penalty], [false, 0], 'a started trip cannot be cancelled this way');
});

test('no trip payload carries the penalty a driver was charged', async () => {
  await reset({ penaltyFee: 25, graceCancellations: 0 });
  await db.User.create({ userId: 'U1', phone: '+919800000000', firstName: 'Asha' });
  await addTrip('T1', { pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 } });
  assert.equal((await cancel('T1')).body.data.driver_penalty, 25);
  assert.equal(db.TripDetails.rows[0].driver_penalty_minor, 2500, 'it is kept on the trip');
  const run = async (fn, req) => { let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = b; return this; }, setHeader() {}, send() {} }; await fn({ headers: {}, params: {}, query: {}, ...req }, res); return JSON.stringify(out); };
  for (const [name, body] of [
    ['details (rider)', await run(rideController.getRideDetails, { query: { trip_id: 'T1', user_id: 'U1' } })],
    ['details (driver)', await run(rideController.getRideDetails, { query: { trip_id: 'T1', driver_id: 'D1' } })],
    ['the trip', await run(rideController.getTrip, { params: { tripId: 'T1' }, user: { role: 'user', userId: 'U1' }, auth: { role: 'user', userId: 'U1' } })],
    ['the list', await run(rideController.listTrips, { query: { driver_id: 'D1' } })]
  ]) { assert.ok(body.includes('T1'), `${name} returned the trip: ${body.slice(0, 120)}`); assert.ok(!body.includes('driver_penalty_minor'), `${name} must not carry the penalty`); }
});
