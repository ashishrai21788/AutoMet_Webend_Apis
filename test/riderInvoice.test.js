// Rider invoices: issued once per trip, named for the business, with the trip and fare broken down and adding up.
process.env.JWT_SECRET = 'test-secret-for-rider-invoice-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
const rides = require('../controllers/rideController');
const { financialYear, buildInvoiceDocument } = require('../lib/riderInvoice');
const { renderRiderInvoice } = require('../lib/riderInvoicePdf');

const call = async (handler, req) => {
  const res = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(h) { Object.assign(this.headers, h); return this; }, send(b) { this.body = b; return this; }, setHeader() {} };
  await handler(req, res);
  return res;
};
const asRider = (userId, tripId) => ({ authRole: 'user', authActorId: userId, params: { tripId } });

const BREAKDOWN = { lines: [{ label: 'Base fare', amount: 10 }, { label: 'Distance (16.4 km)', amount: 164 }, { label: 'Time (45 min)', amount: 450 }], fare: 624, fees: [], feesTotal: 0, taxes: [], taxesTotal: 0, total: 624 };

test.before(async () => {
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha Cabs', slug: 'alpha', appName: 'Alpha', packageName: 'com.alpha', status: 'active', plan: 'standard', supportEmail: 'help@alpha.test', supportPhone: '+911234567890', market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }, billingDetails: { legalName: 'Alpha Mobility Pvt Ltd', gstin: '27AAAAA0000A1Z5', address: '1 Main Road, Pune', stateCode: '27' } });
  await db.Tenant.create({ tenantId: 'app_b', name: 'Beta Rides', slug: 'beta', appName: 'Beta', packageName: 'com.beta', status: 'active', plan: 'standard', market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } });
  await db.User.create({ userId: 'U1', tenantId: 'app_a', firstName: 'Ashish', lastName: 'Rai', phone: '+919876543210' });
  await db.User.create({ userId: 'U2', tenantId: 'app_a', firstName: 'Other', lastName: 'Rider', phone: '+919800000002' });
  await db.User.create({ userId: 'U3', tenantId: 'app_b', firstName: 'Beta', lastName: 'Rider', phone: '+919800000003' });
  await db.Driver.create({ driverId: 'D1', tenantId: 'app_a', firstName: 'Test', lastName: 'Onboarding', email: 'd1@x.test', phone: '+919876500001' });
  await db.VehicleCategory.create({ tenantId: 'app_a', categoryId: 'vc1', name: 'VIP', nameKey: 'vip' });
  await db.Vehicle.create({ tenantId: 'app_a', vehicleId: 'veh1', registrationNumber: 'UP16TS4321', registrationKey: 'UP16TS4321', make: 'Maruti', model: 'Dzire', colour: 'White' });
  await db.DriverVehicleAssignment.create({ tenantId: 'app_a', assignmentId: 'as1', driverId: 'D1', vehicleId: 'veh1', active: true });
});

const trip = (id, extra = {}) => db.TripDetails.create({
  trip_id: id, request_id: 'R_' + id, user_id: 'U1', driver_id: 'D1', tenant_id: 'app_a', category_id: 'vc1', status: 'COMPLETED',
  pickup: { address: 'Vaidpura, Greater Noida', lat: 1, lng: 1 }, drop: { address: 'Noida City Centre', lat: 2, lng: 2 }, timeout_at: new Date(),
  requested_at: new Date('2026-10-16T10:00:00Z'), started_at: new Date('2026-10-16T10:10:00Z'), completed_at: new Date('2026-10-16T10:55:00Z'),
  fare: 624, currency: 'INR', distance_km: 16.4, estimated_duration_min: 45, payment_mode: 'CASH', fare_breakdown: BREAKDOWN, ...extra
});

