// The driver's Profile numbers, the copy of their data and deleting the account. In-memory stand-ins for the database.
process.env.JWT_SECRET = 'test-secret-for-driver-account';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const onboarding = require('../controllers/driverOnboardingController');
const { profile } = require('../controllers/driverSummaryController');
const account = require('../controllers/driverAccountController');
const privateStorage = require('../lib/privateStorage');

const removed = [];
privateStorage.setBackend({ name: 'memory', put: async () => 'image:k', url: () => 'u', remove: async (key) => { removed.push(key); } });

const NOW = Date.now();
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000);
const trip = (id, status, extra = {}) => ({
  trip_id: id, request_id: 'R' + id, user_id: 'U1', driver_id: 'D1', status, fare: 100, requested_at: hoursAgo(2),
  pickup: { address: 'A' }, drop: { address: 'B' }, ...extra
});

const call = async (fn, { body = {}, query = {}, driverId = 'D1' } = {}) => {
  const req = { authActorId: driverId, body, params: {}, query, headers: {}, ip: '127.0.0.1' };
  let out;
  const res = { code: 200, headers: {}, set(h) { Object.assign(this.headers, h); return this; }, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; }, send(b) { out = { code: this.code, body: b, headers: this.headers }; return this; } };
  let ok = false;
  await onboarding.driverContext(req, res, () => { ok = true; });
  if (!ok) return out;
  await fn(req, res);
  return out;
};

const seed = async () => {
  for (const m of ['Tenant', 'ServiceRegion', 'VehicleCategory', 'Driver', 'Vehicle', 'DriverVehicleAssignment', 'DriverDocument', 'VehicleDocument', 'TripDetails', 'DriverIssue', 'DriverDutySession']) db[m].rows.length = 0;
  removed.length = 0;
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', isDefault: true, market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } });
  await db.ServiceRegion.create({ tenantId: 't1', regionId: 'rg1', country: 'IN', state: 'UP', city: 'Noida', zoneName: 'All', key: 'k', active: true });
  await db.VehicleCategory.create({ tenantId: 't1', categoryId: 'c1', name: 'VIP', nameKey: 'vip', passengerCapacity: 4, rideType: 'economy', regionIds: ['rg1'], active: true, imageUrl: 'https://img.test/vip.png' });
  await db.Driver.create({ driverId: 'D1', email: 'd1@t.local', phone: '+919811100000', firstName: 'Ravi', lastName: 'Kumar', tenantId: 't1', accountStatus: 'ACTIVE', operatingRegionId: 'rg1', eligibleCategoryId: 'c1', rating: 4.6, totalRides: 12, driverVerificationStatus: 'APPROVED', licenseNumber: 'DL-123', aadhaarNumber: '1234', vehicleNumber: 'UP16', accessToken: 'tok', fcmToken: 'f', bankAccount: { accountNumber: '99' }, profilePhoto: 'https://img.test/p.jpg', isOnline: true });
  await db.Vehicle.create({ tenantId: 't1', vehicleId: 'v1', registrationNumber: 'UP16 AB 1234', registrationKey: 'UP16AB1234', make: 'Maruti', model: 'Dzire', colour: 'White', year: 2022, categoryId: 'c1', passengerCapacity: 4, status: 'ACTIVE', verificationStatus: 'APPROVED' });
  await db.DriverVehicleAssignment.create({ tenantId: 't1', assignmentId: 'as1', driverId: 'D1', vehicleId: 'v1', active: true });
  await db.DriverDocument.create({ tenantId: 't1', docId: 'dd1', driverId: 'D1', type: 'DRIVING_LICENSE', number: 'DL-123', file: { key: 'image:lic', mime: 'image/jpeg', size: 1, originalName: 'lic.jpg' }, previousFiles: [{ key: 'image:old' }], status: 'APPROVED' });
};

