// The driver's earnings, analytics, bank account and withdrawals, and the business's side of paying them.
process.env.JWT_SECRET = 'test-secret-for-driver-earnings';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const onboarding = require('../controllers/driverOnboardingController');
const E = require('../controllers/driverEarningsController');
const P = require('../controllers/payoutsController');
const money = require('../lib/driverMoney');
const { clearAppTenantCache } = require('../lib/appTenant');

const NOW = Date.now();
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000);
const trip = (id, extra = {}) => ({
  trip_id: id, request_id: 'R' + id, user_id: 'U1', driver_id: 'D1', status: 'COMPLETED', fare: 100, currency: 'INR', payment_mode: 'CASH',
  requested_at: hoursAgo(2), completed_at: hoursAgo(1), distance_km: 5, category_id: 'c1', pickup: { address: 'A' }, drop: { address: 'B' }, ...extra
});

const call = async (fn, { body = {}, query = {}, params = {}, driverId = 'D1' } = {}) => {
  const req = { authActorId: driverId, body, params, query, headers: {}, ip: '127.0.0.1' };
  let out;
  const res = { code: 200, headers: {}, set(h) { Object.assign(this.headers, h); return this; }, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; }, send(b) { out = { code: this.code, body: b, headers: this.headers }; return this; } };
  let ok = false;
  await onboarding.driverContext(req, res, () => { ok = true; });
  if (!ok) return out;
  await fn(req, res);
  return out;
};

const admin = async (fn, { body = {}, params = {}, query = {} } = {}) => {
  const business = await db.Tenant.findOne({ tenantId: 't1' }).lean();
  const req = {
    body, params, query, ip: '1.1.1.1', business, admin: { adminId: 'A1', email: 'a@t.local', role: 'client_admin' },
    legacyData: { find: (M, f) => M.find(f), findOne: (M, f) => M.findOne(f) },
    data: { update: (M, f, v) => M.findOneAndUpdate({ tenantId: 't1' }, { $set: v }, { new: true }) }
  };
  let out;
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};

const seed = async (market = {}) => {
  clearAppTenantCache();
  for (const m of ['Tenant', 'ServiceRegion', 'VehicleCategory', 'Driver', 'TripDetails', 'DriverPayout', 'DriverDutySession', 'AdminAudit']) db[m].rows.length = 0;
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', isDefault: true, market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata', ...market } });
  await db.VehicleCategory.create({ tenantId: 't1', categoryId: 'c1', name: 'VIP', nameKey: 'vip', passengerCapacity: 4, rideType: 'economy', regionIds: [], active: true });
  await db.Driver.create({ driverId: 'D1', email: 'd1@t.local', phone: '+919811100000', firstName: 'Ravi', lastName: 'Kumar', tenantId: 't1', accountStatus: 'ACTIVE' });
};
const setPayout = async (v) => { await db.Tenant.findOneAndUpdate({ tenantId: 't1' }, { $set: { payoutSettings: v } }); clearAppTenantCache(); };

test('earnings are fixed at completion: a later commission change never rewrites them', async () => {
  await seed();
  await setPayout({ commissionPercent: 10 });
  const tenant = await db.Tenant.findOne({ tenantId: 't1' }).lean();
  const snap = money.snapshotFor(trip('S1', { fare: 200 }), tenant);
  assert.deepEqual([snap.fareMinor, snap.feeMinor, snap.netMinor], [20000, 2000, 18000]);
  await setPayout({ commissionPercent: 50 });
  const later = await db.Tenant.findOne({ tenantId: 't1' }).lean();
  assert.equal(money.tripMoney(trip('S1', { fare: 200, driver_earning: snap }), later).netMinor, 18000, 'the stored split is used');
  assert.equal(money.tripMoney(trip('S2', { fare: 200 }), later).netMinor, 10000, 'an old trip with no stored split uses the current rate');
});

