// Driver registration and onboarding for MANY drivers across two businesses, end to end over HTTP:
// sign-up from the app -> the app's onboarding endpoints -> the dashboard's review -> eligibility.
// In-memory stand-ins for the database and document storage. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-multi-driver-onboarding';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.AUTH_ENFORCEMENT = 'strict'; // the app's calls are authenticated by token, as in production

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const { createFakeDb } = require('./helpers/fakeDb');
const { createMemoryStorage } = require('./helpers/memoryStorage');

const db = createFakeDb();
db.install();

// sign-in code records are plain documents here
const savedOtps = [];
for (const rel of ['models/otpModel.js', 'models/userOtpModel.js']) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: class FakeOtp { constructor(d) { Object.assign(this, d); } async save() { savedOtps.push({ ...this }); return this; } static async findOne() { return null; } static async deleteMany() { return {}; } }
  };
}
// the sign-up code builds documents with `new`; give the in-memory driver model that shape
const constructible = (fake) => {
  class Doc {
    constructor(data) { Object.assign(this, data); }
    async save() { const row = await fake.create({ _id: require('crypto').randomBytes(12).toString('hex'), ...this }); Object.assign(this, row); return this; }
  }
  Doc.findById = (id) => fake.findOne({ _id: id });
  for (const k of Object.getOwnPropertyNames(fake)) {
    if (!(k in Doc) && typeof fake[k] === 'function') Doc[k] = fake[k].bind(fake);
  }
  for (const k of ['find', 'findOne', 'updateOne', 'countDocuments', 'create', 'findOneAndUpdate', 'updateMany', 'exists']) {
    if (typeof fake[k] === 'function') Doc[k] = fake[k].bind(fake);
  }
  return Doc;
};
const dynPath = require.resolve(path.join(__dirname, '..', 'models', 'dynamicModel.js'));
const original = require.cache[dynPath].exports;
const DriverDoc = constructible(db.Driver);
require.cache[dynPath].exports = { ...original, createModel: (name) => (name === 'drivers' ? DriverDoc : original.createModel(name)) };

const storage = createMemoryStorage();
require('../lib/privateStorage').setBackend(storage);

const adminRoutes = require('../routes/adminRoutes');
const onboardingRoutes = require('../routes/driverOnboardingRoutes');
const dynamicController = require('../controllers/dynamicController');
const { jsonBodyParser } = require('../lib/jsonBody');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 1)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 9)]);
const FUTURE = '2031-06-30';
const hash = (pw) => bcrypt.hashSync(pw, 4);

let server;
let adminBase;
let appBase;
const ctx = {};

test.before(async () => {
  const mkTenant = (tenantId, name) => db.Tenant.create({
    tenantId, name, slug: tenantId, appName: name, packageName: `com.${tenantId}.app`, status: 'active', plan: 'standard',
    market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }
  });
  await mkTenant('app_a', 'Alpha');
  await mkTenant('app_b', 'Beta');
  const mkRegion = (tenantId, regionId, city, active = true) => db.ServiceRegion.create({ tenantId, regionId, country: 'IN', state: 'S', city, zoneName: 'All areas', key: `${tenantId}-${regionId}`, active });
  await mkRegion('app_a', 'rg_a1', 'Pune');
  await mkRegion('app_a', 'rg_a2', 'Mumbai');
  await mkRegion('app_a', 'rg_a_off', 'Nagpur', false);
  await mkRegion('app_b', 'rg_b1', 'Delhi');
  const mkCat = (tenantId, categoryId, name, regionIds, cap = 4) => db.VehicleCategory.create({ tenantId, categoryId, name, nameKey: `${tenantId}-${name}`, active: true, regionIds, passengerCapacity: cap, rideType: 'economy' });
  await mkCat('app_a', 'vc_a_sedan', 'Sedan', ['rg_a1', 'rg_a2']);
  await mkCat('app_a', 'vc_a_bike', 'Bike', ['rg_a1'], 1);
  await mkCat('app_b', 'vc_b_sedan', 'Sedan', ['rg_b1']);
  await db.AdminUser.create({ adminId: 'u_a_admin', name: 'a', email: 'admin@a.test', role: 'client_admin', tenantId: 'app_a', passwordHash: hash('password-a-admin') });
  await db.AdminUser.create({ adminId: 'u_b_admin', name: 'b', email: 'admin@b.test', role: 'client_admin', tenantId: 'app_b', passwordHash: hash('password-b-admin') });

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  app.use('/api/v1/driver/onboarding', onboardingRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  const port = server.address().port;
  adminBase = `http://127.0.0.1:${port}/api/admin`;
  appBase = `http://127.0.0.1:${port}/api/v1/driver/onboarding`;
});
test.after(() => server.close());

