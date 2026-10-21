// Coupons: the rules, the atomic limits, giving uses back, the fare they produce, what the driver earns, and the admin's side.
process.env.JWT_SECRET = 'test-secret-for-coupons';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const coupons = require('../lib/coupons');
const { priceTripWithCoupon } = require('../lib/tripPricing');
const { validateFareRuleInput } = require('../lib/fareRules');
const { earningsFor } = require('../lib/driverEarnings');
const { linesFromTrip } = require('../lib/riderInvoice');
const A = require('../controllers/couponsAdminController');

const NOW = Date.now();
const DAY = 24 * 3600 * 1000;
const PUNE = { lat: 18.5204, lng: 73.8567 };
const DROP = { lat: 18.5604, lng: 73.9067 };
const tenant = { tenantId: 't1', market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } };
const rule = validateFareRuleInput({ baseFare: 40, perKm: 12, perMinute: 1, minimumFare: 70, bookingFee: 5, waitingFreeMinutes: 3, waitingPerMinute: 2, additionalCharges: [], taxes: [{ name: 'GST', ratePercent: 5, appliesTo: 'fare' }], surge: { enabled: false } }).value;
const config = {
  market: tenant.market, regions: [], categories: [{ categoryId: 'c1', name: 'VIP', active: true, regionIds: [] }],
  fareRules: [{ active: true, categoryId: 'c1', regionId: null, currency: 'INR', ...rule }]
};
const trip = { pickup: PUNE, drop: DROP, categoryId: 'c1' };

const mk = (extra = {}) => ({
  tenantId: 't1', couponId: 'cp' + Math.random().toString(16).slice(2, 8), code: 'SAVE10', type: 'PERCENT', value: 10, maxDiscountMinor: 0, minFareMinor: 0, currency: 'INR',
  startsAt: new Date(NOW - DAY), endsAt: new Date(NOW + DAY), totalLimit: 0, perUserLimit: 1, categoryIds: [], regionIds: [], newUsersOnly: false, fundedBy: 'BUSINESS', active: true, redeemed: 0, ...extra
});
const reset = () => { for (const m of ['Coupon', 'CouponUse', 'CouponRedemption', 'TripDetails', 'VehicleCategory', 'ServiceRegion', 'AdminAudit', 'Tenant']) db[m].rows.length = 0; coupons.reset && coupons.reset(); };

test('evaluate: every rule that can refuse a coupon, and the discount it gives', () => {
  const ok = { grossMinor: 10000, categoryId: 'c1', regionId: 'r1', completedRides: 0 };
  assert.equal(coupons.evaluate(mk(), ok).discountMinor, 1000, '10% of 100.00');
  assert.equal(coupons.evaluate(mk({ maxDiscountMinor: 500 }), ok).discountMinor, 500, 'capped');
  assert.equal(coupons.evaluate(mk({ type: 'FIXED', value: 3000 }), ok).discountMinor, 3000);
  assert.equal(coupons.evaluate(mk({ type: 'FIXED', value: 99999 }), ok).discountMinor, 10000, 'never takes the total below zero');
  assert.equal(coupons.evaluate(mk({ active: false }), ok).code, 'INACTIVE');
  assert.equal(coupons.evaluate(mk({ startsAt: new Date(NOW + DAY) }), ok).code, 'NOT_STARTED');
  assert.equal(coupons.evaluate(mk({ endsAt: new Date(NOW - 1000) }), ok).code, 'EXPIRED');
  assert.equal(coupons.evaluate(mk({ categoryIds: ['cX'] }), ok).code, 'CATEGORY');
  assert.equal(coupons.evaluate(mk({ regionIds: ['rX'] }), ok).code, 'REGION');
  assert.equal(coupons.evaluate(mk({ minFareMinor: 20000 }), ok).code, 'MIN_FARE');
  assert.equal(coupons.evaluate(mk({ newUsersOnly: true }), { ...ok, completedRides: 1 }).code, 'NEW_USERS');
  assert.equal(coupons.evaluate(mk({ totalLimit: 5, redeemed: 5 }), ok).code, 'TOTAL_LIMIT');
  assert.equal(coupons.evaluate(null, ok).code, 'NOT_FOUND');
});

