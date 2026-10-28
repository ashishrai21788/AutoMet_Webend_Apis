// Backfill: completed cash trips from before payments were recorded get a legacy CASH payment and the commission the driver owes on them, once.
// Dry run by default; running it again posts nothing; trips that already have a payment, another business's trips and trips without a usable
// earnings snapshot are never touched.
process.env.JWT_SECRET = 'test-secret-for-backfill';
process.env.PAYMENTS_MOCK_ENABLED = '1';
process.env.PAYMENTS_MOCK_SECRET = 'test-mock-secret-0123456789';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const backfill = require('../lib/payments/backfill');
const cashLib = require('../lib/payments/cash');
const svc = require('../lib/payments/service');
const adapters = require('../lib/payments/adapters');
const ledger = require('../lib/ledger');
const cli = require('../scripts/backfillPayments');
const { ACCOUNTS: A } = ledger;

const MODELS = ['Tenant', 'TripDetails', 'Payment', 'PaymentEvent', 'LedgerTxn'];
const flush = async () => { for (const m of MODELS) await db[m].find({}); };
const earn = (fare, pct = 15) => { const fee = Math.round(fare * pct / 100); return { fareMinor: fare, feeMinor: fee, netMinor: fare - fee, percent: pct, currency: 'INR' }; };
const seed = async () => {
  for (const m of MODELS) db[m].rows.length = 0;
  await flush();
  adapters.resetMock();
  for (const id of ['t1', 't2']) await db.Tenant.create({ tenantId: id, name: id, slug: id, appName: id, packageName: `in.${id}`, isDefault: id === 't1', payments: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK' } });
};
let n = 0;
const trip = (over = {}) => { n += 1; return db.TripDetails.create({ trip_id: `T${n}`, request_id: `R${n}`, tenant_id: 't1', user_id: `U${n}`, driver_id: 'D1', status: 'COMPLETED', timeout_at: new Date(), payment_mode: 'CASH', completed_at: new Date(Date.now() - 86400000 * (n % 5 + 1)), driver_earning: earn(20000), ...over }); };
const counts = async (tenantId = 't1') => ({ payments: (await db.Payment.find({ tenantId })).length, txns: (await ledger.verify({ tenantId })).transactions });
const owed = (tenantId = 't1', driverId = 'D1') => ledger.commissionOutstanding({ tenantId, driverId });

test('a dry run (the default) reports what it would do and changes nothing at all', async () => {
  await seed();
  const a = await trip(); const b = await trip({ driver_earning: earn(10000) });
  const before = JSON.stringify([await db.TripDetails.find({ tenant_id: 't1' })]);
  const r = await backfill.run({ tenantId: 't1' });
  assert.deepEqual([r.dryRun, r.candidates, r.created, r.commissionMinor, r.driversAffected], [true, 2, 0, 3000 + 1500, 1]);
  assert.deepEqual(r.sample.sort(), [a.trip_id, b.trip_id].sort());
  assert.deepEqual(await counts(), { payments: 0, txns: 0 });
  assert.equal(JSON.stringify([await db.TripDetails.find({ tenant_id: 't1' })]), before, 'no trip was touched');
});

test('applying creates a confirmed legacy cash payment per trip and books the commission the driver owes, once', async () => {
  await seed();
  const a = await trip(); await trip({ driver_earning: earn(10000) });
  const r = await backfill.run({ tenantId: 't1', apply: true });
  assert.deepEqual([r.dryRun, r.candidates, r.created, r.posted], [false, 2, 2, 2]);
  const p = (await db.Payment.find({ tenantId: 't1', tripId: a.trip_id }))[0];
  assert.deepEqual([p.method, p.status, p.cashState, p.amountMinor, p.driverId, p.cash.confirmedBy, p.cash.collectedMinor], ['CASH', 'SUCCEEDED', 'CONFIRMED', 20000, 'D1', 'backfill', 20000]);
  assert.deepEqual([p.commission.commissionMinor, p.commission.netMinor], [3000, 17000]);
  assert.ok(p.flags.some((f) => f.reason === 'LEGACY_BACKFILL'));
  assert.ok(p.ledgerTxnId && p.ledgerTxnId !== 'NONE');
  assert.equal(await owed(), 4500, 'what the driver owes on the two cash trips');
  const b = await ledger.balances({ tenantId: 't1' });
  assert.deepEqual([b[A.DRIVER_COMMISSION_RECEIVABLE], b[A.COMMISSION_REVENUE], b[A.GATEWAY_CLEARING] || 0], [4500, -4500, 0], 'a receivable, not cash received');
  const t = await db.TripDetails.findOne({ trip_id: a.trip_id }).lean();
  assert.deepEqual([t.payment_status, t.payment_mode, t.payment_id], ['PAID', 'CASH', p.paymentId]);
  assert.deepEqual((await ledger.verify({ tenantId: 't1' })).problems, []);
});

test('running it again posts nothing new, and twice at the same time makes one payment per trip', async () => {
  await seed();
  await trip(); await trip();
  const first = await backfill.run({ tenantId: 't1', apply: true });
  const second = await backfill.run({ tenantId: 't1', apply: true });
  assert.deepEqual([first.created, second.created, second.candidates, second.posted], [2, 0, 0, 0]);
  assert.deepEqual(await counts(), { payments: 2, txns: 2 });
  await seed();
  await trip(); await trip(); await trip();
  const both = await Promise.all([backfill.run({ tenantId: 't1', apply: true }), backfill.run({ tenantId: 't1', apply: true })]);
  assert.equal(both[0].created + both[1].created, 3, 'each trip was created by exactly one of them');
  assert.deepEqual(await counts(), { payments: 3, txns: 3 }, 'counted in the database');
  assert.equal(await owed(), 3 * 3000);
});

test('a trip that already has a payment (cash or online) is never touched', async () => {
  await seed();
  const cashTrip = await trip(); const upiTrip = await trip(); await trip();
  await cashLib.confirmCash({ tenantId: 't1', tripId: cashTrip.trip_id, driverId: 'D1' });
  const { payment } = await svc.createPayment({ tenantId: 't1', tripId: upiTrip.trip_id, riderId: upiTrip.user_id, method: 'UPI', idempotencyKey: 'k1' });
  const before = JSON.stringify(await db.Payment.find({ tenantId: 't1' }));
  const r = await backfill.run({ tenantId: 't1', apply: true });
  assert.deepEqual([r.candidates, r.created, r.skipped.hasPayment], [1, 1, 2]);
  const after = (await db.Payment.find({ tenantId: 't1' })).filter((p) => p.paymentId === payment.paymentId || p.tripId === cashTrip.trip_id);
  assert.equal(JSON.stringify(after.sort((x, y) => x.paymentId.localeCompare(y.paymentId))), JSON.stringify(JSON.parse(before).filter((p) => p.paymentId === payment.paymentId || p.tripId === cashTrip.trip_id).sort((x, y) => x.paymentId.localeCompare(y.paymentId))), 'their payments are unchanged');
});

test('only the asked business is touched; with no business named every business is done, each on its own books', async () => {
  await seed();
  await trip(); await trip({ tenant_id: 't2', driver_id: 'Y1' });
  const one = await backfill.run({ tenantId: 't1', apply: true });
  assert.equal(one.created, 1);
  assert.deepEqual(await counts('t2'), { payments: 0, txns: 0 }, 'the other business is untouched');
  const all = await backfill.runAll({ apply: true });
  assert.deepEqual(all.map((r) => [r.tenantId, r.created]).sort(), [['t1', 0], ['t2', 1]]);
  assert.equal(await owed('t2', 'Y1'), 3000);
  assert.equal(await owed('t1', 'Y1'), 0, 'a driver id in another business is a different account');
});

test('trips without a usable earnings snapshot, not completed, online, or with a split that does not add up are skipped and counted', async () => {
  await seed();
  await trip({ driver_earning: null });
  await trip({ driver_earning: { fareMinor: 20000, feeMinor: 3000, netMinor: 16000, percent: 15, currency: 'INR' } });
  await trip({ driver_earning: { fareMinor: 0, feeMinor: 0, netMinor: 0, percent: 0, currency: 'INR' } });
  await trip({ status: 'ON_GOING' });
  await trip({ status: 'CANCELLED_BY_USER' });
  await trip({ payment_mode: 'UPI' });
  const ok = await trip();
  const r = await backfill.run({ tenantId: 't1', apply: true });
  assert.deepEqual([r.candidates, r.created], [1, 1]);
  assert.deepEqual(r.skipped, { hasPayment: 0, noSnapshot: 2, splitInconsistent: 1, notCash: 1, noDriver: 0 });
  assert.deepEqual((await db.Payment.find({ tenantId: 't1' })).map((p) => p.tripId), [ok.trip_id]);
});

test('the decision for one trip is made in one place, including a trip with no driver (which a stored trip cannot be)', () => {
  assert.deepEqual(backfill.analyse({ status: 'COMPLETED', payment_mode: 'CASH', driver_id: null, driver_earning: earn(20000) }), { skip: 'noDriver' });
  assert.deepEqual(backfill.analyse({ status: 'COMPLETED', driver_id: 'D1', driver_earning: earn(20000) }).money, { amountMinor: 20000, commissionMinor: 3000, netMinor: 17000, percent: 15, currency: 'INR' }, 'a trip with no payment mode is a cash trip');
  for (const bad of [{ fareMinor: 1.5, feeMinor: 0, netMinor: 1.5 }, { fareMinor: -5, feeMinor: 0, netMinor: -5 }, { fareMinor: '200', feeMinor: 0, netMinor: 200 }]) assert.equal(backfill.analyse({ driver_id: 'D1', driver_earning: bad }).skip, 'noSnapshot');
});

test('a trip with no commission still gets its payment, with nothing owed and nothing posted', async () => {
  await seed();
  const t = await trip({ driver_earning: earn(20000, 0) });
  const r = await backfill.run({ tenantId: 't1', apply: true });
  assert.deepEqual([r.created, r.posted, r.commissionMinor], [1, 0, 0]);
  const p = (await db.Payment.find({ tenantId: 't1', tripId: t.trip_id }))[0];
  assert.deepEqual([p.cashState, p.ledgerTxnId], ['CONFIRMED', 'NONE']);
  assert.equal(await owed(), 0);
  assert.equal((await backfill.run({ tenantId: 't1', apply: true })).created, 0);
});

test('if the ledger fails part way, the payments exist, nothing is booked twice, and the cash repair finishes the rest', async () => {
  await seed();
  await trip(); await trip();
  const real = ledger.post;
  let calls = 0;
  ledger.post = async (a) => { calls += 1; if (calls === 2) throw new Error('ledger unavailable'); return real(a); };
  let r;
  try { r = await backfill.run({ tenantId: 't1', apply: true }); } finally { ledger.post = real; }
  assert.deepEqual([r.created, r.posted, r.failedToPost], [2, 1, 1]);
  assert.equal((await db.Payment.find({ tenantId: 't1', ledgerTxnId: null })).length, 1);
  assert.equal(await cashLib.repairUnposted({ tenantId: 't1' }), 1);
  const again = await backfill.run({ tenantId: 't1', apply: true });
  assert.deepEqual([again.created, again.posted], [0, 0]);
  assert.deepEqual(await counts(), { payments: 2, txns: 2 });
  assert.equal(await owed(), 6000);
});

test('the command line: a dry run unless --apply is given, one business with --tenant, and nonsense is refused', () => {
  assert.deepEqual(cli.parseArgs([]), { apply: false, tenantId: null });
  assert.deepEqual(cli.parseArgs(['--apply']), { apply: true, tenantId: null });
  assert.deepEqual(cli.parseArgs(['--apply', '--tenant', 't1']), { apply: true, tenantId: 't1' });
  assert.deepEqual(cli.parseArgs(['--tenant=t2', '--dry-run']), { apply: false, tenantId: 't2' });
  assert.throws(() => cli.parseArgs(['--apply', '--dry-run']), /either/);
  assert.throws(() => cli.parseArgs(['--tenant']), /needs a business id/);
  assert.throws(() => cli.parseArgs(['--wat']), /unknown option/);
});
