// App registration: drivers and riders can sign up from the apps, into the business the app belongs to.
// In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-registration-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

// the sign-in code record is a plain document here
const savedOtps = [];
for (const rel of ['models/otpModel.js', 'models/userOtpModel.js']) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: class FakeOtp { constructor(d) { Object.assign(this, d); } async save() { savedOtps.push({ ...this }); return this; } static async findOne() { return null; } static async deleteMany() { return {}; } }
  };
}

// the sign-up code builds documents with ; give the in-memory models that shape
const constructible = (fake) => {
  class Doc {
    constructor(data) { Object.assign(this, data); }
    async save() { const row = await fake.create({ _id: require('crypto').randomBytes(12).toString('hex'), ...this }); Object.assign(this, row); return this; }
  }
  Doc.findById = (id) => fake.findOne({ _id: id });
  for (const k of ['find', 'findOne', 'updateOne', 'countDocuments', 'create']) {
    if (typeof fake[k] === 'function') Doc[k] = fake[k].bind(fake);
  }
  return Doc;
};
const dynPath = require.resolve(path.join(__dirname, '..', 'models', 'dynamicModel.js'));
const original = require.cache[dynPath].exports;
const DriverDoc = constructible(db.Driver);
const UserDoc = constructible(db.User);
require.cache[dynPath].exports = { ...original, createModel: (name) => (name === 'drivers' ? DriverDoc : name === 'users' ? UserDoc : original.createModel(name)) };

const { blockSensitiveDynamicCrud } = require('../lib/authMiddleware');
const dynamicController = require('../controllers/dynamicController');
const userController = require('../controllers/userController');

const run = async (handler, req) => {
  let out;
  const res = {
    code: 200,
    setHeader() {},
    status(c) { this.code = c; return this; },
    json(b) { out = { code: this.code, body: b }; return this; }
  };
  await handler(req, res);
  return out;
};
const gate = (method, collectionName) => {
  let passed = false; let blocked = null;
  const res = { status(c) { blocked = c; return this; }, json() { return this; } };
  blockSensitiveDynamicCrud({ method, params: { collectionName } }, res, () => { passed = true; });
  return { passed, blocked };
};

test('POST /drivers reaches the sign-up handler; reading, changing and deleting stay blocked', () => {
  assert.equal(gate('POST', 'drivers').passed, true);
  for (const m of ['GET', 'PUT', 'DELETE']) assert.equal(gate(m, 'drivers').blocked, 403);
  assert.equal(gate('POST', 'users').blocked, 403); // the generic create is still shut for riders and admins
  assert.equal(gate('POST', 'admins').blocked, 403);
  assert.equal(gate('GET', 'trips').passed, true);
});

test('a driver signs up from the app into the app\'s own business, unverified and offline', async () => {
  db.Driver.rows.length = 0;
  const r = await run(dynamicController.createRecord, {
    params: { collectionName: 'drivers' },
    body: { name: 'Ravi Kumar', email: 'ravi@example.com', phoneNumber: '9811122233', password: 'x' },
    appTenant: { tenantId: 'app_uride' }
  });
  assert.equal(r.code, 201, JSON.stringify(r.body).slice(0, 300));
  const d = db.Driver.rows[0];
  assert.equal(d.tenantId, 'app_uride');
  assert.equal(d.isOnline, false);
  assert.equal(d.isPhoneVerified, false);
  assert.equal(d.phone, '9811122233');
  assert.equal(savedOtps.some((o) => o.driverId === d.driverId), true, 'a sign-in code was created');
  assert.equal(JSON.stringify(r.body).includes('passwordHash'), false);
});

test('a driver cannot sign up with a number that exists in another stored form', async () => {
  db.Driver.rows.length = 0;
  await db.Driver.create({ driverId: 'D1', email: 'anil@example.com', phone: '+919876543210', firstName: 'Anil', tenantId: 'app_uride' });
  const r = await run(dynamicController.createRecord, {
    params: { collectionName: 'drivers' },
    body: { name: 'Anil Again', email: 'other@example.com', phoneNumber: '9876543210' },
    appTenant: { tenantId: 'app_uride' }
  });
  assert.equal(r.code, 400);
  assert.equal(r.body.data.field, 'phone');
  assert.equal(db.Driver.rows.length, 1);
});

test('a driver cannot set privileged fields while signing up', async () => {
  db.Driver.rows.length = 0;
  await run(dynamicController.createRecord, {
    params: { collectionName: 'drivers' },
    body: {
      name: 'Sneaky Driver', email: 's@example.com', phoneNumber: '9000011122',
      accountStatus: 'ACTIVE', isVerified: true, eligibleCategoryId: 'vc_x', operatingRegionId: 'rg_x', tenantId: 'app_other', walletBalance: 99999
    },
    appTenant: { tenantId: 'app_uride' }
  });
  const d = db.Driver.rows[0];
  assert.equal(d.tenantId, 'app_uride');
  assert.equal(d.isVerified, false);
  assert.equal(d.walletBalance, 0);
  assert.ok(!d.eligibleCategoryId && !d.operatingRegionId);
});

test('a rider registers into the app\'s own business', async () => {
  db.User.rows.length = 0;
  const r = await run(userController.registerUser, {
    body: { name: 'Rita Rider', phone: '9822233344', email: 'rita@example.com' },
    appTenant: { tenantId: 'app_uride' }
  });
  assert.equal(r.code, 201);
  assert.equal(db.User.rows[0].tenantId, 'app_uride');
});

test('a rider cannot register with a number that exists in another stored form', async () => {
  db.User.rows.length = 0;
  await db.User.create({ userId: 'U1', phone: '+919822233344', name: 'Rita' });
  const r = await run(userController.registerUser, {
    body: { name: 'Rita Two', phone: '9822233344' },
    appTenant: { tenantId: 'app_uride' }
  });
  assert.equal(r.code >= 400 && r.code < 500, true);
  assert.equal(db.User.rows.length, 1);
});
