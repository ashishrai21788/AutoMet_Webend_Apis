// The platform owner (super admin) and a business's own staff must never cross over: who can reach which route, over HTTP.
// In-memory stand-ins. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-boundary-tests';
process.env.RATE_LIMIT_DISABLED = '1';

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
const { can, ROLE_PERMISSIONS, PLATFORM_PERMISSIONS, BUSINESS_PERMISSIONS } = require('../lib/adminPermissions');

let server;
let base;
const ctx = {};
test.before(async () => {
  for (const [id, name] of [['app_a', 'Alpha'], ['app_b', 'Beta']]) await db.Tenant.create({ tenantId: id, name, slug: name.toLowerCase(), appName: name, packageName: `com.${name.toLowerCase()}`, status: 'active', plan: 'standard' });
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: bcrypt.hashSync(pw, 4) });
  await mk('s1', 'super1@x.test', 'super_admin', null, 'password-super-1');
  await mk('s2', 'super2@x.test', 'super_admin', null, 'password-super-2');
  await mk('a1', 'owner@a.test', 'client_admin', 'app_a', 'password-a-owner');
  await mk('a2', 'ops@a.test', 'operations', 'app_a', 'password-a-ops');
  await mk('b1', 'owner@b.test', 'client_admin', 'app_b', 'password-b-owner');
  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const login = async (email, password) => (await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  ctx.s1 = await login('super1@x.test', 'password-super-1');
  ctx.owner = await login('owner@a.test', 'password-a-owner');
  ctx.ops = await login('ops@a.test', 'password-a-ops');
  ctx.ownerB = await login('owner@b.test', 'password-b-owner');
});
test.after(() => server.close());

const call = async (method, path, { token, appId, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(appId ? { 'X-App-Id': appId } : {}) }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : null };
};
const user = (id) => db.AdminUser.rows.find((u) => u.adminId === id);

test('permissions: the platform and business domains do not overlap', () => {
  assert.deepEqual(ROLE_PERMISSIONS.super_admin, PLATFORM_PERMISSIONS);
  assert.equal(PLATFORM_PERMISSIONS.filter((p) => BUSINESS_PERMISSIONS.includes(p)).length, 0);
  for (const role of ['client_admin', 'operations', 'support', 'finance']) {
    for (const p of PLATFORM_PERMISSIONS) assert.equal(can({ role }, p), false, `${role} must not have ${p}`);
  }
  for (const p of BUSINESS_PERMISSIONS) assert.equal(can({ role: 'super_admin' }, p), false, `super_admin must not have ${p}`);
  assert.equal(can({ role: 'super_admin' }, ['team.manage', 'clients.manage']), true, 'any-of: one matching permission is enough');
  assert.equal(can({ role: 'finance' }, ['team.manage', 'clients.manage']), false);
  assert.equal(can({ role: 'nobody' }, 'dashboard.view'), false);
});

test('a super admin is refused on every business operations route, with or without naming a business', async () => {
  const paths = ['/business/overview', '/business/stats', '/business/drivers', '/business/vehicles', '/business/regions', '/business/categories', '/business/fare-rules', '/business/audit', '/business/alerts', '/business/support/issues', '/business/reports/summary', '/business/riders', '/business/trips', '/business', '/business/ride-settings', '/business/live-map'];
  for (const p of paths) {
    for (const appId of [undefined, 'app_a']) {
      const r = await call('GET', p, { token: ctx.s1, appId });
      assert.equal(r.status, 403, `${p} ${appId || ''}`);
    }
  }
  assert.equal((await call('POST', '/business/drivers', { token: ctx.s1, appId: 'app_a', body: {} })).status, 403);
  assert.equal((await call('PUT', '/business/fare-rules', { token: ctx.s1, appId: 'app_a', body: {} })).status, 403);
});

test('business staff are refused on every platform route', async () => {
  const routes = [['GET', '/platform/overview'], ['GET', '/platform/audit'], ['GET', '/platform/team'], ['POST', '/platform/team'], ['PATCH', '/platform/team/s2'], ['PATCH', '/platform/team/s2/active'], ['POST', '/platform/team/s2/reset-password'],
    ['GET', '/platform/revenue/summary'], ['GET', '/platform/plans'], ['GET', '/platform/settings'], ['POST', '/tenants'], ['PATCH', '/tenants/app_a'], ['PATCH', '/tenants/app_a/status'], ['GET', '/tenants/app_a/billing']];
  for (const [m, p] of routes) {
    for (const [who, token] of [['client admin', ctx.owner], ['operations', ctx.ops]]) {
      assert.equal((await call(m, p, { token, body: {} })).status, 403, `${who}: ${m} ${p}`);
    }
    assert.equal((await call(m, p, { body: {} })).status, 401, `signed out: ${m} ${p}`);
  }
});

test('the business list shows a business admin only their own business', async () => {
  const mine = await call('GET', '/tenants', { token: ctx.owner });
  assert.deepEqual(mine.body.data.map((t) => t.appId), ['app_a']);
  const all = await call('GET', '/tenants', { token: ctx.s1 });
  assert.deepEqual(all.body.data.map((t) => t.appId).sort(), ['app_a', 'app_b']);
});

