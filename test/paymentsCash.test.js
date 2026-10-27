// Cash payments: the driver collects the fare and confirms it; the platform's commission becomes a receivable from the driver (never
// revenue already collected, and never cash the platform received). Every result is checked in the payment, the ledger and the trip.
process.env.JWT_SECRET = 'test-secret-for-cash-payments';
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
const adapters = require('../lib/payments/adapters');
const ledger = require('../lib/ledger');
const { ACCOUNTS: A } = ledger;

const MODELS = ['Tenant', 'TripDetails', 'Payment', 'PaymentEvent', 'LedgerTxn'];
const flush = async () => { for (const m of MODELS) await db[m].find({}); };
const earning = { fareMinor: 20000, feeMinor: 3000, netMinor: 17000, percent: 15, currency: 'INR' };
const reset = async (tripOver = {}) => {
  for (const m of MODELS) db[m].rows.length = 0;
  await flush();
  adapters.resetMock();
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', slug: 'uride', appName: 'uRide', packageName: 'in.uride', isDefault: true, payments: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK' } });
  await db.Tenant.create({ tenantId: 't2', name: 'Other', slug: 'other', appName: 'Other', packageName: 'in.other' });
  await db.TripDetails.create({ trip_id: 'T1', request_id: 'R1', tenant_id: 't1', user_id: 'U1', driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), payment_mode: 'CASH', driver_earning: earning, ...tripOver });
};

const confirm = (over = {}) => cash.confirmCash({ tenantId: 't1', tripId: 'T1', driverId: 'D1', idempotencyKey: 'c1', ...over });
const trip = () => db.TripDetails.rows.find((t) => t.trip_id === 'T1');
const cashRow = () => db.Payment.rows.find((p) => p.method === 'CASH');
const dbRow = () => svc.find({ tenantId: 't1', tripId: 'T1', method: 'CASH' });
const txns = () => ledger.verify({ tenantId: 't1' }).then((v) => v.transactions);
const owed = () => ledger.commissionOutstanding({ tenantId: 't1', driverId: 'D1' });
const books = () => ledger.balances({ tenantId: 't1' });
const refuse = (p, code) => assert.rejects(p, (e) => e.code === code, code);

test('completing a trip leaves a cash payment waiting for the driver; asking again (or ten times at once) leaves one', async () => {
  await reset();
  const p = await cash.ensureCashPayment({ tenantId: 't1', trip: trip() });
  assert.deepEqual([p.method, p.status, p.cashState, p.amountMinor, p.driverId, p.live], ['CASH', 'PENDING', 'PENDING', 20000, 'D1', true]);
  assert.equal(trip().payment_status === 'PAID', false);
  const burst = await Promise.all(Array.from({ length: 10 }, () => cash.ensureCashPayment({ tenantId: 't1', trip: trip() })));
  assert.equal(new Set(burst.map((x) => x.paymentId)).size, 1);
  assert.equal((await db.Payment.find({ tenantId: 't1' })).length, 1);
  assert.equal(await txns(), 0, 'nothing is booked until the driver confirms');
});

test('the driver confirms the cash: the fare is paid, and the commission is booked as owed BY the driver, not as money collected', async () => {
  await reset();
  const r = await confirm();
  assert.equal(r.duplicate, false);
  const p = await dbRow();
  assert.deepEqual([p.status, p.cashState, p.cash.collectedMinor, p.cash.confirmedBy, !!p.ledgerTxnId], ['SUCCEEDED', 'CONFIRMED', 20000, 'driver:D1', true]);
  assert.deepEqual([trip().payment_status, trip().payment_mode, trip().payment_id], ['PAID', 'CASH', p.paymentId]);
  const b = await books();
  assert.equal(b[A.DRIVER_COMMISSION_RECEIVABLE], 3000, 'the driver owes 30');
  assert.equal(b[A.COMMISSION_REVENUE], -3000, 'earned, but not yet collected');
  assert.equal(b[A.GATEWAY_CLEARING] || 0, 0, 'no cash reached the platform');
  assert.equal(b[A.DRIVER_PAYABLE] || 0, 0, 'the driver holds their 170 already: the business owes them nothing for a cash fare');
  assert.equal(await owed(), 3000);
  assert.deepEqual((await ledger.verify({ tenantId: 't1' })).problems, []);
});

