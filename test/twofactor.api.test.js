// Two-step verification: required for the platform owner, optional for businesses, never replayable, never in the clear.
process.env.JWT_SECRET = 'test-secret-for-2fa-tests';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.REQUIRE_PLATFORM_2FA = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');
const { createFakeDb } = require('./helpers/fakeDb');
const { createMemoryStorage } = require('./helpers/memoryStorage');
const { jsonBodyParser } = require('../lib/jsonBody');

process.env.REQUIRE_PLATFORM_2FA = '1'; // the fake DB helper defaults it off; this file is about it being on
const db = createFakeDb();
db.install();
require('../lib/privateStorage').setBackend(createMemoryStorage());
const totp = require('../lib/totp');
const adminRoutes = require('../routes/adminRoutes');

let server;
let base;
test.before(async () => {
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha Cabs', slug: 'a', appName: 'A', packageName: 'com.a', status: 'active', plan: 'standard' });
  const mk = (adminId, email, role, tenantId) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: bcrypt.hashSync('password-123456', 4) });
  await mk('s1', 'super@x.test', 'super_admin', null);
  await mk('s2', 'super2@x.test', 'super_admin', null);
  await mk('a1', 'owner@a.test', 'client_admin', 'app_a');
  await mk('a2', 'ops@a.test', 'operations', 'app_a');
  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
test.after(() => server.close());

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = (email) => call('POST', '/auth/login', { body: { email, password: 'password-123456' } });
const user = (id) => db.AdminUser.rows.find((u) => u.adminId === id);
const now = () => totp.codeAt(sealedSecret.current, Math.floor(Date.now() / 30000));
const sealedSecret = { current: null };

test('the platform owner can sign in but can use nothing except setup until two-step verification is on', async () => {
  const r = await login('super@x.test');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.user.twoFactorSetupRequired, true);
  const token = r.body.data.token;
  assert.equal((await call('GET', '/auth/me', { token })).status, 200, 'profile works');
  for (const p of ['/platform/overview', '/tenants', '/platform/revenue/summary', '/platform/team']) {
    const x = await call('GET', p, { token });
    assert.equal(x.status, 403, p);
    assert.equal(x.body.error, 'TWO_FACTOR_SETUP_REQUIRED', p);
  }
  assert.equal((await call('POST', '/auth/2fa/disable', { token, body: {} })).status, 403, 'required: cannot be turned off');
});

test('business admins are not forced', async () => {
  const r = await login('owner@a.test');
  assert.equal(r.body.data.user.twoFactorSetupRequired, false);
  assert.equal((await call('GET', '/business/overview', { token: r.body.data.token })).status, 200);
});

test('setup: the secret is shown once, nothing is on until a code is confirmed, recovery codes come once, secret is stored encrypted', async () => {
  const token = (await login('super@x.test')).body.data.token;
  const setup = await call('POST', '/auth/2fa/setup', { token });
  assert.equal(setup.status, 200);
  assert.match(setup.body.data.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.body.data.otpauthUri, /^otpauth:\/\/totp\/AutoMet%20Platform%3Asuper%40x\.test\?secret=/);
  sealedSecret.current = setup.body.data.secret;
  assert.equal(user('s1').totpEnabled, false);
  const bad = await call('POST', '/auth/2fa/enable', { token, body: { code: '000000' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.code);
  const on = await call('POST', '/auth/2fa/enable', { token, body: { code: now() } });
  assert.equal(on.status, 200);
  assert.equal(on.body.data.recoveryCodes.length, 8);
  assert.match(on.body.data.recoveryCodes[0], /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  assert.equal(on.body.data.user.twoFactorEnabled, true);
  assert.equal(on.body.data.user.twoFactorSetupRequired, false);
  ctx.recovery = on.body.data.recoveryCodes;
  const stored = JSON.stringify(user('s1'));
  assert.ok(!stored.includes(setup.body.data.secret), 'the secret is not stored in the clear');
  for (const c of on.body.data.recoveryCodes) assert.ok(!stored.includes(c), 'recovery codes are stored as hashes');
  assert.equal((await call('GET', '/platform/overview', { token: on.body.data.token })).status, 200, 'the fresh token works');
  assert.equal((await call('GET', '/platform/overview', { token })).status, 401, 'the old session was ended');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'auth.two_factor_enabled'));
});
const ctx = {};

test('sign-in now needs the code: the password alone opens nothing', async () => {
  const r = await login('super@x.test');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.twoFactorRequired, true);
  assert.equal(r.body.data.token, undefined);
  assert.ok(r.body.data.challenge);
  assert.equal((await call('GET', '/auth/me', { token: r.body.data.challenge })).status, 401, 'the challenge is not a session');
  ctx.challenge = r.body.data.challenge;
});

