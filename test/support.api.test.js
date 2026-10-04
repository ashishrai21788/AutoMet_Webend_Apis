// Support inbox for driver-reported issues: list, filters, detail, status and notes, business isolation, roles, and the
// two driver-facing routes that used to be open. In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-support-tests';
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
const dynamicRoutes = require('../routes/dynamicRoutes');
const { can } = require('../lib/adminPermissions');

const ago = (ms) => new Date(Date.now() - ms);
let server;
let base;
const ctx = {};

// 24-hex ids, like the ones MongoDB gives
const ID = { a1: '650000000000000000000001', a2: '650000000000000000000002', a3: '650000000000000000000003', b1: '650000000000000000000009' };

test('permissions: support, operations and the business admin work the inbox; finance does not', () => {
  for (const role of ['support', 'operations', 'client_admin']) assert.equal(can({ role }, 'support.manage'), true, role);
  assert.equal(can({ role: 'super_admin' }, 'support.manage'), false, 'the platform owner does not work a client\'s inbox');
  assert.equal(can({ role: 'finance' }, 'support.manage'), false);
});

test.before(async () => {
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha', slug: 'a', appName: 'A', packageName: 'com.a', status: 'active' });
  await db.Tenant.create({ tenantId: 'app_b', name: 'Beta', slug: 'b', appName: 'B', packageName: 'com.b', status: 'active' });
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: bcrypt.hashSync(pw, 4) });
  await mk('u_a', 'admin@a.test', 'client_admin', 'app_a', 'password-a-admin');
  await mk('u_sup', 'support@a.test', 'support', 'app_a', 'password-a-supp');
  await mk('u_fin', 'finance@a.test', 'finance', 'app_a', 'password-a-fin1');
  await mk('u_b', 'admin@b.test', 'client_admin', 'app_b', 'password-b-admin');

  const driver = (driverId, tenantId, first) => db.Driver.create({ driverId, tenantId, firstName: first, lastName: 'D', email: `${driverId}@x.test`, phone: `+91${driverId}`, passwordHash: 'x' });
  await driver('da1', 'app_a', 'Asha');
  await driver('da2', 'app_a', 'Ravi');
  await driver('db1', 'app_b', 'Bella');
  await driver('dold', null, 'Olga'); // before businesses: the default business, which does not exist in this test

  await db.DriverIssue.create({ _id: ID.a1, driverId: 'da1', issueText: 'App crashes when I accept a ride', imageUrls: ['https://img.example/1.png', 'javascript:alert(1)'], status: 'issue submitted', createdAt: ago(3 * 3600000), updatedAt: ago(3 * 3600000) });
  await db.DriverIssue.create({ _id: ID.a2, driverId: 'da2', issueText: 'Payment was not shown', status: 'under process', adminNotes: 'Checking with finance', notes: [{ at: ago(1000), by: 'admin@a.test', text: 'Checking with finance', status: 'under process' }], createdAt: ago(2 * 3600000), updatedAt: ago(1000) });
  await db.DriverIssue.create({ _id: ID.a3, driverId: 'da1', issueText: 'Fixed already', status: 'complete', resolvedAt: ago(1000), createdAt: ago(5 * 3600000), updatedAt: ago(1000) });
  await db.DriverIssue.create({ _id: ID.b1, driverId: 'db1', issueText: 'Beta driver problem', status: 'issue submitted', createdAt: ago(1000), updatedAt: ago(1000) });

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  app.use('/api', dynamicRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => (await (await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  ctx.admin = await login('admin@a.test', 'password-a-admin');
  ctx.support = await login('support@a.test', 'password-a-supp');
  ctx.finance = await login('finance@a.test', 'password-a-fin1');
  ctx.b = await login('admin@b.test', 'password-b-admin');
});
test.after(() => server.close());

const call = async (method, path, { token = ctx.admin, appId = 'app_a', body } = {}) => {
  const res = await fetch(base + '/api/admin' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-App-Id': appId }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('inbox lists this business\'s drivers\' reports, newest first, with names and an open count', async () => {
  const r = await call('GET', '/business/support/issues');
  assert.equal(r.status, 200);
  const { items, total, open } = r.body.data;
  assert.deepEqual(items.map((i) => i.id), [ID.a2, ID.a1, ID.a3], 'Beta\'s report is not included');
  assert.equal(total, 3);
  assert.equal(open, 2, 'two are not resolved');
  assert.equal(items[1].driverName, 'Asha D');
  assert.equal(items[1].statusLabel, 'New');
  assert.equal(items[0].statusLabel, 'In progress');
  assert.equal(items[2].statusLabel, 'Resolved');
  assert.equal(items[1].imageCount, 2);
  assert.equal(items[0].noteCount, 1);
});

test('inbox filters: status, search, and unknown values', async () => {
  assert.deepEqual((await call('GET', '/business/support/issues?status=complete')).body.data.items.map((i) => i.id), [ID.a3]);
  assert.deepEqual((await call('GET', '/business/support/issues?status=issue%20submitted')).body.data.items.map((i) => i.id), [ID.a1]);
  assert.deepEqual((await call('GET', '/business/support/issues?q=payment')).body.data.items.map((i) => i.id), [ID.a2]);
  assert.deepEqual((await call('GET', '/business/support/issues?q=da1')).body.data.items.map((i) => i.id).sort(), [ID.a1, ID.a3]);
  assert.equal((await call('GET', '/business/support/issues?status=nope')).status, 400);
  assert.equal((await call('GET', '/business/support/issues?pageSize=2&page=2')).body.data.items.length, 1);
});

test('detail: only https images are returned, notes come with who wrote them', async () => {
  const d = (await call('GET', `/business/support/issues/${ID.a1}`)).body.data;
  assert.deepEqual(d.imageUrls, ['https://img.example/1.png'], 'a javascript: link is dropped');
  assert.equal(d.text, 'App crashes when I accept a ride');
  const n = (await call('GET', `/business/support/issues/${ID.a2}`)).body.data.notes;
  assert.deepEqual([n[0].by, n[0].text], ['admin@a.test', 'Checking with finance']);
  assert.equal((await call('GET', `/business/support/issues/${ID.b1}`)).status, 404, "another business's report");
  assert.equal((await call('GET', '/business/support/issues/not-an-id')).status, 404);
  assert.equal((await call('GET', '/business/support/issues/650000000000000000000099')).status, 404);
});

test('update: change status, add a note, both; resolved time follows the status; history and audit', async () => {
  assert.equal((await call('POST', `/business/support/issues/${ID.a1}`, { body: {} })).status, 400, 'nothing to do');
  assert.equal((await call('POST', `/business/support/issues/${ID.a1}`, { body: { status: 'closed' } })).status, 400);
  assert.equal((await call('POST', `/business/support/issues/${ID.a1}`, { body: { note: 'x'.repeat(1001) } })).status, 400);

  const start = await call('POST', `/business/support/issues/${ID.a1}`, { token: ctx.support, body: { status: 'under process', note: 'Looking into the crash' } });
  assert.equal(start.status, 200);
  const doc = db.DriverIssue.rows.find((i) => i._id === ID.a1);
  assert.equal(doc.status, 'under process');
  assert.equal(doc.adminNotes, 'Looking into the crash', 'the driver app shows the latest note');
  assert.equal(doc.resolvedAt, null);
  assert.deepEqual([doc.notes.length, doc.notes[0].by, doc.notes[0].status], [1, 'support@a.test', 'under process']);

  const done = await call('POST', `/business/support/issues/${ID.a1}`, { body: { status: 'complete' } });
  assert.equal(done.body.data.status, 'complete');
  assert.ok(db.DriverIssue.rows.find((i) => i._id === ID.a1).resolvedAt, 'resolved time is set');
  assert.equal(doc.notes[1].text, 'Status changed to Resolved');

  const reopened = await call('POST', `/business/support/issues/${ID.a1}`, { body: { status: 'under process' } });
  assert.equal(reopened.status, 200);
  assert.equal(db.DriverIssue.rows.find((i) => i._id === ID.a1).resolvedAt, null, 'reopening clears the resolved time');

  await call('POST', `/business/support/issues/${ID.a1}`, { body: { note: 'Just a note, no status change' } });
  assert.equal(db.DriverIssue.rows.find((i) => i._id === ID.a1).status, 'under process');
  const audit = db.AdminAudit.rows.filter((a) => a.action === 'support.issue_updated' && a.targetId === ID.a1);
  assert.equal(audit.length, 4);
  assert.deepEqual([audit[0].meta.from, audit[0].meta.to, audit[0].meta.noted, audit[0].tenantId], ['issue submitted', 'under process', true, 'app_a']);
});

test('inbox: roles and business isolation', async () => {
  assert.equal((await call('GET', '/business/support/issues', { token: ctx.finance })).status, 403);
  assert.equal((await call('POST', `/business/support/issues/${ID.a2}`, { token: ctx.finance, body: { note: 'no' } })).status, 403);
  assert.equal((await call('GET', '/business/support/issues', { token: ctx.support })).status, 200);
  assert.equal((await call('GET', '/business/support/issues', { token: ctx.b, appId: 'app_a' })).status, 403);
  assert.equal((await call('POST', `/business/support/issues/${ID.b1}`, { body: { status: 'complete' } })).status, 404, 'cannot change another business\'s report');
  assert.equal(db.DriverIssue.rows.find((i) => i._id === ID.b1).status, 'issue submitted');
  const own = (await call('GET', '/business/support/issues', { token: ctx.b, appId: 'app_b' })).body.data;
  assert.deepEqual(own.items.map((i) => i.id), [ID.b1]);
});

test('driver-facing routes: a driver can no longer change report status, and reads need sign-in', async () => {
  const put = await fetch(`${base}/api/drivers/issues/${ID.b1}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'complete', adminNotes: 'hacked' }) });
  assert.equal(put.status, 403);
  assert.equal(db.DriverIssue.rows.find((i) => i._id === ID.b1).status, 'issue submitted');
  assert.equal(db.DriverIssue.rows.find((i) => i._id === ID.b1).adminNotes, undefined);
});
