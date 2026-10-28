// Payouts through the ledger, in shadow mode: the existing manual flow (driver requests, the business pays and records the bank reference) behaves
// exactly as before, and every step is also posted to the ledger, idempotently and per business. A ledger problem never fails a payout action;
// the repair completes it. The mock payout adapter and its scenarios (success, failure, delayed) go through the same moves and postings.
process.env.JWT_SECRET = 'test-secret-for-payouts';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.PAYMENTS_MOCK_ENABLED = '1';
process.env.PAYMENTS_MOCK_SECRET = 'test-mock-secret-0123456789';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const onboarding = require('../controllers/driverOnboardingController');
const E = require('../controllers/driverEarningsController');
const P = require('../controllers/payoutsController');
const svc = require('../lib/payments/service');
const cash = require('../lib/payments/cash');
const recovery = require('../lib/payments/recovery');
const payouts = require('../lib/payments/payouts');
const jobs = require('../lib/payments/jobs');
const adapters = require('../lib/payments/adapters');
const ledger = require('../lib/ledger');
const { ACCOUNTS: A } = ledger;
const { clearAppTenantCache } = require('../lib/appTenant');

const MODELS = ['Tenant', 'Driver', 'TripDetails', 'DriverPayout', 'DriverDutySession', 'AdminAudit', 'Payment', 'PaymentEvent', 'LedgerTxn'];
const flush = async () => { for (const m of MODELS) await db[m].find({}); };
const earn = (fare, pct = 0) => { const fee = Math.round(fare * pct / 100); return { fareMinor: fare, feeMinor: fee, netMinor: fare - fee, percent: pct, currency: 'INR' }; };
const BANK = { accountHolderName: 'Ravi Kumar', accountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC Bank' };

let phoneSeq = 0;
const seed = async () => {
  clearAppTenantCache();
  for (const m of MODELS) db[m].rows.length = 0;
  await flush();
  adapters.resetMock();
  for (const id of ['t1', 't2']) {
    await db.Tenant.create({ tenantId: id, name: id, slug: id, appName: id, packageName: `in.${id}`, isDefault: id === 't1', market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }, payments: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', commissionRecovery: 'DEDUCT_FROM_PAYABLE' } });
  }
  await db.Driver.create({ driverId: 'D1', email: 'd1@t.local', phone: '+919811100000', firstName: 'Ravi', lastName: 'Kumar', tenantId: 't1', accountStatus: 'ACTIVE', bankAccount: BANK });
  await db.Driver.create({ driverId: 'Y1', email: 'y1@t.local', phone: '+919811100099', firstName: 'Yash', lastName: 'Other', tenantId: 't2', accountStatus: 'ACTIVE', bankAccount: BANK });
};

const call = async (fn, { body = {}, params = {}, driverId = 'D1' } = {}) => {
  const req = { authActorId: driverId, body, params, query: {}, headers: {}, ip: '127.0.0.1' };
  let out;
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  let ok = false;
  await onboarding.driverContext(req, res, () => { ok = true; });
  if (!ok) return out;
  await fn(req, res);
  return out;
};
const admin = async (fn, { body = {}, params = {}, tenant = 't1' } = {}) => {
  const business = await db.Tenant.findOne({ tenantId: tenant }).lean();
  const req = {
    body, params, query: {}, ip: '1.1.1.1', business, admin: { adminId: 'A1', email: 'a@t.local', role: 'client_admin' },
    legacyData: { find: (M, f) => M.find(f), findOne: (M, f) => M.findOne(f) }, data: { update: (M, f, v) => M.findOneAndUpdate({ tenantId: tenant }, { $set: v }, { new: true }) }
  };
  let out;
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};

/** The driver is owed `fare` (no commission) from a verified online payment: money in the ledger and in the derived balance. */
async function fundOnline(id = 'W1', fare = 100000, pct = 0, tenantId = 't1', driverId = 'D1') {
  await db.TripDetails.create({ trip_id: id, request_id: `R${id}`, tenant_id: tenantId, user_id: `U${id}`, driver_id: driverId, status: 'COMPLETED', timeout_at: new Date(), fare: fare / 100, currency: 'INR', payment_mode: 'CASH', requested_at: new Date(Date.now() - 7200000), completed_at: new Date(Date.now() - 3600000), distance_km: 5, pickup: { address: 'A' }, drop: { address: 'B' }, driver_earning: earn(fare, pct) });
  const { payment } = await svc.createPayment({ tenantId, tripId: id, riderId: `U${id}`, method: 'UPI', idempotencyKey: `k-${id}` });
  await svc.simulate({ tenantId, paymentId: payment.paymentId, scenario: 'SUCCESS' });
  return payment.paymentId;
}
const reserved = (tenantId = 't1', driverId = 'D1') => ledger.driverBalance({ tenantId, driverId, account: A.PAYOUT_RESERVED }).then((b) => (b === 0 ? 0 : -b)); // never -0
const types = async (tenantId = 't1') => (await db.LedgerTxn.find({ tenantId })).map((t) => t.type).sort();
const payable = (tenantId = 't1', driverId = 'D1') => ledger.owedToDriver({ tenantId, driverId });
const withdraw = (amount, over = {}) => call(E.withdraw, { body: { amount }, ...over });
const stored = (id) => db.DriverPayout.findOne({ payoutId: id }).lean();

test('requesting a withdrawal sets the amount aside in the ledger: payable down, reserved up, the total owed unchanged, and the reply is the same as before', async () => {
  await seed(); await fundOnline();
  const w = await withdraw(400);
  assert.equal(w.code, 200, JSON.stringify(w.body));
  assert.deepEqual([w.body.data.status, w.body.data.minor], ['REQUESTED', 40000]);
  assert.equal(await payable(), 60000);
  assert.equal(await reserved(), 40000);
  const txn = (await db.LedgerTxn.find({ tenantId: 't1', type: 'PAYOUT_RESERVED' }))[0];
  assert.equal(txn.eventKey, `payout:${w.body.data.id}:reserve`);
  assert.deepEqual(txn.entries.map((e) => [e.account, e.debitMinor || 0, e.creditMinor || 0]).sort(), [[A.DRIVER_PAYABLE, 40000, 0], [A.PAYOUT_RESERVED, 0, 40000]]);
  assert.equal((await stored(w.body.data.id)).ledgerSyncedStatus, 'REQUESTED');
  assert.deepEqual((await ledger.verify({ tenantId: 't1' })).problems, []);
});

test('starting changes nothing in the ledger; paying moves the reservation to settlement; paying twice or syncing again posts nothing new', async () => {
  await seed(); await fundOnline();
  const id = (await withdraw(400)).body.data.id;
  await admin(P.start, { params: { id } });
  assert.deepEqual(await types(), ['ONLINE_FARE_CAPTURED', 'PAYOUT_RESERVED']);
  const paid = await admin(P.pay, { params: { id }, body: { reference: 'HDFC20261021A1' } });
  assert.deepEqual([paid.code, paid.body.data.status], [200, 'PAID']);
  assert.deepEqual([await payable(), await reserved()], [60000, 0]);
  const b = await ledger.balances({ tenantId: 't1' });
  assert.equal(b[A.SETTLEMENT_CLEARING], -40000, 'settlement is credited with what was sent');
  assert.equal((await db.LedgerTxn.find({ tenantId: 't1', type: 'PAYOUT_PAID' })).length, 1);
  assert.equal((await admin(P.pay, { params: { id }, body: { reference: 'HDFC20261021A2' } })).code, 409, 'the manual rules are unchanged');
  const again = await payouts.syncPayout(await stored(id));
  assert.deepEqual([again.posted, (await ledger.verify({ tenantId: 't1' })).transactions], [0, 3]);
});

test('a failed payout puts the money back in the payable; so does the driver cancelling', async () => {
  await seed(); await fundOnline();
  const a = (await withdraw(400)).body.data.id;
  assert.equal((await admin(P.fail, { params: { id: a }, body: { reason: 'Account closed' } })).body.data.status, 'FAILED');
  assert.deepEqual([await payable(), await reserved()], [100000, 0]);
  assert.deepEqual(await types(), ['ONLINE_FARE_CAPTURED', 'PAYOUT_RELEASED', 'PAYOUT_RESERVED']);
  const b = (await withdraw(250)).body.data.id;
  assert.equal((await call(E.cancelWithdrawal, { params: { id: b } })).body.data.status, 'CANCELLED');
  assert.deepEqual([await payable(), await reserved()], [100000, 0]);
  assert.equal((await ledger.verify({ tenantId: 't1' })).transactions, 5);
});

test('a withdrawal that is refused (too much, no bank, one already open) leaves the ledger alone', async () => {
  await seed(); await fundOnline();
  assert.equal((await withdraw(1000.01)).code, 400);
  await db.Driver.findOneAndUpdate({ driverId: 'D1' }, { $set: { bankAccount: null } });
  assert.equal((await withdraw(100)).code, 409);
  await db.Driver.findOneAndUpdate({ driverId: 'D1' }, { $set: { bankAccount: BANK } });
  await withdraw(100);
  assert.equal((await withdraw(100)).code, 409);
  assert.equal((await db.LedgerTxn.find({ tenantId: 't1', type: 'PAYOUT_RESERVED' })).length, 1);
});

test('retry after a failure: the second request reserves again and the books carry both, netting correctly', async () => {
  await seed(); await fundOnline();
  const a = (await withdraw(400)).body.data.id;
  await admin(P.fail, { params: { id: a }, body: { reason: 'Account closed' } });
  const b = (await withdraw(400)).body.data.id;
  assert.deepEqual([await payable(), await reserved()], [60000, 40000]);
  await admin(P.pay, { params: { id: b }, body: { reference: 'HDFC20261021B1' } });
  assert.deepEqual([await payable(), await reserved()], [60000, 0]);
  assert.deepEqual((await ledger.verify({ tenantId: 't1' })).problems, []);
});

test('five simultaneous withdrawal requests leave one payout and one reservation', async () => {
  await seed(); await fundOnline();
  const out = await Promise.all(Array.from({ length: 5 }, () => withdraw(400)));
  assert.equal(out.filter((r) => r.code === 200).length, 1);
  assert.equal((await db.DriverPayout.find({ tenantId: 't1', driverId: 'D1' })).length, 1);
  assert.equal((await db.LedgerTxn.find({ tenantId: 't1', type: 'PAYOUT_RESERVED' })).length, 1, 'counted in the database, not a test copy');
  assert.equal(await reserved(), 40000);
});

test('a ledger that cannot be written never fails a payout action: the action succeeds, the payout is marked for repair, and the repair completes it once', async () => {
  await seed(); await fundOnline();
  const real = ledger.post;
  ledger.post = async () => { throw new Error('ledger unavailable'); };
  let id;
  try {
    const w = await withdraw(400);
    assert.equal(w.code, 200, 'the driver still gets their request');
    id = w.body.data.id;
    assert.equal((await admin(P.pay, { params: { id }, body: { reference: 'HDFC20261021C1' } })).code, 200, 'and the business can still pay it');
  } finally { ledger.post = real; }
  assert.equal((await stored(id)).status, 'PAID');
  assert.notEqual((await stored(id)).ledgerSyncedStatus, 'PAID', 'marked as not yet in the ledger');
  assert.equal(await reserved(), 0);
  assert.equal(await payable(), 100000, 'nothing was posted');
  const r = await payouts.repairUnsynced({ tenantId: 't1' });
  assert.equal(r.repaired, 1);
  assert.deepEqual([await payable(), await reserved()], [60000, 0], 'reserve and paid were both posted, in order');
  assert.equal((await stored(id)).ledgerSyncedStatus, 'PAID');
  assert.equal((await payouts.repairUnsynced({ tenantId: 't1' })).repaired, 0, 'running it again finds nothing');
});

test('the repair also brings in payouts made before the ledger followed them (no sync marker at all), for this business only', async () => {
  await seed(); await fundOnline(); await fundOnline('Y9', 50000, 0, 't2', 'Y1');
  await db.DriverPayout.create({ tenantId: 't1', payoutId: 'po_old', driverId: 'D1', amountMinor: 30000, currency: 'INR', status: 'PAID', open: false, reference: 'OLDREF1', paidAt: new Date(), requestedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
  await db.DriverPayout.create({ tenantId: 't2', payoutId: 'po_theirs', driverId: 'Y1', amountMinor: 10000, currency: 'INR', status: 'REQUESTED', open: true, requestedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
  const r = await payouts.repairUnsynced({ tenantId: 't1' });
  assert.equal(r.repaired, 1);
  assert.equal(await payable(), 70000);
  assert.equal((await stored('po_theirs')).ledgerSyncedStatus || null, null, 'the other business\'s payout is untouched');
  assert.equal(await payable('t2', 'Y1'), 50000, 'and so are its books');
  assert.equal((await db.LedgerTxn.find({ tenantId: 't1', eventKey: 'payout:po_old:paid' })).length, 1);
});

test('payouts are posted to their own business: the same driver id in another business is a different account', async () => {
  await seed(); await fundOnline(); await fundOnline('Y9', 50000, 0, 't2', 'D1');
  const id = (await withdraw(400)).body.data.id;
  assert.equal(await reserved('t1'), 40000);
  assert.equal(await reserved('t2'), 0);
  assert.equal(await payable('t2'), 50000);
  assert.ok(id);
});

test('commission recovery and a withdrawal share one payable: the recovery takes only what the reservation left, and nothing is counted twice', async () => {
  await seed(); await fundOnline();
  await db.TripDetails.create({ trip_id: 'C1', request_id: 'RC1', tenant_id: 't1', user_id: 'UC1', driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), fare: 300, currency: 'INR', payment_mode: 'CASH', requested_at: new Date(Date.now() - 7200000), completed_at: new Date(Date.now() - 3600000), distance_km: 5, pickup: { address: 'A' }, drop: { address: 'B' }, driver_earning: earn(30000, 15) });
  await db.Tenant.findOneAndUpdate({ tenantId: 't1' }, { $set: { payments: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', commissionRecovery: 'MANUAL_ONLY' } } });
  clearAppTenantCache();
  await cash.confirmCash({ tenantId: 't1', tripId: 'C1', driverId: 'D1' });
  assert.equal(await ledger.commissionOutstanding({ tenantId: 't1', driverId: 'D1' }), 4500);
  const id = (await withdraw(955)).body.data.id; // everything but the Rs 45 the business is owed
  assert.deepEqual([await payable(), await reserved()], [4500, 95500]);
  const r = await recovery.recoverCommission({ tenantId: 't1', driverId: 'D1', trigger: 'admin', createdBy: 'admin:A1' });
  assert.equal(r.recoveredMinor, 4500);
  assert.deepEqual([await payable(), await reserved(), await ledger.commissionOutstanding({ tenantId: 't1', driverId: 'D1' })], [0, 95500, 0]);
  await admin(P.pay, { params: { id }, body: { reference: 'HDFC20261021D1' } });
  assert.deepEqual([await payable(), await reserved()], [0, 0]);
  assert.deepEqual((await ledger.verify({ tenantId: 't1' })).problems, []);
});

// ---------------------------------------------------------------- the payout adapter

const request = async (amount = 400) => (await withdraw(amount)).body.data.id;
const setMode = (name) => adapters.getAdapter('MOCK').payoutScenario(name);

test('PAYOUT_SUCCESS: the provider sends it, the payout is paid with the provider\'s reference, and the ledger moves to settlement', async () => {
  await seed(); await fundOnline();
  const id = await request();
  setMode('PAYOUT_SUCCESS');
  const p = await payouts.disburse({ tenantId: 't1', payoutId: id });
  assert.deepEqual([p.status, p.open, p.handledBy], ['PAID', false, 'provider:MOCK']);
  assert.match(p.reference, /^mock_po_/);
  assert.deepEqual([await payable(), await reserved()], [60000, 0]);
  assert.equal((await db.LedgerTxn.find({ tenantId: 't1', type: 'PAYOUT_PAID' })).length, 1);
  assert.equal(adapters.getAdapter('MOCK').payouts.size, 1);
});

test('asking the provider twice for the same payout sends one transfer', async () => {
  await seed(); await fundOnline();
  const id = await request();
  setMode('PAYOUT_SUCCESS');
  const out = await Promise.allSettled([payouts.disburse({ tenantId: 't1', payoutId: id }), payouts.disburse({ tenantId: 't1', payoutId: id }), payouts.disburse({ tenantId: 't1', payoutId: id })]);
  assert.ok(out.filter((o) => o.status === 'fulfilled').length >= 1, 'at least one call did the work');
  assert.ok(out.filter((o) => o.status === 'rejected').every((o) => o.reason.code === 'NOT_OPEN'), 'a late call is told the payout is no longer open, nothing else');
  assert.equal(adapters.getAdapter('MOCK').payouts.size, 1, 'one transfer at the provider');
  assert.equal((await stored(id)).status, 'PAID');
  assert.equal((await db.LedgerTxn.find({ tenantId: 't1', type: 'PAYOUT_PAID' })).length, 1);
  await assert.rejects(payouts.disburse({ tenantId: 't1', payoutId: id }), (e) => e.code === 'NOT_OPEN');
});

test('PAYOUT_FAILURE: the payout fails with a reason and the amount goes back to the payable; asking again later succeeds', async () => {
  await seed(); await fundOnline();
  const id = await request();
  setMode('PAYOUT_FAILURE');
  const p = await payouts.disburse({ tenantId: 't1', payoutId: id });
  assert.deepEqual([p.status, p.open], ['FAILED', false]);
  assert.match(p.failureReason, /provider/i);
  assert.deepEqual([await payable(), await reserved()], [100000, 0]);
  const retry = await request();
  setMode('PAYOUT_SUCCESS');
  assert.equal((await payouts.disburse({ tenantId: 't1', payoutId: retry })).status, 'PAID');
  assert.deepEqual([await payable(), await reserved()], [60000, 0]);
});

test('PAYOUT_DELAYED: the payout is processing and the money stays reserved until the provider confirms; confirming from two places pays it once', async () => {
  await seed(); await fundOnline();
  const id = await request();
  setMode('PAYOUT_DELAYED');
  const p = await payouts.disburse({ tenantId: 't1', payoutId: id });
  assert.deepEqual([p.status, p.open], ['PROCESSING', true]);
  assert.ok(p.providerPayoutId);
  assert.deepEqual([await payable(), await reserved()], [60000, 40000]);
  assert.equal((await payouts.settleDisbursement({ tenantId: 't1', payoutId: id })).status, 'PROCESSING', 'the provider has not finished');
  adapters.getAdapter('MOCK').completePayout(p.providerPayoutId, 'processed');
  const both = await Promise.all([payouts.settleDisbursement({ tenantId: 't1', payoutId: id }), payouts.settleDisbursement({ tenantId: 't1', payoutId: id })]);
  assert.deepEqual(both.map((x) => x.status), ['PAID', 'PAID']);
  assert.equal((await db.LedgerTxn.find({ tenantId: 't1', type: 'PAYOUT_PAID' })).length, 1);
  assert.deepEqual([await payable(), await reserved()], [60000, 0]);
  // and a delayed one the provider then fails is returned to the payable
  const second = await request();
  setMode('PAYOUT_DELAYED');
  const d = await payouts.disburse({ tenantId: 't1', payoutId: second });
  adapters.getAdapter('MOCK').completePayout(d.providerPayoutId, 'failed');
  assert.equal((await payouts.settleDisbursement({ tenantId: 't1', payoutId: second })).status, 'FAILED');
  assert.deepEqual([await payable(), await reserved()], [60000, 0]);
});

test('a manual payment and the provider cannot both settle the same payout', async () => {
  await seed(); await fundOnline();
  const id = await request();
  await admin(P.pay, { params: { id }, body: { reference: 'HDFC20261021E1' } });
  setMode('PAYOUT_SUCCESS');
  await assert.rejects(payouts.disburse({ tenantId: 't1', payoutId: id }), (e) => e.code === 'NOT_OPEN');
  assert.equal(adapters.getAdapter('MOCK').payouts.size, 0, 'no transfer was sent for an already paid payout');
});

test('only a business whose provider can send payouts may use the adapter; the real providers are not built and refuse', async () => {
  await seed(); await fundOnline();
  const id = await request();
  await assert.rejects(payouts.disburse({ tenantId: 't2', payoutId: id }), (e) => e.code === 'NOT_FOUND', 'another business cannot send this payout');
  await db.Tenant.findOneAndUpdate({ tenantId: 't1' }, { $set: { payments: { enabledMethods: ['CASH', 'UPI'], provider: 'RAZORPAY' } } });
  clearAppTenantCache();
  await assert.rejects(payouts.disburse({ tenantId: 't1', payoutId: id }), (e) => e.code === 'PAYOUTS_NOT_SUPPORTED');
  const rz = adapters.getAdapter('RAZORPAY', { RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' });
  await assert.rejects(rz.requestPayout({}), (e) => e.code === 'NOT_IMPLEMENTED');
  await assert.rejects(adapters.getAdapter('CASHFREE', {}).fetchPayout('x'), (e) => e.code === 'PROVIDER_NOT_CONFIGURED');
  assert.equal((await stored(id)).status, 'REQUESTED', 'nothing happened to the payout');
});

test('the scheduled upkeep settles delayed provider payouts and repairs unsynced payouts, for every business, once', async () => {
  await seed(); await fundOnline();
  const id = await request();
  setMode('PAYOUT_DELAYED');
  const p = await payouts.disburse({ tenantId: 't1', payoutId: id });
  adapters.getAdapter('MOCK').completePayout(p.providerPayoutId, 'processed');
  await db.DriverPayout.create({ tenantId: 't1', payoutId: 'po_old2', driverId: 'D1', amountMinor: 10000, currency: 'INR', status: 'PAID', open: false, reference: 'OLDREF2', paidAt: new Date(), requestedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
  const report = await jobs.runAll();
  const row = report.find((r) => r.tenantId === 't1');
  assert.deepEqual([row.payoutsSettled, row.payoutsRepaired, row.errors], [1, 1, []]);
  assert.equal((await stored(id)).status, 'PAID');
  const again = await jobs.runAll();
  assert.deepEqual([again.find((r) => r.tenantId === 't1').payoutsSettled, again.find((r) => r.tenantId === 't1').payoutsRepaired], [0, 0]);
});
