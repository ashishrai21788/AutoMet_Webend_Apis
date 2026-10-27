// The payments HTTP layer: who may call what, that the business always comes from the signed-in account, that no client can set an
// amount, and that the dashboard endpoints are scoped to one business and leave an audit trail. Checks the stored state, not just replies.
process.env.JWT_SECRET = 'test-secret-for-payments-api';
process.env.PAYMENTS_MOCK_ENABLED = '1';
process.env.PAYMENTS_MOCK_SECRET = 'test-mock-secret-0123456789';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const pay = require('../controllers/paymentsController');
const svc = require('../lib/payments/service');
const adapters = require('../lib/payments/adapters');
const ledger = require('../lib/ledger');
const { ACCOUNTS: A } = ledger;

const MODELS = ['Tenant', 'TripDetails', 'Payment', 'PaymentEvent', 'PaymentRefund', 'PaymentDiscrepancy', 'LedgerTxn', 'AdminAudit', 'User', 'Driver'];
const flush = async () => { for (const m of MODELS) await db[m].find({}); };
const earn = (fare) => ({ fareMinor: fare, feeMinor: Math.round(fare * 0.15), netMinor: fare - Math.round(fare * 0.15), percent: 15, currency: 'INR' });
const settings = { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK' };
const reset = async () => {
  for (const m of MODELS) db[m].rows.length = 0;
  await flush();
  adapters.resetMock();
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', slug: 'uride', appName: 'uRide', packageName: 'in.uride', isDefault: true, payments: settings });
  await db.Tenant.create({ tenantId: 't2', name: 'Other', slug: 'other', appName: 'Other', packageName: 'in.other', payments: settings });
  let n = 0;
  const phone = () => `+9198000${String(n += 1).padStart(5, '0')}`;
  for (const [userId, tenantId] of [['U1', 't1'], ['U2', 't1'], ['X1', 't2']]) await db.User.create({ userId, tenantId, phone: phone() });
  for (const [driverId, tenantId] of [['D1', 't1'], ['D2', 't1'], ['Y1', 't2']]) await db.Driver.create({ driverId, tenantId, phone: phone(), email: `${driverId}@t.test` });
  await db.TripDetails.create({ trip_id: 'T1', request_id: 'R1', tenant_id: 't1', user_id: 'U1', driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), driver_earning: earn(20000) });
  await db.TripDetails.create({ trip_id: 'T9', request_id: 'R9', tenant_id: 't2', user_id: 'X1', driver_id: 'Y1', status: 'COMPLETED', timeout_at: new Date(), driver_earning: earn(50000) });
};

const call = async (handler, { role, id, tenant = 't1', body = {}, params = {}, query = {}, headers = {}, admin = null, rawBody = null } = {}) => {
  const account = role === 'user' ? { userId: id, tenantId: tenant } : role === 'driver' ? { driverId: id, tenantId: tenant } : null;
  const req = {
    authRole: role, authActorId: id, user: role === 'user' ? account : null, driver: role === 'driver' ? account : null, body, params, query, headers, ip: '1.1.1.1',
    get: (h) => headers[h] || headers[String(h).toLowerCase()], rawBody,
    business: admin ? { tenantId: tenant } : undefined, admin
  };
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await handler(req, res);
  return out;
};
const rider = (o = {}) => ({ role: 'user', id: 'U1', ...o });
const drv = (o = {}) => ({ role: 'driver', id: 'D1', ...o });
const staff = (o = {}) => ({ role: null, id: null, admin: { adminId: 'A1', email: 'fin@t1.test', role: 'finance' }, ...o });
const paymentRow = (id) => svc.find({ tenantId: 't1', paymentId: id });
const audits = (action) => db.AdminAudit.find({ action });

