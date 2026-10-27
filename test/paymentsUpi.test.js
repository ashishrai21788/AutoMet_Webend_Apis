// Online (UPI) payments through the mock gateway: the server decides, from verified provider messages only; every result is checked in the
// payment record, the ledger and the trip. Runs on both database engines (TEST_DB=postgres).
process.env.JWT_SECRET = 'test-secret-for-payments';
process.env.PAYMENTS_MOCK_ENABLED = '1';
process.env.PAYMENTS_MOCK_SECRET = 'test-mock-secret-0123456789';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const svc = require('../lib/payments/service');
const adapters = require('../lib/payments/adapters');
const ledger = require('../lib/ledger');
const config = require('../lib/payments/config');
const { ACCOUNTS: A } = ledger;

const settings = { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK' };
const flush = async () => { for (const m of ['Tenant', 'TripDetails', 'Payment', 'PaymentEvent', 'LedgerTxn']) await db[m].find({}); };
const reset = async (tripOver = {}) => {
  for (const m of ['Tenant', 'TripDetails', 'Payment', 'PaymentEvent', 'LedgerTxn']) db[m].rows.length = 0;
  await flush();
  adapters.resetMock();
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', slug: 'uride', appName: 'uRide', packageName: 'in.uride', isDefault: true, payments: settings });
  await db.Tenant.create({ tenantId: 't2', name: 'Other', slug: 'other', appName: 'Other', packageName: 'in.other', payments: settings });
  await db.TripDetails.create({
    trip_id: 'T1', request_id: 'R1', tenant_id: 't1', user_id: 'U1', driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), payment_mode: 'CASH',
    driver_earning: { fareMinor: 20000, feeMinor: 3000, netMinor: 17000, percent: 15, currency: 'INR' }, ...tripOver
  });
};

const open = (over = {}) => svc.createPayment({ tenantId: 't1', tripId: 'T1', riderId: 'U1', method: 'UPI', idempotencyKey: 'k1', ...over });
const run = async (paymentId, scenario, tenantId = 't1', overrides = {}) => svc.simulate({ tenantId, paymentId, scenario, overrides });
const trip = () => db.TripDetails.rows.find((t) => t.trip_id === 'T1');
const pay = (id) => db.Payment.rows.find((p) => p.paymentId === id);
const books = () => ledger.balances({ tenantId: 't1' });
const txns = () => db.LedgerTxn.rows.filter((t) => t.tenantId === 't1');

test('a payment is opened from the server\'s own finalised fare, and only for the rider\'s own completed ride in an enabled business', async () => {
  await reset();
  const { payment, created, checkout } = await open();
  assert.equal(created, true);
  assert.deepEqual([payment.amountMinor, payment.currency, payment.status, payment.method, payment.provider, payment.driverId], [20000, 'INR', 'PENDING', 'UPI', 'MOCK', 'D1']);
  assert.deepEqual([payment.commission.commissionMinor, payment.commission.netMinor], [3000, 17000]);
  assert.ok(payment.providerOrderId && checkout.orderId === payment.providerOrderId);
  const refuse = async (over, code) => assert.rejects(open({ idempotencyKey: `x${Math.random()}`, ...over }), (e) => e.code === code, code);
  await refuse({ riderId: 'U2' }, 'NOT_FOUND');
  await refuse({ tenantId: 't2' }, 'NOT_FOUND');
  await refuse({ method: 'CASH' }, 'UNSUPPORTED_METHOD');
  await reset({ status: 'ON_GOING' });
  await refuse({}, 'TRIP_NOT_COMPLETED');
  await reset({ driver_earning: null });
  await refuse({}, 'TRIP_NOT_FINALISED');
  await reset({ driver_earning: { fareMinor: 20000, feeMinor: 3000, netMinor: 16999, currency: 'INR' } });
  await refuse({}, 'FARE_SPLIT_INCONSISTENT');
  await reset({ driver_earning: { fareMinor: 0, feeMinor: 0, netMinor: 0, currency: 'INR' } });
  await refuse({}, 'NOTHING_TO_PAY');
  await reset();
  await db.Tenant.findOneAndUpdate({ tenantId: 't1' }, { $set: { payments: { enabledMethods: ['CASH'] } } });
  await refuse({}, 'METHOD_NOT_ENABLED');
});