test('overview: net earnings, change against the period before, trips and average', async () => {
  await seed();
  await setPayout({ commissionPercent: 10 });
  await db.TripDetails.create(trip('O1', { fare: 100, completed_at: hoursAgo(1) }));
  await db.TripDetails.create(trip('O2', { fare: 300, completed_at: hoursAgo(2) }));
  await db.TripDetails.create(trip('O3', { fare: 200, completed_at: hoursAgo(24 * 9) }));
  const r = await call(E.overview, { query: { range: 'week' } });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200));
  const d = r.body.data;
  assert.equal(d.total.minor, 36000, '400 less 10%');
  assert.equal(d.previous || d.total.previous.minor, 18000, 'the week before: 200 less 10%');
  assert.equal(d.total.changePercent, 100);
  assert.equal(d.completedTrips.value, 2);
  assert.equal(d.averagePerTrip.minor, 18000);
  assert.equal(d.bars.reduce((s, b) => s + b.minor, 0), d.total.minor, 'the bars add up to the total');
  assert.ok(d.message && /100%/.test(d.message.text));
});

test('analytics: the breakdown, ride types and payment methods all add up to the same net', async () => {
  await seed();
  await setPayout({ commissionPercent: 10 });
  await db.TripDetails.create(trip('A1', { fare: 100, payment_mode: 'CASH' }));
  await db.TripDetails.create(trip('A2', { fare: 333.33, payment_mode: 'UPI' }));
  await db.TripDetails.create(trip('A3', { fare: 50.5, payment_mode: 'UPI', status: 'COMPLETED' }));
  const d = (await call(E.analytics, { query: { range: 'week', trend: 'daily' } })).body.data;
  const fares = d.earnings.breakdown.find((x) => x.key === 'fares').minor;
  const fees = d.earnings.breakdown.find((x) => x.key === 'fees').minor;
  assert.equal(fares + fees, d.earnings.net.minor, 'fares less fees is the net');
  assert.equal(d.earnings.byRideType.reduce((s, x) => s + x.minor, 0), d.earnings.net.minor);
  assert.equal(d.earnings.byPaymentMethod.reduce((s, x) => s + x.minor, 0), d.earnings.net.minor);
  assert.equal(d.earnings.trend.points.length, 7);
  assert.equal(d.trips.completed, 3);
});

test('balance: cash earnings are already in the driver\'s hand, online ones are owed to them', async () => {
  await seed();
  await setPayout({ commissionPercent: 10 });
  await db.TripDetails.create(trip('B1', { fare: 1000, payment_mode: 'CASH' }));
  let d = (await call(E.payoutsSummary)).body.data;
  assert.equal(d.totalEarnings.minor, 90000, 'cash counts as earnings');
  assert.equal(d.available.minor, 0, 'but nothing is owed to the driver for a cash ride');
  await db.TripDetails.create(trip('B2', { fare: 500, payment_mode: 'UPI' }));
  d = (await call(E.payoutsSummary)).body.data;
  assert.equal(d.available.minor, 45000 - 10000, 'online earnings (450) less the share owed on cash rides (100)');
  await setPayout({ commissionPercent: 10, cashWithdrawable: true });
  d = (await call(E.payoutsSummary)).body.data;
  assert.equal(d.available.minor, 135000, 'a business that pays cash earnings out counts them');
});