test('which payment methods a business offers: cash only until online payment is configured', async () => {
  await reset();
  let r = await call(pay.methods, rider());
  assert.deepEqual([r.code, r.body.data.methods, r.body.data.mock], [200, ['CASH', 'UPI'], true]);
  await db.Tenant.findOneAndUpdate({ tenantId: 't1' }, { $set: { payments: {} } });
  r = await call(pay.methods, rider());
  assert.deepEqual(r.body.data.methods, ['CASH']);
  await db.Tenant.findOneAndUpdate({ tenantId: 't1' }, { $set: { payments: { enabledMethods: ['UPI'] } } });
  assert.deepEqual((await call(pay.methods, rider())).body.data.methods, [], 'UPI enabled but no provider: nothing online is offered');
});

test('the rider opens the payment; the amount is always the server\'s fare (a client-sent amount is ignored), and replays return the same payment', async () => {
  await reset();
  const r = await call(pay.create, rider({ body: { trip_id: 'T1', amount_minor: 1, amount: 1, fare: 1, tenant_id: 't2', idempotency_key: 'k1' } }));
  assert.equal(r.code, 201, JSON.stringify(r.body));
  const p = r.body.data.payment;
  assert.deepEqual([p.amount_minor, p.status, p.method, p.awaiting_verification], [20000, 'PENDING', 'UPI', true]);
  assert.equal(p.commission_minor, undefined, 'the rider is not shown the commission split');
  assert.equal(r.body.data.checkout.type, 'MOCK');
  assert.equal((await paymentRow(p.payment_id)).tenantId, 't1', 'the business came from the account, not from the body');
  const again = await call(pay.create, rider({ body: { trip_id: 'T1', idempotency_key: 'k1' } }));
  assert.deepEqual([again.code, again.body.data.created, again.body.data.payment.payment_id], [200, false, p.payment_id]);
  assert.equal((await db.Payment.find({})).length, 1);
});

test('a rider cannot pay for someone else\'s ride, another business\'s ride, or a ride that is not completed; a driver cannot open a rider payment', async () => {
  await reset();
  const other = await call(pay.create, rider({ id: 'U2', body: { trip_id: 'T1' } }));
  assert.deepEqual([other.code, other.body.error], [404, 'NOT_FOUND']);
  const cross = await call(pay.create, rider({ body: { trip_id: 'T9' } }));
  assert.deepEqual([cross.code, cross.body.error], [404, 'NOT_FOUND']);
  const missing = await call(pay.create, rider({ body: {} }));
  assert.equal(missing.code, 400);
  await db.TripDetails.findOneAndUpdate({ trip_id: 'T1' }, { $set: { status: 'ON_GOING' } });
  assert.equal((await call(pay.create, rider({ body: { trip_id: 'T1' } }))).body.error, 'TRIP_NOT_COMPLETED');
  assert.equal((await db.Payment.find({})).length, 0);
});

test('either party of the ride can read its payment; nobody else can; only the driver sees the commission', async () => {
  await reset();
  await call(pay.create, rider({ body: { trip_id: 'T1', idempotency_key: 'k' } }));
  const asRider = await call(pay.forTrip, rider({ params: { tripId: 'T1' } }));
  const asDriver = await call(pay.forTrip, drv({ params: { tripId: 'T1' } }));
  assert.deepEqual([asRider.code, asRider.body.data.payment.status, asRider.body.data.trip_payment_status], [200, 'PENDING', 'UNPAID']);
  assert.equal(asRider.body.data.payment.commission_minor, undefined);
  assert.equal(asDriver.body.data.payment.commission_minor, 3000);
  for (const who of [rider({ id: 'U2' }), drv({ id: 'D2' }), rider({ id: 'X1', tenant: 't2' }), drv({ id: 'Y1', tenant: 't2' })]) {
    assert.equal((await call(pay.forTrip, { ...who, params: { tripId: 'T1' } })).code, 404, `${who.role} ${who.id}`);
  }
});

