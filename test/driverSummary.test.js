// The driver's own summary for the app's Home and Profile. In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-driver-summary';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const onboarding = require('../controllers/driverOnboardingController');
const { summary, startOfDay } = require('../controllers/driverSummaryController');

const call = async (driverId = 'D1') => {
  const req = { authActorId: driverId, body: {}, params: {}, headers: {}, ip: '127.0.0.1' };
  let out;
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  let ok = false;
  await onboarding.driverContext(req, res, () => { ok = true; });
  if (!ok) return out;
  await summary(req, res);
  return out;
};

const NOW = Date.now();
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000);
const iso = (d) => d.toISOString().slice(0, 10);
const trip = (id, status, extra = {}) => ({
  trip_id: id, request_id: 'R' + id, user_id: 'U1', driver_id: 'D1', status, fare: 100, requested_at: hoursAgo(2),
  pickup: { address: 'A' }, drop: { address: 'B' }, ...extra
});

const seed = async () => {
  for (const m of ['Tenant', 'ServiceRegion', 'VehicleCategory', 'Driver', 'Vehicle', 'DriverVehicleAssignment', 'DriverDocument', 'VehicleDocument', 'TripDetails']) db[m].rows.length = 0;
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', isDefault: true, market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } });
  await db.ServiceRegion.create({ tenantId: 't1', regionId: 'rg1', country: 'IN', state: 'UP', city: 'Noida', zoneName: 'All', key: 'k', active: true });
  await db.VehicleCategory.create({ tenantId: 't1', categoryId: 'c1', name: 'VIP', nameKey: 'vip', passengerCapacity: 4, rideType: 'economy', regionIds: ['rg1'], active: true });
  await db.Driver.create({ driverId: 'D1', email: 'd1@t.local', phone: '+919811100000', firstName: 'Ravi', tenantId: 't1', accountStatus: 'ACTIVE', operatingRegionId: 'rg1', eligibleCategoryId: 'c1', rating: 4.6, totalRides: 12 });
  await db.Vehicle.create({ tenantId: 't1', vehicleId: 'v1', registrationNumber: 'UP16 AB 1234', make: 'Maruti', model: 'Dzire', categoryId: 'c1', passengerCapacity: 4, status: 'ACTIVE', verificationStatus: 'APPROVED' });
  await db.DriverVehicleAssignment.create({ tenantId: 't1', assignmentId: 'as1', driverId: 'D1', vehicleId: 'v1', active: true });
};

test('today and the week are counted from completed trips', async () => {
  await seed();
  await db.TripDetails.create(trip('T1', 'COMPLETED', { fare: 120, completed_at: hoursAgo(0.2) }));
  await db.TripDetails.create(trip('T2', 'COMPLETED', { fare: 80.5, completed_at: hoursAgo(0.1) }));
  await db.TripDetails.create(trip('T3', 'COMPLETED', { fare: 200, completed_at: hoursAgo(60) })); // an earlier day this week
  await db.TripDetails.create(trip('T4', 'COMPLETED', { fare: 999, completed_at: hoursAgo(24 * 20) })); // too old for the week
  await db.TripDetails.create(trip('T5', 'COMPLETED', { fare: 50, driver_id: 'OTHER', completed_at: hoursAgo(0.1) })); // another driver
  const r = await call();
  assert.equal(r.code, 200);
  const d = r.body.data;
  assert.equal(d.currency, 'INR');
  assert.equal(d.week.trips, 3);
  assert.equal(d.week.earnings, 400.5);
  assert.ok(d.today.trips >= 0 && d.today.trips <= 2);
  assert.equal(d.rating.average, 4.6);
  assert.equal(d.rating.totalRides, 12);
  assert.equal(d.lastTrip.tripId, 'T2');
});

test('vehicle, area and account come from the business records', async () => {
  await seed();
  const d = (await call()).body.data;
  assert.equal(d.vehicle.registrationNumber, 'UP16 AB 1234');
  assert.equal(d.vehicle.categoryName, 'VIP');
  assert.equal(d.vehicle.seats, 4);
  assert.equal(d.area.city, 'Noida');
  assert.equal(d.account.status, 'ACTIVE');
});

test('acceptance is the share of answered requests the driver took, over 30 days', async () => {
  await seed();
  await db.TripDetails.create(trip('A1', 'COMPLETED', { completed_at: hoursAgo(1) }));
  await db.TripDetails.create(trip('A2', 'ACCEPTED'));
  await db.TripDetails.create(trip('A3', 'NO_RESPONSE'));
  await db.TripDetails.create(trip('A4', 'REJECTED'));
  await db.TripDetails.create(trip('A5', 'REQUESTED')); // still open: not counted
  await db.TripDetails.create(trip('A6', 'CANCELLED', { cancel_stage: 'before_accept', cancelled_by: 'USER' })); // the rider changed their mind
  const d = (await call()).body.data;
  assert.equal(d.acceptance.offered, 4);
  assert.equal(d.acceptance.accepted, 2);
  assert.equal(d.acceptance.ratePercent, 50);
});

test('documents that are rejected, expired or about to expire are listed for the driver', async () => {
  await seed();
  const inDays = (n) => iso(new Date(NOW + n * 86400000));
  await db.DriverDocument.create({ tenantId: 't1', docId: 'dd1', driverId: 'D1', type: 'DRIVING_LICENCE', status: 'APPROVED', expiryDate: inDays(10) });
  await db.DriverDocument.create({ tenantId: 't1', docId: 'dd2', driverId: 'D1', type: 'IDENTITY', status: 'REJECTED', rejectionReason: 'Blurred' });
  await db.VehicleDocument.create({ tenantId: 't1', docId: 'vd1', vehicleId: 'v1', type: 'INSURANCE', status: 'APPROVED', expiryDate: inDays(-3) });
  await db.VehicleDocument.create({ tenantId: 't1', docId: 'vd2', vehicleId: 'v1', type: 'REGISTRATION_CERTIFICATE', status: 'APPROVED', expiryDate: inDays(400) });
  const a = (await call()).body.data.alerts;
  const kinds = Object.fromEntries(a.map((x) => [x.type, x.kind]));
  assert.equal(kinds.DRIVING_LICENCE, 'EXPIRING');
  assert.equal(kinds.IDENTITY, 'REJECTED');
  assert.equal(kinds.INSURANCE, 'EXPIRED');
  assert.equal(kinds.REGISTRATION_CERTIFICATE, undefined, 'a document far from expiry is not an alert');
  assert.equal(a.find((x) => x.type === 'IDENTITY').reason, 'Blurred');
});

test('a driver with no vehicle and no trips gets an honest empty summary', async () => {
  await seed();
  db.DriverVehicleAssignment.rows.length = 0;
  const d = (await call()).body.data;
  assert.equal(d.vehicle, null);
  assert.equal(d.today.trips, 0);
  assert.equal(d.today.earnings, 0);
  assert.equal(d.lastTrip, null);
  assert.equal(d.acceptance.ratePercent, null);
});

test('startOfDay is midnight in the given zone', () => {
  const noon = new Date('2026-10-14T06:30:00Z'); // 12:00 in India
  assert.equal(startOfDay(noon, 'Asia/Kolkata').toISOString(), '2026-10-13T18:30:00.000Z');
});
