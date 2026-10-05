// Runs the real admin routes and controller over HTTP, with in-memory stand-ins for the Mongoose models
// (no database needed). Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-admin-api-tests';
process.env.RATE_LIMIT_DISABLED = '1'; // this file signs in far more often than a person would; the limits are tested in security.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');
const { jsonBodyParser } = require('../lib/jsonBody');

const { createFakeDb } = require('./helpers/fakeDb');
const db = createFakeDb();
db.install();
const { Tenant, AdminUser } = db;

const adminRoutes = require('../routes/adminRoutes');

let server;
let base;
const hash = (pw) => bcrypt.hashSync(pw, 4);

test.before(async () => {
  await Tenant.create({ tenantId: 't_a', name: 'Client A', slug: 'a', appName: 'A', packageName: 'com.a.rider', status: 'active', plan: 'standard' });
  await Tenant.create({ tenantId: 't_b', name: 'Client B', slug: 'b', appName: 'B', packageName: 'com.b.rider', status: 'active', plan: 'standard' });
  const mk = (adminId, email, role, tenantId, pw) => AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: hash(pw) });
  await mk('a_super', 'super@x.test', 'super_admin', null, 'super-password-1');
  await mk('a_clientA', 'a@x.test', 'client_admin', 't_a', 'client-password-1');
  await mk('a_clientB', 'b@x.test', 'client_admin', 't_b', 'client-password-2');
  await mk('a_supportA', 'support-a@x.test', 'support', 't_a', 'support-password-1');
  await mk('a_lock', 'lock@x.test', 'client_admin', 't_a', 'lock-password-1');

  const app = express();
  app.use(jsonBodyParser()); // the same parser index.js uses
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
test.after(() => server.close());

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}
const login = async (email, password) => (await call('POST', '/auth/login', { body: { email, password } }));
const tokenFor = async (email, password) => (await login(email, password)).body.data.token;

test('login: success returns a token and the user, never the password hash', async () => {
  const r = await login('a@x.test', 'client-password-1');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.token);
  assert.equal(r.body.data.user.role, 'client_admin');
  assert.equal(r.body.data.user.tenantId, 't_a');
  assert.equal(JSON.stringify(r.body).includes('passwordHash'), false);
});

test('login: wrong password and unknown email look the same', async () => {
  const wrong = await login('a@x.test', 'nope-nope-nope');
  const unknown = await login('ghost@x.test', 'whatever-password');
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.message, unknown.body.message);
});

test('login: five wrong passwords lock the account, even for the right password', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login('lock@x.test', 'bad-bad-bad-bad')).status, 401);
  assert.equal((await login('lock@x.test', 'lock-password-1')).status, 429);
});

test('protected routes need a token', async () => {
  assert.equal((await call('GET', '/tenants')).status, 401);
  assert.equal((await call('GET', '/dashboard')).status, 401);
});

test('a client admin sees only their own client', async () => {
  const token = await tokenFor('a@x.test', 'client-password-1');
  const r = await call('GET', '/tenants', { token });
  assert.deepEqual(r.body.data.map((t) => t.id), ['t_a']);
});

test('the super admin sees every client', async () => {
  const token = await tokenFor('super@x.test', 'super-password-1');
  const ids = (await call('GET', '/tenants', { token })).body.data.map((t) => t.id).sort();
  assert.deepEqual(ids, ['t_a', 't_b']);
});

test('isolation: a client admin cannot read another client\'s team or dashboard', async () => {
  const token = await tokenFor('a@x.test', 'client-password-1');
  assert.equal((await call('GET', '/users?tenantId=t_b', { token })).status, 403);
  assert.equal((await call('GET', '/dashboard?tenantId=t_b', { token })).status, 403);
  assert.equal((await call('GET', '/audit?tenantId=t_b', { token })).status, 403);
  const own = await call('GET', '/users', { token });
  assert.equal(own.status, 200);
  assert.ok(own.body.data.every((u) => u.tenantId === 't_a'));
});