test('opening the payment again (same key, a different key, or two taps) gives back the same open payment', async () => {
  await reset();
  const a = await open();
  const same = await open();
  const other = await open({ idempotencyKey: 'k2' });
  assert.equal(same.payment.paymentId, a.payment.paymentId);
  assert.equal(other.payment.paymentId, a.payment.paymentId, 'one open payment per ride');
  assert.equal(same.created, false);
  assert.equal(db.Payment.rows.length, 1);
  await reset();
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => open({ idempotencyKey: `burst-${i % 3}` })));
  assert.equal(new Set(burst.map((r) => r.payment.paymentId)).size, 1);
  assert.equal(db.Payment.rows.filter((p) => p.live).length, 1);
});

test('SUCCESS: the payment succeeds, the ledger gets the fare, the driver\'s share and the commission, and the ride is paid', async () => {
  await reset();
  const { payment } = await open();
  const r = await run(payment.paymentId, 'SUCCESS');
  assert.equal(r.replies[0].outcome, 'APPLIED');
  const p = pay(payment.paymentId);
  assert.deepEqual([p.status, p.live, p.succeededAt instanceof Date, !!p.ledgerTxnId], ['SUCCEEDED', true, true, true]);
  assert.deepEqual([trip().payment_status, trip().payment_mode, trip().payment_id], ['PAID', 'UPI', payment.paymentId]);
  const t = txns();
  assert.equal(t.length, 1);
  assert.equal(t[0].type, 'ONLINE_FARE_CAPTURED');
  const b = await books();
  assert.deepEqual([b[A.GATEWAY_CLEARING], b[A.DRIVER_PAYABLE], b[A.COMMISSION_REVENUE]], [20000, -17000, -3000]);
  assert.equal(await ledger.owedToDriver({ tenantId: 't1', driverId: 'D1' }), 17000);
  assert.deepEqual((await ledger.verify({ tenantId: 't1' })).problems, []);
  await assert.rejects(open({ idempotencyKey: 'again' }), (e) => e.code === 'ALREADY_PAID');
});

test('a webhook delivered twice changes nothing the second time (one event, one ledger transaction)', async () => {
  await reset();
  const { payment } = await open();
  const r = await run(payment.paymentId, 'DUPLICATE_WEBHOOK');
  assert.deepEqual(r.replies.map((x) => x.outcome), ['APPLIED', 'DUPLICATE']);
  assert.equal(txns().length, 1);
  assert.equal(db.PaymentEvent.rows.length, 1);
  assert.equal(pay(payment.paymentId).history.filter((h) => h.status === 'SUCCEEDED').length, 1);
});

test('a message with a bad or missing signature is refused and nothing changes', async () => {
  await reset();
  const { payment } = await open();
  const gw = adapters.getAdapter('MOCK');
  const plan = gw.scenario('SUCCESS', payment.providerOrderId);
  const good = plan.deliverNow[0];
  const tampered = Buffer.from(good.rawBody.toString().replace('20000', '1'));
  for (const [rawBody, headers] of [[tampered, good.headers], [good.rawBody, { 'x-mock-signature': 'deadbeef' }], [good.rawBody, {}], [Buffer.from('not json'), good.headers]]) {
    const r = await svc.handleWebhook({ provider: 'MOCK', rawBody, headers });
    assert.deepEqual([r.httpStatus, r.outcome], [400, 'INVALID_SIGNATURE']);
  }
  assert.equal(pay(payment.paymentId).status, 'PENDING');
  assert.equal(txns().length, 0);
  assert.equal(db.PaymentEvent.rows.length, 0, 'unverified messages are not recorded as events');
  assert.deepEqual([(await svc.handleWebhook({ provider: 'NOPE', rawBody: good.rawBody, headers: good.headers })).httpStatus], [404]);
});

test('a signed message with the wrong amount or currency is rejected and flagged, and the payment does not succeed', async () => {
  await reset();
  const { payment } = await open();
  const wrongAmount = await run(payment.paymentId, 'SUCCESS', 't1', { amountMinor: 100 });
  assert.deepEqual([wrongAmount.replies[0].outcome, pay(payment.paymentId).status], ['REJECTED_MISMATCH', 'PENDING']);
  const wrongCurrency = await run(payment.paymentId, 'SUCCESS', 't1', { currency: 'USD' });
  assert.deepEqual([wrongCurrency.replies[0].outcome, pay(payment.paymentId).status], ['REJECTED_MISMATCH', 'PENDING']);
  assert.equal(pay(payment.paymentId).flags.length, 2);
  assert.equal(txns().length, 0);
  assert.equal(trip().payment_status === 'PAID', false);
});