test('confirming again is harmless: same key, different key, a retry after a lost reply, or ten at once all leave one booking', async () => {
  await reset();
  const first = await confirm();
  const again = await confirm();
  const other = await confirm({ idempotencyKey: 'c2' });
  assert.deepEqual([again.duplicate, other.duplicate], [true, true]);
  assert.equal(again.payment.paymentId, first.payment.paymentId);
  assert.equal(await txns(), 1);
  assert.equal(await owed(), 3000);
  await reset();
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => confirm({ idempotencyKey: `b${i}` })));
  assert.equal(burst.filter((r) => !r.duplicate).length, 1, 'exactly one request did the work');
  assert.equal(await txns(), 1);
  assert.equal(await owed(), 3000);
  assert.equal(db.Payment.rows.filter((p) => p.method === 'CASH').length, 1);
});

test('a second confirmation with a different amount is refused (a confirmed collection is never silently changed)', async () => {
  await reset();
  await confirm();
  await refuse(confirm({ collectedMinor: 15000 }), 'ALREADY_CONFIRMED');
  assert.equal((await dbRow()).cash.collectedMinor, 20000);
  assert.equal(await owed(), 3000);
});

test('only the trip\'s own driver, in the trip\'s own business, after the ride is completed and while it is not paid another way', async () => {
  await reset();
  await refuse(confirm({ driverId: 'D2' }), 'NOT_FOUND');
  await refuse(confirm({ tenantId: 't2' }), 'NOT_FOUND');
  await refuse(confirm({ tripId: 'NOPE' }), 'NOT_FOUND');
  assert.equal((await db.Payment.find({})).length, 0, 'refused attempts create nothing');
  await reset({ status: 'ON_GOING' });
  await refuse(confirm(), 'TRIP_NOT_COMPLETED');
  await reset({ driver_earning: null });
  await refuse(confirm(), 'TRIP_NOT_FINALISED');
  await reset({ payment_status: 'PAID', payment_mode: 'UPI' });
  await refuse(confirm(), 'ALREADY_PAID');
  assert.equal(await txns(), 0);
});

test('a collected amount that is not the fare is not booked: it becomes a dispute for the business to resolve', async () => {
  await reset();
  const r = await confirm({ collectedMinor: 15000 });
  assert.equal(r.disputed, true);
  const p = await dbRow();
  assert.deepEqual([p.status, p.cashState, p.cash.collectedMinor, p.cash.dispute.by], ['PENDING', 'DISPUTED', 15000, 'driver']);
  assert.equal(trip().payment_status, 'DISPUTED');
  assert.equal(await txns(), 0, 'nothing is booked on a disputed amount');
  const same = await confirm({ collectedMinor: 15000 });
  assert.equal(same.duplicate, true);
  await refuse(confirm({ collectedMinor: 20000, idempotencyKey: 'other' }), 'PAYMENT_IN_DISPUTE');
  for (const bad of [-1, 10.5, '200']) await refuse(confirm({ collectedMinor: bad, idempotencyKey: `x${bad}` }), 'BAD_AMOUNT');
});

