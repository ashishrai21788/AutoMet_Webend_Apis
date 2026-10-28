// Reconciliation of what the ledger says a driver is owed against the existing balance calculation (lib/driverMoney.js). The two cannot be equal as
// a whole: the old balance also counts tips, incentives, admin adjustments, penalties, coupon top-ups and a deduction for the commission on EVERY
// cash trip (confirmed or not), none of which the ledger carries. So the three parts that must agree exactly are compared, and only those can be
// flagged as PAYABLE_MISMATCH: online earnings, money set aside for open payouts, and money sent in paid payouts. Nothing is ever adjusted.
process.env.JWT_SECRET = 'test-secret-for-payable-reconcile';
process.env.PAYMENTS_MOCK_ENABLED = '1';
process.env.PAYMENTS_MOCK_SECRET = 'test-mock-secret-0123456789';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const svc = require('../lib/payments/service');
const payouts = require('../lib/payments/payouts');
const reconcile = require('../lib/payments/reconcile');
const adapters = require('../lib/payments/adapters');
const ledger = require('../lib/ledger');
const { clearAppTenantCache } = require('../lib/appTenant');

const MODELS = ['Tenant', 'Driver', 'TripDetails', 'DriverPayout', 'DriverAdjustment', 'Payment', 'PaymentEvent', 'PaymentRefund', 'PaymentDiscrepancy', 'LedgerTxn'];
const flush = async () => { for (const m of MODELS) await db[m].find({}); };
const earn = (fare, pct = 0) => { const fee = Math.round(fare * pct / 100); return { fareMinor: fare, feeMinor: fee, netMinor: fare - fee, percent: pct, currency: 'INR' }; };
const seed = async () => {
  clearAppTenantCache();
  for (const m of MODELS) db[m].rows.length = 0;
  await flush();
  adapters.resetMock();
  for (const id of ['t1', 't2']) await db.Tenant.create({ tenantId: id, name: id, slug: id, appName: id, packageName: `in.${id}`, isDefault: id === 't1', payments: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK' } });
};
const trip = (id, over = {}) => db.TripDetails.create({ trip_id: id, request_id: `R${id}`, tenant_id: 't1', user_id: `U${id}`, driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), payment_mode: 'CASH', driver_earning: earn(100000, 10), ...over });
const online = async (id, tenantId = 't1', driverId = 'D1', fare = 100000, pct = 10) => {
  await trip(id, { tenant_id: tenantId, driver_id: driverId, driver_earning: earn(fare, pct) });
  const { payment } = await svc.createPayment({ tenantId, tripId: id, riderId: `U${id}`, method: 'UPI', idempotencyKey: `k-${id}` });
  await svc.simulate({ tenantId, paymentId: payment.paymentId, scenario: 'SUCCESS' });
};
const payout = (id, status, amountMinor, over = {}) => db.DriverPayout.create({ tenantId: 't1', payoutId: id, driverId: 'D1', amountMinor, currency: 'INR', status, open: status === 'REQUESTED' || status === 'PROCESSING', reference: status === 'PAID' ? `REF${id}` : '', requestedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...over });
const run = (tenantId = 't1') => reconcile.run({ tenantId });
const mismatches = (r) => r.discrepancies.filter((d) => d.type === 'PAYABLE_MISMATCH').map((d) => d.ref).sort();
const txnCount = async (tenantId = 't1') => (await ledger.verify({ tenantId })).transactions;

test('when the ledger and the old balance agree on the parts they share, there is nothing to report', async () => {
  await seed();
  await online('W1'); await online('W2');
  await payout('po1', 'PAID', 50000); await payout('po2', 'REQUESTED', 30000);
  await payouts.repairUnsynced({ tenantId: 't1' });
  const r = await run();
  assert.deepEqual(mismatches(r), []);
});

test('online earnings that differ between the trip and the ledger are flagged', async () => {
  await seed();
  await online('W1');
  await db.TripDetails.findOneAndUpdate({ trip_id: 'W1' }, { $set: { driver_earning: earn(100000, 25) } }); // the trip now says a different split than was booked
  const r = await run();
  assert.deepEqual(mismatches(r), ['D1:online earnings']);
  assert.match(r.discrepancies.find((d) => d.type === 'PAYABLE_MISMATCH').detail, /trips paid online are worth 75000 to the driver, the ledger booked 90000/);
});

test('money the old records say is set aside or sent for payouts, but the ledger does not, is flagged', async () => {
  await seed();
  await online('W1');
  await payout('po1', 'REQUESTED', 30000, { ledgerSyncedStatus: 'REQUESTED' }); // says it followed it, but there is nothing in the ledger
  await payout('po2', 'PAID', 20000, { ledgerSyncedStatus: 'PAID' });
  const r = await run();
  assert.deepEqual(mismatches(r), ['D1:payouts sent', 'D1:payouts set aside']);
});

test('a payout the ledger simply has not caught up with is explained, not flagged; once repaired it still agrees', async () => {
  await seed();
  await online('W1');
  await payout('po1', 'PAID', 50000); // no sync marker: the ledger is behind and the repair will fix it
  assert.deepEqual(mismatches(await run()), []);
  await payouts.repairUnsynced({ tenantId: 't1' });
  assert.deepEqual(mismatches(await run()), []);
});

test('a payment that succeeded but was never posted is reported once, as that, and not again as a payable difference', async () => {
  await seed();
  await online('W1');
  await db.LedgerTxn.deleteMany({ tenantId: 't1' });
  await db.Payment.findOneAndUpdate({ tripId: 'W1' }, { $set: { ledgerTxnId: null } });
  const r = await run();
  assert.deepEqual(r.discrepancies.map((d) => d.type), ['SUCCESS_NOT_POSTED']);
  await svc.repairUnposted({ tenantId: 't1' });
  assert.deepEqual((await run()).discrepancies.filter((d) => d.type === 'PAYABLE_MISMATCH'), []);
});

test('the known reasons the old balance and the ledger differ are not mistaken for a problem', async () => {
  await seed();
  await online('W1');
  await trip('C1', { driver_earning: earn(30000, 15) }); // a cash trip nobody has confirmed: the old balance already deducts its commission
  await trip('L1', { payment_mode: 'UPI', driver_earning: earn(40000, 10) }); // an older online trip, paid before payments were recorded
  await db.DriverAdjustment.create({ tenantId: 't1', adjustmentId: 'adj1', driverId: 'D1', kind: 'INCENTIVE', amountMinor: 50000, currency: 'INR', title: 'Bonus', at: new Date(), createdAt: new Date() });
  await db.DriverAdjustment.create({ tenantId: 't1', adjustmentId: 'adj2', driverId: 'D1', kind: 'PENALTY', amountMinor: -2000, currency: 'INR', title: 'Penalty', refId: 'T9', at: new Date(), createdAt: new Date() });
  await db.TripDetails.findOneAndUpdate({ trip_id: 'W1' }, { $set: { tip_minor: 5000 } });
  assert.deepEqual(mismatches(await run()), []);
});

test('reconciling only reads: the ledger and the payouts are exactly as they were', async () => {
  await seed();
  await online('W1');
  await db.TripDetails.findOneAndUpdate({ trip_id: 'W1' }, { $set: { driver_earning: earn(100000, 25) } });
  await payout('po1', 'REQUESTED', 30000, { ledgerSyncedStatus: 'REQUESTED' });
  const before = await txnCount();
  await run(); await run();
  assert.equal(await txnCount(), before, 'no entry was posted to "fix" anything');
  const p = await db.DriverPayout.findOne({ payoutId: 'po1' }).lean();
  assert.deepEqual([p.status, p.amountMinor, p.ledgerSyncedStatus], ['REQUESTED', 30000, 'REQUESTED']);
});

test('a finding is stored once, stays open until someone records what was done, and another business never sees it', async () => {
  await seed();
  await online('W1');
  await db.TripDetails.findOneAndUpdate({ trip_id: 'W1' }, { $set: { driver_earning: earn(100000, 25) } });
  const first = await run(); const again = await run();
  assert.deepEqual([first.newCount, again.newCount], [1, 0]);
  assert.deepEqual(mismatches(await run('t2')), []);
  const found = (await reconcile.list({ tenantId: 't1', status: 'OPEN' })).find((d) => d.type === 'PAYABLE_MISMATCH');
  const done = await reconcile.resolve({ tenantId: 't1', discrepancyId: found.discrepancyId, adminId: 'A1', note: 'Split corrected on the trip after review' });
  assert.equal(done.status, 'RESOLVED');
});

test('another business\'s drivers and trips are not compared in this business\'s report', async () => {
  await seed();
  await online('Y9', 't2', 'Y1');
  await db.TripDetails.findOneAndUpdate({ trip_id: 'Y9' }, { $set: { driver_earning: earn(100000, 25) } });
  assert.deepEqual(mismatches(await run('t1')), []);
  assert.deepEqual(mismatches(await run('t2')), ['Y1:online earnings']);
});