async function fundedDriver() {
  await seed();
  await db.TripDetails.create(trip('W1', { fare: 1000, payment_mode: 'UPI' }));
  await db.Driver.findOneAndUpdate({ driverId: 'D1' }, { $set: { bankAccount: { accountHolderName: 'Ravi Kumar', accountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC Bank' } } });
}

test('withdraw: needs a bank account, a sensible amount, one at a time, and never more than the balance', async () => {
  await seed();
  await db.TripDetails.create(trip('W0', { fare: 1000, payment_mode: 'UPI' }));
  assert.equal((await call(E.withdraw, { body: { amount: 100 } })).code, 409, 'no bank yet');
  assert.equal((await call(E.saveBank, { body: { accountHolderName: 'R', accountNumber: '12', ifscCode: 'bad', bankName: '' } })).code, 400);
  assert.equal((await call(E.saveBank, { body: { accountHolderName: 'Ravi Kumar', accountNumber: '123456789012', ifscCode: 'hdfc0001234', bankName: 'HDFC Bank' } })).code, 200);
  assert.equal((await call(E.withdraw, { body: { amount: 0 } })).code, 400);
  assert.equal((await call(E.withdraw, { body: { amount: 1000.01 } })).code, 400, 'more than the balance');
  const ok = await call(E.withdraw, { body: { amount: 400 } });
  assert.equal(ok.code, 200, JSON.stringify(ok.body).slice(0, 200));
  assert.equal(ok.body.data.status, 'REQUESTED');
  assert.equal(ok.body.data.bank, 'HDFC Bank ••••9012', 'only the last four digits are shown');
  assert.equal((await call(E.withdraw, { body: { amount: 100 } })).code, 409, 'one open withdrawal at a time');
  const s = (await call(E.payoutsSummary)).body.data;
  assert.equal(s.pending.minor, 40000);
  assert.equal(s.available.minor, 60000);
  assert.ok(!JSON.stringify(s).includes('123456789012'), 'the account number never leaves the server');
  assert.equal((await call(E.saveBank, { body: { accountHolderName: 'Ravi Kumar', accountNumber: '999999999999', ifscCode: 'HDFC0001234', bankName: 'HDFC' } })).code, 409, 'no bank change during a withdrawal');
  const id = ok.body.data.id;
  assert.equal((await call(E.cancelWithdrawal, { params: { id }, driverId: 'OTHER' })).code, 404, 'not another driver\'s');
});

test('the business pays: a reference is required and unique, a payout can be settled only once, and a failure returns the money', async () => {
  await fundedDriver();
  const w = (await call(E.withdraw, { body: { amount: 400 } })).body.data;
  const id = w.id;
  assert.equal((await admin(P.pay, { params: { id }, body: { reference: 'x' } })).code, 400, 'a reference is required');
  assert.equal((await admin(P.start, { params: { id } })).body.data.status, 'PROCESSING');
  const paid = await admin(P.pay, { params: { id }, body: { reference: 'HDFC20261021A1' } });
  assert.equal(paid.code, 200, JSON.stringify(paid.body).slice(0, 200));
  assert.equal(paid.body.data.status, 'PAID');
  assert.equal((await admin(P.pay, { params: { id }, body: { reference: 'HDFC20261021A2' } })).code, 409, 'already paid');
  assert.equal((await admin(P.fail, { params: { id }, body: { reason: 'Account closed' } })).code, 409, 'a paid payout cannot fail');
  let s = (await call(E.payoutsSummary)).body.data;
  assert.equal(s.paidOut.minor, 40000);
  assert.equal(s.available.minor, 60000);
  assert.equal(s.history[0].reference, 'HDFC20261021A1');

  const w2 = (await call(E.withdraw, { body: { amount: 100 } })).body.data;
  assert.equal((await admin(P.pay, { params: { id: w2.id }, body: { reference: 'HDFC20261021A1' } })).code, 409, 'the same bank reference cannot settle two payouts');
  assert.equal((await admin(P.fail, { params: { id: w2.id }, body: { reason: 'Account closed' } })).body.data.status, 'FAILED');
  s = (await call(E.payoutsSummary)).body.data;
  assert.equal(s.available.minor, 60000, 'a failed payout is back in the balance');
  assert.equal(s.pending.minor, 0);
  assert.ok(db.AdminAudit.rows.some((r) => r.action === 'payout.paid'), 'every change is audited');
});

test('payout settings are validated and drive the minimum withdrawal', async () => {
  await fundedDriver();
  assert.equal((await admin(P.updateSettings, { body: { commissionPercent: 120 } })).code, 400);
  const ok = await admin(P.updateSettings, { body: { commissionPercent: 5, minWithdrawal: 100, cashWithdrawable: false } });
  assert.equal(ok.code, 200);
  clearAppTenantCache();
  assert.equal((await call(E.withdraw, { body: { amount: 50 } })).code, 400, 'below the smallest withdrawal');
  assert.equal((await call(E.withdraw, { body: { amount: 100 } })).code, 200);
});

test('csv export: one line per trip and a total that matches', async () => {
  await seed();
  await db.TripDetails.create(trip('C1', { fare: 120 }));
  await db.TripDetails.create(trip('C2', { fare: 80 }));
  const r = await call(E.exportCsv, { query: { range: 'week' } });
  const lines = r.body.replace('﻿', '').trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[3], /^Total,,2 trips,,200\.00,0\.00,0\.00,200\.00$/);
});

// ---- incentives, goals, tips and adjustments ----
const I = require('../controllers/incentivesAdminController');
const incentivesLib = require('../lib/incentives');
const seedMore = async () => { for (const m of ['Incentive', 'DriverAdjustment']) db[m].rows.length = 0; };
const mkInc = (extra = {}) => ({ tenantId: 't1', incentiveId: 'inc1', name: 'Weekly 3', targetTrips: 3, bonusMinor: 20000, currency: 'INR', startsAt: hoursAgo(24 * 3), endsAt: new Date(NOW + 24 * 3600 * 1000), active: true, ...extra });

test('incentives: the bonus is credited once when the target is reached, never twice, and counts as earnings', async () => {
  await seed(); await seedMore();
  await db.Incentive.create(mkInc());
  await db.TripDetails.create(trip('N1')); await db.TripDetails.create(trip('N2'));
  let o = (await call(E.incentivesList)).body.data.offers;
  assert.equal(o[0].progress, 2); assert.equal(o[0].reached, false);
  assert.equal(db.DriverAdjustment.rows.length, 0, 'not reached yet, nothing paid');
  await db.TripDetails.create(trip('N3'));
  o = (await call(E.incentivesList)).body.data.offers;
  assert.equal(o[0].reached, true); assert.equal(o[0].paid, true);
  await call(E.overview, { query: { range: 'week' } }); await call(E.payoutsSummary);
  assert.equal(db.DriverAdjustment.rows.filter((a) => a.kind === 'INCENTIVE').length, 1, 'credited exactly once');
  const ov = (await call(E.overview, { query: { range: 'week' } })).body.data;
  assert.equal(ov.total.minor, 30000 + 20000, 'three 100 trips and the 200 bonus');
  const an = (await call(E.analytics, { query: { range: 'week' } })).body.data.earnings;
  const sum = an.breakdown.reduce((s, x) => s + x.minor, 0);
  assert.equal(sum, an.net.minor, 'the breakdown adds up to the net, bonus included');
  assert.ok(an.breakdown.some((x) => x.key === 'incentives' && x.minor === 20000));
  const bal = (await call(E.payoutsSummary)).body.data;
  assert.equal(bal.available.minor, 20000, 'the bonus is owed by the business even though the rides were cash');
});

test('incentives: a goal with no bonus pays nothing; a window or category that does not match does not count', async () => {
  await seed(); await seedMore();
  await db.Incentive.create(mkInc({ incentiveId: 'g1', name: 'Goal', bonusMinor: 0 }));
  await db.Incentive.create(mkInc({ incentiveId: 'old', name: 'Expired', endsAt: hoursAgo(24) }));
  await db.Incentive.create(mkInc({ incentiveId: 'cat', name: 'Other category', categoryId: 'cX' }));
  for (const id of ['G1', 'G2', 'G3']) await db.TripDetails.create(trip(id));
  const d = (await call(E.overview, { query: { range: 'week' } })).body.data;
  assert.equal(db.DriverAdjustment.rows.length, 0, 'no bonus anywhere');
  assert.equal(d.goal.name, 'Goal'); assert.equal(d.goal.progress, 3);
  assert.equal(d.incentives.activeOffers, 1, 'only the category offer is an open bonus (the expired one is closed)');
  const offers = (await call(E.incentivesList)).body.data.offers;
  assert.equal(offers.find((x) => x.id === 'cat').progress, 0, 'trips of another category do not count');
});

test('tips go to the driver in full and are paid the way the ride was; adjustments move the balance', async () => {
  await seed(); await seedMore();
  await setPayout({ commissionPercent: 10 });
  await db.TripDetails.create(trip('T1', { fare: 100, payment_mode: 'UPI', tip_minor: 2000, tip_at: hoursAgo(1) }));
  await db.TripDetails.create(trip('T2', { fare: 100, payment_mode: 'CASH', tip_minor: 1000, tip_at: hoursAgo(1) }));
  const ov = (await call(E.overview, { query: { range: 'week' } })).body.data;
  assert.equal(ov.total.minor, 9000 + 2000 + 9000 + 1000, 'fares less 10%, plus both tips untouched');
  let s = (await call(E.payoutsSummary)).body.data;
  assert.equal(s.available.minor, 9000 + 2000 - 1000, 'online fare and tip, less the share owed on the cash ride');
  assert.equal(s.tipsEarned.minor, 3000);
  const added = await admin(I.addAdjustment, { body: { driverId: 'D1', amount: 50, reason: 'Toll refund' } });
  assert.equal(added.code, 200, JSON.stringify(added.body).slice(0, 200));
  assert.equal((await admin(I.addAdjustment, { body: { driverId: 'D1', amount: 0, reason: 'x' } })).code, 400);
  assert.equal((await admin(I.addAdjustment, { body: { driverId: 'NOPE', amount: 5, reason: 'Toll refund' } })).code, 400);
  s = (await call(E.payoutsSummary)).body.data;
  assert.equal(s.available.minor, 9000 + 2000 - 1000 + 5000);
  const tx = (await call(E.transactions)).body.data.items;
  assert.ok(tx.some((r) => r.kind === 'TIP') && tx.some((r) => r.kind === 'ADJUSTMENT'));
});

test('admin incentives: validated, and a started incentive keeps its rules', async () => {
  await seed(); await seedMore();
  const bad = await admin(I.create, { body: { name: 'x', targetTrips: 0, bonus: -1, startsAt: 'nope', endsAt: 'nope' } });
  assert.equal(bad.code, 400);
  assert.ok(bad.body.errors.name && bad.body.errors.targetTrips && bad.body.errors.bonus && bad.body.errors.startsAt);
  const ok = await admin(I.create, { body: { name: 'Weekend 10', targetTrips: 10, bonus: 150, startsAt: new Date(NOW + 3600000).toISOString(), endsAt: new Date(NOW + 7 * 24 * 3600000).toISOString() } });
  assert.equal(ok.code, 200, JSON.stringify(ok.body).slice(0, 200));
  assert.equal(ok.body.data.bonusMinor, 15000);
  assert.equal((await admin(I.update, { params: { id: ok.body.data.id }, body: { targetTrips: 20 } })).code, 200, 'before it starts everything can change');
  await db.Incentive.create(mkInc({ incentiveId: 'run' }));
  const locked = await admin(I.update, { params: { id: 'run' }, body: { targetTrips: 99, bonus: 999 } });
  assert.equal(locked.code, 400);
  assert.ok(locked.body.errors.targetTrips && locked.body.errors.bonus);
  assert.equal((await admin(I.update, { params: { id: 'run' }, body: { active: false } })).code, 200, 'but it can be switched off');
});