test('a completed trip gets an invoice named for the business, with the trip and the fare broken down', async () => {
  await trip('t1');
  const r = await call(rides.getTripInvoice, asRider('U1', 't1'));
  assert.equal(r.statusCode, 200);
  const inv = r.body.data;
  assert.equal(inv.business.name, 'Alpha Cabs');
  assert.equal(inv.business.legalName, 'Alpha Mobility Pvt Ltd');
  assert.equal(inv.business.gstin, '27AAAAA0000A1Z5');
  assert.equal(inv.business.supportEmail, 'help@alpha.test');
  assert.match(inv.invoiceNumber, /^INV-\d{4}-000001$/);
  assert.equal(inv.type, 'TRIP');
  assert.equal(inv.tripId, 't1');
  assert.equal(inv.rider.name, 'Ashish Rai');
  assert.equal(inv.rider.phoneMasked, '********3210', 'the phone is masked');
  assert.equal(inv.driver.name, 'Test Onboarding');
  assert.equal(inv.driver.vehicleNumber, 'UP16TS4321');
  assert.equal(inv.driver.vehicleModel, 'Maruti Dzire');
  assert.equal(inv.trip.rideType, 'VIP');
  assert.equal(inv.trip.pickup, 'Vaidpura, Greater Noida');
  assert.equal(inv.trip.distanceKm, 16.4);
  assert.equal(inv.trip.durationMin, 45, 'the real time between start and finish');
  assert.deepEqual(inv.lines.map((l) => [l.label, l.amountMinor]), [['Base fare', 1000], ['Distance (16.4 km)', 16400], ['Time (45 min)', 45000]]);
  assert.equal(inv.totalMinor, 62400);
  assert.equal(inv.lines.reduce((s, l) => s + l.amountMinor, 0), inv.totalMinor, 'the lines add up to the total');
  assert.equal(inv.tenantId, undefined, 'no internal fields leak');
});

test('asking again returns the same invoice, even when several asks race: one invoice per trip, numbers never repeat', async () => {
  const first = (await call(rides.getTripInvoice, asRider('U1', 't1'))).body.data;
  const again = (await call(rides.getTripInvoice, asRider('U1', 't1'))).body.data;
  assert.equal(again.invoiceNumber, first.invoiceNumber);
  assert.equal(again.invoiceId, first.invoiceId);

  await trip('t2');
  const raced = await Promise.all([1, 2, 3, 4, 5].map(() => call(rides.getTripInvoice, asRider('U1', 't2'))));
  assert.ok(raced.every((r) => r.statusCode === 200));
  assert.equal(new Set(raced.map((r) => r.body.data.invoiceNumber)).size, 1, 'five simultaneous asks, one invoice');
  assert.equal(db.RiderInvoice.rows.filter((i) => i.tripId === 't2').length, 1);
  const numbers = db.RiderInvoice.rows.filter((i) => i.tenantId === 'app_a').map((i) => i.invoiceNumber);
  assert.equal(new Set(numbers).size, numbers.length, 'no number is used twice');
});

test('numbers are per business, and an invoice never changes when the business is edited later', async () => {
  await db.Driver.create({ driverId: 'D3', tenantId: 'app_b', firstName: 'Beta', lastName: 'Driver', email: 'd3@x.test', phone: '+919800000009' });
  await trip('tb1', { user_id: 'U3', driver_id: 'D3', tenant_id: 'app_b', category_id: undefined });
  const b = (await call(rides.getTripInvoice, asRider('U3', 'tb1'))).body.data;
  assert.match(b.invoiceNumber, /-000001$/, 'business B starts its own sequence');
  assert.equal(b.business.name, 'Beta Rides');

  const before = (await call(rides.getTripInvoice, asRider('U1', 't1'))).body.data;
  await db.Tenant.findOneAndUpdate({ tenantId: 'app_a' }, { $set: { name: 'Alpha Renamed', billingDetails: { legalName: 'Someone Else', gstin: '' } } });
  require('../lib/appTenant').clearAppTenantCache();
  await db.Vehicle.findOneAndUpdate({ vehicleId: 'veh1' }, { $set: { registrationNumber: 'ZZ00ZZ0000' } });
  const after = (await call(rides.getTripInvoice, asRider('U1', 't1'))).body.data;
  assert.equal(after.business.name, 'Alpha Cabs');
  assert.equal(after.business.legalName, 'Alpha Mobility Pvt Ltd');
  assert.equal(after.driver.vehicleNumber, 'UP16TS4321');
  assert.deepEqual(after, before, 'byte for byte the same');
});