test('a success message the provider does not confirm is not believed (the provider\'s own record decides)', async () => {
  await reset();
  const { payment } = await open();
  const gw = adapters.getAdapter('MOCK');
  const plan = gw.scenario('SUCCESS', payment.providerOrderId);
  gw.orders.get(payment.providerOrderId).status = 'created'; // the provider never actually took the money
  const r = await svc.handleWebhook({ provider: 'MOCK', ...plan.deliverNow[0] });
  assert.deepEqual([r.outcome, pay(payment.paymentId).status], ['REJECTED_UNVERIFIED', 'PENDING']);
  assert.equal(txns().length, 0);
  // the provider took a different amount than the message claims
  gw.orders.get(payment.providerOrderId).amountMinor = 5;
  const plan2 = gw.scenario('SUCCESS', payment.providerOrderId, { amountMinor: 20000 });
  const r2 = await svc.handleWebhook({ provider: 'MOCK', ...plan2.deliverNow[0] });
  assert.deepEqual([r2.outcome, pay(payment.paymentId).flags.slice(-1)[0].reason], ['REJECTED_UNVERIFIED', 'success message not confirmed by the provider: AMOUNT_MISMATCH']);
  assert.equal(pay(payment.paymentId).status, 'PENDING');
});

test('a message for a payment that belongs to another ride or business cannot touch this one', async () => {
  await reset();
  await db.TripDetails.create({ trip_id: 'T2', request_id: 'R2', tenant_id: 't2', user_id: 'U9', driver_id: 'D9', status: 'COMPLETED', timeout_at: new Date(), driver_earning: { fareMinor: 5000, feeMinor: 500, netMinor: 4500, currency: 'INR' } });
  const mine = (await open()).payment;
  const theirs = (await svc.createPayment({ tenantId: 't2', tripId: 'T2', riderId: 'U9', method: 'UPI', idempotencyKey: 'o1' })).payment;
  await run(theirs.paymentId, 'SUCCESS', 't2');
  assert.equal(pay(mine.paymentId).status, 'PENDING');
  assert.equal(trip().payment_status === 'PAID', false);
  assert.equal((await books())[A.GATEWAY_CLEARING] || 0, 0, 'the other business\'s money is not in this business\'s books');
  assert.equal((await ledger.balances({ tenantId: 't2' }))[A.GATEWAY_CLEARING], 5000);
  await assert.rejects(run(theirs.paymentId, 'SUCCESS', 't1'), (e) => e.code === 'NOT_FOUND', 'another business cannot even simulate it');
  await assert.rejects(svc.refresh({ tenantId: 't1', paymentId: theirs.paymentId }), (e) => e.code === 'NOT_FOUND');
});

test('FAILURE: the payment fails, nothing is booked, and the rider can try again and pay once', async () => {
  await reset();
  const first = (await open()).payment;
  await run(first.paymentId, 'FAILURE');
  assert.deepEqual([pay(first.paymentId).status, pay(first.paymentId).live], ['FAILED', false]);
  assert.equal(txns().length, 0);
  assert.equal(trip().payment_status === 'PAID', false);
  const retry = (await open({ idempotencyKey: 'retry' })).payment;
  assert.notEqual(retry.paymentId, first.paymentId);
  await run(retry.paymentId, 'SUCCESS');
  assert.equal(pay(retry.paymentId).status, 'SUCCEEDED');
  assert.equal(txns().length, 1);
  assert.equal((await books())[A.COMMISSION_REVENUE], -3000);
});