test('a wrong code is refused and counted; the right one signs in; the same code cannot be used twice', async () => {
  assert.equal((await call('POST', '/auth/2fa/verify', { body: { challenge: ctx.challenge, code: '123456' } })).status, 401);
  assert.equal(user('s1').failedLogins, 1);
  assert.equal((await call('POST', '/auth/2fa/verify', { body: { challenge: 'garbage', code: now() } })).status, 401);
  // the code used to enable it is in the past step; wait for a fresh one by using the next step's code
  const next = totp.codeAt(sealedSecret.current, Math.floor(Date.now() / 30000) + 1);
  const ok = await call('POST', '/auth/2fa/verify', { body: { challenge: ctx.challenge, code: next } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.data.token);
  assert.equal(ok.body.data.user.twoFactorEnabled, true);
  assert.equal(user('s1').failedLogins, 0);
  const again = await login('super@x.test');
  const replay = await call('POST', '/auth/2fa/verify', { body: { challenge: again.body.data.challenge, code: next } });
  assert.equal(replay.status, 401, 'a code works once');
  const log = db.AdminAudit.rows.filter((a) => a.action === 'auth.login' && a.actorEmail === 'super@x.test').pop();
  assert.deepEqual(log.meta, { twoFactor: 'app' });
});

test('a recovery code signs in once and is then gone', async () => {
  const code = ctx.recovery[0];
  const c1 = (await login('super@x.test')).body.data.challenge;
  const ok = await call('POST', '/auth/2fa/verify', { body: { challenge: c1, recoveryCode: code } });
  assert.equal(ok.status, 200);
  const c2 = (await login('super@x.test')).body.data.challenge;
  assert.equal((await call('POST', '/auth/2fa/verify', { body: { challenge: c2, recoveryCode: code } })).status, 401);
  assert.equal(user('s1').recoveryHashes.length, 7);
  assert.deepEqual(db.AdminAudit.rows.filter((a) => a.action === 'auth.login').pop().meta, { twoFactor: 'recovery-code' });
});

test('repeated wrong codes lock the account like wrong passwords do', async () => {
  const c = (await login('super@x.test')).body.data.challenge;
  for (let i = 0; i < 5; i++) await call('POST', '/auth/2fa/verify', { body: { challenge: c, code: '111111' } });
  const locked = await call('POST', '/auth/2fa/verify', { body: { challenge: c, code: totp.codeAt(sealedSecret.current, Math.floor(Date.now() / 30000) + 1) } });
  assert.equal(locked.status, 429);
  user('s1').lockUntil = null;
});

test('a business admin can turn it on and off with their password and a code; the app label is the business, not AutoMet', async () => {
  const token = (await login('owner@a.test')).body.data.token;
  const setup = await call('POST', '/auth/2fa/setup', { token });
  assert.match(setup.body.data.otpauthUri, /Alpha%20Cabs/);
  assert.ok(!/AutoMet/i.test(setup.body.data.otpauthUri));
  const secret = setup.body.data.secret;
  const on = await call('POST', '/auth/2fa/enable', { token, body: { code: totp.codeAt(secret, Math.floor(Date.now() / 30000)) } });
  assert.equal(on.status, 200);
  const t2 = on.body.data.token;
  const noPw = await call('POST', '/auth/2fa/disable', { token: t2, body: { password: 'wrong', code: totp.codeAt(secret, Math.floor(Date.now() / 30000) + 1) } });
  assert.equal(noPw.status, 400);
  const off = await call('POST', '/auth/2fa/disable', { token: t2, body: { password: 'password-123456', code: totp.codeAt(secret, Math.floor(Date.now() / 30000) + 1) } });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.user.twoFactorEnabled, false);
  assert.equal((await login('owner@a.test')).body.data.twoFactorRequired, undefined, 'back to password only');
});

test('lost phone: a business admin can reset their staff, the platform owner their client admin, another platform account a platform account; never yourself', async () => {
  // a2 (operations) turns it on; a1 (client admin) resets it
  const t2 = (await login('ops@a.test')).body.data.token;
  const s = (await call('POST', '/auth/2fa/setup', { token: t2 })).body.data.secret;
  await call('POST', '/auth/2fa/enable', { token: t2, body: { code: totp.codeAt(s, Math.floor(Date.now() / 30000)) } });
  assert.equal(user('a2').totpEnabled, true);
  const owner = (await login('owner@a.test')).body.data.token;
  assert.equal((await call('POST', '/users/a1/reset-2fa', { token: owner })).status, 400, 'not yourself');
  assert.equal((await call('POST', '/users/a2/reset-2fa', { token: owner })).status, 200);
  assert.deepEqual([user('a2').totpEnabled, user('a2').recoveryHashes.length], [false, 0]);
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'user.two_factor_reset' && a.tenantId === 'app_a'));
  // platform: s2 enrols, s1 (already enrolled) resets s2; neither may reset themselves
  const s1 = (await call('POST', '/auth/2fa/verify', { body: { challenge: (await login('super@x.test')).body.data.challenge, recoveryCode: ctx.recovery[1] } })).body.data.token;
  const s2login = (await login('super2@x.test')).body.data.token;
  const sec2 = (await call('POST', '/auth/2fa/setup', { token: s2login })).body.data.secret;
  await call('POST', '/auth/2fa/enable', { token: s2login, body: { code: totp.codeAt(sec2, Math.floor(Date.now() / 30000)) } });
  assert.equal((await call('POST', '/platform/team/s1/reset-2fa', { token: s1 })).status, 400, 'not yourself');
  assert.equal((await call('POST', '/platform/team/a1/reset-2fa', { token: s1 })).status, 404, 'a business account is not a platform account');
  assert.equal((await call('POST', '/platform/team/s2/reset-2fa', { token: s1 })).status, 200);
  assert.equal(user('s2').totpEnabled, false);
  assert.equal((await call('POST', '/platform/team/s2/reset-2fa', { token: owner })).status, 403, 'a business admin cannot');
  assert.equal((await call('POST', '/users/a2/reset-2fa', { token: s1 })).status, 403, 'the platform owner cannot reset business staff other than client admins');
});

test('with enforcement switched off (local development) the platform owner is not blocked', async () => {
  process.env.REQUIRE_PLATFORM_2FA = '0';
  try {
    const r = await login('super2@x.test');
    assert.equal(r.body.data.user.twoFactorSetupRequired, false);
    assert.equal((await call('GET', '/platform/overview', { token: r.body.data.token })).status, 200);
  } finally { process.env.REQUIRE_PLATFORM_2FA = '1'; }
});