test('only the rider of the trip can read it; unfinished and unknown trips have none', async () => {
  assert.equal((await call(rides.getTripInvoice, asRider('U2', 't1'))).statusCode, 403, 'another rider');
  assert.equal((await call(rides.getTripInvoice, { authRole: 'driver', authActorId: 'D1', params: { tripId: 't1' } })).statusCode, 403, 'the driver');
  assert.equal((await call(rides.getTripInvoice, { params: { tripId: 't1' } })).statusCode, 403, 'nobody signed in');
  assert.equal((await call(rides.getTripInvoice, asRider('U1', 'nope'))).statusCode, 404);
  await trip('t_live', { status: 'ON_GOING', completed_at: null });
  assert.equal((await call(rides.getTripInvoice, asRider('U1', 't_live'))).statusCode, 404, 'a ride in progress has no invoice yet');
  await trip('t_cancel_free', { status: 'CANCELLED_BY_USER', cancellation_fee: 0, fare: null, fare_breakdown: null });
  assert.equal((await call(rides.getTripInvoice, asRider('U1', 't_cancel_free'))).statusCode, 404, 'a free cancellation has nothing to invoice');
});

test('a cancellation charge gets its own invoice for exactly that charge', async () => {
  await trip('t_cancel_fee', { status: 'CANCELLED_BY_USER_AFTER_ACCEPTANCE', cancellation_fee: 30, cancelled_by: 'USER', fare: 624, fare_breakdown: BREAKDOWN, started_at: null, completed_at: null, cancelled_at: new Date('2026-10-16T11:00:00Z') });
  const inv = (await call(rides.getTripInvoice, asRider('U1', 't_cancel_fee'))).body.data;
  assert.equal(inv.type, 'CANCELLATION');
  assert.deepEqual(inv.lines.map((l) => [l.label, l.amountMinor]), [['Cancellation charge', 3000]]);
  assert.equal(inv.totalMinor, 3000, 'not the fare of the ride that never happened');
});

test('lines always add up to the fare charged: fees and taxes are listed, a discount is shown, a broken breakdown falls back to one line', async () => {
  const taxed = { lines: [{ label: 'Ride', amount: 200 }], fees: [{ label: 'Booking fee', amount: 20 }], taxes: [{ label: 'GST 5%', amount: 11 }], total: 231 };
  await trip('t_tax', { fare: 231, fare_breakdown: taxed });
  const t = (await call(rides.getTripInvoice, asRider('U1', 't_tax'))).body.data;
  assert.deepEqual(t.lines.map((l) => [l.kind, l.amountMinor]), [['RIDE', 20000], ['FEE', 2000], ['TAX', 1100]]);
  assert.equal(t.taxMinor, 1100);
  assert.equal(t.subtotalMinor, 22000);
  assert.equal(t.totalMinor, 23100);

  await trip('t_disc', { fare: 180, fare_breakdown: { lines: [{ label: 'Ride', amount: 200 }], fees: [], taxes: [], total: 200 } });
  const d = (await call(rides.getTripInvoice, asRider('U1', 't_disc'))).body.data;
  assert.deepEqual(d.lines.map((l) => [l.kind, l.amountMinor]), [['RIDE', 20000], ['DISCOUNT', -2000]]);
  assert.equal(d.totalMinor, 18000);

  await trip('t_old', { fare: 150, fare_breakdown: null });
  const o = (await call(rides.getTripInvoice, asRider('U1', 't_old'))).body.data;
  assert.deepEqual(o.lines.map((l) => [l.label, l.amountMinor]), [['Ride fare', 15000]]);

  await trip('t_bad', { fare: 100, fare_breakdown: { lines: [{ label: 'Ride', amount: 50 }], total: 50 } });
  const bad = (await call(rides.getTripInvoice, asRider('U1', 't_bad'))).body.data;
  assert.deepEqual(bad.lines.map((l) => l.amountMinor), [10000], 'never prints lines that do not add up to what was charged');
});

