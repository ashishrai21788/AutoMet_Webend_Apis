// Who may go online and receive rides, over HTTP for the real go-online handler and the admin ride settings, plus the pure rules.
process.env.JWT_SECRET = 'test-secret-for-availability-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');
const { createFakeDb } = require('./helpers/fakeDb');
const { createMemoryStorage } = require('./helpers/memoryStorage');
const { jsonBodyParser } = require('../lib/jsonBody');

const db = createFakeDb();
db.install();
require('../lib/privateStorage').setBackend(createMemoryStorage());
const adminRoutes = require('../routes/adminRoutes');
const dynamicController = require('../controllers/dynamicController');
const { appTenantMiddleware, clearAppTenantCache } = require('../lib/appTenant');
const { evaluateAvailability, checkDriverAvailable, validateRideSettings } = require('../lib/driverAvailability');

const NOW = new Date('2026-10-04T00:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86400000);

// ---------- pure rules ----------

const verifiedDriver = { driverId: 'd', accountStatus: 'ACTIVE', driverVerificationStatus: 'APPROVED', verificationExpiresAt: day(90), operatingRegionId: 'r1', eligibleCategoryId: 'c1' };
const goodVehicle = { status: 'ACTIVE', verificationStatus: 'APPROVED', verificationExpiresAt: day(90), categoryId: 'c1', operatingRegionId: 'r1' };
const region = { regionId: 'r1', active: true };
const on = { rideSettings: { requireEligibleDrivers: true } };
const off = { rideSettings: {} };

test('rule 1: a suspended or inactive account is never available, whatever the setting', () => {
  for (const status of ['SUSPENDED', 'INACTIVE']) {
    for (const tenant of [on, off, null]) {
      const r = evaluateAvailability({ driver: { ...verifiedDriver, accountStatus: status }, tenant, vehicle: goodVehicle, region, now: NOW });
      assert.equal(r.available, false, `${status} ${JSON.stringify(tenant)}`);
      assert.equal(r.code, 'DRIVER_ACCOUNT_NOT_ACTIVE');
      assert.match(r.message, /account is (suspended|inactive)/);
    }
  }
});

test('rule 2: full eligibility is required only when the business turns it on', () => {
  const unverified = { driverId: 'd', accountStatus: 'ACTIVE', operatingRegionId: null }; // an old driver, never verified, no vehicle
  const lenient = evaluateAvailability({ driver: unverified, tenant: off, vehicle: null, region: null, now: NOW });
  assert.equal(lenient.available, true, 'off by default: existing drivers keep working');
  assert.equal(lenient.enforced, false);
  assert.equal(lenient.eligibility.eligible, false, 'but the eligibility is still reported');

  const strict = evaluateAvailability({ driver: unverified, tenant: on, vehicle: null, region: null, now: NOW });
  assert.equal(strict.available, false);
  assert.equal(strict.code, 'DRIVER_NOT_ELIGIBLE');
  assert.ok(strict.reasons.length >= 3);
  assert.match(strict.message, /^You cannot go online yet: /);

  assert.equal(evaluateAvailability({ driver: verifiedDriver, tenant: on, vehicle: goodVehicle, region, now: NOW }).available, true);
  assert.equal(evaluateAvailability({ driver: verifiedDriver, tenant: on, vehicle: { ...goodVehicle, status: 'INACTIVE' }, region, now: NOW }).available, false);
  assert.equal(evaluateAvailability({ driver: { ...verifiedDriver, verificationExpiresAt: day(-1) }, tenant: on, vehicle: goodVehicle, region, now: NOW }).available, false, 'expired documents block');
});

test('ride settings validation', () => {
  assert.deepEqual(validateRideSettings({ requireEligibleDrivers: true }).value, { requireEligibleDrivers: true });
  assert.ok(validateRideSettings({ requireEligibleDrivers: 'yes' }).errors.requireEligibleDrivers);
  assert.ok(validateRideSettings({}).errors.requireEligibleDrivers);
});

// ---------- over HTTP ----------

let server;
let base;
const hash = (pw) => bcrypt.hashSync(pw, 4);
const ctx = {};

test.before(async () => {
  await db.Tenant.create({ tenantId: 'app_def', name: 'Default', slug: 'def', appName: 'D', packageName: 'in.def.app', status: 'active', isDefault: true });
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha', slug: 'a', appName: 'A', packageName: 'com.a.app', status: 'active', market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } });
  await db.Tenant.create({ tenantId: 'app_b', name: 'Beta', slug: 'b', appName: 'B', packageName: 'com.b.app', status: 'active', market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } });
  await db.ServiceRegion.create({ tenantId: 'app_a', regionId: 'rg_a', country: 'IN', state: 'S', city: 'Pune', zoneName: 'All areas', key: 'a', active: true });
  await db.VehicleCategory.create({ tenantId: 'app_a', categoryId: 'vc_a', name: 'Sedan', nameKey: 'sedan', active: true, regionIds: ['rg_a'], passengerCapacity: 4, rideType: 'economy' });
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: hash(pw) });
  await mk('u_a', 'admin@a.test', 'client_admin', 'app_a', 'password-a-admin');
  await mk('u_a_sup', 'support@a.test', 'support', 'app_a', 'password-a-supp');
  await mk('u_a_fin', 'finance@a.test', 'finance', 'app_a', 'password-a-fin1');
  await mk('u_b', 'admin@b.test', 'client_admin', 'app_b', 'password-b-admin');

  const driver = (driverId, tenantId, extra = {}) => db.Driver.create({ driverId, tenantId, firstName: driverId, lastName: 'D', email: `${driverId}@x.test`, phone: `+9100000${driverId.slice(-5)}`, passwordHash: 'x', isOnline: false, ...extra });
  await driver('drv_legacy', null); // from before businesses: the default business
  await driver('drv_a_plain', 'app_a', { operatingRegionId: 'rg_a', eligibleCategoryId: 'vc_a' }); // created, not verified
  await driver('drv_a_ready', 'app_a', { operatingRegionId: 'rg_a', eligibleCategoryId: 'vc_a', driverVerificationStatus: 'APPROVED', verificationExpiresAt: new Date(Date.now() + 90 * 86400000) });
  await db.Vehicle.create({ tenantId: 'app_a', vehicleId: 'veh_ready', registrationNumber: 'MH12 AB 1', registrationKey: 'MH12AB1', make: 'M', model: 'D', categoryId: 'vc_a', passengerCapacity: 4, operatingRegionId: 'rg_a', status: 'ACTIVE', verificationStatus: 'APPROVED', verificationExpiresAt: new Date(Date.now() + 90 * 86400000) });
  await db.DriverVehicleAssignment.create({ tenantId: 'app_a', assignmentId: 'as_1', driverId: 'drv_a_ready', vehicleId: 'veh_ready', active: true });

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  app.use('/api', appTenantMiddleware);
  // the real go-online handler (authentication is not what is under test)
  app.put('/api/drivers/online-status', dynamicController.updateOnlineStatus);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => (await (await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  ctx.admin = await login('admin@a.test', 'password-a-admin');
  ctx.support = await login('support@a.test', 'password-a-supp');
  ctx.finance = await login('finance@a.test', 'password-a-fin1');
  ctx.b = await login('admin@b.test', 'password-b-admin');
});
test.after(() => server.close());
test.beforeEach(() => clearAppTenantCache());

