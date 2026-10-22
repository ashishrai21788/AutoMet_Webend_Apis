// Tolls: the driver enters one when ending a trip; it is capped, fixed on the trip, paid back by the rider and received by the driver in full.
process.env.JWT_SECRET = 'test-secret-for-tolls';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const tolls = require('../lib/tolls');
const money = require('../lib/driverMoney');
const { earningsFor } = require('../lib/driverEarnings');
const { linesFromTrip, buildInvoiceDocument } = require('../lib/riderInvoice');
const { buildPublicConfig } = require('../lib/publicConfig');
const { updateTripStatus } = require('../controllers/rideController');
const A = require('../controllers/tollsAdminController');
const { clearAppTenantCache } = require('../lib/appTenant');

const on = (maxTollMinor = 30000) => ({ tenantId: 't1', market: { country: 'IN', currency: 'INR' }, tollSettings: { enabled: true, maxTollMinor } });
const off = { tenantId: 't1', market: { country: 'IN', currency: 'INR' } };

test('no toll entered means none, even when tolls are switched off', () => {
  for (const body of [{}, { toll_amount: '' }, { toll_amount: null }, { toll_amount: 0 }, { toll_amount: '0' }]) assert.deepEqual(tolls.parseToll(body, off), { ok: true, minor: 0 }, JSON.stringify(body));
});

test('a toll needs tolls switched on, a real amount, whole paise and to stay within the limit', () => {
  assert.equal(tolls.parseToll({ toll_amount: 60 }, off).ok, false, 'switched off');
  assert.match(tolls.parseToll({ toll_amount: 60 }, off).message, /not enabled/);
  assert.deepEqual(tolls.parseToll({ toll_amount: 60 }, on()), { ok: true, minor: 6000 });
  assert.deepEqual(tolls.parseToll({ toll_amount: '45.50' }, on()), { ok: true, minor: 4550 });
  assert.equal(tolls.parseToll({ toll_amount: 300 }, on()).ok, true, 'exactly the limit is fine');
  assert.equal(tolls.parseToll({ toll_amount: 300.01 }, on()).ok, false, 'over the limit');
  assert.match(tolls.parseToll({ toll_amount: 301 }, on()).message, /not be more than 300/);
  for (const bad of [-5, 'abc', NaN, Infinity, 1.234]) assert.equal(tolls.parseToll({ toll_amount: bad }, on()).ok, false, String(bad));
  assert.equal(tolls.parseToll({ toll_amount: 10 }, on(0)).ok, false, 'switched on with no limit set means no toll can be entered');
});

test('the settings form needs a limit when tolls are on, and stores whole minor units', () => {
  assert.ok(tolls.validateSettings({ enabled: true, maxToll: '' }, off).errors.maxToll);
  assert.ok(tolls.validateSettings({ enabled: true, maxToll: -1 }, off).errors.maxToll);
  assert.deepEqual(tolls.validateSettings({ enabled: false, maxToll: '' }, off), { value: { enabled: false, maxTollMinor: 0 }, errors: {} });
  assert.deepEqual(tolls.validateSettings({ enabled: true, maxToll: '250.50' }, off).value, { enabled: true, maxTollMinor: 25050 });
});

test('the public config tells the driver app whether to ask and the most to accept', () => {
  assert.deepEqual(buildPublicConfig({ tenant: { tenantId: 't1', name: 'x', appName: 'x', market: { country: 'IN', currency: 'INR' } } }).tolls, { enabled: false, maxToll: 0 });
  const c = buildPublicConfig({ tenant: { tenantId: 't1', name: 'x', appName: 'x', ...on(25050) } });
  assert.deepEqual(c.tolls, { enabled: true, maxToll: 250.5 });
});

