// Driver self-service onboarding: the driver fills in the business's own records from the app.
// In-memory stand-ins for the database and document storage. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-driver-onboarding-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

// document storage: accept everything and remember the keys
const stored = [];
const storagePath = require.resolve(path.join(__dirname, '..', 'lib', 'privateStorage.js'));
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true,
  exports: {
    isAvailable: () => true,
    putPrivate: async (buf, meta) => { const key = 'k_' + stored.length; stored.push({ key, meta }); return key; },
    signedUrl: () => 'https://example.invalid/file',
    SIGNED_URL_TTL_SECONDS: 60
  }
};

const ctl = require('../controllers/driverOnboardingController');

const run = async (handler, req) => {
  let out;
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await handler(req, res);
  return out;
};
// the same chain the route runs: context first, then the handler
const call = async (handler, body = {}, extra = {}) => {
  const req = { authActorId: 'D1', body, params: {}, headers: {}, ip: '127.0.0.1', ...extra };
  let ctxOut;
  const res = { status(c) { this.code = c; return this; }, json(b) { ctxOut = { code: this.code, body: b }; return this; } };
  let proceeded = false;
  await ctl.driverContext(req, res, () => { proceeded = true; });
  if (!proceeded) return ctxOut;
  return run(handler, req);
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

const seed = async () => {
  for (const m of ['Tenant', 'ServiceRegion', 'VehicleCategory', 'Driver', 'Vehicle', 'DriverVehicleAssignment', 'DriverDocument', 'VehicleDocument', 'EntityHistory', 'AdminAudit']) db[m].rows.length = 0;
  stored.length = 0;
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', appName: 'uRide', isDefault: true, market: { country: 'IN', currency: 'INR' } });
  await db.ServiceRegion.create({ tenantId: 't1', regionId: 'rg1', country: 'IN', state: 'UP', city: 'Noida', zoneName: 'All', key: 'up|noida|all', active: true });
  await db.ServiceRegion.create({ tenantId: 't1', regionId: 'rg2', country: 'IN', state: 'UP', city: 'Agra', zoneName: 'All', key: 'up|agra|all', active: true });
  await db.VehicleCategory.create({ tenantId: 't1', categoryId: 'c_auto', name: 'Auto', nameKey: 'auto', passengerCapacity: 3, rideType: 'economy', regionIds: ['rg1'], active: true });
  await db.VehicleCategory.create({ tenantId: 't1', categoryId: 'c_cab', name: 'Cab', nameKey: 'cab', passengerCapacity: 4, rideType: 'economy', regionIds: ['rg1', 'rg2'], active: true });
  await db.Driver.create({ driverId: 'D1', email: 'd1@test.local', phone: '+919811100000', firstName: 'Ravi', lastName: 'Kumar', tenantId: 't1', accountStatus: 'ACTIVE' });
};

test('the state lists the business\'s regions, ride types and required documents, with nothing done yet', async () => {
  await seed();
  const r = await call(ctl.getState);
  assert.equal(r.code, 200);
  const d = r.body.data;
  assert.deepEqual(d.choices.regions.map((x) => x.city).sort(), ['Agra', 'Noida']);
  assert.deepEqual(d.choices.categories.map((x) => x.name).sort(), ['Auto', 'Cab']);
  assert.ok(d.requirements.driver.some((x) => x.type === 'DRIVING_LICENCE' && x.mandatory));
  assert.ok(d.requirements.vehicle.some((x) => x.type === 'REGISTRATION_CERTIFICATE' && x.mandatory));
  assert.equal(d.vehicle, null);
  assert.deepEqual(d.steps, { area: false, vehicle: false, documents: false });
  assert.equal(d.eligibility.eligible, false);
});

test('choosing an area and ride type is validated against the business', async () => {
  await seed();
  assert.equal((await call(ctl.setArea, { operatingRegionId: 'rg2', eligibleCategoryId: 'c_auto' })).code, 400); // Auto is not offered in Agra
  assert.equal((await call(ctl.setArea, {})).code, 400);
  const ok = await call(ctl.setArea, { operatingRegionId: 'rg1', eligibleCategoryId: 'c_auto' });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.data.driver.operatingRegionId, 'rg1');
  assert.equal(ok.body.data.steps.area, true);
  assert.equal(db.Driver.rows[0].eligibleCategoryId, 'c_auto');
});