test('the rider or the driver can dispute a collection, even after it was confirmed; the booking stays until the business decides', async () => {
  await reset();
  await confirm();
  await refuse(cash.disputeCash({ tenantId: 't1', tripId: 'T1', by: 'rider', actorId: 'U9', reason: 'I paid 150 not 200' }), 'NOT_FOUND');
  await refuse(cash.disputeCash({ tenantId: 't1', tripId: 'T1', by: 'rider', actorId: 'U1', reason: '' }), 'REASON_REQUIRED');
  const d = await cash.disputeCash({ tenantId: 't1', tripId: 'T1', by: 'rider', actorId: 'U1', reason: 'I paid 150 not 200' });
  assert.deepEqual([d.cashState, d.status, d.cash.dispute.by, d.cash.dispute.reason], ['DISPUTED', 'SUCCEEDED', 'rider', 'I paid 150 not 200']);
  assert.equal(trip().payment_status, 'DISPUTED');
  assert.equal(await owed(), 3000, 'the commission booking is untouched while it is disputed');
  assert.equal(await txns(), 1);
});

test('the business resolves a dispute: confirming the fare books the commission once; adjusting it reverses the old booking and books the right one', async () => {
  await reset();
  await confirm({ collectedMinor: 15000 });
  const id = (await dbRow()).paymentId;
  await refuse(cash.resolveCash({ tenantId: 't1', paymentId: id, adminId: 'A1', action: 'CONFIRM', reason: '' }), 'REASON_REQUIRED');
  await refuse(cash.resolveCash({ tenantId: 't2', paymentId: id, adminId: 'A9', action: 'CONFIRM', reason: 'x' }), 'NOT_FOUND');
  const ok = await cash.resolveCash({ tenantId: 't1', paymentId: id, adminId: 'A1', action: 'CONFIRM', reason: 'Rider confirmed Rs 200 by phone' });
  assert.deepEqual([ok.status, ok.cashState, ok.cash.resolution.by, ok.cash.resolution.action], ['SUCCEEDED', 'CONFIRMED', 'A1', 'CONFIRM']);
  assert.equal(await owed(), 3000);
  assert.equal(trip().payment_status, 'PAID');
  await refuse(cash.resolveCash({ tenantId: 't1', paymentId: id, adminId: 'A1', action: 'CONFIRM', reason: 'again' }), 'NOT_DISPUTED');

  await reset();
  await confirm();
  await cash.disputeCash({ tenantId: 't1', tripId: 'T1', by: 'rider', actorId: 'U1', reason: 'paid less' });
  const id2 = cashRow().paymentId;
  await refuse(cash.resolveCash({ tenantId: 't1', paymentId: id2, adminId: 'A1', action: 'ADJUST', adjustedFareMinor: -5, reason: 'negative fare' }), 'BAD_AMOUNT');
  const adj = await cash.resolveCash({ tenantId: 't1', paymentId: id2, adminId: 'A1', action: 'ADJUST', adjustedFareMinor: 15000, reason: 'Fare reduced to Rs 150 after the rider complained' });
  assert.deepEqual([adj.cashState, adj.cash.adjustedFareMinor, adj.cash.adjustedCommission.commissionMinor, adj.cash.adjustedCommission.netMinor], ['ADJUSTED', 15000, 2250, 12750]);
  assert.equal(adj.amountMinor, 20000, 'the original fare on the payment is never rewritten');
  assert.equal(adj.commission.commissionMinor, 3000, 'nor is the original commission snapshot');
  assert.equal(await owed(), 2250, 'the driver now owes 22.50');
  assert.equal((await books())[A.COMMISSION_REVENUE], -2250);
  assert.deepEqual((await db.LedgerTxn.find({ tenantId: 't1' })).map((t) => t.type).sort(), ['CASH_COMMISSION_ACCRUED', 'CASH_COMMISSION_ADJUSTED', 'REVERSAL_OF_CASH_COMMISSION_ACCRUED']);
  assert.deepEqual((await ledger.verify({ tenantId: 't1' })).problems, []);
});

test('a confirmation can come late (days after the ride) and still books correctly', async () => {
  await reset();
  await cash.ensureCashPayment({ tenantId: 't1', trip: trip() });
  const week = new Date(Date.now() + 7 * 86400000);
  const r = await cash.confirmCash({ tenantId: 't1', tripId: 'T1', driverId: 'D1', idempotencyKey: 'late', now: week });
  assert.equal(r.payment.cashState, 'CONFIRMED');
  assert.equal(await owed(), 3000);
});

