// Team management (edit, role change, password reset), business editing and the platform audit log, with the safety
// rules around them. In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-superadmin-tests';
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

let server;
let base;
const ctx = {};
const hash = (pw) => bcrypt.hashSync(pw, 4);
const user = (id) => db.AdminUser.rows.find((u) => u.adminId === id);

test.before(async () => {
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha', slug: 'alpha', appName: 'Alpha Go', packageName: 'com.a', status: 'active', plan: 'trial', city: 'Pune' });
  await db.Tenant.create({ tenantId: 'app_b', name: 'Beta', slug: 'beta', appName: 'Beta', packageName: 'com.b', status: 'active' });
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: hash(pw) });
  await mk('s1', 'super@x.test', 'super_admin', null, 'password-super-1');
  await mk('a1', 'owner@a.test', 'client_admin', 'app_a', 'password-a-owner');
  await mk('a2', 'second@a.test', 'client_admin', 'app_a', 'password-a-second');
  await mk('a3', 'ops@a.test', 'operations', 'app_a', 'password-a-ops1');
  await mk('a4', 'sup@a.test', 'support', 'app_a', 'password-a-supp');
  await mk('b1', 'owner@b.test', 'client_admin', 'app_b', 'password-b-owner');
  await db.AdminAudit.create({ tenantId: 'app_a', actorEmail: 'owner@a.test', action: 'driver.created', targetType: 'driver', targetId: 'd1', at: new Date(Date.now() - 5000) });
  await db.AdminAudit.create({ tenantId: 'app_b', actorEmail: 'owner@b.test', action: 'vehicle.created', targetType: 'vehicle', targetId: 'v1', at: new Date(Date.now() - 4000) });
  await db.AdminAudit.create({ tenantId: null, actorEmail: 'super@x.test', action: 'tenant.created', targetType: 'tenant', targetId: 'app_b', at: new Date(Date.now() - 3000) });

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const login = async (email, password) => (await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  ctx.super = await login('super@x.test', 'password-super-1');
  ctx.owner = await login('owner@a.test', 'password-a-owner');
  ctx.ownerB = await login('owner@b.test', 'password-b-owner');
  ctx.ops = await login('ops@a.test', 'password-a-ops1');
});
test.after(() => server.close());