test('cash: the driver confirms, the replay is harmless, a wrong amount becomes a dispute, and a wrong driver or business is refused', async () => {
  await reset();
  assert.equal((await call(pay.confirmCash, drv({ body: { trip_id: 'T1', collected_minor: 'lots' } }))).code, 400);
  assert.equal((await call(pay.confirmCash, drv({ id: 'D2', body: { trip_id: 'T1' } }))).code, 404);
  assert.equal((await call(pay.confirmCash, drv({ id: 'Y1', tenant: 't2', body: { trip_id: 'T1' } }))).code, 404);
  const first = await call(pay.confirmCash, drv({ body: { trip_id: 'T1', idempotency_key: 'c1' } }));
  assert.deepEqual([first.code, first.body.data.duplicate, first.body.data.payment.cash_state, first.body.data.payment.commission_minor], [201, false, 'CONFIRMED', 3000]);
  const again = await call(pay.confirmCash, drv({ body: { trip_id: 'T1', idempotency_key: 'c2' } }));
  assert.deepEqual([again.code, again.body.data.duplicate], [200, true]);
  assert.equal(await ledger.commissionOutstanding({ tenantId: 't1', driverId: 'D1' }), 3000);
  const summary = await call(pay.commissionSummary, drv());
  assert.deepEqual([summary.body.data.accrued_minor, summary.body.data.collected_minor, summary.body.data.outstanding_minor], [3000, 0, 3000]);
  const disputed = await call(pay.disputeCash, rider({ body: { trip_id: 'T1', reason: 'I paid less than that' } }));
  assert.equal(disputed.body.data.payment.cash_state, 'DISPUTED');
  assert.equal((await call(pay.disputeCash, rider({ id: 'U2', body: { trip_id: 'T1', reason: 'not my ride' } }))).code, 404);
});

test('the provider\'s webhook: forged or unknown is refused, a real one settles the payment, a repeat is recognised, and the body is the exact bytes', async () => {
  await reset();
  const created = await call(pay.create, rider({ body: { trip_id: 'T1', idempotency_key: 'k' } }));
  const payment = await paymentRow(created.body.data.payment.payment_id);
  const plan = adapters.getAdapter('MOCK').scenario('SUCCESS', payment.providerOrderId);
  const good = plan.deliverNow[0];
  const send = (provider, rawBody, headers) => call(pay.webhook, { params: { provider }, rawBody, headers });
  assert.equal((await send('mock', good.rawBody, { 'x-mock-signature': 'forged' })).code, 400);
  assert.equal((await send('mock', Buffer.from(good.rawBody.toString().replace('20000', '10')), good.headers)).code, 400, 'a changed body no longer matches its signature');
  assert.equal((await send('nope', good.rawBody, good.headers)).code, 404);
  assert.equal((await paymentRow(payment.paymentId)).status, 'PENDING');
  const real = await send('mock', good.rawBody, good.headers);
  assert.deepEqual([real.code, real.body.outcome], [200, 'APPLIED']);
  assert.equal((await paymentRow(payment.paymentId)).status, 'SUCCEEDED');
  const repeat = await send('mock', good.rawBody, good.headers);
  assert.deepEqual([repeat.code, repeat.body.outcome], [200, 'DUPLICATE']);
  assert.equal((await ledger.verify({ tenantId: 't1' })).transactions, 1);
});

test('the mock simulator exists only where the mock gateway is allowed, and only for the caller\'s own payment', async () => {
  await reset();
  const created = await call(pay.create, rider({ body: { trip_id: 'T1', idempotency_key: 'k' } }));
  const id = created.body.data.payment.payment_id;
  assert.equal((await call(pay.mockSimulate, rider({ body: { payment_id: id, scenario: 'NOPE' } }))).code, 400);
  assert.equal((await call(pay.mockSimulate, rider({ id: 'U2', body: { payment_id: id, scenario: 'SUCCESS' } }))).code, 404);
  assert.equal((await call(pay.mockSimulate, drv({ body: { payment_id: id, scenario: 'SUCCESS' } }))).code, 404, 'the driver is not the payer');
  const ok = await call(pay.mockSimulate, rider({ body: { payment_id: id, scenario: 'SUCCESS' } }));
  assert.deepEqual([ok.code, ok.body.data.outcomes, ok.body.data.payment.status], [200, ['APPLIED'], 'SUCCEEDED']);
  process.env.NODE_ENV = 'production';
  try {
    const off = await call(pay.mockSimulate, rider({ body: { payment_id: id, scenario: 'SUCCESS' } }));
    assert.deepEqual([off.code, off.body.error], [404, 'NOT_FOUND'], 'in production the route behaves as if it did not exist');
    assert.equal((await call(pay.methods, rider())).body.data.mock, false);
  } finally { process.env.NODE_ENV = 'test'; }
});