const admin = async (method, path, { token = ctx.admin, appId = 'app_a', body } = {}) => {
  const res = await fetch(base + '/api/admin' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-App-Id': appId }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const duty = async (driverId, isOnline, appId) => {
  const res = await fetch(base + '/api/drivers/online-status', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(appId ? { 'X-App-Id': appId } : {}) }, body: JSON.stringify({ driverId, isOnline }) });
  return { status: res.status, body: await res.json() };
};
const row = (id) => db.Driver.rows.find((d) => d.driverId === id);

test('ride settings: default off, a business admin can change it, other roles cannot, businesses are independent', async () => {
  assert.equal((await admin('GET', '/business/ride-settings')).body.data.requireEligibleDrivers, false);
  assert.equal((await admin('PUT', '/business/ride-settings', { body: { requireEligibleDrivers: 'yes' } })).status, 400);
  assert.equal((await admin('PUT', '/business/ride-settings', { token: ctx.support, body: { requireEligibleDrivers: true } })).status, 403);
  assert.equal((await admin('GET', '/business/ride-settings', { token: ctx.support })).status, 200, 'support can read it');
  assert.equal((await admin('GET', '/business/ride-settings', { token: ctx.b, appId: 'app_a' })).status, 403, 'another business cannot');
  const set = await admin('PUT', '/business/ride-settings', { body: { requireEligibleDrivers: true } });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.requireEligibleDrivers, true);
  assert.equal((await admin('GET', '/business/ride-settings', { token: ctx.b, appId: 'app_b' })).body.data.requireEligibleDrivers, false, 'business B is untouched');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'business.ride_settings_updated' && a.actorEmail === 'admin@a.test'));
  await admin('PUT', '/business/ride-settings', { body: { requireEligibleDrivers: false } });
});

test('with the setting off, an unverified driver can still go online (nothing changes for existing drivers)', async () => {
  const r = await duty('drv_a_plain', true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(row('drv_a_plain').isOnline, true);
  assert.equal((await duty('drv_legacy', true)).status, 200, 'a driver from before businesses, in the default business');
  await duty('drv_a_plain', false); await duty('drv_legacy', false);
});

test('with the setting on, only eligible drivers can go online; going offline is always allowed', async () => {
  await admin('PUT', '/business/ride-settings', { body: { requireEligibleDrivers: true } });
  const blocked = await duty('drv_a_plain', true);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.success, false);
  assert.equal(blocked.body.error, 'DRIVER_NOT_ELIGIBLE');
  assert.match(blocked.body.message, /^You cannot go online yet: /);
  assert.ok(blocked.body.data.reasons.some((x) => x.code === 'DRIVER_NOT_VERIFIED'));
  assert.ok(blocked.body.data.reasons.some((x) => x.code === 'NO_VEHICLE'));
  assert.equal(row('drv_a_plain').isOnline, false, 'the driver stays offline');

  const ready = await duty('drv_a_ready', true);
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(row('drv_a_ready').isOnline, true);

  // an ineligible driver who is somehow online can always go offline
  row('drv_a_plain').isOnline = true;
  assert.equal((await duty('drv_a_plain', false)).status, 200);
  assert.equal(row('drv_a_plain').isOnline, false);
  await duty('drv_a_ready', false);
});