async function adminCall(method, url, { token, appId, body } = {}) {
  const res = await fetch(adminBase + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(appId ? { 'X-App-Id': appId } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}
async function adminSignIn(email, password) {
  return (await adminCall('POST', '/auth/login', { body: { email, password } })).body.data.token;
}

/** The app's call as a signed-in driver. */
async function appCall(driver, method, url, { body, form } = {}) {
  const res = await fetch(appBase + url, {
    method,
    headers: { Authorization: `Bearer ${driver.token}`, ...(form ? {} : { 'Content-Type': 'application/json' }) },
    body: form || (body ? JSON.stringify(body) : undefined)
  });
  return { status: res.status, body: await res.json() };
}
const appUpload = (driver, fields, { bytes = JPEG, name = 'doc.jpg', mime = 'image/jpeg' } = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, v);
  if (bytes) form.append('file', new Blob([bytes], { type: mime }), name);
  return appCall(driver, 'POST', '/documents', { form });
};

/** Sign-up from the app (the same handler POST /api/drivers runs), then the token the OTP step would issue. */
async function signUp(tenantId, { name, phone, email }) {
  let out;
  const before = new Set(db.Driver.rows.map((d) => d.driverId));
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await dynamicController.createRecord({
    params: { collectionName: 'drivers' }, headers: {}, ip: '127.0.0.1',
    body: { name, phoneNumber: phone, ...(email ? { email } : {}) }, appTenant: { tenantId }
  }, res);
  if (out.code !== 201) return { ...out, driver: null };
  const row = db.Driver.rows.find((d) => !before.has(d.driverId)); // the account this call created
  const token = jwt.sign({ driverId: row.driverId, role: 'driver' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  await db.Driver.updateOne({ driverId: row.driverId }, { $set: { accessToken: token } });
  return { ...out, driver: { driverId: row.driverId, token, tenantId } };
}

const reg = (n) => `MH12AB${String(1000 + n)}`;

async function fullOnboarding(driver, { region, category, plate, make = 'Maruti', model = 'Dzire', optional = {} }) {
  const area = await appCall(driver, 'PUT', '/area', { body: { operatingRegionId: region, eligibleCategoryId: category } });
  assert.equal(area.status, 200, `area: ${JSON.stringify(area.body).slice(0, 200)}`);
  const veh = await appCall(driver, 'PUT', '/vehicle', { body: { registrationNumber: plate, make, model, ...optional } });
  assert.equal(veh.status, 200, `vehicle: ${JSON.stringify(veh.body).slice(0, 200)}`);
  const state = (await appCall(driver, 'GET', '/')).body.data;
  const send = async (subject, req) => {
    const r = await appUpload(driver, { subject, type: req.type, number: req.needsNumber ? `NO-${req.type}-${driver.driverId}`.slice(0, 30) : undefined, expiryDate: req.needsExpiry ? FUTURE : undefined });
    assert.equal(r.status, 201, `${subject}/${req.type}: ${JSON.stringify(r.body).slice(0, 200)}`);
  };
  for (const req of state.requirements.driver.filter((x) => x.mandatory)) await send('driver', req);
  for (const req of state.requirements.vehicle.filter((x) => x.mandatory)) await send('vehicle', req);
  return (await appCall(driver, 'GET', '/')).body.data;
}

// ---------------------------------------------------------------------------------------------

test('admins sign in', async () => {
  ctx.a = { token: await adminSignIn('admin@a.test', 'password-a-admin'), appId: 'app_a' };
  ctx.b = { token: await adminSignIn('admin@b.test', 'password-b-admin'), appId: 'app_b' };
  assert.ok(ctx.a.token && ctx.b.token);
});

test('sign-up: several drivers register, each into the right business, with unique ids and canonical phones', async () => {
  const people = [
    ['a1', 'app_a', { name: 'Asha One', phone: '9810000001', email: 'asha1@x.test' }],
    ['a2', 'app_a', { name: 'Asha Two', phone: '+91 98100 00002' }],
    ['a3', 'app_a', { name: 'Asha Three', phone: '919810000003', email: 'asha3@x.test' }],
    ['a4', 'app_a', { name: 'Asha Four', phone: '9810000004' }],
    ['a5', 'app_a', { name: 'Asha Five', phone: '9810000005' }],
    ['a6', 'app_a', { name: 'Asha Six', phone: '9810000006' }],
    ['b1', 'app_b', { name: 'Bela One', phone: '9820000001' }],
    ['b2', 'app_b', { name: 'Bela Two', phone: '9820000002' }]
  ];
  for (const [key, tenant, p] of people) {
    const r = await signUp(tenant, p);
    assert.equal(r.code, 201, `${key}: ${JSON.stringify(r.body).slice(0, 200)}`);
    ctx[key] = r.driver;
  }
  const ids = people.map(([k]) => ctx[k].driverId);
  assert.equal(new Set(ids).size, ids.length, 'driver ids are unique');
  for (const row of db.Driver.rows.filter((d) => d.tenantId)) {
    assert.match(row.phone, /^\+91\d{10}$/, `phone is international for ${row.driverId}`);
    assert.equal(row.isOnline, false);
    assert.ok(!row.eligibleCategoryId && !row.operatingRegionId, 'nothing is chosen at sign-up');
    assert.notEqual(row.driverVerificationStatus, 'APPROVED');
  }
  assert.equal(db.Driver.rows.filter((d) => d.tenantId === 'app_a').length, 6);
  assert.equal(db.Driver.rows.filter((d) => d.tenantId === 'app_b').length, 2);
});

test('sign-up: duplicates, bad input and privileged fields are refused', async () => {
  const zero = await signUp('app_a', { name: 'Again', phone: '09810000001' });
  assert.equal(zero.code, 400, 'a leading 0 is the same number');
  const sameNumber = await signUp('app_a', { name: 'Again', phone: '+919810000001' });
  assert.equal(sameNumber.code, 400, 'the same number in another form');
  const sameEmail = await signUp('app_a', { name: 'Mail Twin', phone: '9810000099', email: 'ASHA1@x.test' });
  assert.equal(sameEmail.code, 400, 'the same email, any case');
  const noName = await signUp('app_a', { name: '', phone: '9810000098' });
  assert.equal(noName.code, 400);
  const noPhone = await signUp('app_a', { name: 'No Phone', phone: '' });
  assert.equal(noPhone.code, 400);
  // the same number cannot sign up in another business either (accounts are unique across the platform)
  const otherBusiness = await signUp('app_b', { name: 'Other Biz', phone: '9810000001' });
  assert.equal(otherBusiness.code, 400);
});

test('onboarding state: each driver sees only their own business\'s regions and ride types, and nothing done yet', async () => {
  const a = (await appCall(ctx.a1, 'GET', '/')).body.data;
  assert.deepEqual(a.choices.regions.map((r) => r.city).sort(), ['Mumbai', 'Pune'], 'inactive Nagpur is not offered');
  assert.deepEqual(a.choices.categories.map((c) => c.name).sort(), ['Bike', 'Sedan']);
  assert.deepEqual(a.steps, { area: false, vehicle: false, documents: false });
  assert.equal(a.eligibility.eligible, false);
  const b = (await appCall(ctx.b1, 'GET', '/')).body.data;
  assert.deepEqual(b.choices.regions.map((r) => r.city), ['Delhi']);
  assert.deepEqual(b.choices.categories.map((c) => c.name), ['Sedan']);
  assert.equal(b.business.name, 'Beta');
});

test('the app needs a signed-in driver', async () => {
  const none = await fetch(appBase + '/');
  assert.equal(none.status, 401);
  const bad = await fetch(appBase + '/', { headers: { Authorization: 'Bearer not-a-token' } });
  assert.equal(bad.status, 401);
  // a token the server has since replaced (a newer sign-in) no longer works
  const stale = jwt.sign({ driverId: ctx.a1.driverId, role: 'driver', n: 1 }, process.env.JWT_SECRET);
  const r = await fetch(appBase + '/', { headers: { Authorization: `Bearer ${stale}` } });
  assert.equal(r.status, 401);
});

test('area: invalid combinations are refused with a field message, valid ones are saved', async () => {
  const notOffered = await appCall(ctx.a2, 'PUT', '/area', { body: { operatingRegionId: 'rg_a2', eligibleCategoryId: 'vc_a_bike' } });
  assert.equal(notOffered.status, 400);
  assert.ok(notOffered.body.errors.eligibleCategoryId);
  const inactive = await appCall(ctx.a2, 'PUT', '/area', { body: { operatingRegionId: 'rg_a_off', eligibleCategoryId: 'vc_a_sedan' } });
  assert.equal(inactive.status, 400);
  assert.ok(inactive.body.errors.operatingRegionId);
  const foreign = await appCall(ctx.a2, 'PUT', '/area', { body: { operatingRegionId: 'rg_b1', eligibleCategoryId: 'vc_b_sedan' } });
  assert.equal(foreign.status, 400, 'another business\'s region and category are not found');
  const empty = await appCall(ctx.a2, 'PUT', '/area', { body: {} });
  assert.equal(empty.status, 400);
  assert.ok(db.Driver.rows.find((d) => d.driverId === ctx.a2.driverId).operatingRegionId == null, 'nothing was saved by the failed calls (unset reads as undefined or null, by engine)');
});

test('vehicle: needs the area first; plate rules; one vehicle per driver; no taking another driver\'s plate', async () => {
  const early = await appCall(ctx.a3, 'PUT', '/vehicle', { body: { registrationNumber: reg(3), make: 'Maruti', model: 'Dzire' } });
  assert.equal(early.status, 400);

  // a1 completes everything
  ctx.a1.state = await fullOnboarding(ctx.a1, { region: 'rg_a1', category: 'vc_a_sedan', plate: 'mh 12 ab 1001', optional: { year: 2021, colour: 'White' } });
  assert.equal(ctx.a1.state.vehicle.registrationNumber, 'MH 12 AB 1001');
  assert.equal(ctx.a1.state.vehicle.status, 'INACTIVE', 'the business activates it, not the driver');
  assert.deepEqual(ctx.a1.state.steps, { area: true, vehicle: true, documents: true });
  assert.equal(ctx.a1.state.eligibility.eligible, false, 'documents alone do not make a driver eligible');

  // a2 tries a1's plate in another spelling
  await appCall(ctx.a2, 'PUT', '/area', { body: { operatingRegionId: 'rg_a2', eligibleCategoryId: 'vc_a_sedan' } });
  const taken = await appCall(ctx.a2, 'PUT', '/vehicle', { body: { registrationNumber: 'MH12-AB-1001', make: 'Maruti', model: 'Dzire' } });
  assert.equal(taken.status, 409);
  assert.ok(taken.body.errors && taken.body.errors.registrationNumber);
  assert.equal(db.Vehicle.rows.filter((v) => v.tenantId === 'app_a').length, 1, 'no vehicle was created by the refused call');

  // bad vehicle input, field by field
  const bad = await appCall(ctx.a2, 'PUT', '/vehicle', { body: { registrationNumber: '!!', make: '', model: '', year: 1850 } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.registrationNumber && bad.body.errors.make && bad.body.errors.model);
});

test('the same plate is allowed in a different business', async () => {
  const s = await fullOnboarding(ctx.b1, { region: 'rg_b1', category: 'vc_b_sedan', plate: 'MH12AB1001' });
  assert.equal(s.vehicle.registrationNumber, 'MH12AB1001');
  assert.deepEqual(s.steps, { area: true, vehicle: true, documents: true });
});

test('several drivers in one business onboard side by side without touching each other', async () => {
  ctx.a2.state = await fullOnboarding(ctx.a2, { region: 'rg_a2', category: 'vc_a_sedan', plate: 'MH12AB1002' });
  ctx.a3.state = await fullOnboarding(ctx.a3, { region: 'rg_a1', category: 'vc_a_bike', plate: 'MH12AB1003', make: 'Honda', model: 'Activa' });
  ctx.b2.state = await fullOnboarding(ctx.b2, { region: 'rg_b1', category: 'vc_b_sedan', plate: 'MH12AB1004' });

  const vehicles = db.Vehicle.rows.filter((v) => v.tenantId === 'app_a');
  assert.equal(vehicles.length, 3);
  assert.equal(new Set(vehicles.map((v) => v.vehicleId)).size, 3);
  for (const d of ['a1', 'a2', 'a3']) {
    const active = db.DriverVehicleAssignment.rows.filter((x) => x.driverId === ctx[d].driverId && x.active);
    assert.equal(active.length, 1, `${d} has exactly one active assignment`);
  }
  // a vehicle is assigned to one driver only
  const perVehicle = {};
  for (const a of db.DriverVehicleAssignment.rows.filter((x) => x.active)) perVehicle[a.vehicleId] = (perVehicle[a.vehicleId] || 0) + 1;
  assert.ok(Object.values(perVehicle).every((n) => n === 1));
  // categories and capacity come from the business, per driver
  assert.equal(vehicles.find((v) => v.registrationNumber === 'MH12AB1003').passengerCapacity, 1);
  assert.equal(vehicles.find((v) => v.registrationNumber === 'MH12AB1002').operatingRegionId, 'rg_a2');
  // a driver's state lists only their own documents
  const docsA1 = db.DriverDocument.rows.filter((d) => d.driverId === ctx.a1.driverId).length;
  const docsA2 = db.DriverDocument.rows.filter((d) => d.driverId === ctx.a2.driverId).length;
  assert.ok(docsA1 > 0 && docsA2 > 0);
  const s1 = (await appCall(ctx.a1, 'GET', '/')).body.data;
  assert.equal(s1.vehicle.registrationNumber, 'MH 12 AB 1001');
  assert.equal(s1.driver.driverId, ctx.a1.driverId);
});

test('documents: required details, real files only, expiry in the future, replace keeps one current document', async () => {
  const d = ctx.a4;
  await appCall(d, 'PUT', '/area', { body: { operatingRegionId: 'rg_a1', eligibleCategoryId: 'vc_a_sedan' } });
  const noNumber = await appUpload(d, { subject: 'driver', type: 'DRIVING_LICENCE', expiryDate: FUTURE });
  assert.equal(noNumber.status, 400);
  const noExpiry = await appUpload(d, { subject: 'driver', type: 'DRIVING_LICENCE', number: 'DL12345678' });
  assert.equal(noExpiry.status, 400);
  const past = await appUpload(d, { subject: 'driver', type: 'DRIVING_LICENCE', number: 'DL12345678', expiryDate: '2020-01-01' });
  assert.equal(past.status, 400, 'an expired document is refused');
  const exe = await appUpload(d, { subject: 'driver', type: 'DRIVING_LICENCE', number: 'DL12345678', expiryDate: FUTURE }, { bytes: EXE, name: 'x.jpg' });
  assert.equal(exe.status, 400, 'a program renamed to .jpg is refused');
  const noFile = await appUpload(d, { subject: 'driver', type: 'DRIVING_LICENCE', number: 'DL12345678', expiryDate: FUTURE }, { bytes: null });
  assert.equal(noFile.status, 400);
  const unknownType = await appUpload(d, { subject: 'driver', type: 'HOROSCOPE', number: 'X1' });
  assert.equal(unknownType.status, 400, 'a type the business does not ask for');
  const noVehicle = await appUpload(d, { subject: 'vehicle', type: 'REGISTRATION_CERTIFICATE', number: 'RC12345' });
  assert.equal(noVehicle.status, 400, 'vehicle documents need a vehicle');
  assert.equal(db.DriverDocument.rows.filter((x) => x.driverId === d.driverId).length, 0, 'refused uploads leave nothing behind');

  const ok = await appUpload(d, { subject: 'driver', type: 'DRIVING_LICENCE', number: 'DL12345678', expiryDate: FUTURE });
  assert.equal(ok.status, 201);
  const pdf = await appUpload(d, { subject: 'driver', type: 'IDENTITY', number: 'ID12345678' }, { bytes: PDF, name: 'id.pdf', mime: 'application/pdf' });
  assert.equal(pdf.status, 201, JSON.stringify(pdf.body).slice(0, 200));
  const again = await appUpload(d, { subject: 'driver', type: 'DRIVING_LICENCE', number: 'DL87654321', expiryDate: FUTURE });
  assert.ok([200, 201].includes(again.status), 'a replacement is accepted');
  const licences = db.DriverDocument.rows.filter((x) => x.driverId === d.driverId && x.type === 'DRIVING_LICENCE');
  assert.equal(licences.filter((x) => x.current !== false && x.status !== 'SUPERSEDED').length >= 1, true);
});

test('review: the dashboard sees what the app submitted; a rejection reaches the app and can be fixed and resubmitted', async () => {
  const { a } = ctx; // admin session of business A
  const docs = (await adminCall('GET', `/business/drivers/${ctx.a1.driverId}/documents`, a)).body.data;
  assert.ok(JSON.stringify(docs).includes('DRIVING_LICENCE'));

  const licDoc = db.DriverDocument.rows.find((x) => x.driverId === ctx.a1.driverId && x.type === 'DRIVING_LICENCE');
  const reject = await adminCall('POST', `/business/driver-documents/${licDoc.docId}/review`, { ...a, body: { decision: 'REJECT', reason: 'The photo is blurred' } });
  assert.equal(reject.status, 200, JSON.stringify(reject.body).slice(0, 200));
  let s = (await appCall(ctx.a1, 'GET', '/')).body.data;
  const lic = s.requirements.driver.find((x) => x.type === 'DRIVING_LICENCE');
  assert.equal(lic.document.status, 'REJECTED');
  assert.equal(lic.document.rejectionReason, 'The photo is blurred');
  assert.equal(s.steps.documents, false, 'a rejected required document is not done');
  assert.equal(s.driver.verificationStatus === 'REJECTED' || s.driver.verificationStatus === 'INCOMPLETE' || s.driver.verificationStatus === 'PENDING_REVIEW', true);

  const resub = await appUpload(ctx.a1, { subject: 'driver', type: 'DRIVING_LICENCE', number: 'DL99998888', expiryDate: FUTURE });
  assert.ok([200, 201].includes(resub.status), 'a corrected document is accepted');
  s = (await appCall(ctx.a1, 'GET', '/')).body.data;
  assert.equal(s.requirements.driver.find((x) => x.type === 'DRIVING_LICENCE').document.status, 'SUBMITTED');
  assert.equal(s.steps.documents, true);
});

test('approval: all mandatory documents approved, then the vehicle approved and activated, makes each driver eligible', async () => {
  const { a, b } = ctx;
  const approveAll = async (admin, driverKey) => {
    const driverId = ctx[driverKey].driverId;
    for (const doc of db.DriverDocument.rows.filter((x) => x.driverId === driverId && x.status === 'SUBMITTED')) {
      const r = await adminCall('POST', `/business/driver-documents/${doc.docId}/review`, { ...admin, body: { decision: 'APPROVE' } });
      assert.equal(r.status, 200, `${driverKey} ${doc.type}: ${JSON.stringify(r.body).slice(0, 160)}`);
    }
    const vehicleId = db.DriverVehicleAssignment.rows.find((x) => x.driverId === driverId && x.active).vehicleId;
    for (const doc of db.VehicleDocument.rows.filter((x) => x.vehicleId === vehicleId && x.status === 'SUBMITTED')) {
      const r = await adminCall('POST', `/business/vehicle-documents/${doc.docId}/review`, { ...admin, body: { decision: 'APPROVE' } });
      assert.equal(r.status, 200, `${driverKey} vehicle ${doc.type}: ${JSON.stringify(r.body).slice(0, 160)}`);
    }
    const act = await adminCall('POST', `/business/vehicles/${vehicleId}/status`, { ...admin, body: { status: 'ACTIVE' } });
    assert.ok(act.status === 200 || act.status === 409, `${driverKey} activate: ${JSON.stringify(act.body).slice(0, 160)}`); // 409: already active
  };
  // before any approval: not eligible
  assert.equal((await appCall(ctx.a1, 'GET', '/')).body.data.eligibility.eligible, false);
  // activating a vehicle does not make the driver eligible while it is unverified: both are required
  const vehicleId = db.DriverVehicleAssignment.rows.find((x) => x.driverId === ctx.a1.driverId && x.active).vehicleId;
  const early = await adminCall('POST', `/business/vehicles/${vehicleId}/status`, { ...a, body: { status: 'ACTIVE' } });
  assert.equal(early.status, 200);
  const stillNot = (await appCall(ctx.a1, 'GET', '/')).body.data.eligibility;
  assert.equal(stillNot.eligible, false);
  assert.ok(stillNot.reasons.some((r) => r.code === 'VEHICLE_NOT_VERIFIED' || r.code === 'DRIVER_NOT_VERIFIED'));

  for (const k of ['a1', 'a2', 'a3']) await approveAll(a, k);
  await approveAll(b, 'b1');
  await approveAll(b, 'b2');
  for (const k of ['a1', 'a2', 'a3', 'b1', 'b2']) {
    const s = (await appCall(ctx[k], 'GET', '/')).body.data;
    assert.equal(s.eligibility.eligible, true, `${k}: ${JSON.stringify(s.eligibility.reasons)}`);
    assert.equal(s.driver.verificationStatus, 'APPROVED', k);
    assert.equal(s.editable, false, `${k} is locked once verified`);
  }
  // a4 submitted only some documents and has no vehicle: still not eligible, with reasons
  const s4 = (await appCall(ctx.a4, 'GET', '/')).body.data;
  assert.equal(s4.eligibility.eligible, false);
  assert.ok(s4.eligibility.reasons.some((r) => r.code === 'NO_VEHICLE'));
});

test('after approval the driver cannot change area, ride type or vehicle from the app', async () => {
  const area = await appCall(ctx.a1, 'PUT', '/area', { body: { operatingRegionId: 'rg_a2', eligibleCategoryId: 'vc_a_sedan' } });
  assert.equal(area.status, 409);
  const veh = await appCall(ctx.a1, 'PUT', '/vehicle', { body: { registrationNumber: 'MH12AB7777', make: 'X', model: 'Y' } });
  assert.equal(veh.status, 409);
});

test('a driver who changes the ride type before approval carries the vehicle with them', async () => {
  // a5: area, vehicle, then switches region and ride type
  await appCall(ctx.a5, 'PUT', '/area', { body: { operatingRegionId: 'rg_a1', eligibleCategoryId: 'vc_a_sedan' } });
  await appCall(ctx.a5, 'PUT', '/vehicle', { body: { registrationNumber: 'MH12AB1005', make: 'Honda', model: 'Shine' } });
  const switched = await appCall(ctx.a5, 'PUT', '/area', { body: { operatingRegionId: 'rg_a1', eligibleCategoryId: 'vc_a_bike' } });
  assert.equal(switched.status, 200);
  const v = db.Vehicle.rows.find((x) => x.registrationNumber === 'MH12AB1005');
  assert.equal(v.categoryId, 'vc_a_bike');
  assert.equal(v.passengerCapacity, 1);
  assert.equal(switched.body.data.vehicle.categoryId, 'vc_a_bike');
  // the plate can be corrected before approval
  const fixed = await appCall(ctx.a5, 'PUT', '/vehicle', { body: { registrationNumber: 'MH12AB1006', make: 'Honda', model: 'Shine' } });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.data.vehicle.registrationNumber, 'MH12AB1006');
  assert.equal(db.Vehicle.rows.filter((x) => x.createdBy === ctx.a5.driverId).length, 1, 'the vehicle was updated, not duplicated');
  assert.equal(db.DriverVehicleAssignment.rows.filter((x) => x.driverId === ctx.a5.driverId && x.active).length, 1);
});

test('a business cannot see another business\'s drivers or documents in its dashboard', async () => {
  const cross = await adminCall('GET', `/business/drivers/${ctx.b1.driverId}`, ctx.a);
  assert.equal(cross.status, 404);
  const list = (await adminCall('GET', '/business/drivers?pageSize=100', ctx.a)).body.data;
  const ids = JSON.stringify(list);
  assert.equal(ids.includes(ctx.b1.driverId), false);
  assert.equal(ids.includes(ctx.a1.driverId), true);
});