test('the PDF is a real PDF carrying the invoice, and only the rider can download it', async () => {
  const r = await call(rides.getTripInvoicePdf, asRider('U1', 't1'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['Content-Type'], 'application/pdf');
  assert.match(r.headers['Content-Disposition'], /INV-\d{4}-000001\.pdf/);
  assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
  assert.ok(r.body.length > 1500);
  assert.equal((await call(rides.getTripInvoicePdf, asRider('U2', 't1'))).statusCode, 403);

  const inv = (await call(rides.getTripInvoice, asRider('U1', 't1'))).body.data;
  const plain = await renderRiderInvoice(inv, { compress: false });
  // pdfkit writes each word as hex-encoded glyph codes in the page stream: decode them to read the page back
  const text = [...plain.toString('latin1').matchAll(/<([0-9a-f]+)>/gi)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
  for (const needle of ['Alpha Cabs', 'INVOICE', 'Vaidpura', 'Base fare', 'Total', 'Rs.']) assert.ok(text.includes(needle), `the PDF shows ${needle}`);
});

test('the financial year runs April to March', () => {
  assert.equal(financialYear('2026-04-01T00:00:00Z'), '2627');
  assert.equal(financialYear('2027-03-31T23:00:00Z'), '2627');
  assert.equal(financialYear('2027-04-01T00:00:00Z'), '2728');
  assert.equal(financialYear('2026-01-15T00:00:00Z'), '2526');
});

test('the builder is pure: the same inputs give the same invoice', () => {
  const tenant = { tenantId: 'app_a', name: 'Alpha Cabs', market: { currency: 'INR' } };
  const args = { trip: { trip_id: 'x', user_id: 'U', fare: 100, currency: 'INR', fare_breakdown: null, pickup: { address: 'A' }, drop: { address: 'B' } }, tenant, rider: { firstName: 'A', phone: '+919999999999' }, issuedAt: new Date('2026-10-16') };
  assert.deepEqual(buildInvoiceDocument(args), buildInvoiceDocument(args));
});

test('analytics stay open for the apps but bounded: too many events or too large a batch is refused', async () => {
  const { analyticsGuard, MAX_EVENTS_PER_REQUEST } = require('../lib/analyticsGuard');
  const guard = analyticsGuard('test')[1];
  const run = (body) => { let out = null; const res = { status(c) { out = { code: c }; return this; }, json(b) { out.body = b; return this; } }; let passed = false; guard({ body }, res, () => { passed = true; }); return { passed, out }; };
  assert.equal(run({ events: Array.from({ length: 20 }, () => ({ eventName: 'x' })) }).passed, true, 'an ordinary batch goes through');
  const many = run({ events: Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, () => ({ eventName: 'x' })) });
  assert.equal(many.passed, false);
  assert.equal(many.out.code, 413);
  const big = run({ events: [{ eventName: 'x', blob: 'a'.repeat(300 * 1024) }] });
  assert.equal(big.out.code, 413);
});

test('the invoice carries the same driver and vehicle details as the ride details screen', () => {
  const { buildInvoiceDocument } = require('../lib/riderInvoice');
  const d = buildInvoiceDocument({
    trip: { trip_id: 'T1', user_id: 'u1', fare: 50, currency: 'INR' }, tenant: { name: 'Biz' }, rider: { firstName: 'A' },
    driver: { firstName: 'Ravi', rating: 4.84, seatingCapacity: 3, fuleType: 'CNG', vehicleColor: 'Green', vehicleNumber: 'DL1' }
  });
  assert.equal(d.driver.rating, 4.8);
  assert.equal(d.driver.seats, 3);
  assert.equal(d.driver.fuelType, 'CNG');
  assert.equal(d.driver.vehicleColour, 'Green');
  assert.equal(d.trip.status, 'COMPLETED');
});