test('profile: who the driver is, lifetime numbers, the vehicle and how they are doing', async () => {
  await seed();
  await db.TripDetails.create(trip('P1', 'COMPLETED', { fare: 100, completed_at: hoursAgo(1), rider_rating: { stars: 5 } }));
  await db.TripDetails.create(trip('P2', 'COMPLETED', { fare: 60, completed_at: hoursAgo(30), rider_rating: { stars: 4 } }));
  await db.TripDetails.create(trip('P3', 'CANCELLED_BY_DRIVER', { fare: 0 }));
  const r = await call(profile);
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200));
  const d = r.body.data;
  assert.equal(d.driver.name, 'Ravi Kumar');
  assert.equal(d.driver.verified, true);
  assert.equal(d.stats.trips, 2);
  assert.equal(d.stats.totalEarnings, 160);
  assert.equal(d.stats.rating, 4.5);
  assert.equal(d.vehicle.registrationNumber, 'UP16 AB 1234');
  assert.equal(d.vehicle.imageUrl, 'https://img.test/vip.png');
  assert.equal(d.performance.completion.ratePercent, 67, '2 finished of the 3 rides taken');
});

test('data export: the driver\'s own data, without secrets or document files', async () => {
  await seed();
  await db.TripDetails.create(trip('E1', 'COMPLETED', { completed_at: hoursAgo(1) }));
  await db.TripDetails.create(trip('E2', 'COMPLETED', { driver_id: 'OTHER' }));
  const r = await call(account.exportData);
  assert.equal(r.code, 200);
  assert.match(r.headers['Content-Disposition'], /my-driver-data\.json/);
  const file = JSON.parse(r.body);
  assert.equal(file.account.firstName, 'Ravi');
  assert.equal(file.trips.length, 1, 'only this driver\'s trips');
  assert.ok(!('accessToken' in file.account) && !('passwordHash' in file.account) && !('fcmToken' in file.account), 'no secrets');
  assert.ok(!JSON.stringify(file).includes('image:lic'), 'no storage keys');
  assert.equal(file.documents[0].type, 'DRIVING_LICENSE');
});

test('delete account: needs the confirmation, refuses during a ride, then erases the personal data', async () => {
  await seed();
  assert.equal((await call(account.deleteAccount)).code, 400, 'no confirmation');
  await db.TripDetails.create(trip('L1', 'ON_GOING'));
  const busy = await call(account.deleteAccount, { body: { confirm: 'DELETE' } });
  assert.equal(busy.code, 409, 'a ride is in progress');
  db.TripDetails.rows.length = 0;
  await db.TripDetails.create(trip('L2', 'COMPLETED', { completed_at: hoursAgo(1) }));
  await db.DriverIssue.create({ driverId: 'D1', issueText: 'help' });

  const r = await call(account.deleteAccount, { body: { confirm: 'delete' } });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200));
  const d = db.Driver.rows.find((x) => x.driverId === 'D1');
  assert.equal(d.firstName, 'Deleted');
  assert.equal(d.phone, 'deleted_D1');
  assert.ok(/deleted\.invalid$/.test(d.email));
  assert.equal(d.licenseNumber, null);
  assert.equal(d.aadhaarNumber, null);
  assert.ok(d.bankAccount == null || !(d.bankAccount.accountNumber || d.bankAccount.ifscCode), 'no bank details are kept (the field reads null or undefined by engine)');
  assert.equal(d.accessToken, null);
  assert.equal(d.isOnline, false);
  assert.ok(d.deletedAt);
  assert.equal(db.DriverDocument.rows.length, 0, 'the documents are gone');
  assert.deepEqual(removed.slice().sort(), ['image:lic', 'image:old'], 'and so are their stored files');
  assert.equal(db.DriverIssue.rows.length, 0);
  assert.equal(db.DriverVehicleAssignment.rows.find((a) => a.driverId === 'D1').active, false, 'the vehicle is released');
  assert.equal(db.TripDetails.rows.length, 1, 'trip records stay, without any name');
});
