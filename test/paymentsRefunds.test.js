// Refunds of online payments: a separate refund status, exact shares between the business's commission and the driver's earnings,
// no over-refund however many requests arrive, and a ledger that balances through every outcome (processed, pending, failed).
process.env.JWT_SECRET = 'test-secret-for-refunds';
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
const adapters = require('../lib/payments/adapters');
const ledger = require('../lib/ledger');
const { ACCOUNTS: A } = ledger;

const MODELS = ['Tenant', 'TripDetails', 'Payment', 'PaymentEvent', 'PaymentRefund', 'LedgerTxn'];
const flush = async () => { for (const m of MODELS) await db[m].find({}); };
const reset = async () => {
  for (const m of MODELS) db[m].rows.length = 0;
  await flush();
  adapters.resetMock();
  for (const id of ['t1', 't2']) await db.Tenant.create({ tenantId: id, name: id, slug: id, appName: id, packageName: `in.${id}`, isDefault: id === 't1', payments: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', commissionRecovery: 'MANUAL_ONLY' } });
  await db.TripDetails.create({ trip_id: 'T1', request_id: 'R1', tenant_id: 't1', user_id: 'U1', driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), driver_earning: { fareMinor: 20000, feeMinor: 3000, netMinor: 17000, percent: 15, currency: 'INR' } });
};
const paid = async (key = 'p1') => {
  const { payment } = await svc.createPayment({ tenantId: 't1', tripId: 'T1', riderId: 'U1', method: 'UPI', idempotencyKey: key });
  await svc.simulate({ tenantId: 't1', paymentId: payment.paymentId, scenario: 'SUCCESS' });
  return payment.paymentId;
};
const ask = (paymentId, amountMinor, over = {}) => refunds.requestRefund({ tenantId: 't1', paymentId, amountMinor, reason: 'rider complaint', requestedBy: 'admin:a1', idempotencyKey: `r-${amountMinor}-${Math.random()}`, ...over });
const payment = (id) => svc.find({ tenantId: 't1', paymentId: id });
const books = () => ledger.balances({ tenantId: 't1' });
const refuse = (p, code) => assert.rejects(p, (e) => e.code === code, code);
const ledgerTypes = async () => (await db.LedgerTxn.find({ tenantId: 't1' })).map((t) => t.type).sort();
const gw = () => adapters.getAdapter('MOCK');

test('a full refund reverses the fare in the ledger exactly: the gateway, the driver\'s share and the commission all go back to zero', async () => {
  await reset();
  const id = await paid();
  const r = await ask(id, 20000);
  assert.equal(r.refund.status, 'PROCESSED');
  const p = await payment(id);
  assert.deepEqual([p.refundStatus, p.refundedMinor, p.status], ['REFUNDED', 20000, 'SUCCEEDED']);
  assert.equal(db.TripDetails.rows[0].payment_status, 'REFUNDED');
  const b = await books();
  assert.deepEqual([b[A.GATEWAY_CLEARING], b[A.DRIVER_PAYABLE], b[A.COMMISSION_REVENUE]], [0, 0, 0]);
  assert.deepEqual(await ledgerTypes(), ['ONLINE_FARE_CAPTURED', 'ONLINE_REFUND']);
  assert.equal(await ledger.owedToDriver({ tenantId: 't1', driverId: 'D1' }), 0);
  assert.deepEqual((await ledger.verify({ tenantId: 't1' })).problems, []);
});

test('partial refunds share the amount between commission and driver in proportion, and the last one takes the exact remainder', async () => {
  await reset();
  const id = await paid();
  const a = await ask(id, 5000);
  assert.deepEqual([a.refund.commissionMinor, a.refund.netMinor], [750, 4250]);
  let p = await payment(id);
  assert.deepEqual([p.refundStatus, p.refundedMinor], ['PARTIALLY_REFUNDED', 5000]);
  assert.equal(db.TripDetails.rows[0].payment_status, 'PAID', 'a partly refunded ride is still a paid ride');
  const b1 = await books();
  assert.deepEqual([b1[A.GATEWAY_CLEARING], b1[A.DRIVER_PAYABLE], b1[A.COMMISSION_REVENUE]], [15000, -12750, -2250]);
  const c = await ask(id, 333); // a share that does not divide evenly
  assert.equal(c.refund.commissionMinor + c.refund.netMinor, 333);
  const last = await ask(id, 20000 - 5000 - 333);
  p = await payment(id);
  assert.deepEqual([p.refundStatus, p.refundedMinor], ['REFUNDED', 20000]);
  const b2 = await books();
  assert.deepEqual([b2[A.GATEWAY_CLEARING], b2[A.DRIVER_PAYABLE], b2[A.COMMISSION_REVENUE]], [0, 0, 0], 'rounding never leaves a paisa behind');
  assert.equal(a.refund.commissionMinor + c.refund.commissionMinor + last.refund.commissionMinor, 3000);
  assert.equal(a.refund.netMinor + c.refund.netMinor + last.refund.netMinor, 17000);
});

test('the same refund request twice is one refund; asking for more than is left, or after it is all refunded, is refused', async () => {
  await reset();
  const id = await paid();
  const first = await refunds.requestRefund({ tenantId: 't1', paymentId: id, amountMinor: 5000, reason: 'late', requestedBy: 'admin:a1', idempotencyKey: 'same' });
  const again = await refunds.requestRefund({ tenantId: 't1', paymentId: id, amountMinor: 5000, reason: 'late', requestedBy: 'admin:a1', idempotencyKey: 'same' });
  assert.equal(again.duplicate, true);
  assert.equal(again.refund.refundId, first.refund.refundId);
  assert.equal((await db.LedgerTxn.find({ tenantId: 't1', type: 'ONLINE_REFUND' })).length, 1);
  assert.equal((await payment(id)).refundedMinor, 5000);
  await refuse(ask(id, 15001), 'AMOUNT_TOO_HIGH');
  await ask(id, 15000);
  await refuse(ask(id, 1), 'AMOUNT_TOO_HIGH');
  assert.equal((await payment(id)).refundedMinor, 20000);
});

test('five simultaneous refund requests of Rs 100 against a Rs 200 payment refund exactly Rs 200', async () => {
  await reset();
  const id = await paid();
  const out = await Promise.allSettled(Array.from({ length: 5 }, () => ask(id, 10000)));
  assert.equal(out.filter((o) => o.status === 'fulfilled').length, 2);
  assert.ok(out.filter((o) => o.status === 'rejected').every((o) => o.reason.code === 'AMOUNT_TOO_HIGH'));
  const p = await payment(id);
  assert.deepEqual([p.refundedMinor, p.refundStatus], [20000, 'REFUNDED']);
  assert.equal((await ledger.verify({ tenantId: 't1' })).transactions, 3);
  const b = await books();
  assert.deepEqual([b[A.GATEWAY_CLEARING], b[A.DRIVER_PAYABLE], b[A.COMMISSION_REVENUE]], [0, 0, 0]);
});

test('a refund the provider fails books nothing and releases the amount, so it can be refunded again', async () => {
  await reset();
  const id = await paid();
  gw().refundMode = 'failed';
  const bad = await ask(id, 20000);
  assert.deepEqual([bad.refund.status, bad.refund.failureReason], ['FAILED', 'PROVIDER_FAILED']);
  let p = await payment(id);
  assert.deepEqual([p.refundStatus, p.refundedMinor, p.refund.reservedMinor], ['NONE', 0, 0]);
  assert.equal((await db.LedgerTxn.find({ tenantId: 't1', type: 'ONLINE_REFUND' })).length, 0);
  gw().refundMode = 'processed';
  const ok = await ask(id, 20000);
  assert.equal(ok.refund.status, 'PROCESSED');
  p = await payment(id);
  assert.equal(p.refundStatus, 'REFUNDED');
});

test('a delayed refund stays pending (and blocks over-requesting) until the provider confirms; confirming twice books it once', async () => {
  await reset();
  const id = await paid();
  gw().refundMode = 'pending';
  const r = await ask(id, 20000);
  assert.equal(r.refund.status, 'REQUESTED');
  let p = await payment(id);
  assert.deepEqual([p.refundStatus, p.refundedMinor], ['REFUND_PENDING', 0]);
  assert.equal((await db.LedgerTxn.find({ tenantId: 't1', type: 'ONLINE_REFUND' })).length, 0, 'nothing is booked before the provider confirms');
  await refuse(ask(id, 1), 'AMOUNT_TOO_HIGH');
  const still = await refunds.settleRefund({ tenantId: 't1', refundId: r.refund.refundId });
  assert.equal(still.status, 'REQUESTED', 'the provider has not finished');
  gw().completeRefund(r.refund.providerRefundId, 'processed');
  const [a, b] = await Promise.all([refunds.settleRefund({ tenantId: 't1', refundId: r.refund.refundId }), refunds.settleRefund({ tenantId: 't1', refundId: r.refund.refundId })]);
  assert.deepEqual([a.status, b.status], ['PROCESSED', 'PROCESSED']);
  p = await payment(id);
  assert.deepEqual([p.refundStatus, p.refundedMinor], ['REFUNDED', 20000]);
  assert.equal((await ledger.verify({ tenantId: 't1' })).transactions, 2);
  assert.equal((await books())[A.GATEWAY_CLEARING], 0);

  await reset();
  const id2 = await paid();
  gw().refundMode = 'pending';
  const r2 = await ask(id2, 5000);
  gw().completeRefund(r2.refund.providerRefundId, 'failed');
  const failed = await refunds.settleRefund({ tenantId: 't1', refundId: r2.refund.refundId });
  assert.equal(failed.status, 'FAILED');
  const p2 = await payment(id2);
  assert.deepEqual([p2.refundStatus, p2.refund.reservedMinor], ['NONE', 0]);
});

test('a refund after the driver was already paid out leaves the driver owing it (a negative payable), and the books still balance', async () => {
  await reset();
  const id = await paid();
  await ledger.post({ tenantId: 't1', eventKey: 'payout-1', type: 'PAYOUT_PAID', currency: 'INR', driverId: 'D1', entries: [{ account: A.DRIVER_PAYABLE, driverId: 'D1', debitMinor: 17000 }, { account: A.SETTLEMENT_CLEARING, creditMinor: 17000 }] });
  assert.equal(await ledger.owedToDriver({ tenantId: 't1', driverId: 'D1' }), 0);
  await ask(id, 20000);
  assert.equal(await ledger.owedToDriver({ tenantId: 't1', driverId: 'D1' }), -17000, 'the driver now owes the business Rs 170');
  assert.deepEqual((await ledger.verify({ tenantId: 't1' })).problems, []);
});

test('a second payment for an already paid ride is refunded against the money owed back, not against the driver or the commission', async () => {
  await reset();
  const first = (await svc.createPayment({ tenantId: 't1', tripId: 'T1', riderId: 'U1', method: 'UPI', idempotencyKey: 'a' })).payment;
  await svc.simulate({ tenantId: 't1', paymentId: first.paymentId, scenario: 'EXPIRED' });
  const second = (await svc.createPayment({ tenantId: 't1', tripId: 'T1', riderId: 'U1', method: 'UPI', idempotencyKey: 'b' })).payment;
  await svc.simulate({ tenantId: 't1', paymentId: second.paymentId, scenario: 'SUCCESS' });
  await svc.simulate({ tenantId: 't1', paymentId: first.paymentId, scenario: 'SUCCESS' }); // the late duplicate
  const r = await ask(first.paymentId, 20000);
  assert.equal(r.refund.duplicateCapture, true);
  assert.deepEqual([r.refund.commissionMinor, r.refund.netMinor], [0, 0]);
  const b = await books();
  assert.deepEqual([b[A.GATEWAY_CLEARING], b[A.DRIVER_PAYABLE], b[A.COMMISSION_REVENUE], b[A.REFUND_CLEARING]], [20000, -17000, -3000, 0]);
});

test('only a succeeded online fare payment of this business can be refunded, with a reason and a whole positive amount', async () => {
  await reset();
  const { payment: pending } = await svc.createPayment({ tenantId: 't1', tripId: 'T1', riderId: 'U1', method: 'UPI', idempotencyKey: 'x' });
  await refuse(ask(pending.paymentId, 100), 'NOT_REFUNDABLE');
  await svc.simulate({ tenantId: 't1', paymentId: pending.paymentId, scenario: 'SUCCESS' });
  await refuse(refunds.requestRefund({ tenantId: 't2', paymentId: pending.paymentId, amountMinor: 100, reason: 'x y z', requestedBy: 'a', idempotencyKey: 'k' }), 'NOT_FOUND');
  await refuse(ask(pending.paymentId, 100, { reason: '' }), 'REASON_REQUIRED');
  for (const bad of [0, -5, 10.5, '100', null]) await refuse(ask(pending.paymentId, bad), 'BAD_AMOUNT');
  await refuse(refunds.requestRefund({ tenantId: 't1', paymentId: pending.paymentId, amountMinor: 100, reason: 'why', requestedBy: 'a' }), 'IDEMPOTENCY_KEY_REQUIRED');
  await reset();
  await cash.confirmCash({ tenantId: 't1', tripId: 'T1', driverId: 'D1' });
  const cashPay = (await db.Payment.find({ method: 'CASH' }))[0];
  await refuse(ask(cashPay.paymentId, 100), 'NOT_REFUNDABLE');
  assert.equal((await db.PaymentRefund.find({})).length, 0, 'refused requests leave no record');
});

test('rounding drift across many tiny refunds is corrected by the last one: the books end at exactly zero', async () => {
  await reset();
  const id = await paid();
  const shares = [];
  for (let i = 0; i < 5; i += 1) shares.push((await ask(id, 1)).refund); // each 1 paisa rounds its commission share down to 0
  assert.ok(shares.every((r) => r.commissionMinor === 0 && r.netMinor === 1));
  const last = await ask(id, 20000 - 5);
  assert.equal(last.refund.commissionMinor, 3000, 'the last refund carries all the commission still to be reversed');
  assert.equal(last.refund.netMinor, 17000 - 5, 'and the driver share is what is left of theirs');
  const b = await books();
  assert.deepEqual([b[A.GATEWAY_CLEARING], b[A.DRIVER_PAYABLE], b[A.COMMISSION_REVENUE]], [0, 0, 0]);
  assert.equal((await payment(id)).refundStatus, 'REFUNDED');
});
