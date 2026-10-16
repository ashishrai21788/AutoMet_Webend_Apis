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
  assert.equal(d.rating.average, 4.6, 'with no rated trips the stored rating is used');
  assert.equal(d.rating.totalRides, 4, 'completed trips are counted from the trips');
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
  await db.TripDetails.create(trip('A6', 'CANCELLED_BY_USER', { cancel_stage: 'before_accept', cancelled_by: 'USER' })); // the rider changed their mind
  await db.TripDetails.create(trip('A7', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE', { cancel_stage: 'after_accept', cancelled_by: 'USER' })); // taken, then the rider cancelled
  const d = (await call()).body.data;
  assert.equal(d.acceptance.offered, 5);
  assert.equal(d.acceptance.accepted, 3);
  assert.equal(d.acceptance.ratePercent, 60);
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

test('the rating is the average of what riders gave on the driver\'s trips', async () => {
  await seed();
  await db.TripDetails.create(trip('R1', 'COMPLETED', { completed_at: hoursAgo(5), rider_rating: { stars: 5 } }));
  await db.TripDetails.create(trip('R2', 'COMPLETED', { completed_at: hoursAgo(4), rider_rating: { stars: 4 } }));
  await db.TripDetails.create(trip('R3', 'COMPLETED', { completed_at: hoursAgo(3) })); // not rated
  const d = (await call()).body.data;
  assert.equal(d.rating.average, 4.5);
  assert.equal(d.rating.ratedTrips, 2);
  assert.equal(d.rating.totalRides, 3);
});

// ---- online hours, the detailed summary and the ride history ----
const duty = require('../lib/dutyLog');
const callWith = async (fn, query = {}, driverId = 'D1') => {
  const req = { authActorId: driverId, body: {}, params: {}, query, headers: {}, ip: '127.0.0.1' };
  let out;
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  let ok = false;
  await onboarding.driverContext(req, res, () => { ok = true; });
  if (!ok) return out;
  await fn(req, res);
  return out;
};
const { detail, trips: tripList } = require('../controllers/driverSummaryController');

test('online hours: a closed session counts as it was, an open one runs to now while the driver is online', async () => {
  await seed();
  db.DriverDutySession.rows.length = 0;
  await db.DriverDutySession.create({ driverId: 'D1', startedAt: hoursAgo(5), endedAt: hoursAgo(4) }); // 1 h
  await db.DriverDutySession.create({ driverId: 'D1', startedAt: hoursAgo(0.5), endedAt: null }); // open
  await db.Driver.updateMany({ driverId: 'D1' }, { $set: { isOnline: true } });
  const week = (await call()).body.data.week.onlineSeconds;
  assert.ok(week >= 3600 + 1700 && week <= 3600 + 1900, `week online seconds ${week}`);
});

test('online hours: a session nobody closed ends when the driver was last seen, and never runs past 16 hours', async () => {
  await seed();
  db.DriverDutySession.rows.length = 0;
  await db.DriverDutySession.create({ driverId: 'D1', startedAt: hoursAgo(10), endedAt: null });
  await db.Driver.updateMany({ driverId: 'D1' }, { $set: { isOnline: false, lastActive: hoursAgo(8) } });
  const secs = (await call()).body.data.week.onlineSeconds;
  assert.ok(secs >= 2 * 3600 - 60 && secs <= 2 * 3600 + 60, `stray session ${secs}`);
  const long = duty.onlineSeconds([{ startedAt: hoursAgo(30), endedAt: hoursAgo(1) }], null, new Date(0), new Date(NOW + 1000), new Date(NOW));
  assert.equal(long, 16 * 3600);
});

test('going online twice keeps one session; going offline closes it; coming back later opens a new one', async () => {
  db.DriverDutySession.rows.length = 0;
  const d = { driverId: 'D1', tenantId: 't1' };
  await duty.markOnline(d, { isOnline: false }, hoursAgo(3));
  await duty.markOnline(d, { isOnline: true }, hoursAgo(2));
  assert.equal(db.DriverDutySession.rows.length, 1);
  await duty.markOffline('D1', hoursAgo(1));
  assert.ok(db.DriverDutySession.rows[0].endedAt);
  await duty.markOnline(d, { isOnline: false }, hoursAgo(0.5));
  assert.equal(db.DriverDutySession.rows.length, 2);
});

test('detailed summary: one row per day, newest first, with totals and the average fare', async () => {
  await seed();
  db.DriverDutySession.rows.length = 0;
  await db.TripDetails.create(trip('D1a', 'COMPLETED', { fare: 100, completed_at: hoursAgo(0.1) }));
  await db.TripDetails.create(trip('D1b', 'COMPLETED', { fare: 300, completed_at: hoursAgo(0.2) }));
  await db.TripDetails.create(trip('D1c', 'COMPLETED', { fare: 50, completed_at: hoursAgo(24 * 3) }));
  await db.TripDetails.create(trip('D1d', 'COMPLETED', { fare: 70, driver_id: 'OTHER', completed_at: hoursAgo(1) }));
  const r = await callWith(detail, { days: '7' });
  assert.equal(r.code, 200);
  const d = r.body.data;
  assert.equal(d.daily.length, 7);
  assert.ok(d.daily[0].date > d.daily[1].date, 'newest first');
  assert.equal(d.week.rides, 3);
  assert.equal(d.week.earnings, 450);
  assert.equal(d.week.averageFare, 150);
  assert.equal((await callWith(detail, { days: '500' })).body.data.days, 90, 'the period is capped');
});

test('ride history: this driver only, finished and cancelled-after-accept, newest first, paged', async () => {
  await seed();
  await db.TripDetails.create(trip('H1', 'COMPLETED', { fare: 10, requested_at: hoursAgo(5), completed_at: hoursAgo(4.5) }));
  await db.TripDetails.create(trip('H2', 'CANCELLED_BY_DRIVER', { fare: 0, requested_at: hoursAgo(4) }));
  await db.TripDetails.create(trip('H3', 'COMPLETED', { fare: 30, requested_at: hoursAgo(3), completed_at: hoursAgo(2.5) }));
  await db.TripDetails.create(trip('H4', 'REJECTED', { requested_at: hoursAgo(2) }));
  await db.TripDetails.create(trip('H5', 'COMPLETED', { driver_id: 'OTHER', requested_at: hoursAgo(1) }));
  const first = (await callWith(tripList, { limit: '2' })).body.data;
  assert.deepEqual(first.trips.map((t) => t.tripId), ['H3', 'H2']);
  assert.equal(first.hasMore, true);
  const next = (await callWith(tripList, { limit: '2', skip: String(first.nextSkip) })).body.data;
  assert.deepEqual(next.trips.map((t) => t.tripId), ['H1']);
  assert.equal(next.hasMore, false);
});

test('the go-online and go-offline call opens and closes the duty session the online hours come from', async () => {
  await seed();
  db.DriverDutySession.rows.length = 0;
  const dynamic = require('../controllers/dynamicController');
  const toggle = async (isOnline) => {
    const req = { body: { driverId: 'D1', isOnline, onlineAs: 0 }, params: {}, query: {}, headers: {}, ip: '127.0.0.1' };
    let out;
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
    await dynamic.updateOnlineStatus(req, res);
    return out;
  };
  const on = await toggle(true);
  assert.equal(on.code, 200, JSON.stringify(on.body).slice(0, 200));
  assert.equal(db.DriverDutySession.rows.length, 1);
  assert.equal(db.DriverDutySession.rows[0].endedAt, null);
  await toggle(true); // a repeated call keeps the same session
  assert.equal(db.DriverDutySession.rows.length, 1);
  await toggle(false);
  assert.ok(db.DriverDutySession.rows[0].endedAt, 'going offline closes the session');
});