test('the toll is a line of its own and part of what the rider paid; it carries no tax', () => {
  const trip = { trip_id: 'T', fare: 172, currency: 'INR', toll_minor: 6000, fare_breakdown: { lines: [{ label: 'Base fare', amount: 10 }, { label: 'Distance', amount: 52 }, { label: 'Time', amount: 150 }], fees: [], taxes: [], discount: 40, total: 172 }, coupon: { code: 'X', discount_minor: 4000, funded_by: 'BUSINESS' } };
  const { lines, totalMinor, tollMinor } = linesFromTrip(trip, 2);
  assert.equal(tollMinor, 6000);
  assert.equal(totalMinor, 17200 + 6000);
  assert.deepEqual(lines.map((l) => l.kind), ['RIDE', 'RIDE', 'RIDE', 'DISCOUNT', 'TOLL']);
  assert.equal(lines.reduce((s, l) => s + l.amountMinor, 0), totalMinor, 'the lines add up to the total');
  const inv = buildInvoiceDocument({ trip, tenant: { name: 'u', market: { currency: 'INR' } }, rider: {}, driver: null });
  assert.equal(inv.totalMinor, 23200);
  assert.equal(inv.taxMinor, 0);
  assert.equal(inv.subtotalMinor, 23200);
  assert.equal(linesFromTrip({ ...trip, toll_minor: 0 }, 2).totalMinor, 17200, 'a trip without a toll is unchanged');
});

test('the driver gets the whole toll and the business takes its commission on the fare only', () => {
  const tenant = { market: { currency: 'INR' }, payoutSettings: { commissionPercent: 10 } };
  const trip = { trip_id: 'T', fare: 200, currency: 'INR', payment_mode: 'CASH', toll_minor: 5000, fare_breakdown: { lines: [{ label: 'Ride', amount: 200 }], fees: [], taxes: [] } };
  const e = earningsFor(trip, tenant);
  assert.equal(e.toll, 50);
  assert.equal(e.passenger_fare, 250);
  assert.equal(e.platform_fee, 20, '10% of 200, not of 250');
  assert.equal(e.earnings, 230, '180 from the fare plus the 50 toll');
  assert.ok(e.lines.some((l) => l.kind === 'TOLL' && l.amount === 50));
  const m = money.tripMoney(trip, tenant);
  assert.deepEqual([m.fareMinor, m.feeMinor, m.netMinor], [25000, 2000, 23000]);
});

test('on a cash ride the toll is already in the driver\'s hand; on an online ride it is owed to them', () => {
  const tenant = { market: { currency: 'INR' }, payoutSettings: { commissionPercent: 0 } };
  const mk = (id, mode) => ({ trip_id: id, fare: 200, currency: 'INR', payment_mode: mode, toll_minor: 5000, fare_breakdown: { lines: [{ label: 'Ride', amount: 200 }], fees: [], taxes: [] } });
  const cash = money.totals([mk('C', 'CASH')], tenant);
  const online = money.totals([mk('O', 'UPI')], tenant);
  assert.equal(cash.totalMinor, 25000);
  assert.equal(money.balanceOf(cash, [], money.settingsOf(tenant)).availableMinor, 0, 'cash: nothing is owed');
  assert.equal(online.totalMinor, 25000);
  assert.equal(money.balanceOf(online, [], money.settingsOf(tenant)).availableMinor, 25000, 'online: the toll is part of what is owed');
});

// ---- through the real completion handler ----
let n = 0;
const setup = async (tollSettings) => {
  for (const m of ['Tenant', 'Driver', 'TripDetails', 'RiderInvoice', 'AdminAudit']) db[m].rows.length = 0;
  clearAppTenantCache();
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', appName: 'uRide', isDefault: true, market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }, payoutSettings: { commissionPercent: 10 }, ...(tollSettings ? { tollSettings } : {}) });
  await db.Driver.create({ driverId: 'D1', email: 'd1@t.local', phone: '+919811100000', firstName: 'Ravi', lastName: 'Kumar', tenantId: 't1', accountStatus: 'ACTIVE' });
};
const ongoing = async (extra = {}) => {
  n += 1;
  const t = {
    trip_id: `toll_${n}`, request_id: `REQ_TOLL_${n}`, user_id: 'U1', driver_id: 'D1', status: 'ON_GOING', fare: 172, currency: 'INR', payment_mode: 'CASH', distance_km: 5.2,
    pickup: { address: 'A', lat: 28.57, lng: 77.48 }, drop: { address: 'B', lat: 28.6, lng: 77.5 }, started_at: new Date(Date.now() - 600000), responded_at: new Date(), timeout_at: new Date(),
    fare_breakdown: { lines: [{ label: 'Base fare', amount: 10 }, { label: 'Distance', amount: 52 }, { label: 'Time', amount: 150 }], fees: [], taxes: [], discount: 40, total: 172 },
    coupon: { code: 'WELCOME', coupon_id: 'c1', discount_minor: 4000, funded_by: 'BUSINESS' }, ...extra
  };
  await db.TripDetails.create(t);
  return t;
};
const complete = async (t, body = {}) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await updateTripStatus({ params: { tripId: t.trip_id }, body: { status: 'COMPLETED', driver_id: 'D1', ...body }, authActorId: 'D1', authRole: 'driver' }, res);
  return res;
};
const row = (id) => db.TripDetails.rows.find((r) => r.trip_id === id);

