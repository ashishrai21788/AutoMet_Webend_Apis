// Minimum app version: the form is validated, the public config carries the policy, and old builds are refused with 426.
process.env.JWT_SECRET = 'test-secret-for-app-versions';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const versions = require('../lib/appVersions');
const A = require('../controllers/appVersionsController');
const { buildPublicConfig } = require('../lib/publicConfig');
const { clearAppTenantCache } = require('../lib/appTenant');

const tenant = (appVersions) => ({ tenantId: 't1', name: 'uRide', appName: 'uRide', appVersions });
const reset = () => { for (const m of ['Tenant', 'AdminAudit']) db[m].rows.length = 0; clearAppTenantCache(); };

const admin = async (fn, { body = {} } = {}) => {
  const req = { body, params: {}, query: {}, ip: '1.1.1.1', business: { tenantId: 't1' }, data: { update: (M, f, v) => db.Tenant.findOneAndUpdate({ tenantId: 't1' }, { $set: v }, { new: true }) }, admin: { adminId: 'A1', email: 'a@t.local', role: 'client_admin' } };
  let out;
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};
const gateRun = (headers, t, path = '/v1/trips/estimate') => {
  let out = null; let nexted = false;
  const res = { status(c) { out = { code: c }; return this; }, json(b) { out.body = b; return this; } };
  versions.enforceMinAppVersion({ headers, path, appTenant: t }, res, () => { nexted = true; });
  return { out, nexted };
};

test('nothing is blocked until a minimum is set', () => {
  assert.equal(versions.settingsOf(tenant()).rider.minVersionCode, 0);
  assert.equal(gateRun({ 'x-app-type': 'rider', 'x-app-version-code': '1' }, tenant()).nexted, true);
  assert.equal(gateRun({ 'x-app-type': 'rider', 'x-app-version-code': '1' }, null).nexted, true, 'no business, no gate');
});

test('a build below its minimum gets 426 UPDATE_REQUIRED with the message and store link', () => {
  const t = tenant({ rider: { minVersionCode: 5, message: 'Please update uRide', storeUrl: 'https://play.google.com/store/apps/details?id=x' }, driver: { minVersionCode: 0 } });
  const r = gateRun({ 'x-app-type': 'rider', 'x-app-version-code': '4' }, t);
  assert.equal(r.nexted, false);
  assert.equal(r.out.code, 426);
  assert.equal(r.out.body.code, 'UPDATE_REQUIRED');
  assert.equal(r.out.body.message, 'Please update uRide');
  assert.equal(r.out.body.data.minVersionCode, 5);
  assert.equal(r.out.body.data.storeUrl, 'https://play.google.com/store/apps/details?id=x');
});

test('the same build or newer goes through; the other app is judged by its own minimum', () => {
  const t = tenant({ rider: { minVersionCode: 5 }, driver: { minVersionCode: 9 } });
  assert.equal(gateRun({ 'x-app-type': 'rider', 'x-app-version-code': '5' }, t).nexted, true);
  assert.equal(gateRun({ 'x-app-type': 'rider', 'x-app-version-code': '40' }, t).nexted, true);
  assert.equal(gateRun({ 'x-app-type': 'driver', 'x-app-version-code': '8' }, t).out.code, 426);
  assert.equal(gateRun({ 'x-app-type': 'driver', 'x-app-version-code': '9' }, t).nexted, true);
});

test('a request that does not say its version is never blocked, nor is the public config', () => {
  const t = tenant({ rider: { minVersionCode: 5 }, driver: { minVersionCode: 5 } });
  assert.equal(gateRun({}, t).nexted, true, 'no headers (an older build, a script)');
  assert.equal(gateRun({ 'x-app-type': 'rider' }, t).nexted, true, 'no version');
  assert.equal(gateRun({ 'x-app-version-code': '1' }, t).nexted, true, 'no app type');
  assert.equal(gateRun({ 'x-app-type': 'rider', 'x-app-version-code': 'abc' }, t).nexted, true, 'not a number');
  assert.equal(gateRun({ 'x-app-type': 'rider', 'x-app-version-code': '1' }, t, '/v1/public/business/config').nexted, true, 'the app must be able to read the policy');
});

test('the default message is used when the business wrote none', () => {
  const r = gateRun({ 'x-app-type': 'driver', 'x-app-version-code': '1' }, tenant({ driver: { minVersionCode: 3 } }));
  assert.equal(r.out.body.message, versions.DEFAULT_MESSAGE);
});

test('the form refuses bad values and says which field', () => {
  const bad = versions.validate({ rider: { minVersionCode: -1, message: 'x'.repeat(201), storeUrl: 'http://insecure.example.com' }, driver: { minVersionCode: 1.5, storeUrl: 'javascript:alert(1)' } });
  for (const k of ['rider.minVersionCode', 'rider.message', 'rider.storeUrl', 'driver.minVersionCode', 'driver.storeUrl']) assert.ok(bad.errors[k], k);
  const ok = versions.validate({ rider: { minVersionCode: '12', message: ' Update ', storeUrl: ' https://example.com/app ' }, driver: { minVersionCode: '' } });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.value.rider, { minVersionCode: 12, message: 'Update', storeUrl: 'https://example.com/app' });
  assert.equal(ok.value.driver.minVersionCode, 0, 'empty means no minimum');
});

test('the public config carries both minimums, and its version changes when they do', () => {
  const a = buildPublicConfig({ tenant: tenant() });
  const b = buildPublicConfig({ tenant: tenant({ rider: { minVersionCode: 7 } }) });
  assert.equal(a.appVersions.rider.minVersionCode, 0);
  assert.equal(b.appVersions.rider.minVersionCode, 7);
  assert.equal(b.appVersions.driver.minVersionCode, 0);
  assert.equal(b.appVersions.rider.message, versions.DEFAULT_MESSAGE);
  assert.notEqual(a.version, b.version, 'an app that has the old copy sees the change');
});

test('saving writes the minimums, an audit row, and refuses invalid input without writing', async () => {
  reset();
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', appName: 'uRide', isDefault: true });
  const bad = await admin(A.update, { body: { rider: { minVersionCode: -5 }, driver: {} } });
  assert.equal(bad.code, 400);
  assert.equal(db.AdminAudit.rows.length, 0);
  const ok = await admin(A.update, { body: { rider: { minVersionCode: 3, message: 'Update please' }, driver: { minVersionCode: 4 } } });
  assert.equal(ok.code, 200, JSON.stringify(ok.body).slice(0, 200));
  const saved = db.Tenant.rows[0].appVersions;
  assert.equal(saved.rider.minVersionCode, 3);
  assert.equal(saved.driver.minVersionCode, 4);
  assert.equal(db.AdminAudit.rows.length, 1);
  assert.equal(db.AdminAudit.rows[0].action, 'business.app_versions_updated');
});