test('an unexpected error is a generic 500 that leaks nothing', async () => {
  await reset();
  const real = ledger.post;
  ledger.post = async () => { throw new TypeError('secret internal detail: connection string xyz'); };
  try {
    const created = await call(pay.create, rider({ body: { trip_id: 'T1', idempotency_key: 'k' } }));
    const r = await call(pay.mockSimulate, rider({ body: { payment_id: created.body.data.payment.payment_id, scenario: 'SUCCESS' } }));
    assert.equal(r.code, 500);
    assert.ok(!JSON.stringify(r.body).includes('secret internal detail'));
  } finally { ledger.post = real; }
});

test('dashboard: payments are listed and read for this business only, and a payment of another business is simply not found', async () => {
  await reset();
  const mine = (await call(pay.create, rider({ body: { trip_id: 'T1', idempotency_key: 'a' } }))).body.data.payment.payment_id;
  const theirs = (await svc.createPayment({ tenantId: 't2', tripId: 'T9', riderId: 'X1', method: 'UPI', idempotencyKey: 'b' })).payment.paymentId;
  await svc.simulate({ tenantId: 't2', paymentId: theirs, scenario: 'SUCCESS' });
  const list = await call(pay.adminList, staff());
  assert.deepEqual(list.body.data.items.map((p) => p.payment_id), [mine]);
  assert.equal((await call(pay.adminList, staff({ query: { status: 'SUCCEEDED' } }))).body.data.total, 0);
  assert.equal((await call(pay.adminGet, staff({ params: { id: theirs } }))).code, 404);
  const detail = await call(pay.adminGet, staff({ params: { id: mine } }));
  assert.equal(detail.body.data.payment.provider, 'MOCK');
  const t2 = await call(pay.adminGet, staff({ tenant: 't2', params: { id: theirs } }));
  assert.equal(t2.code, 200);
  assert.ok(t2.body.data.ledger.every((t) => t.entries.every((e) => e.account)), 'ledger detail is returned for the owning business');
  assert.equal(detail.body.data.ledger.length, 0, 'and not for the other one');
});

test('dashboard: a refund needs a key, a reason and a whole amount, is scoped to the business, is audited, and a repeat is not audited twice', async () => {
  await reset();
  const id = (await call(pay.create, rider({ body: { trip_id: 'T1', idempotency_key: 'a' } }))).body.data.payment.payment_id;
  await call(pay.mockSimulate, rider({ body: { payment_id: id, scenario: 'SUCCESS' } }));
  const refund = (over = {}) => call(pay.adminRefund, staff({ params: { id }, body: { amount_minor: 5000, reason: 'Rider complained', idempotency_key: 'rf1' }, ...over }));
  assert.equal((await call(pay.adminRefund, staff({ params: { id }, body: { amount_minor: 5000, reason: 'x y z' } }))).body.error, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await call(pay.adminRefund, staff({ params: { id }, body: { amount_minor: 5.5, reason: 'x y z', idempotency_key: 'q' } }))).code, 400);
  assert.equal((await refund({ tenant: 't2' })).code, 404, 'another business\'s staff cannot refund it');
  const first = await refund();
  assert.deepEqual([first.code, first.body.data.refund.status, first.body.data.refund.amountMinor], [201, 'PROCESSED', 5000]);
  const repeat = await refund();
  assert.deepEqual([repeat.code, repeat.body.data.duplicate], [200, true]);
  const a = await audits('payment.refund');
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].tenantId, a[0].actorId, a[0].targetId, a[0].meta.amountMinor], ['t1', 'A1', id, 5000]);
  assert.equal((await paymentRow(id)).refundStatus, 'PARTIALLY_REFUNDED');
  assert.equal((await ledger.balances({ tenantId: 't1' }))[A.GATEWAY_CLEARING], 15000);
});