test('ending a trip with a toll fixes it on the trip and the rider pays fare plus toll', async () => {
  await setup({ enabled: true, maxTollMinor: 30000 });
  const t = await ongoing();
  const r = await complete(t, { toll_amount: 60 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.toll, 60);
  assert.equal(r.body.total_paid, 232, '172 fare after the coupon plus 60 toll');
  assert.equal(row(t.trip_id).status, 'COMPLETED');
  assert.equal(row(t.trip_id).toll_minor, 6000);
  assert.equal(row(t.trip_id).fare, 172, 'the metered fare itself is not changed');
  // the driver's earnings were fixed at completion: 10% of the fare before the coupon (212), plus the whole toll
  const snap = row(t.trip_id).driver_earning;
  assert.equal(snap.feeMinor, 2120);
  assert.equal(snap.netMinor, 21200 - 2120 + 6000);
  // and the invoice carries the toll line and the full total
  const inv = db.RiderInvoice.rows.find((i) => i.tripId === t.trip_id);
  assert.ok(inv, 'an invoice was issued');
  assert.equal(inv.totalMinor, 23200);
  assert.ok(inv.lines.some((l) => l.kind === 'TOLL' && l.amountMinor === 6000));
});

test('a trip ended without a toll is exactly as before', async () => {
  await setup({ enabled: true, maxTollMinor: 30000 });
  const t = await ongoing();
  const r = await complete(t, {});
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.toll, undefined);
  assert.equal(row(t.trip_id).toll_minor || 0, 0);
  assert.equal(db.RiderInvoice.rows.find((i) => i.tripId === t.trip_id).totalMinor, 17200);
});

test('a toll above the limit, or with tolls switched off, is refused and the trip stays on', async () => {
  await setup({ enabled: true, maxTollMinor: 30000 });
  const a = await ongoing();
  const tooMuch = await complete(a, { toll_amount: 500 });
  assert.equal(tooMuch.statusCode, 400);
  assert.equal(tooMuch.body.error, 'TOLL_INVALID');
  assert.equal(row(a.trip_id).status, 'ON_GOING', 'nothing was changed');
  const ok = await complete(a, { toll_amount: 100 });
  assert.equal(ok.statusCode, 200, 'the driver can correct the amount and finish');

  await setup(null);
  const b = await ongoing();
  const disabled = await complete(b, { toll_amount: 20 });
  assert.equal(disabled.statusCode, 400);
  assert.match(disabled.body.message, /not enabled/);
  assert.equal(row(b.trip_id).status, 'ON_GOING');
});

test('the dashboard saves the toll settings, refuses an empty limit and records who changed it', async () => {
  await setup(null);
  const call = async (fn, body) => {
    const business = await db.Tenant.findOne({ tenantId: 't1' }).lean();
    const req = { body, params: {}, query: {}, ip: '1.1.1.1', business, data: { update: (M, f, v) => M.findOneAndUpdate({ tenantId: 't1' }, { $set: v }, { new: true }) }, admin: { adminId: 'A1', email: 'a@t.local', role: 'client_admin' } };
    let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
    await fn(req, res); return out;
  };
  assert.equal((await call(A.update, { enabled: true, maxToll: '' })).code, 400);
  assert.equal(db.AdminAudit.rows.length, 0);
  const ok = await call(A.update, { enabled: true, maxToll: 250 });
  assert.equal(ok.code, 200, JSON.stringify(ok.body).slice(0, 200));
  assert.deepEqual(ok.body.data, { enabled: true, maxToll: 250, currency: 'INR' });
  assert.equal(db.Tenant.rows[0].tollSettings.maxTollMinor, 25000);
  assert.equal(db.AdminAudit.rows[0].action, 'business.toll_settings_updated');
  assert.deepEqual((await call(A.get)).body.data, { enabled: true, maxToll: 250, currency: 'INR' });
});

