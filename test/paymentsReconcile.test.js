// Reconciliation: compares our payments, ledger, trips and refunds with each other and with the provider's own records. It only FINDS
// differences; nothing is adjusted automatically, and every finding stays open until a person records what was done.
process.env.JWT_SECRET = 'test-secret-for-reconcile';
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
const reconcile = require('../lib/payments/reconcile');
const adapters = require('../lib/payments/adapters');
const ledger = require('../lib/ledger');
const { ACCOUNTS: A } = ledger;

const MODELS = ['Tenant', 'TripDetails', 'Payment', 'PaymentEvent', 'PaymentRefund', 'PaymentDiscrepancy', 'LedgerTxn'];
const flush = async () => { for (const m of MODELS) await db[m].find({}); };
const earn = (fare) => ({ fareMinor: fare, feeMinor: Math.round(fare * 0.15), netMinor: fare - Math.round(fare * 0.15), percent: 15, currency: 'INR' });
const reset = async () => {
  for (const m of MODELS) db[m].rows.length = 0;
  await flush();
  adapters.resetMock();
  for (const id of ['t1', 't2']) await db.Tenant.create({ tenantId: id, name: id, slug: id, appName: id, packageName: `in.${id}`, isDefault: id === 't1', payments: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', commissionRecovery: 'MANUAL_ONLY' } });
};
const trip = (id, fare = 20000, tenantId = 't1', over = {}) => db.TripDetails.create({ trip_id: id, request_id: `R${id}`, tenant_id: tenantId, user_id: `U${id}`, driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), driver_earning: earn(fare), ...over });
const open = async (id, scenario = null, tenantId = 't1') => {
  const { payment } = await svc.createPayment({ tenantId, tripId: id, riderId: `U${id}`, method: 'UPI', idempotencyKey: `u-${id}-${Math.random()}` });
  if (scenario) await svc.simulate({ tenantId, paymentId: payment.paymentId, scenario });
  return payment.paymentId;
};
const run = (tenantId = 't1', extra = {}) => reconcile.run({ tenantId, ...extra });
const types = (r) => r.discrepancies.map((d) => d.type).sort();
const gw = () => adapters.getAdapter('MOCK');

test('books that agree produce no findings, across cash, online and a refund', async () => {
  await reset();
  await trip('T1'); await trip('T2'); await trip('T3');
  await cash.confirmCash({ tenantId: 't1', tripId: 'T1', driverId: 'D1' });
  const online = await open('T2', 'SUCCESS');
  await refunds.requestRefund({ tenantId: 't1', paymentId: online, amountMinor: 5000, reason: 'part refund', requestedBy: 'a', idempotencyKey: 'rf' });
  await open('T3'); // an open payment, still pending at the provider too
  const r = await run();
  assert.deepEqual(r.discrepancies, []);
  assert.ok(r.checked.payments >= 3);
});

test('the provider took the money but we never recorded it: flagged, and nothing is changed behind anyone\'s back', async () => {
  await reset();
  await trip('T1');
  const id = await open('T1');
  const p = await svc.find({ tenantId: 't1', paymentId: id });
  gw().orders.get(p.providerOrderId).status = 'paid'; // the webhook never arrived
  const r = await run();
  assert.deepEqual(types(r), ['PROVIDER_PAID_NOT_RECORDED']);
  assert.equal((await svc.find({ tenantId: 't1', paymentId: id })).status, 'PENDING', 'reconciliation does not mark it paid');
  assert.equal((await ledger.verify({ tenantId: 't1' })).transactions, 0);
});

test('we recorded a success the provider does not confirm, or for another amount', async () => {
  await reset();
  await trip('T1'); await trip('T2');
  const a = await open('T1', 'SUCCESS');
  const b = await open('T2', 'SUCCESS');
  gw().orders.get((await svc.find({ tenantId: 't1', paymentId: a })).providerOrderId).status = 'failed';
  gw().orders.get((await svc.find({ tenantId: 't1', paymentId: b })).providerOrderId).amountMinor = 100;
  const r = await run();
  assert.deepEqual(types(r), ['PROVIDER_AMOUNT_MISMATCH', 'SUCCESS_NOT_CONFIRMED_BY_PROVIDER']);
});

test('a succeeded payment with no ledger posting, a paid trip with no payment, and a ride paid twice are each flagged', async () => {
  await reset();
  await trip('T1'); await trip('T2', 20000, 't1', { payment_status: 'PAID', payment_mode: 'UPI' }); await trip('T3');
  const a = await open('T1', 'SUCCESS');
  db.LedgerTxn.rows.length = 0; await flush();
  await db.Payment.findOneAndUpdate({ paymentId: a }, { $set: { ledgerTxnId: null } });
  // T3 paid twice: a late success on an expired first attempt plus a normal second payment
  const first = await open('T3'); await svc.simulate({ tenantId: 't1', paymentId: first, scenario: 'EXPIRED' });
  const second = await open('T3'); await svc.simulate({ tenantId: 't1', paymentId: second, scenario: 'SUCCESS' });
  await svc.simulate({ tenantId: 't1', paymentId: first, scenario: 'SUCCESS' });
  const r = await run();
  assert.deepEqual(types(r), ['DUPLICATE_PAYMENT', 'SUCCESS_NOT_POSTED', 'TRIP_PAID_WITHOUT_PAYMENT']);
  assert.equal((await svc.find({ tenantId: 't1', paymentId: a })).ledgerTxnId, null, 'still not posted: repairing is a separate, explicit step');
});

test('a commission that disagrees with the ledger, a webhook never finished, and an unbalanced entry are flagged', async () => {
  await reset();
  await trip('T1');
  const a = await open('T1', 'SUCCESS');
  await db.Payment.findOneAndUpdate({ paymentId: a }, { $set: { commission: { rule: { percent: 15 }, commissionMinor: 2000, netMinor: 18000 } } });
  await db.PaymentEvent.create({ tenantId: 't1', provider: 'MOCK', eventId: 'stuck-1', receivedAt: new Date(Date.now() - 3 * 3600000), outcome: null });
  await db.PaymentEvent.create({ tenantId: 't1', provider: 'MOCK', eventId: 'err-1', receivedAt: new Date(Date.now() - 3 * 3600000), outcome: 'ERROR' });
  await db.LedgerTxn.create({ tenantId: 't1', txnId: 'rogue', eventKey: 'rogue', type: 'X', currency: 'INR', entries: [{ account: A.GATEWAY_CLEARING, debitMinor: 10 }, { account: A.COMMISSION_REVENUE, creditMinor: 9 }] });
  const r = await run();
  assert.deepEqual(types(r), ['COMMISSION_MISMATCH', 'LEDGER_UNBALANCED', 'UNPROCESSED_WEBHOOK', 'UNPROCESSED_WEBHOOK']);
});

test('refunds: one stuck for a day, and one the provider finished that we never recorded', async () => {
  await reset();
  await trip('T1'); await trip('T2');
  const a = await open('T1', 'SUCCESS'); const b = await open('T2', 'SUCCESS');
  gw().refundMode = 'pending';
  const r1 = await refunds.requestRefund({ tenantId: 't1', paymentId: a, amountMinor: 1000, reason: 'slow', requestedBy: 'x', idempotencyKey: 'k1' });
  const r2 = await refunds.requestRefund({ tenantId: 't1', paymentId: b, amountMinor: 1000, reason: 'done', requestedBy: 'x', idempotencyKey: 'k2' });
  gw().completeRefund(r2.refund.providerRefundId, 'processed'); // provider finished it, our record still says requested
  await db.PaymentRefund.findOneAndUpdate({ refundId: r1.refund.refundId }, { $set: { createdAt: new Date(Date.now() - 2 * 86400000) } });
  const r = await run();
  assert.deepEqual(types(r), ['REFUND_PROVIDER_FINISHED_NOT_RECORDED', 'REFUND_STUCK']);
});

test('a cash fare the driver never confirmed is flagged after the grace period, not before', async () => {
  await reset();
  await trip('T1');
  await cash.ensureCashPayment({ tenantId: 't1', trip: db.TripDetails.rows[0] });
  assert.deepEqual((await run('t1', { now: new Date() })).discrepancies, []);
  const r = await run('t1', { now: new Date(Date.now() + 3 * 86400000) });
  assert.deepEqual(types(r), ['CASH_NOT_CONFIRMED']);
});

test('findings are stored once, kept open until a person resolves them with a note, and reopened if the problem is still there', async () => {
  await reset();
  await trip('T1');
  const id = await open('T1');
  const p = await svc.find({ tenantId: 't1', paymentId: id });
  gw().orders.get(p.providerOrderId).status = 'paid';
  const first = await run();
  const again = await run();
  assert.equal(first.newCount, 1);
  assert.equal(again.newCount, 0, 'the same finding is the same record');
  assert.equal((await db.PaymentDiscrepancy.find({ tenantId: 't1' })).length, 1);
  const found = (await reconcile.list({ tenantId: 't1', status: 'OPEN' }))[0];
  await assert.rejects(reconcile.resolve({ tenantId: 't1', discrepancyId: found.discrepancyId, adminId: 'A1', note: '' }), (e) => e.code === 'NOTE_REQUIRED');
  await assert.rejects(reconcile.resolve({ tenantId: 't2', discrepancyId: found.discrepancyId, adminId: 'A9', note: 'not mine' }), (e) => e.code === 'NOT_FOUND', 'another business cannot resolve it');
  const done = await reconcile.resolve({ tenantId: 't1', discrepancyId: found.discrepancyId, adminId: 'A1', note: 'Marked paid after checking the provider dashboard' });
  assert.deepEqual([done.status, done.resolvedBy], ['RESOLVED', 'A1']);
  assert.equal((await reconcile.list({ tenantId: 't1', status: 'OPEN' })).length, 0);
  const third = await run();
  const reopened = (await reconcile.list({ tenantId: 't1', status: 'OPEN' }))[0];
  assert.deepEqual([third.newCount, reopened.reopenedCount], [0, 1], 'it was not really fixed, so it is open again');
});

test('one business\'s reconciliation never shows or counts another business\'s money', async () => {
  await reset();
  await trip('T1'); await trip('T9', 20000, 't2');
  const mine = await open('T1');
  const theirs = await open('T9', null, 't2');
  gw().orders.get((await svc.find({ tenantId: 't2', paymentId: theirs })).providerOrderId).status = 'paid';
  const r1 = await run('t1');
  assert.deepEqual(r1.discrepancies, [], 'the other business\'s problem is not in this report');
  const r2 = await run('t2');
  assert.deepEqual(types(r2), ['PROVIDER_PAID_NOT_RECORDED']);
  assert.equal((await reconcile.list({ tenantId: 't1', status: 'OPEN' })).length, 0);
  assert.ok(mine);
});