test('PENDING stays pending; DELAYED_SUCCESS is picked up by asking the provider when no message ever arrives', async () => {
  await reset();
  const { payment } = await open();
  const r = await run(payment.paymentId, 'PENDING');
  assert.equal(r.replies.length, 0);
  assert.equal((await svc.refresh({ tenantId: 't1', paymentId: payment.paymentId })).status, 'PENDING');
  const d = await run(payment.paymentId, 'DELAYED_SUCCESS');
  assert.equal(d.replies.length, 0);
  assert.equal(pay(payment.paymentId).status, 'PENDING', 'nothing yet');
  d.later[0].apply(); // the provider takes the money; the webhook is lost
  const after = await svc.refresh({ tenantId: 't1', paymentId: payment.paymentId });
  assert.equal(after.status, 'SUCCEEDED');
  assert.equal(txns().length, 1);
  const late = await svc.handleWebhook({ provider: 'MOCK', ...d.later[0].delivery }); // and the delayed webhook turns up afterwards
  assert.equal(late.outcome, 'IGNORED_ALREADY_SUCCEEDED');
  assert.equal(txns().length, 1);
});

test('CANCELLED and EXPIRED close the payment without booking anything', async () => {
  await reset();
  const a = (await open()).payment;
  await run(a.paymentId, 'CANCELLED');
  assert.deepEqual([pay(a.paymentId).status, pay(a.paymentId).live], ['CANCELLED', false]);
  const b = (await open({ idempotencyKey: 'again' })).payment;
  await run(b.paymentId, 'EXPIRED');
  assert.equal(pay(b.paymentId).status, 'EXPIRED');
  assert.equal(txns().length, 0);
});

test('OUT OF ORDER: an older "failed" arriving after the newer "captured" cannot undo the payment', async () => {
  await reset();
  const { payment } = await open();
  const r = await run(payment.paymentId, 'OUT_OF_ORDER_WEBHOOK');
  assert.deepEqual(r.replies.map((x) => x.outcome), ['APPLIED', 'IGNORED_STALE']);
  assert.equal(pay(payment.paymentId).status, 'SUCCEEDED');
  assert.equal(txns().length, 1);
});

test('a success that arrives after the payment expired is real money: it is accepted, posted once and flagged for review', async () => {
  await reset();
  const { payment } = await open();
  await run(payment.paymentId, 'EXPIRED');
  assert.equal(pay(payment.paymentId).status, 'EXPIRED');
  const r = await run(payment.paymentId, 'SUCCESS');
  assert.equal(r.replies[0].outcome, 'APPLIED');
  assert.equal(pay(payment.paymentId).status, 'SUCCEEDED');
  assert.ok(pay(payment.paymentId).flags.some((f) => /after the payment was EXPIRED/.test(f.reason)));
  assert.equal(txns().length, 1);
  assert.equal(trip().payment_status, 'PAID');
});

test('paying twice (a late success on an earlier attempt after a retry also paid) books the second as owed back, never as earnings again', async () => {
  await reset();
  const first = (await open()).payment;
  await run(first.paymentId, 'EXPIRED');
  const second = (await open({ idempotencyKey: 'retry' })).payment;
  await run(second.paymentId, 'SUCCESS');
  await run(first.paymentId, 'SUCCESS'); // the first attempt's money arrives late
  const b = await books();
  assert.equal(b[A.GATEWAY_CLEARING], 40000, 'the provider really holds both');
  assert.equal(b[A.DRIVER_PAYABLE], -17000, 'the driver is credited once');
  assert.equal(b[A.COMMISSION_REVENUE], -3000, 'the commission is earned once');
  assert.equal(b[A.REFUND_CLEARING], -20000, 'the extra 200 is owed back to the rider');
  assert.deepEqual(txns().map((t) => t.type).sort(), ['DUPLICATE_FARE_CAPTURED', 'ONLINE_FARE_CAPTURED']);
  assert.deepEqual((await ledger.verify({ tenantId: 't1' })).problems, []);
});

test('ten simultaneous success messages (different event ids) and refreshes leave exactly one ledger transaction', async () => {
  await reset();
  const { payment } = await open();
  const gw = adapters.getAdapter('MOCK');
  const deliveries = Array.from({ length: 10 }, () => gw.scenario('SUCCESS', payment.providerOrderId).deliverNow[0]);
  await Promise.all([
    ...deliveries.map((d) => svc.handleWebhook({ provider: 'MOCK', ...d })),
    ...Array.from({ length: 5 }, () => svc.refresh({ tenantId: 't1', paymentId: payment.paymentId }))
  ]);
  assert.equal((await svc.find({ tenantId: 't1', paymentId: payment.paymentId })).status, 'SUCCEEDED');
  assert.equal((await ledger.verify({ tenantId: 't1' })).transactions, 1, 'counted in the database itself, not in the test helper copy');
  assert.equal((await books())[A.GATEWAY_CLEARING], 20000);
  assert.equal((await books())[A.DRIVER_PAYABLE], -17000);
});

