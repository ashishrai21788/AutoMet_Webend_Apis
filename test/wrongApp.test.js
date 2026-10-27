// A rider or driver signed in to one business must be refused when the request names another business's app (X-App-Id).
// Requests that name no app keep working (older builds), and an account with no business tag belongs to the default business.
process.env.JWT_SECRET = 'test-secret-for-wrong-app';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.AUTH_ENFORCEMENT = 'strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const { requireAuth } = require('../lib/authMiddleware');
const { clearAppTenantCache } = require('../lib/appTenant');

const reset = async () => {
  for (const m of ['Tenant', 'User', 'Driver']) db[m].rows.length = 0;
  clearAppTenantCache();
  await db.Tenant.create({ tenantId: 'app_default', name: 'Default', slug: 'default', appName: 'Default', packageName: 'com.default', isDefault: true });
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha', slug: 'alpha', appName: 'Alpha', packageName: 'com.alpha' });
  await db.Tenant.create({ tenantId: 'app_b', name: 'Beta', slug: 'beta', appName: 'Beta', packageName: 'com.beta' });
  const tok = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
  const tb = tok({ userId: 'UB' });
  await db.User.create({ userId: 'UB', firstName: 'B', lastName: 'Rider', phone: '+919800000002', tenantId: 'app_b', accessToken: tb });
  const td = tok({ driverId: 'DB' });
  await db.Driver.create({ driverId: 'DB', firstName: 'B', lastName: 'Driver', phone: '+919800000003', email: 'db@t.test', tenantId: 'app_b', accessToken: td });
  const tl = tok({ userId: 'UL' });
  await db.User.create({ userId: 'UL', firstName: 'Old', lastName: 'Rider', phone: '+919800000004', accessToken: tl }); // no business tag: the default business
  return { tb, td, tl };
};

const run = async (token, appId, role = 'any') => {
  const headers = { authorization: `Bearer ${token}`, ...(appId ? { 'x-app-id': appId } : {}) };
  const req = { headers, body: {}, path: '/x', appTenant: appId ? { tenantId: appId } : { tenantId: 'app_default' } };
  let out = null; let passed = false;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await requireAuth({ roles: [role] })(req, res, () => { passed = true; });
  return { passed, out };
};

test('a rider of business B is refused when the request names business A', async () => {
  const { tb } = await reset();
  const r = await run(tb, 'app_a');
  assert.equal(r.passed, false);
  assert.equal(r.out.code, 403);
  assert.match(JSON.stringify(r.out.body), /WRONG_APP/);
});

test('a driver of business B is refused when the request names business A', async () => {
  const { td } = await reset();
  const r = await run(td, 'app_a');
  assert.equal(r.passed, false);
  assert.equal(r.out.code, 403);
});

test('the same business, no app named, and an untagged account on the default business all pass', async () => {
  const { tb, td, tl } = await reset();
  assert.equal((await run(tb, 'app_b')).passed, true, 'B on B');
  assert.equal((await run(td, 'app_b')).passed, true, 'B driver on B');
  assert.equal((await run(tb, null)).passed, true, 'an older build that names no app');
  assert.equal((await run(tl, 'app_default')).passed, true, 'an untagged account on the default business');
  assert.equal((await run(tl, null)).passed, true);
  const crossed = await run(tl, 'app_a');
  assert.equal(crossed.passed, false, 'an untagged (default) account cannot use A either');
});
