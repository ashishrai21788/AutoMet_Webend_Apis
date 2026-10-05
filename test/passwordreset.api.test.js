// Forgot / reset password: one answer for everyone, single-use expiring links, sessions ended, nothing secret leaked.
process.env.JWT_SECRET = 'test-secret-for-reset-tests';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.ADMIN_DASHBOARD_URL = 'https://dash.example.test';

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
const mailer = require('../lib/mailer');
const adminRoutes = require('../routes/adminRoutes');

const outbox = [];
let server;
let base;

test.before(async () => {
  await db.Tenant.create({ tenantId: 'app_a', name: 'A', slug: 'a', appName: 'A', packageName: 'com.a', status: 'active', plan: 'standard' });
  await db.Tenant.create({ tenantId: 'app_s', name: 'S', slug: 's', appName: 'S', packageName: 'com.s', status: 'suspended', plan: 'standard' });
  const mk = (adminId, email, role, tenantId, extra = {}) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: bcrypt.hashSync('old-password-123', 4), ...extra });
  await mk('s1', 'super@x.test', 'super_admin', null);
  await mk('a1', 'owner@a.test', 'client_admin', 'app_a');
  await mk('a2', 'off@a.test', 'operations', 'app_a', { active: false });
  await mk('x1', 'owner@s.test', 'client_admin', 'app_s');
  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
test.after(() => server.close());

const post = async (path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const user = (id) => db.AdminUser.rows.find((u) => u.adminId === id);
const tokenFrom = (mail) => /token=([0-9a-f]{64})/.exec(mail.text)[1];

test('with no email provider the request still answers the same and nothing is sent', async () => {
  mailer.setTransport(null);
  const r = await post('/auth/forgot-password', { email: 'owner@a.test' });
  assert.equal(r.status, 200);
  assert.match(r.body.data.message, /If that email belongs to an account/);
});

test('one identical answer for a known, unknown, inactive, suspended-business or malformed address; mail only to the real one', async () => {
  mailer.setTransport({ async send(m) { outbox.push(m); } });
  const answers = [];
  for (const email of ['owner@a.test', 'nobody@a.test', 'off@a.test', 'owner@s.test', 'not-an-email', '']) {
    const r = await post('/auth/forgot-password', { email });
    answers.push(JSON.stringify([r.status, r.body.data]));
  }
  assert.equal(new Set(answers).size, 1);
  assert.deepEqual(outbox.map((m) => m.to), ['owner@a.test']);
  assert.match(outbox[0].text, /^Hello a1,/);
  assert.match(outbox[0].text, /https:\/\/dash\.example\.test\/reset-password\?token=[0-9a-f]{64}/);
  assert.equal(user('a1').resetTokenHash.length, 64, 'only a hash is stored');
  assert.ok(!JSON.stringify(user('a1')).includes(tokenFrom(outbox[0])), 'the token itself is never stored');
});

test('the link sets a new password once, ends every session and unlocks the account', async () => {
  const token = tokenFrom(outbox[0]);
  user('a1').failedLogins = 5;
  user('a1').lockUntil = new Date(Date.now() + 600000);
  const version = user('a1').tokenVersion;
  assert.equal((await post('/auth/reset-password', { token, password: 'short' })).status, 400, 'too short');
  assert.equal(user('a1').resetTokenHash.length, 64, 'a rejected attempt does not use up the link');
  const ok = await post('/auth/reset-password', { token, password: 'a-brand-new-password' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.role, 'client_admin');
  assert.deepEqual([user('a1').failedLogins, user('a1').lockUntil, user('a1').resetTokenHash, user('a1').tokenVersion], [0, null, null, version + 1]);
  assert.equal((await post('/auth/login', { email: 'owner@a.test', password: 'old-password-123' })).status, 401);
  assert.equal((await post('/auth/login', { email: 'owner@a.test', password: 'a-brand-new-password' })).status, 200);
  assert.equal((await post('/auth/reset-password', { token, password: 'another-new-password' })).status, 400, 'single use');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'auth.password_reset_completed' && a.tenantId === 'app_a'));
  assert.ok(!JSON.stringify(db.AdminAudit.rows).includes(token), 'the token is never written to the audit log');
});

test('invalid, malformed and expired tokens are refused', async () => {
  assert.equal((await post('/auth/reset-password', { token: 'abc', password: 'a-brand-new-password' })).status, 400);
  assert.equal((await post('/auth/reset-password', { token: 'f'.repeat(64), password: 'a-brand-new-password' })).status, 400);
  outbox.length = 0;
  await post('/auth/forgot-password', { email: 'super@x.test' });
  const token = tokenFrom(outbox[0]);
  user('s1').resetTokenExpires = new Date(Date.now() - 1000);
  assert.equal((await post('/auth/reset-password', { token, password: 'a-brand-new-password' })).status, 400, 'expired');
  assert.equal((await post('/auth/login', { email: 'super@x.test', password: 'old-password-123' })).status, 200, 'the old password still works');
});

test('a second request replaces the first link', async () => {
  outbox.length = 0;
  await post('/auth/forgot-password', { email: 'super@x.test' });
  await post('/auth/forgot-password', { email: 'super@x.test' });
  assert.equal(outbox.length, 2);
  assert.equal((await post('/auth/reset-password', { token: tokenFrom(outbox[0]), password: 'a-brand-new-password' })).status, 400, 'the older link is dead');
  assert.equal((await post('/auth/reset-password', { token: tokenFrom(outbox[1]), password: 'a-brand-new-password' })).status, 200);
});

test('a failing provider does not change the answer or leak anything', async () => {
  mailer.setTransport({ async send() { throw new Error('provider down'); } });
  const r = await post('/auth/forgot-password', { email: 'owner@a.test' });
  assert.equal(r.status, 200);
  assert.match(r.body.data.message, /If that email belongs to an account/);
});