test('if the booking is interrupted after the collection is confirmed, a retry or the repair completes it once', async () => {
  await reset();
  const real = ledger.post;
  ledger.post = async () => { throw new Error('database went away'); };
  await assert.rejects(confirm(), /database went away/);
  ledger.post = real;
  let p = await dbRow();
  assert.deepEqual([p.cashState, !!p.ledgerTxnId], ['CONFIRMED', false], 'confirmed but not yet booked');
  const retry = await confirm();
  assert.equal(retry.duplicate, true);
  assert.equal(await owed(), 3000);
  assert.equal(await txns(), 1);
  p = await dbRow();
  assert.equal(!!p.ledgerTxnId, true);
  // and the repair finds nothing left to do
  assert.equal(await cash.repairUnposted({ tenantId: 't1' }), 0);
});

test('a business with a 0% commission confirms cash with nothing to book, and nothing is owed', async () => {
  await reset({ driver_earning: { fareMinor: 20000, feeMinor: 0, netMinor: 20000, percent: 0, currency: 'INR' } });
  const r = await confirm();
  assert.equal(r.payment.cashState, 'CONFIRMED');
  assert.equal(await txns(), 0);
  assert.equal(await owed(), 0);
  assert.equal(trip().payment_status, 'PAID');
  assert.equal(await cash.repairUnposted({ tenantId: 't1' }), 0, 'a fare with no commission is not "unposted"');
});

test('choosing UPI while the cash payment is still waiting cancels the cash payment; once cash is confirmed or disputed UPI is refused', async () => {
  await reset();
  await cash.ensureCashPayment({ tenantId: 't1', trip: trip() });
  const up = await svc.createPayment({ tenantId: 't1', tripId: 'T1', riderId: 'U1', method: 'UPI', idempotencyKey: 'u1' });
  assert.equal(up.payment.method, 'UPI');
  assert.deepEqual([cashRow().status, cashRow().live], ['CANCELLED', false]);
  await reset();
  await confirm();
  await refuse(svc.createPayment({ tenantId: 't1', tripId: 'T1', riderId: 'U1', method: 'UPI', idempotencyKey: 'u2' }), 'ALREADY_PAID');
  await reset();
  await confirm({ collectedMinor: 100 });
  await refuse(svc.createPayment({ tenantId: 't1', tripId: 'T1', riderId: 'U1', method: 'UPI', idempotencyKey: 'u3' }), 'PAYMENT_IN_DISPUTE');
});

test('the commission each driver owes is kept per driver and per business', async () => {
  await reset();
  await db.TripDetails.create({ trip_id: 'T2', request_id: 'R2', tenant_id: 't1', user_id: 'U2', driver_id: 'D2', status: 'COMPLETED', timeout_at: new Date(), driver_earning: { fareMinor: 10000, feeMinor: 1500, netMinor: 8500, percent: 15, currency: 'INR' } });
  await db.TripDetails.create({ trip_id: 'T3', request_id: 'R3', tenant_id: 't2', user_id: 'U3', driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), driver_earning: { fareMinor: 40000, feeMinor: 6000, netMinor: 34000, percent: 15, currency: 'INR' } });
  await confirm();
  await cash.confirmCash({ tenantId: 't1', tripId: 'T2', driverId: 'D2', idempotencyKey: 'd2' });
  await cash.confirmCash({ tenantId: 't2', tripId: 'T3', driverId: 'D1', idempotencyKey: 'x' });
  assert.equal(await ledger.commissionOutstanding({ tenantId: 't1', driverId: 'D1' }), 3000);
  assert.equal(await ledger.commissionOutstanding({ tenantId: 't1', driverId: 'D2' }), 1500);
  assert.equal(await ledger.commissionOutstanding({ tenantId: 't2', driverId: 'D1' }), 6000, 'a driver id in another business is a different account');
});