test('another business cannot be reached by naming it', async () => {
  for (const p of ['/business/overview', '/business/drivers', '/business/audit']) {
    assert.equal((await call('GET', p, { token: ctx.ownerB, appId: 'app_a' })).status, 403, p);
    assert.equal((await call('GET', p, { token: ctx.owner, appId: 'app_b' })).status, 403, p);
  }
  assert.equal((await call('GET', '/business/overview', { token: ctx.owner })).status, 200, 'their own works');
});

test('team: the platform owner manages only client admin accounts; a business manages its own staff', async () => {
  const list = await call('GET', '/users?tenantId=app_a', { token: ctx.s1 });
  assert.equal(list.status, 200);
  const create = await call('POST', '/users', { token: ctx.s1, body: { name: 'Ops Person', email: 'newops@a.test', role: 'operations', tenantId: 'app_a' } });
  assert.equal(create.status, 403, 'not an operations account');
  const admin = await call('POST', '/users', { token: ctx.s1, body: { name: 'New Owner', email: 'newowner@a.test', role: 'client_admin', tenantId: 'app_a' } });
  assert.equal(admin.status, 201);
  assert.equal(admin.body.data.role, 'client_admin');
  assert.equal((await call('PATCH', '/users/a2', { token: ctx.s1, body: { name: 'Renamed' } })).status, 403, 'an operations account of a business');
  assert.equal((await call('PATCH', '/users/a2/active', { token: ctx.s1, body: { active: false } })).status, 403);
  assert.equal((await call('POST', '/users/a2/reset-password', { token: ctx.s1 })).status, 403);
  assert.equal(user('a2').active !== false, true, 'untouched');
  assert.equal((await call('GET', '/users', { token: ctx.ops })).status, 403, 'operations cannot manage a team');
  // the business admin runs its own team, and only its own
  assert.equal((await call('PATCH', '/users/a2', { token: ctx.owner, body: { role: 'support' } })).status, 200);
  assert.equal((await call('PATCH', '/users/b1/active', { token: ctx.owner, body: { active: false } })).status, 403, 'not another business\'s admin');
});

test('platform team: create, rename, reset, deactivate; never yourself, never the last one; audited without a business', async () => {
  assert.equal((await call('POST', '/platform/team', { token: ctx.s1, body: { name: 'X', email: 'bad' } })).status, 400);
  assert.equal((await call('POST', '/platform/team', { token: ctx.s1, body: { name: 'Third Person', email: 'super1@x.test' } })).status, 409, 'email already in use');
  const made = await call('POST', '/platform/team', { token: ctx.s1, body: { name: 'Third Person', email: 'super3@x.test' } });
  assert.equal(made.status, 201);
  assert.equal(made.body.data.role, 'super_admin');
  assert.ok(made.body.data.temporaryPassword.length >= 12);
  assert.equal(user(made.body.data.id).mustChangePassword, true);
  const id = made.body.data.id;
  assert.deepEqual((await call('GET', '/platform/team', { token: ctx.s1 })).body.data.map((u) => u.role), ['super_admin', 'super_admin', 'super_admin'], 'only platform accounts, never a business\'s staff');
  assert.equal((await call('PATCH', `/platform/team/${id}`, { token: ctx.s1, body: { name: 'Renamed Person' } })).body.data.name, 'Renamed Person');
  assert.equal((await call('PATCH', '/platform/team/a1', { token: ctx.s1, body: { name: 'Hijack' } })).status, 404, 'a business account is not a platform account');
  assert.equal((await call('PATCH', '/platform/team/s1/active', { token: ctx.s1, body: { active: false } })).status, 400, 'not yourself');
  assert.equal((await call('POST', '/platform/team/s1/reset-password', { token: ctx.s1 })).status, 400);
  const before = user('s2').tokenVersion || 0;
  assert.equal((await call('PATCH', '/platform/team/s2/active', { token: ctx.s1, body: { active: false } })).status, 200);
  assert.equal(user('s2').tokenVersion, before + 1, 'their sessions end');
  assert.equal((await call('PATCH', `/platform/team/${id}/active`, { token: ctx.s1, body: { active: false } })).status, 200);
  const sole = await call('PATCH', '/platform/team/s1/active', { token: ctx.s1, body: { active: false } });
  assert.equal(sole.status, 400);
  const log = db.AdminAudit.rows.filter((a) => /^platform_user\./.test(a.action));
  assert.ok(log.length >= 4 && log.every((a) => a.tenantId === null), 'platform events carry no business');
  assert.ok(!JSON.stringify(db.AdminAudit.rows).includes(made.body.data.temporaryPassword), 'the one-time password is never logged');
});

test('business admins never see platform events in their own audit log', async () => {
  const r = await call('GET', '/business/audit', { token: ctx.owner });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.items.every((a) => !/^(platform_user|plan|subscription|invoice|platform)\./.test(a.action)));
});