test('a success whose ledger posting was interrupted is completed by the repair, exactly once', async () => {
  await reset();
  const { payment } = await open();
  await run(payment.paymentId, 'SUCCESS');
  db.LedgerTxn.rows.length = 0; db.Payment.rows[0].ledgerTxnId = null; trip().payment_status = 'UNPAID';
  await flush();
  assert.equal(await svc.repairUnposted({ tenantId: 't1' }), 1);
  assert.equal(await svc.repairUnposted({ tenantId: 't1' }), 0, 'running it again finds nothing to repair');
  assert.equal(txns().length, 1);
  assert.equal(trip().payment_status, 'PAID');
});

test('payments left open past their window are closed after asking the provider; one that was really paid is succeeded, not expired', async () => {
  await reset();
  const { payment } = await open();
  const later = new Date(Date.now() + 60 * 60 * 1000);
  assert.deepEqual(await svc.expireStale({ tenantId: 't1', now: new Date() }), [], 'not yet');
  const gw = adapters.getAdapter('MOCK');
  gw.orders.get(payment.providerOrderId).status = 'paid'; // paid, but the message was lost
  assert.deepEqual(await svc.expireStale({ tenantId: 't1', now: later }), [], 'it was really paid');
  assert.equal(pay(payment.paymentId).status, 'SUCCEEDED');
  await reset();
  const unpaid = (await open()).payment;
  assert.deepEqual(await svc.expireStale({ tenantId: 't1', now: later }), [unpaid.paymentId]);
  assert.equal(pay(unpaid.paymentId).status, 'EXPIRED');
});

test('the mock gateway cannot exist in production, and a production server with it switched on refuses to start', async () => {
  assert.equal(config.mockEnabled({ PAYMENTS_MOCK_ENABLED: '1', NODE_ENV: 'production' }), false);
  assert.equal(config.mockEnabled({ PAYMENTS_MOCK_ENABLED: '1', NODE_ENV: 'development' }), true);
  assert.equal(config.mockEnabled({ NODE_ENV: 'development' }), false);
  assert.throws(() => adapters.getAdapter('MOCK', { PAYMENTS_MOCK_ENABLED: '1', NODE_ENV: 'production' }), (e) => e.code === 'MOCK_DISABLED');
  assert.throws(() => config.assertSafeStartup({ PAYMENTS_MOCK_ENABLED: '1', NODE_ENV: 'production' }), /must not be set in production/);
  assert.doesNotThrow(() => config.assertSafeStartup({ NODE_ENV: 'production' }));
  await reset();
  const { payment } = await open();
  await assert.rejects(svc.simulate({ tenantId: 't1', paymentId: payment.paymentId, scenario: 'SUCCESS', env: { NODE_ENV: 'production', PAYMENTS_MOCK_ENABLED: '1' } }), (e) => e.code === 'MOCK_DISABLED');
  assert.equal(pay(payment.paymentId).status, 'PENDING');
});

test('real providers refuse to run until they are configured and built, instead of guessing', async () => {
  for (const name of ['RAZORPAY', 'CASHFREE']) {
    const a = adapters.getAdapter(name, {});
    await assert.rejects(a.createOrder({}), (e) => e.code === 'PROVIDER_NOT_CONFIGURED', name);
  }
  const withKeys = adapters.getAdapter('RAZORPAY', { RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' });
  await assert.rejects(withKeys.createOrder({}), (e) => e.code === 'NOT_IMPLEMENTED');
  await reset();
  await db.Tenant.findOneAndUpdate({ tenantId: 't1' }, { $set: { payments: { enabledMethods: ['UPI'], provider: 'RAZORPAY' } } });
  await assert.rejects(open(), (e) => e.code === 'PROVIDER_ERROR');
  assert.equal(db.Payment.rows[0].status, 'FAILED', 'the attempt is closed, not left open');
});
