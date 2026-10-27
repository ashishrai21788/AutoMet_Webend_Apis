// The scheduled upkeep: stale payments are closed (or succeeded, if the provider really took the money), interrupted bookings are finished,
// pending refunds are settled, one business failing does not stop another, and running it twice changes nothing.
process.env.JWT_SECRET = 'test-secret-for-payment-jobs';
process.env.PAYMENTS_MOCK_ENABLED = '1';
process.env.PAYMENTS_MOCK_SECRET = 'test-mock-secret-0123456789';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const svc = require('../lib/payments/service');
const cash = require('../lib/payments/cash');
const refunds = require('../lib/payments/refunds');
const jobs = require('../lib/payments/jobs');
const adapters = require('../lib/payments/adapters');
const ledger = require('../lib/ledger');

const MODELS = ['Tenant', 'TripDetails', 'Payment', 'PaymentEvent', 'PaymentRefund', 'LedgerTxn'];
const flush = async () => { for (const m of MODELS) await db[m].find({}); };
const earn = (fare) => ({ fareMinor: fare, feeMinor: Math.round(fare * 0.15), netMinor: fare - Math.round(fare * 0.15), percent: 15, currency: 'INR' });
const reset = async () => {
  for (const m of MODELS) db[m].rows.length = 0;
  await flush();
  adapters.resetMock();
  for (const id of ['t1', 't2']) await db.Tenant.create({ tenantId: id, name: id, slug: id, appName: id, packageName: `in.${id}`, isDefault: id === 't1', payments: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', commissionRecovery: 'MANUAL_ONLY' } });
};
const trip = (id, tenantId = 't1', fare = 20000) => db.TripDetails.create({ trip_id: id, request_id: `R${id}`, tenant_id: tenantId, user_id: `U${id}`, driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), driver_earning: earn(fare) });
const open = async (id, tenantId = 't1') => (await svc.createPayment({ tenantId, tripId: id, riderId: `U${id}`, method: 'UPI', idempotencyKey: `k-${id}` })).payment.paymentId;
const row = (tenantId, report) => report.find((r) => r.tenantId === tenantId);

test('a payment left open past its window is expired; one the provider really took is succeeded instead; running again changes nothing', async () => {
  await reset();
  await trip('T1'); await trip('T2');
  const stale = await open('T1');
  const paidAtProvider = await open('T2');
  const gw = adapters.getAdapter('MOCK');
  gw.orders.get((await svc.find({ tenantId: 't1', paymentId: paidAtProvider })).providerOrderId).status = 'paid'; // the webhook was lost
  const later = new Date(Date.now() + 2 * 3600000);
  const first = await jobs.runAll({ now: later });
  assert.equal(row('t1', first).expired, 1, 'only the unpaid one expires');
  assert.equal((await svc.find({ tenantId: 't1', paymentId: stale })).status, 'EXPIRED');
  const done = await svc.find({ tenantId: 't1', paymentId: paidAtProvider });
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal((await ledger.verify({ tenantId: 't1' })).transactions, 1);
  const second = await jobs.runAll({ now: later });
  assert.deepEqual([row('t1', second).expired, row('t1', second).errors], [0, []]);
  assert.equal((await ledger.verify({ tenantId: 't1' })).transactions, 1);
});

test('interrupted bookings are finished: a succeeded online payment and a confirmed cash fare that never reached the ledger', async () => {
  await reset();
  await trip('T1'); await trip('T2');
  const online = await open('T1');
  await svc.simulate({ tenantId: 't1', paymentId: online, scenario: 'SUCCESS' });
  await cash.confirmCash({ tenantId: 't1', tripId: 'T2', driverId: 'D1' });
  db.LedgerTxn.rows.length = 0; await flush();
  await db.Payment.findOneAndUpdate({ paymentId: online }, { $set: { ledgerTxnId: null } });
  await db.Payment.findOneAndUpdate({ method: 'CASH' }, { $set: { ledgerTxnId: null } });
  const r = await jobs.runAll();
  assert.deepEqual([row('t1', r).repairedOnline, row('t1', r).repairedCash], [1, 1]);
  assert.equal((await ledger.verify({ tenantId: 't1' })).transactions, 2);
  const again = await jobs.runAll();
  assert.deepEqual([row('t1', again).repairedOnline, row('t1', again).repairedCash], [0, 0]);
});

test('a refund still waiting is settled once the provider has finished it', async () => {
  await reset();
  await trip('T1');
  const id = await open('T1');
  await svc.simulate({ tenantId: 't1', paymentId: id, scenario: 'SUCCESS' });
  const gw = adapters.getAdapter('MOCK');
  gw.refundMode = 'pending';
  const r = await refunds.requestRefund({ tenantId: 't1', paymentId: id, amountMinor: 5000, reason: 'part refund', requestedBy: 'a', idempotencyKey: 'rf' });
  assert.equal(r.refund.status, 'REQUESTED');
  gw.completeRefund(r.refund.providerRefundId, 'processed');
  const report = await jobs.runAll();
  assert.equal(row('t1', report).refundsSettled, 1);
  assert.equal((await db.PaymentRefund.find({}))[0].status, 'PROCESSED');
  assert.equal((await svc.find({ tenantId: 't1', paymentId: id })).refundStatus, 'PARTIALLY_REFUNDED');
});

test('one business failing does not stop the others, and the failure is reported rather than hidden', async () => {
  await reset();
  await trip('T1'); await trip('T9', 't2');
  const a = await open('T1');
  const b = await open('T9', 't2');
  await db.Payment.findOneAndUpdate({ paymentId: a }, { $set: { provider: 'RAZORPAY' } }); // this business's provider cannot be asked
  const later = new Date(Date.now() + 2 * 3600000);
  const report = await jobs.runAll({ now: later });
  assert.ok(row('t1', report).errors.length >= 1, 'the broken business reports its error');
  assert.equal(row('t2', report).expired, 1, 'the other business is still handled');
  assert.equal((await svc.find({ tenantId: 't2', paymentId: b })).status, 'EXPIRED');
  assert.equal((await svc.find({ tenantId: 't1', paymentId: a })).status, 'PENDING', 'and the broken one is left exactly as it was');
});