const call = async (method, path, { token = ctx.owner, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('edit a team member: name and role, session ended on a role change, audited', async () => {
  assert.equal((await call('PATCH', '/users/a4', { body: {} })).status, 400, 'nothing to change');
  assert.equal((await call('PATCH', '/users/a4', { body: { name: 'x' } })).status, 400, 'name too short');
  assert.equal((await call('PATCH', '/users/a4', { body: { role: 'super_admin' } })).status, 400, 'cannot grant super admin');
  assert.equal((await call('PATCH', '/users/a4', { body: { role: 'wizard' } })).status, 400);

  const before = user('a4').tokenVersion;
  const renamed = await call('PATCH', '/users/a4', { body: { name: 'Sam Support' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.name, 'Sam Support');
  assert.equal(user('a4').tokenVersion, before, 'a rename does not end the session');

  const promoted = await call('PATCH', '/users/a4', { body: { role: 'operations' } });
  assert.equal(promoted.body.data.role, 'operations');
  assert.equal(user('a4').tokenVersion, before + 1, 'a new role means signing in again');
  const a = db.AdminAudit.rows.find((x) => x.action === 'user.updated' && x.meta.to === 'operations');
  assert.deepEqual([a.tenantId, a.targetId, a.meta.from, a.actorEmail], ['app_a', 'a4', 'support', 'owner@a.test']);
  await call('PATCH', '/users/a4', { body: { role: 'support' } });
});

test('team edits: own role, other businesses, super admins, and who may', async () => {
  assert.equal((await call('PATCH', '/users/a1', { body: { role: 'support' } })).status, 400, 'not your own role');
  assert.equal((await call('PATCH', '/users/b1', { body: { name: 'Hacked Name' } })).status, 403, "another business's person");
  assert.equal((await call('PATCH', '/users/s1', { body: { name: 'Hacked Name' } })).status, 403, 'the platform owner');
  assert.equal((await call('PATCH', '/users/nobody', { body: { name: 'Nobody At All' } })).status, 404);
  assert.equal((await call('PATCH', '/users/a4', { token: ctx.ops, body: { name: 'Not Allowed' } })).status, 403, 'operations cannot manage the team');
  assert.equal(user('b1').name, 'b1');
});

test('a business always keeps an active client admin', async () => {
  // a1 and a2 are both client admins: demoting or deactivating one is fine, the last one is refused
  assert.equal((await call('PATCH', '/users/a2', { body: { role: 'operations' } })).status, 200);
  const last = await call('PATCH', '/users/a1/active', { token: ctx.super, body: { active: false } });
  assert.equal(last.status, 400, 'a1 is now the only client admin');
  assert.match(last.body.message, /only active client admin/);
  assert.equal(user('a1').active, true);
  const demote = await call('PATCH', '/users/a1', { token: ctx.super, body: { role: 'operations' } });
  assert.equal(demote.status, 403, 'the platform owner may only manage client admin accounts, so this is refused before the last-admin rule');
  assert.equal((await call('PATCH', '/users/a2', { body: { role: 'client_admin' } })).status, 200, 'restore a second client admin');
  assert.equal((await call('PATCH', '/users/a2/active', { body: { active: false } })).status, 200, 'now one can be deactivated');
  await call('PATCH', '/users/a2/active', { body: { active: true } });
});

test('reset a password: a one-time password, forced change, sessions ended, lockout cleared, audited', async () => {
  user('a4').failedLogins = 5;
  user('a4').lockUntil = new Date(Date.now() + 600000);
  const version = user('a4').tokenVersion;
  const r = await call('POST', '/users/a4/reset-password');
  assert.equal(r.status, 200);
  const pw = r.body.data.temporaryPassword;
  assert.ok(pw && pw.length >= 12);
  assert.equal(user('a4').mustChangePassword, true);
  assert.equal(user('a4').failedLogins, 0);
  assert.equal(user('a4').lockUntil, null);
  assert.equal(user('a4').tokenVersion, version + 1);
  assert.ok(bcrypt.compareSync(pw, user('a4').passwordHash));
  assert.ok(!JSON.stringify(db.AdminAudit.rows.filter((x) => x.action === 'user.password_reset')).includes(pw), 'the password is never written to the audit log');
  const signIn = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sup@a.test', password: pw }) });
  assert.equal((await signIn.json()).data.user.mustChangePassword, true, 'the person must choose their own');
  assert.equal((await call('POST', '/users/a1/reset-password')).status, 400, 'not your own');
  assert.equal((await call('POST', '/users/b1/reset-password')).status, 403);
  assert.equal((await call('POST', '/users/s1/reset-password')).status, 403);
  assert.equal((await call('POST', '/users/a3/reset-password', { token: ctx.ops })).status, 403);
});

test('edit a business: the platform owner only; App ID and package name are fixed', async () => {
  assert.equal((await call('PATCH', '/tenants/app_a', { body: { name: 'Hacked' } })).status, 403, 'a business admin cannot');
  assert.equal((await call('PATCH', '/tenants/app_a', { token: ctx.super, body: {} })).status, 400);
  assert.equal((await call('PATCH', '/tenants/app_a', { token: ctx.super, body: { plan: 'free' } })).status, 400);
  assert.equal((await call('PATCH', '/tenants/app_a', { token: ctx.super, body: { name: 'A' } })).status, 400);
  assert.equal((await call('PATCH', '/tenants/app_a', { token: ctx.super, body: { packageName: 'com.evil' } })).status, 400);
  assert.equal((await call('PATCH', '/tenants/app_a', { token: ctx.super, body: { appId: 'app_zzz' } })).status, 400);
  assert.equal((await call('PATCH', '/tenants/nope', { token: ctx.super, body: { name: 'Whatever Co' } })).status, 404);

  const ok = await call('PATCH', '/tenants/app_a', { token: ctx.super, body: { name: 'Alpha Rides', plan: 'standard', city: 'Mumbai' } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.data.name, ok.body.data.plan, ok.body.data.city, ok.body.data.packageName, ok.body.data.appId], ['Alpha Rides', 'standard', 'Mumbai', 'com.a', 'app_a']);
  assert.equal(ok.body.data.status, 'active', 'a paid plan ends the trial');
  const a = db.AdminAudit.rows.find((x) => x.action === 'tenant.updated');
  assert.deepEqual([a.tenantId, a.meta.fields, a.meta.plan, a.actorEmail], ['app_a', 'name,city,plan,status', 'trial -> standard', 'super@x.test']);
  assert.equal(db.Tenant.rows.find((t) => t.tenantId === 'app_b').name, 'Beta', 'the other business is untouched');
});

test('platform audit log: every business and the platform, with business names; super admin only', async () => {
  const r = await call('GET', '/platform/audit?pageSize=100', { token: ctx.super });
  assert.equal(r.status, 200);
  const { items, total } = r.body.data;
  const named = Object.fromEntries(items.filter((i) => ['driver.created', 'vehicle.created', 'tenant.created'].includes(i.action)).map((i) => [i.action, i.businessName]));
  assert.deepEqual(named, { 'driver.created': 'Alpha Rides', 'vehicle.created': 'Beta', 'tenant.created': 'Platform' });
  assert.ok(total >= 3);
  assert.equal(items[0].at >= items[items.length - 1].at, true, 'newest first');
  const onlyB = (await call('GET', '/platform/audit?tenantId=app_b', { token: ctx.super })).body.data.items;
  assert.ok(onlyB.length >= 1 && onlyB.every((i) => i.tenantId === 'app_b'));
  assert.equal((await call('GET', '/platform/audit?action=vehicle.', { token: ctx.super })).body.data.items.length, 1);
  assert.equal((await call('GET', '/platform/audit?from=nope', { token: ctx.super })).status, 400);
  assert.equal((await call('GET', '/platform/audit', { token: ctx.owner })).status, 403, 'a business admin cannot read the platform log');
  assert.equal((await fetch(base + '/platform/audit')).status, 401);
});