test('isolation: a client admin cannot manage clients', async () => {
  const token = await tokenFor('a@x.test', 'client-password-1');
  const input = { name: 'New Co', appName: 'New', packageName: 'com.new.rider', city: 'X', plan: 'trial', adminName: 'N', adminEmail: 'n@x.test' };
  assert.equal((await call('POST', '/tenants', { token, body: input })).status, 403);
  assert.equal((await call('PATCH', '/tenants/t_b/status', { token, body: { status: 'suspended' } })).status, 403);
});

test('roles: support cannot manage the team', async () => {
  const token = await tokenFor('support-a@x.test', 'support-password-1');
  assert.equal((await call('GET', '/users', { token })).status, 403);
  assert.equal((await call('POST', '/users', { token, body: { name: 'x', email: 'y@x.test', role: 'support' } })).status, 403);
});

test('super admin creates a client with a temporary-password admin who can sign in and must change it', async () => {
  const token = await tokenFor('super@x.test', 'super-password-1');
  const input = { name: 'Zeta Rides', appName: 'Zeta', packageName: 'com.zeta.rider', city: 'Pune', plan: 'standard', adminName: 'Zed', adminEmail: 'Zed@Example.test' };
  const created = await call('POST', '/tenants', { token, body: input });
  assert.equal(created.status, 201);
  const { initialAdmin } = created.body.data;
  assert.equal(initialAdmin.email, 'zed@example.test');
  assert.ok(initialAdmin.temporaryPassword.length >= 12);

  const dup = await call('POST', '/tenants', { token, body: { ...input, adminEmail: 'other@example.test' } });
  assert.equal(dup.status, 409, 'same name/package is rejected');
  assert.equal(Tenant.rows.filter((t) => t.slug === 'zeta-rides').length, 1);

  const signIn = await login(initialAdmin.email, initialAdmin.temporaryPassword);
  assert.equal(signIn.status, 200);
  assert.equal(signIn.body.data.user.mustChangePassword, true);
  assert.equal(signIn.body.data.user.tenantId, created.body.data.id);

  const t = signIn.body.data.token;
  const wrongCurrent = await call('POST', '/auth/change-password', { token: t, body: { currentPassword: 'wrong-wrong-wrong', newPassword: 'a-new-password-1' } });
  assert.equal(wrongCurrent.status, 400, 'a wrong current password is a form error (a 401 would sign the person out)');
  assert.ok(wrongCurrent.body.errors.currentPassword);
  assert.equal((await call('GET', '/auth/me', { token: t })).status, 200, 'and the session is still valid');
  assert.equal((await call('POST', '/auth/change-password', { token: t, body: { currentPassword: initialAdmin.temporaryPassword, newPassword: 'short' } })).status, 400);
  const changed = await call('POST', '/auth/change-password', { token: t, body: { currentPassword: initialAdmin.temporaryPassword, newPassword: 'a-new-password-1' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.user.mustChangePassword, false);
  assert.equal((await call('GET', '/auth/me', { token: t })).status, 401, 'old session ends after a password change');
  assert.equal((await call('GET', '/auth/me', { token: changed.body.data.token })).status, 200);
});

test('create-client validation', async () => {
  const token = await tokenFor('super@x.test', 'super-password-1');
  const ok = { name: 'V Co', appName: 'V', packageName: 'com.v.rider', city: 'X', plan: 'trial', adminName: 'V', adminEmail: 'v@example.test' };
  assert.equal((await call('POST', '/tenants', { token, body: { ...ok, packageName: 'Bad Package' } })).status, 400);
  assert.equal((await call('POST', '/tenants', { token, body: { ...ok, adminEmail: 'not-an-email' } })).status, 400);
  assert.equal((await call('POST', '/tenants', { token, body: { ...ok, plan: 'gold' } })).status, 400);
  assert.equal((await call('POST', '/tenants', { token, body: { ...ok, adminEmail: 'a@x.test' } })).status, 409);
});

test('suspending a client ends its sessions and blocks sign-in; activating restores it', async () => {
  const superToken = await tokenFor('super@x.test', 'super-password-1');
  const bToken = await tokenFor('b@x.test', 'client-password-2');
  assert.equal((await call('GET', '/auth/me', { token: bToken })).status, 200);

  const suspended = await call('PATCH', '/tenants/t_b/status', { token: superToken, body: { status: 'suspended' } });
  assert.equal(suspended.status, 200);
  assert.equal((await call('GET', '/auth/me', { token: bToken })).status, 401, 'existing sessions end immediately');
  assert.equal((await login('b@x.test', 'client-password-2')).status, 403, 'and new sign-ins are refused');
  // the other client is unaffected
  assert.equal((await login('a@x.test', 'client-password-1')).status, 200);

  await call('PATCH', '/tenants/t_b/status', { token: superToken, body: { status: 'active' } });
  assert.equal((await login('b@x.test', 'client-password-2')).status, 200);
  assert.equal((await call('PATCH', '/tenants/t_b/status', { token: superToken, body: { status: 'bogus' } })).status, 400);
  assert.equal((await call('PATCH', '/tenants/nope/status', { token: superToken, body: { status: 'active' } })).status, 404);
});

test('team: a client admin adds people to their own client only, and cannot create a super admin', async () => {
  const token = await tokenFor('a@x.test', 'client-password-1');
  // a spoofed tenantId in the body is ignored for client admins
  const r = await call('POST', '/users', { token, body: { name: 'Op One', email: 'op1@x.test', role: 'operations', tenantId: 't_b' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.tenantId, 't_a');
  assert.ok(r.body.data.temporaryPassword);
  assert.equal((await call('POST', '/users', { token, body: { name: 'Evil', email: 'evil@x.test', role: 'super_admin' } })).status, 400);
  assert.equal((await call('POST', '/users', { token, body: { name: 'Dup', email: 'op1@x.test', role: 'support' } })).status, 409);
});

test('team: deactivating a user ends their session; cross-client and self changes are refused', async () => {
  const token = await tokenFor('a@x.test', 'client-password-1');
  const supportToken = await tokenFor('support-a@x.test', 'support-password-1');
  assert.equal((await call('PATCH', '/users/a_supportA/active', { token, body: { active: false } })).status, 200);
  assert.equal((await call('GET', '/auth/me', { token: supportToken })).status, 401);
  assert.equal((await login('support-a@x.test', 'support-password-1')).status, 401);

  assert.equal((await call('PATCH', '/users/a_clientB/active', { token, body: { active: false } })).status, 403);
  assert.equal((await call('PATCH', '/users/a_clientA/active', { token, body: { active: false } })).status, 400);
  assert.equal((await call('PATCH', '/users/a_super/active', { token, body: { active: false } })).status, 403);
  assert.equal((await call('PATCH', '/users/a_clientA/active', { token, body: { active: 'no' } })).status, 400);
});

test('audit log records who did what, scoped by client', async () => {
  const superToken = await tokenFor('super@x.test', 'super-password-1');
  const all = await call('GET', '/platform/audit?pageSize=100', { token: superToken });
  assert.equal(all.status, 200);
  const actions = all.body.data.items.map((r) => r.action);
  assert.ok(actions.includes('tenant.created'));
  assert.ok(actions.includes('tenant.status_changed'));
  assert.ok(actions.includes('auth.login'));
});

test('sign-in upgrades an older, slower password hash and keeps working', async () => {
  const row = AdminUser.rows.find((u) => u.email === 'a@x.test');
  row.passwordHash = bcrypt.hashSync('client-password-1', 12);
  assert.equal(bcrypt.getRounds(row.passwordHash), 12);
  assert.equal((await login('a@x.test', 'client-password-1')).status, 200);
  assert.equal(bcrypt.getRounds(row.passwordHash), 10);
  assert.equal((await login('a@x.test', 'client-password-1')).status, 200, 'the upgraded hash still verifies');
  assert.equal((await login('a@x.test', 'wrong-wrong-wrong')).status, 401);
});

test('a malformed JSON body is the caller\'s mistake (400), not a server error', async () => {
  const token = await tokenFor('super@x.test', 'super-password-1');
  const res = await fetch(base + '/tenants', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{bad json' });
  assert.equal(res.status, 400);
  const empty = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '' });
  assert.notEqual(empty.status, 500, 'an empty body is still handled');
});