test('dashboard: resolving a cash dispute and recovering commission are audited; the commission report is this business\'s drivers only', async () => {
  await reset();
  await call(pay.confirmCash, drv({ body: { trip_id: 'T1', collected_minor: 15000, idempotency_key: 'c' } }));
  const payment = (await db.Payment.find({ method: 'CASH' }))[0];
  const bad = await call(pay.adminResolveCash, staff({ params: { id: payment.paymentId }, body: { action: 'ADJUST', adjusted_fare_minor: 15000, reason: '' } }));
  assert.equal(bad.body.error, 'REASON_REQUIRED');
  const ok = await call(pay.adminResolveCash, staff({ params: { id: payment.paymentId }, body: { action: 'ADJUST', adjusted_fare_minor: 15000, reason: 'Fare reduced after a complaint' } }));
  assert.equal(ok.code, 200);
  assert.equal(ok.body.data.payment.cash.adjustedCommission.commissionMinor, 2250);
  assert.equal((await audits('payment.cash.resolved')).length, 1);
  assert.equal((await call(pay.adminResolveCash, staff({ tenant: 't2', params: { id: payment.paymentId }, body: { action: 'CONFIRM', reason: 'nope nope' } }))).code, 404);
  const report = await call(pay.adminCommission, staff());
  assert.deepEqual(report.body.data.drivers.map((d) => [d.driver_id, d.outstanding_minor]), [['D1', 2250]]);
  assert.equal((await call(pay.adminCommission, staff({ tenant: 't2' }))).body.data.drivers.length, 0);
  const rec = await call(pay.adminRecover, staff({ params: { driverId: 'D1' } }));
  assert.equal(rec.body.data.recovered_minor, 0, 'nothing is owed to the driver to recover from');
  assert.equal((await audits('commission.recovered')).length, 1);
});

test('dashboard: reconciliation runs, lists and resolves for this business with an audit entry each time', async () => {
  await reset();
  const id = (await call(pay.create, rider({ body: { trip_id: 'T1', idempotency_key: 'a' } }))).body.data.payment.payment_id;
  const p = await paymentRow(id);
  adapters.getAdapter('MOCK').orders.get(p.providerOrderId).status = 'paid';
  const run = await call(pay.adminReconcileRun, staff());
  assert.deepEqual(run.body.data.discrepancies.map((d) => d.type), ['PROVIDER_PAID_NOT_RECORDED']);
  const other = await call(pay.adminReconcileRun, staff({ tenant: 't2' }));
  assert.deepEqual(other.body.data.discrepancies, []);
  const open = await call(pay.adminReconcileList, staff({ query: { status: 'open' } }));
  assert.equal(open.body.data.items.length, 1);
  assert.equal((await call(pay.adminReconcileList, staff({ tenant: 't2', query: { status: 'open' } }))).body.data.items.length, 0);
  const fid = open.body.data.items[0].discrepancyId;
  assert.equal((await call(pay.adminReconcileResolve, staff({ tenant: 't2', params: { id: fid }, body: { note: 'trying it' } }))).code, 404);
  assert.equal((await call(pay.adminReconcileResolve, staff({ params: { id: fid }, body: { note: '' } }))).body.error, 'NOTE_REQUIRED');
  assert.equal((await call(pay.adminReconcileResolve, staff({ params: { id: fid }, body: { note: 'Checked the provider dashboard' } }))).code, 200);
  assert.deepEqual([(await audits('reconciliation.run')).length, (await audits('reconciliation.resolved')).length], [2, 1]);
});
