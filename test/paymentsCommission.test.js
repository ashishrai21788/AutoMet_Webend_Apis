// Commission owed on cash fares: recovered from the driver's later online earnings (when the business's policy allows it), or paid by the
// driver directly online. Accrued, collected and outstanding stay separate amounts, and every recovery is its own ledger transaction.
process.env.JWT_SECRET = 'test-secret-for-commission';
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
const recovery = require('../lib/payments/recovery');
const commission = require('../lib/payments/commission');
const adapters = require('../lib/payments/adapters');
const ledger = require('../lib/ledger');
const { ACCOUNTS: A } = ledger;

const MODELS = ['Tenant', 'TripDetails', 'Payment', 'PaymentEvent', 'LedgerTxn'];
const flush = async () => { for (const m of MODELS) await db[m].find({}); };
const earn = (fare, pct = 15) => { const fee = Math.round(fare * pct / 100); return { fareMinor: fare, feeMinor: fee, netMinor: fare - fee, percent: pct, currency: 'INR' }; };
const reset = async (payments = { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK' }) => {
  for (const m of MODELS) db[m].rows.length = 0;
  await flush();
  adapters.resetMock();
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', slug: 'uride', appName: 'uRide', packageName: 'in.uride', isDefault: true, payments });
  await db.Tenant.create({ tenantId: 't2', name: 'Other', slug: 'other', appName: 'Other', packageName: 'in.other', payments: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK' } });
};
const addTrip = (id, fare, over = {}) => db.TripDetails.create({ trip_id: id, request_id: `R${id}`, tenant_id: 't1', user_id: `U${id}`, driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), driver_earning: earn(fare), ...over });
const cashTrip = async (id, fare) => { await addTrip(id, fare); await cash.confirmCash({ tenantId: 't1', tripId: id, driverId: 'D1', idempotencyKey: `c-${id}` }); };
const onlineTrip = async (id, fare, tenantId = 't1', scenario = 'SUCCESS') => {
  if (!db.TripDetails.rows.find((t) => t.trip_id === id)) await addTrip(id, fare);
  const { payment } = await svc.createPayment({ tenantId, tripId: id, riderId: `U${id}`, method: 'UPI', idempotencyKey: `u-${id}` });
  if (scenario) await svc.simulate({ tenantId, paymentId: payment.paymentId, scenario });
  return payment;
};
const outstanding = () => ledger.commissionOutstanding({ tenantId: 't1', driverId: 'D1' });
const payable = () => ledger.owedToDriver({ tenantId: 't1', driverId: 'D1' });
const types = async () => (await db.LedgerTxn.find({ tenantId: 't1' })).map((t) => t.type).sort();

test('the worked example: Rs 45 owed from cash trips, then a Rs 400 online trip: Rs 340 net becomes Rs 295 payable, and the recovery is its own entry', async () => {
  await reset();
  await cashTrip('C1', 30000); // 15% of Rs 300 = Rs 45
  assert.equal(await outstanding(), 4500);
  await onlineTrip('O1', 40000); // commission Rs 60, net Rs 340
  assert.equal(await payable(), 29500, 'Rs 340 less the Rs 45 recovered');
  assert.equal(await outstanding(), 0);
  assert.deepEqual(await types(), ['CASH_COMMISSION_ACCRUED', 'COMMISSION_RECOVERED', 'ONLINE_FARE_CAPTURED']);
  const cashTxn = (await db.LedgerTxn.find({ tenantId: 't1', type: 'CASH_COMMISSION_ACCRUED' }))[0];
  assert.deepEqual(cashTxn.entries.map((e) => e.debitMinor || e.creditMinor), [4500, 4500], 'the cash trip\'s own commission entry is untouched');
  const s = await commission.summary({ tenantId: 't1', driverId: 'D1' });
  assert.deepEqual([s.accruedMinor, s.collectedMinor, s.outstandingMinor], [4500, 4500, 0]);
  const b = await ledger.balances({ tenantId: 't1' });
  assert.equal(b[A.COMMISSION_REVENUE], -(4500 + 6000), 'revenue is the commission on both trips');
  assert.deepEqual((await ledger.verify({ tenantId: 't1' })).problems, []);
});

test('recovery never takes more than the driver is owed: what cannot be recovered stays outstanding, and later earnings pay it down', async () => {
  await reset();
  await cashTrip('C1', 60000); // owes Rs 90
  await onlineTrip('O1', 4000); // net Rs 34
  assert.equal(await payable(), 0, 'all of the Rs 34 went to the commission');
  assert.equal(await outstanding(), 9000 - 3400);
  await onlineTrip('O2', 40000); // net Rs 340
  assert.equal(await outstanding(), 0);
  assert.equal(await payable(), 34000 - 5600);
  const s = await commission.summary({ tenantId: 't1', driverId: 'D1' });
  assert.deepEqual([s.accruedMinor, s.collectedMinor, s.outstandingMinor], [9000, 9000, 0]);
});

test('with nothing outstanding there is no recovery entry, and a business that disallows recovery keeps the commission outstanding', async () => {
  await reset();
  await onlineTrip('O1', 40000);
  assert.deepEqual(await types(), ['ONLINE_FARE_CAPTURED']);
  assert.equal(await payable(), 34000);
  await reset({ enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', commissionRecovery: 'MANUAL_ONLY' });
  await cashTrip('C1', 30000);
  await onlineTrip('O1', 40000);
  assert.equal(await outstanding(), 4500, 'not recovered');
  assert.equal(await payable(), 34000);
  assert.ok(!(await types()).includes('COMMISSION_RECOVERED'));
  const manual = await recovery.recoverCommission({ tenantId: 't1', driverId: 'D1', trigger: 'admin', createdBy: 'admin:a1' });
  assert.equal(manual.recoveredMinor, 4500, 'an administrator can still trigger it');
  assert.equal(await outstanding(), 0);
});

test('two online payments succeeding at once recover the outstanding commission exactly once, and it is never taken twice', async () => {
  await reset();
  await cashTrip('C1', 30000); // owes Rs 45
  await addTrip('O1', 40000); await addTrip('O2', 40000);
  const p1 = (await svc.createPayment({ tenantId: 't1', tripId: 'O1', riderId: 'UO1', method: 'UPI', idempotencyKey: 'a' })).payment;
  const p2 = (await svc.createPayment({ tenantId: 't1', tripId: 'O2', riderId: 'UO2', method: 'UPI', idempotencyKey: 'b' })).payment;
  await Promise.all([svc.simulate({ tenantId: 't1', paymentId: p1.paymentId, scenario: 'SUCCESS' }), svc.simulate({ tenantId: 't1', paymentId: p2.paymentId, scenario: 'SUCCESS' })]);
  assert.equal(await outstanding(), 0);
  assert.equal(await payable(), 34000 * 2 - 4500, 'Rs 45 taken once, not twice');
  const recoveries = (await db.LedgerTxn.find({ tenantId: 't1', type: 'COMMISSION_RECOVERED' }));
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].entries.find((e) => e.account === A.DRIVER_COMMISSION_RECEIVABLE).creditMinor, 4500);
});

test('asking for the recovery again changes nothing', async () => {
  await reset();
  await cashTrip('C1', 30000);
  await onlineTrip('O1', 40000);
  const again = await recovery.recoverCommission({ tenantId: 't1', driverId: 'D1', trigger: 'auto' });
  assert.equal(again.recoveredMinor, 0);
  assert.equal((await db.LedgerTxn.find({ tenantId: 't1', type: 'COMMISSION_RECOVERED' })).length, 1);
  assert.equal(await payable(), 29500);
});

test('the driver can pay the commission directly online: a verified payment reduces what is owed, once, however often the message arrives', async () => {
  await reset({ enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', commissionRecovery: 'MANUAL_ONLY' });
  await cashTrip('C1', 30000); // owes Rs 45
  const { payment } = await svc.createCommissionPayment({ tenantId: 't1', driverId: 'D1', amountMinor: 3000, idempotencyKey: 'cp1' });
  assert.deepEqual([payment.purpose, payment.method, payment.amountMinor, payment.status, payment.driverId], ['COMMISSION', 'UPI', 3000, 'PENDING', 'D1']);
  assert.equal(await outstanding(), 4500, 'nothing changes until the provider confirms');
  const r = await svc.simulate({ tenantId: 't1', paymentId: payment.paymentId, scenario: 'DUPLICATE_WEBHOOK' });
  assert.deepEqual(r.replies.map((x) => x.outcome), ['APPLIED', 'DUPLICATE']);
  assert.equal(await outstanding(), 1500);
  assert.equal((await ledger.balances({ tenantId: 't1' }))[A.GATEWAY_CLEARING], 3000, 'the money really reached the gateway');
  assert.ok((await types()).includes('COMMISSION_PAID_DIRECT'));
  const s = await commission.summary({ tenantId: 't1', driverId: 'D1' });
  assert.deepEqual([s.accruedMinor, s.collectedMinor, s.outstandingMinor], [4500, 3000, 1500]);
});

test('a commission payment is refused when nothing is owed, for more than is owed (counting payments still open), or for another business\'s driver', async () => {
  await reset({ enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', commissionRecovery: 'MANUAL_ONLY' });
  const refuse = (p, code) => assert.rejects(p, (e) => e.code === code, code);
  await refuse(svc.createCommissionPayment({ tenantId: 't1', driverId: 'D1', amountMinor: 100, idempotencyKey: 'x1' }), 'NOTHING_OWED');
  await cashTrip('C1', 30000);
  await refuse(svc.createCommissionPayment({ tenantId: 't1', driverId: 'D1', amountMinor: 4501, idempotencyKey: 'x2' }), 'AMOUNT_TOO_HIGH');
  await refuse(svc.createCommissionPayment({ tenantId: 't1', driverId: 'D1', amountMinor: 0, idempotencyKey: 'x3' }), 'BAD_AMOUNT');
  await refuse(svc.createCommissionPayment({ tenantId: 't1', driverId: 'D1', amountMinor: 10.5, idempotencyKey: 'x4' }), 'BAD_AMOUNT');
  await svc.createCommissionPayment({ tenantId: 't1', driverId: 'D1', amountMinor: 3000, idempotencyKey: 'ok1' });
  await refuse(svc.createCommissionPayment({ tenantId: 't1', driverId: 'D1', amountMinor: 2000, idempotencyKey: 'ok2' }), 'AMOUNT_TOO_HIGH'); // 3000 is already open
  const same = await svc.createCommissionPayment({ tenantId: 't1', driverId: 'D1', amountMinor: 3000, idempotencyKey: 'ok1' });
  assert.equal(same.created, false, 'the same request again returns the same payment');
  await refuse(svc.createCommissionPayment({ tenantId: 't2', driverId: 'D1', amountMinor: 100, idempotencyKey: 'x5' }), 'NOTHING_OWED');
  assert.equal(await ledger.commissionOutstanding({ tenantId: 't2', driverId: 'D1' }), 0, 'another business has no such debt');
});

test('a failed commission payment books nothing', async () => {
  await reset({ enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', commissionRecovery: 'MANUAL_ONLY' });
  await cashTrip('C1', 30000);
  const { payment } = await svc.createCommissionPayment({ tenantId: 't1', driverId: 'D1', amountMinor: 4500, idempotencyKey: 'f1' });
  await svc.simulate({ tenantId: 't1', paymentId: payment.paymentId, scenario: 'FAILURE' });
  assert.equal(await outstanding(), 4500);
  assert.equal((await db.Payment.find({ purpose: 'COMMISSION' }))[0].status, 'FAILED');
  assert.ok(!(await types()).includes('COMMISSION_PAID_DIRECT'));
});