test('every invoice line kind the code produces is one the stored invoice accepts', () => {
  // the in-memory test database does not check enums, so check the real model's list directly
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '../models/riderInvoiceModel.js'), 'utf8');
  const allowed = (src.match(/kind: \{[^}]*enum: \[([^\]]*)\]/) || [])[1] || '';
  const trip = { trip_id: 'T', fare: 172, currency: 'INR', toll_minor: 6000, fare_breakdown: { lines: [{ label: 'Base', amount: 10 }, { label: 'Dist', amount: 52 }, { label: 'Time', amount: 150 }], fees: [{ label: 'Fee', amount: 5 }], taxes: [{ label: 'GST', amount: 9 }] }, coupon: { code: 'X', discount_minor: 4000 } };
  const kinds = new Set(linesFromTrip(trip, 2).lines.map((l) => l.kind));
  kinds.add('CANCELLATION');
  for (const k of kinds) assert.ok(allowed.includes(`'${k}'`), `the invoice model must allow line kind ${k}`);
});

test('the rider trip list carries what was paid in all, so the list agrees with the receipt', async () => {
  await setup({ enabled: true, maxToll: 300 });
  const { listTrips } = require('../controllers/rideController');
  await db.TripDetails.create({ trip_id: 'L1', request_id: 'RL1', user_id: 'U1', driver_id: 'D1', status: 'COMPLETED', fare: 172, currency: 'INR', toll_minor: 6000, pickup: { address: 'A' }, drop: { address: 'B' }, requested_at: new Date() });
  await db.TripDetails.create({ trip_id: 'L2', request_id: 'RL2', user_id: 'U1', driver_id: 'D1', status: 'COMPLETED', fare: 100, currency: 'INR', pickup: { address: 'A' }, drop: { address: 'B' }, requested_at: new Date(Date.now() - 1000) });
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = b; return this; } };
  await listTrips({ query: { user_id: 'U1' } }, res);
  const row = (id) => out.data.find((t) => t.trip_id === id);
  assert.equal(row('L1').total_paid, 232);
  assert.equal(row('L1').toll, 60);
  assert.equal(row('L1').fare, 172, 'the fare itself is unchanged');
  assert.equal(row('L2').total_paid, 100, 'no toll, same as the fare');
});

test('a cash ride with a business-funded coupon: the rider pays less than the fare the driver is paid on, and the driver screens can say so', () => {
  const tenant = { market: { currency: 'INR' }, payoutSettings: { commissionPercent: 0 } };
  const trip = { trip_id: 'T', fare: 182, currency: 'INR', payment_mode: 'CASH', toll_minor: 7500, coupon: { code: 'SAVE30', discount_minor: 3000, funded_by: 'BUSINESS' }, fare_breakdown: { lines: [{ label: 'Base', amount: 10 }, { label: 'Dist', amount: 52 }, { label: 'Time', amount: 150 }], fees: [], taxes: [] } };
  const e = earningsFor(trip, tenant);
  assert.equal(e.rider_paid, 257, 'what the rider hands over: fare after the coupon plus the toll');
  assert.equal(e.coupon_discount_funded, 30);
  assert.equal(e.passenger_fare, 287, 'the driver is paid on the fare before the coupon, plus the toll');
  assert.equal(e.earnings, 287);
  assert.equal(e.passenger_fare - e.coupon_discount_funded, e.rider_paid, 'the figures agree');
});

test('the offer sent to the driver says how much of a coupon the business pays on top of the fare', () => {
  const { couponCoveredMajor } = require('../lib/driverEarnings');
  assert.equal(couponCoveredMajor({ currency: 'INR', coupon: { discount_minor: 3000, funded_by: 'BUSINESS' } }), 30);
  assert.equal(couponCoveredMajor({ currency: 'INR', coupon: { discount_minor: 3000 } }), 30, 'business-funded is the default');
  assert.equal(couponCoveredMajor({ currency: 'INR', coupon: { discount_minor: 3000, funded_by: 'DRIVER' } }), 0, 'a driver-funded coupon is not paid by the business');
  assert.equal(couponCoveredMajor({ currency: 'INR' }), 0);
  assert.equal(couponCoveredMajor({ currency: 'INR', coupon: { discount_minor: 0 } }), 0);
});