test('the fare: the server works the discount out from the ride total, and the estimate, the stored breakdown and the invoice agree', async () => {
  reset();
  await db.Coupon.create(mk({ code: 'SAVE10' }));
  const plain = await priceTripWithCoupon(config, trip, { tenant, userId: 'U1', code: '' });
  const withCoupon = await priceTripWithCoupon(config, trip, { tenant, userId: 'U1', code: 'save10' });
  assert.equal(withCoupon.coupon.applied, true, 'the code is case-insensitive');
  const gross = plain.estimate.breakdown.total;
  assert.equal(withCoupon.coupon.discount, Math.round(gross * 10) / 100, '10% of the total before the discount');
  assert.equal(withCoupon.estimate.fare, Math.round((gross - withCoupon.coupon.discount) * 100) / 100);
  assert.equal(withCoupon.estimate.breakdown.discount, withCoupon.coupon.discount);
  // the invoice names the coupon on the discount line
  const lines = linesFromTrip({ fare: withCoupon.estimate.fare, fare_breakdown: withCoupon.estimate.breakdown, coupon: { code: 'SAVE10' } }, 2).lines;
  assert.ok(lines.some((l) => l.kind === 'DISCOUNT' && /SAVE10/.test(l.label)), 'a discount line with the code');
  assert.equal(lines.reduce((s, l) => s + l.amountMinor, 0), Math.round(withCoupon.estimate.fare * 100), 'the lines add up to what the rider pays');
  // a bad code never silently charges the full fare as if it had worked
  const bad = await priceTripWithCoupon(config, trip, { tenant, userId: 'U1', code: 'NOPE' });
  assert.equal(bad.coupon.applied, false);
  assert.equal(bad.estimate.fare, plain.estimate.fare);
});

test('limits are atomic: the last use goes to one booking, and a rider cannot use a one-per-rider coupon twice', async () => {
  reset();
  const c = await db.Coupon.create(mk({ code: 'ONCE', totalLimit: 2, perUserLimit: 1 }));
  const take = (userId, tripId) => coupons.reserve({ tenantId: 't1', coupon: c, userId, tripId, discountMinor: 100, currency: 'INR' });
  assert.equal((await take('U1', 'T1')).ok, true);
  const again = await take('U1', 'T2');
  assert.equal(again.ok, false); assert.equal(again.code, 'USER_LIMIT');
  assert.equal(db.Coupon.rows[0].redeemed, 1, 'the failed second use gave its slot back');
  // two riders race for the last use
  const [a, b] = await Promise.all([take('U2', 'T3'), take('U3', 'T4')]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, 'exactly one wins');
  assert.equal(db.Coupon.rows[0].redeemed, 2);
  assert.equal(db.CouponRedemption.rows.length, 2);
});

test('a cancelled, rejected or unanswered booking gives the use back; a completed one stays used', async () => {
  reset();
  const c = await db.Coupon.create(mk({ code: 'GIVE', totalLimit: 1, perUserLimit: 1 }));
  assert.equal((await coupons.reserve({ tenantId: 't1', coupon: c, userId: 'U1', tripId: 'G1', discountMinor: 100 })).ok, true);
  await db.TripDetails.create({ trip_id: 'G1', request_id: 'RG1', user_id: 'U1', driver_id: 'D', status: 'REQUESTED', pickup: { address: 'a' }, drop: { address: 'b' } });
  let r = await coupons.check({ tenantId: 't1', code: 'GIVE', userId: 'U2', grossMinor: 10000, categoryId: 'c1' });
  assert.equal(r.code, 'TOTAL_LIMIT', 'held while the booking is live');
  db.TripDetails.rows[0].status = 'CANCELLED_BY_USER';
  r = await coupons.check({ tenantId: 't1', code: 'GIVE', userId: 'U2', grossMinor: 10000, categoryId: 'c1' });
  assert.equal(r.ok, true, 'the cancelled booking gave its use back');
  assert.equal(db.Coupon.rows[0].redeemed, 0);
  assert.equal(db.CouponRedemption.rows[0].state, 'RELEASED');
  assert.equal(db.CouponUse.rows[0].count, 0, 'and the rider can use it again');
  // a completed ride keeps it
  assert.equal((await coupons.reserve({ tenantId: 't1', coupon: db.Coupon.rows[0], userId: 'U2', tripId: 'G2', discountMinor: 100 })).ok, true);
  await db.TripDetails.create({ trip_id: 'G2', request_id: 'RG2', user_id: 'U2', driver_id: 'D', status: 'COMPLETED', pickup: { address: 'a' }, drop: { address: 'b' } });
  await coupons.reconcile('t1', { couponId: db.Coupon.rows[0].couponId });
  assert.equal(db.CouponRedemption.rows.find((x) => x.tripId === 'G2').state, 'REDEEMED');
  assert.equal(db.Coupon.rows[0].redeemed, 1);
});

test('new-user coupons refuse a rider with a completed ride', async () => {
  reset();
  await db.Coupon.create(mk({ code: 'WELCOME', newUsersOnly: true }));
  await db.TripDetails.create({ trip_id: 'W1', request_id: 'RW1', user_id: 'U9', driver_id: 'D', status: 'COMPLETED', pickup: { address: 'a' }, drop: { address: 'b' } });
  assert.equal((await coupons.check({ tenantId: 't1', code: 'WELCOME', userId: 'U9', grossMinor: 10000, categoryId: 'c1' })).code, 'NEW_USERS');
  assert.equal((await coupons.check({ tenantId: 't1', code: 'WELCOME', userId: 'U10', grossMinor: 10000, categoryId: 'c1' })).ok, true);
});