test('the vehicle needs the area first, then it is created, assigned and left inactive for the business', async () => {
  await seed();
  assert.equal((await call(ctl.saveVehicle, { registrationNumber: 'UP16AB1234', make: 'Bajaj', model: 'RE' })).code, 400);
  await call(ctl.setArea, { operatingRegionId: 'rg1', eligibleCategoryId: 'c_auto' });
  const r = await call(ctl.saveVehicle, { registrationNumber: 'up16 ab 1234', make: 'Bajaj', model: 'RE', year: 2021, colour: 'Green' });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200));
  const v = r.body.data.vehicle;
  assert.equal(v.registrationNumber, 'UP16 AB 1234');
  assert.equal(v.categoryId, 'c_auto');
  assert.equal(v.status, 'INACTIVE'); // the business makes it active
  assert.equal(db.Vehicle.rows[0].passengerCapacity, 3); // from the category, not the driver
  assert.equal(db.DriverVehicleAssignment.rows.filter((a) => a.active).length, 1);
  assert.equal(r.body.data.steps.vehicle, true);
});

test('the same registration number cannot be added twice in a business', async () => {
  await seed();
  await db.Vehicle.create({ tenantId: 't1', vehicleId: 'veh_x', registrationNumber: 'UP16 AB 1234', registrationKey: 'UP16AB1234', make: 'x', model: 'y', categoryId: 'c_auto', passengerCapacity: 3, status: 'ACTIVE' });
  await call(ctl.setArea, { operatingRegionId: 'rg1', eligibleCategoryId: 'c_auto' });
  const r = await call(ctl.saveVehicle, { registrationNumber: 'UP16AB1234', make: 'Bajaj', model: 'RE' });
  assert.equal(r.code, 409, JSON.stringify(r.body).slice(0, 300));
});

test('a document lands in the business\'s own records, where the dashboard reviews it', async () => {
  await seed();
  const r = await call(ctl.submitDocument, { subject: 'driver', type: 'DRIVING_LICENCE', number: 'DL1420110012345', expiryDate: '2099-01-01' },
    { file: { buffer: PNG, size: PNG.length, originalname: 'licence.png' } });
  assert.equal(r.code, 201, JSON.stringify(r.body).slice(0, 240));
  const doc = db.DriverDocument.rows[0];
  assert.equal(doc.driverId, 'D1');
  assert.equal(doc.tenantId, 't1');
  assert.equal(doc.status, 'SUBMITTED');
  assert.equal(stored.length, 1);
  // and it shows up on the driver's state, number masked
  const s = (await call(ctl.getState)).body.data.requirements.driver.find((x) => x.type === 'DRIVING_LICENCE');
  assert.equal(s.document.status, 'SUBMITTED');
  assert.ok(s.document.number.endsWith('2345') && s.document.number.startsWith('•'));
});

test('vehicle documents need a vehicle, and a file must be a real image or PDF', async () => {
  await seed();
  const noVehicle = await call(ctl.submitDocument, { subject: 'vehicle', type: 'REGISTRATION_CERTIFICATE', number: 'RC1' },
    { file: { buffer: PNG, size: PNG.length, originalname: 'rc.png' } });
  assert.equal(noVehicle.code, 400);
  const notAnImage = await call(ctl.submitDocument, { subject: 'driver', type: 'DRIVING_LICENCE', number: 'DL1', expiryDate: '2099-01-01' },
    { file: { buffer: Buffer.from('<script>alert(1)</script>'), size: 25, originalname: 'x.png' } });
  assert.equal(notAnImage.code, 400);
});

test('a verified driver cannot change their area from the app', async () => {
  await seed();
  db.Driver.rows[0].driverVerificationStatus = 'APPROVED';
  const r = await call(ctl.setArea, { operatingRegionId: 'rg1', eligibleCategoryId: 'c_auto' });
  assert.equal(r.code, 409);
});