test('suspending a driver takes them offline at once and keeps them from going online, regardless of the setting', async () => {
  await admin('PUT', '/business/ride-settings', { body: { requireEligibleDrivers: false } });
  assert.equal((await duty('drv_a_ready', true)).status, 200);
  assert.equal(row('drv_a_ready').isOnline, true);

  const suspend = await admin('POST', '/business/drivers/drv_a_ready/status', { body: { status: 'SUSPENDED', reason: 'Complaint under review' } });
  assert.equal(suspend.status, 200);
  assert.equal(row('drv_a_ready').isOnline, false, 'taken offline immediately');
  const again = await duty('drv_a_ready', true);
  assert.equal(again.status, 403);
  assert.equal(again.body.error, 'DRIVER_ACCOUNT_NOT_ACTIVE');
  assert.match(again.body.message, /suspended/);

  await admin('POST', '/business/drivers/drv_a_ready/status', { body: { status: 'INACTIVE' } }).catch(() => {});
  assert.equal((await admin('POST', '/business/drivers/drv_a_ready/status', { body: { status: 'ACTIVE' } })).status, 200);
  assert.equal((await duty('drv_a_ready', true)).status, 200, 'reactivated drivers can go online again');
  await duty('drv_a_ready', false);
});

test('an app that names its business can only take that business\'s drivers online', async () => {
  assert.equal((await duty('drv_a_ready', true, 'app_a')).status, 200, 'the right app');
  await duty('drv_a_ready', false);
  const wrong = await duty('drv_a_ready', true, 'app_b');
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, 'WRONG_APP');
  assert.equal(row('drv_a_ready').isOnline, false);
  assert.equal((await duty('drv_a_ready', true)).status, 200, 'an app that sends no business keeps working as before');
  await duty('drv_a_ready', false);
});

test('the ride-request check uses the same rules (suspended, and ineligible when required)', async () => {
  await admin('PUT', '/business/ride-settings', { body: { requireEligibleDrivers: true } });
  clearAppTenantCache();
  const plain = await checkDriverAvailable(row('drv_a_plain'));
  assert.equal(plain.available, false, JSON.stringify(plain.reasons));
  assert.equal(plain.code, 'DRIVER_NOT_ELIGIBLE');
  const ready = await checkDriverAvailable(row('drv_a_ready'));
  assert.equal(ready.available, true, JSON.stringify(ready.reasons));
  const legacy = await checkDriverAvailable(row('drv_legacy'));
  assert.equal(legacy.available, true, 'the default business has not turned the setting on');
  await admin('PUT', '/business/ride-settings', { body: { requireEligibleDrivers: false } });
  clearAppTenantCache();
  const offAgain = await checkDriverAvailable(row('drv_a_plain'));
  assert.equal(offAgain.available, true, `setting off again: ${JSON.stringify(offAgain.reasons)}`);
  row('drv_a_plain').accountStatus = 'SUSPENDED';
  assert.equal((await checkDriverAvailable(row('drv_a_plain'))).available, false, 'a suspension applies even when the setting is off');
  row('drv_a_plain').accountStatus = 'ACTIVE';
});

test('availability summary: counts, reasons, and who can see it', async () => {
  row('drv_a_ready').isOnline = true;
  row('drv_a_plain').isOnline = true;
  const r = await admin('GET', '/business/availability');
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.totalDrivers, 2, 'only this business\'s drivers');
  assert.equal(d.online, 2);
  assert.equal(d.onlineEligible, 1);
  assert.equal(d.onlineNotEligible, 1);
  assert.equal(d.eligible, 1);
  assert.equal(d.notEligible, 1);
  assert.equal(d.blockedBy.DRIVER_NOT_VERIFIED, 1);
  assert.equal(d.blockedBy.NO_VEHICLE, 1);
  assert.equal(d.truncated, false);
  assert.equal(d.settings.requireEligibleDrivers, false);
  assert.equal((await admin('GET', '/business/availability', { token: ctx.support })).status, 200);
  assert.equal((await admin('GET', '/business/availability', { token: ctx.finance })).status, 403);
  assert.equal((await admin('GET', '/business/availability', { token: ctx.b, appId: 'app_a' })).status, 403);
  const other = await admin('GET', '/business/availability', { token: ctx.b, appId: 'app_b' });
  assert.equal(other.body.data.totalDrivers, 0, 'business B sees none of A\'s drivers');
  row('drv_a_ready').isOnline = false; row('drv_a_plain').isOnline = false;
});