test('driver earnings: a business-funded coupon does not reduce the driver, a driver-funded one does', () => {
  const t = { ...tenant, payoutSettings: { commissionPercent: 10 } };
  const base = { fare: 90, currency: 'INR', fare_breakdown: { lines: [{ label: 'Base', amount: 100 }], fees: [], taxes: [], total: 100 } };
  const funded = earningsFor({ ...base, coupon: { discount_minor: 1000, funded_by: 'BUSINESS' } }, t);
  assert.equal(funded.passenger_fare, 100, 'earned on the fare before the discount');
  assert.equal(funded.rider_paid, 90);
  assert.equal(funded.earnings, 90, '100 less 10%');
  const own = earningsFor({ ...base, coupon: { discount_minor: 1000, funded_by: 'DRIVER' } }, t);
  assert.equal(own.passenger_fare, 90);
  assert.equal(own.earnings, 81, '90 less 10%');
  const none = earningsFor({ ...base, fare: 100 }, t);
  assert.equal(none.earnings, 90);
});

test('driver balance: on a cash ride the business owes the driver the discount the passenger did not pay', () => {
  const money = require('../lib/driverMoney');
  const t = { ...tenant, payoutSettings: { commissionPercent: 10 } };
  const cashTrip = { trip_id: 'X', fare: 90, currency: 'INR', payment_mode: 'CASH', fare_breakdown: { lines: [{ label: 'Base', amount: 100 }], fees: [], taxes: [], total: 100 }, coupon: { discount_minor: 1000, funded_by: 'BUSINESS' } };
  const life = money.totals([cashTrip], t);
  assert.equal(life.netMinor, 9000);
  assert.equal(life.cashDiscountMinor, 1000);
  const bal = money.balanceOf(life, [], money.settingsOf(t));
  assert.equal(bal.availableMinor, 0, 'the driver holds 90 in cash; owes 10 to the business; is owed 10 for the discount: nothing to pay out');
  const life2 = money.totals([{ ...cashTrip, coupon: { discount_minor: 2000, funded_by: 'BUSINESS' }, fare_breakdown: { lines: [{ label: 'Base', amount: 100 }], fees: [], taxes: [], total: 100 }, fare: 80 }], t);
  assert.equal(money.balanceOf(life2, [], money.settingsOf(t)).availableMinor, 1000, 'a 20 discount: owed 20, less the 10 fee');
});

const admin = async (fn, { body = {}, params = {}, query = {} } = {}) => {
  const req = {
    body, params, query, ip: '1.1.1.1', business: { ...tenant, name: 'uRide' }, admin: { adminId: 'A1', email: 'a@t.local', role: 'client_admin' },
    data: { find: (M) => M.find({}) }
  };
  let out;
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};

test('admin: create validates, codes are unique per business, and a used coupon keeps its promised discount', async () => {
  reset();
  await db.VehicleCategory.create({ tenantId: 't1', categoryId: 'c1', name: 'VIP', nameKey: 'vip', passengerCapacity: 4, rideType: 'economy', regionIds: [], active: true });
  const bad = await admin(A.create, { body: { code: 'x', type: 'PERCENT', value: 150, startsAt: 'no', endsAt: 'no' } });
  assert.equal(bad.code, 400);
  assert.ok(bad.body.errors.code && bad.body.errors.value && bad.body.errors.startsAt);
  const good = { code: ' summer 20 '.trim().replace(' ', ''), type: 'PERCENT', value: 20, maxDiscount: 50, minFare: 100, totalLimit: 100, perUserLimit: 2, categoryIds: ['c1'], startsAt: new Date(NOW - DAY).toISOString(), endsAt: new Date(NOW + 7 * DAY).toISOString() };
  const made = await admin(A.create, { body: good });
  assert.equal(made.code, 200, JSON.stringify(made.body).slice(0, 200));
  assert.equal(made.body.data.maxDiscount, 50);
  assert.equal(made.body.data.state, 'LIVE');
  assert.equal((await admin(A.create, { body: good })).code, 409, 'the same code twice');
  assert.equal((await admin(A.create, { body: { ...good, code: 'OTHER', categoryIds: ['nope'] } })).code, 400, 'only the business\'s own categories');
  const id = made.body.data.id;
  assert.equal((await admin(A.update, { params: { id }, body: { value: 30 } })).code, 200, 'unused: anything can change');
  db.Coupon.rows[0].redeemed = 3;
  const locked = await admin(A.update, { params: { id }, body: { value: 50, totalLimit: 2 } });
  assert.equal(locked.code, 400);
  assert.ok(locked.body.errors.value && locked.body.errors.totalLimit);
  assert.equal((await admin(A.update, { params: { id }, body: { active: false } })).body.data.state, 'OFF', 'but it can be switched off');
  const list = await admin(A.list, { query: { q: 'summer' } });
  assert.equal(list.body.data.total, 1);
  assert.ok(db.AdminAudit.rows.some((r) => r.action === 'coupon.created'));
});
