// Rider complaints: a rider reports a problem (about a trip of their own), reads the answer, and the business's support
// inbox sees it beside the drivers' reports, and no other business does. In-memory stand-ins. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-rider-issue-tests';
process.env.AUTH_ENFORCEMENT = 'strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const { createFakeDb } = require('./helpers/fakeDb');
const { createMemoryStorage } = require('./helpers/memoryStorage');
const { jsonBodyParser } = require('../lib/jsonBody');

const db = createFakeDb();
db.install();
require('../lib/privateStorage').setBackend(createMemoryStorage());
const adminRoutes = require('../routes/adminRoutes');
const userRoutes = require('../routes/userRoutes');
const { appTenantMiddleware, clearAppTenantCache } = require('../lib/appTenant');

let server;
let base;
const ctx = {};
const sign = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

test.before(async () => {
  await db.Tenant.create({ tenantId: 'app_def', name: 'Default', slug: 'def', appName: 'D', packageName: 'in.def', status: 'active', isDefault: true });
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha', slug: 'a', appName: 'A', packageName: 'com.a', status: 'active' });
  await db.Tenant.create({ tenantId: 'app_b', name: 'Beta', slug: 'b', appName: 'B', packageName: 'com.b', status: 'active' });
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: bcrypt.hashSync(pw, 4) });
  await mk('u_a', 'admin@a.test', 'client_admin', 'app_a', 'password-a-admin');
  await mk('u_b', 'admin@b.test', 'client_admin', 'app_b', 'password-b-admin');
  await mk('u_def', 'admin@def.test', 'client_admin', 'app_def', 'password-def-admin');

  const rider = (userId, tenantId, first) => { const t = sign(userId); ctx[userId] = t; return db.User.create({ userId, tenantId, firstName: first, lastName: 'R', phone: `+91${userId}`, accessToken: t }); };
  await rider('ra', 'app_a', 'Anita');
  await rider('ra2', 'app_a', 'Asha');
  await rider('rb', 'app_b', 'Bella');
  await rider('rold', null, 'Olga'); // before businesses: the default business
  await db.TripDetails.create({ trip_id: 'T_ra', request_id: 'q1', user_id: 'ra', driver_id: 'd', tenant_id: 'app_a', status: 'COMPLETED', pickup: { address: 'a', lat: 1, lng: 1 }, drop: { address: 'b', lat: 1, lng: 1 }, requested_at: new Date(), timeout_at: new Date() });
  await db.TripDetails.create({ trip_id: 'T_rb', request_id: 'q2', user_id: 'rb', driver_id: 'd', tenant_id: 'app_b', status: 'COMPLETED', pickup: { address: 'a', lat: 1, lng: 1 }, drop: { address: 'b', lat: 1, lng: 1 }, requested_at: new Date(), timeout_at: new Date() });
  await db.Driver.create({ driverId: 'drv_a', tenantId: 'app_a', firstName: 'Ravi', lastName: 'D', email: 'd@x.test', phone: '+91drv', passwordHash: 'x' });
  await db.DriverIssue.create({ _id: '650000000000000000000001', driverId: 'drv_a', issueText: 'App crashes on accept', status: 'issue submitted', createdAt: new Date(Date.now() - 1000), updatedAt: new Date() });

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  app.use('/api', appTenantMiddleware);
  app.use('/api/users', userRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.RATE_LIMIT_DISABLED = '1';
  const login = async (email, password) => (await (await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  ctx.adminA = await login('admin@a.test', 'password-a-admin');
  ctx.adminB = await login('admin@b.test', 'password-b-admin');
  ctx.adminDef = await login('admin@def.test', 'password-def-admin');
});
test.after(() => server.close());
test.beforeEach(() => clearAppTenantCache());

const rider = async (method, path, userId, body, headers = {}) => {
  const res = await fetch(base + '/api/users' + path, { method, headers: { 'Content-Type': 'application/json', ...(userId ? { Authorization: `Bearer ${ctx[userId]}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const admin = async (method, path, token, appId, body) => {
  const res = await fetch(base + '/api/admin' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-App-Id': appId }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('a rider reports a problem about their own trip, tagged with their business', async () => {
  const r = await rider('POST', '/issues', 'ra', { issueText: 'The driver took a much longer route', tripId: 'T_ra', imageUrls: ['https://img.example/a.png', 'http://insecure.example/b.png', 'javascript:alert(1)'] });
  assert.equal(r.status, 201);
  const doc = db.DriverIssue.rows.find((i) => i.riderId === 'ra');
  assert.deepEqual([doc.reporterType, doc.tenantId, doc.tripId, doc.status], ['rider', 'app_a', 'T_ra', 'issue submitted']);
  assert.deepEqual(doc.imageUrls, ['https://img.example/a.png'], 'only https links are kept');
  assert.equal(r.body.data.issueId, String(doc._id || r.body.data.issueId));
});

test('the rider\'s business comes from their account; an untagged rider belongs to the default business', async () => {
  assert.equal((await rider('POST', '/issues', 'rold', { issueText: 'My fare looks wrong' })).status, 201);
  assert.equal(db.DriverIssue.rows.find((i) => i.riderId === 'rold').tenantId, 'app_def');
});

test('validation: a description is required; a trip must be the rider\'s own', async () => {
  assert.equal((await rider('POST', '/issues', 'ra', { issueText: 'x' })).status, 400);
  assert.equal((await rider('POST', '/issues', 'ra', {})).status, 400);
  assert.equal((await rider('POST', '/issues', 'ra', { issueText: 'y'.repeat(2001) })).status, 400);
  const other = await rider('POST', '/issues', 'ra', { issueText: 'A complaint about someone else\'s trip', tripId: 'T_rb' });
  assert.equal(other.status, 400);
  assert.ok(other.body.errors.tripId);
  assert.equal((await rider('POST', '/issues', 'ra', { issueText: 'Valid text here', tripId: 'T_nope' })).status, 400);
  assert.equal((await rider('POST', '/issues', 'ra', { issueText: 'Valid text here', imageUrls: 'nope' })).status, 400);
  assert.equal(db.DriverIssue.rows.filter((i) => i.riderId === 'ra').length, 1, 'nothing extra was saved');
});

test('sign-in is required, and a rider cannot report as someone else', async () => {
  assert.equal((await rider('POST', '/issues', null, { issueText: 'No token at all here' })).status, 401);
  assert.equal((await rider('GET', '/issues', null)).status, 401);
  const spoof = await rider('POST', '/issues', 'ra2', { issueText: 'Pretending to be another rider', userId: 'ra' });
  assert.equal(spoof.status, 403, 'strict mode refuses a different userId');
  assert.equal(db.DriverIssue.rows.filter((i) => i.riderId === 'ra').length, 1);
});

test('support sees rider reports beside driver reports, only for their own business', async () => {
  const a = (await admin('GET', '/business/support/issues', ctx.adminA, 'app_a')).body.data;
  const kinds = Object.fromEntries(a.items.map((i) => [i.reporterType + ':' + i.reporterId, i]));
  assert.deepEqual(Object.keys(kinds).sort(), ['driver:drv_a', 'rider:ra']);
  assert.equal(kinds['rider:ra'].driverName, 'Anita R', 'the rider\'s name');
  assert.equal(kinds['rider:ra'].tripId, 'T_ra');
  assert.equal(kinds['rider:ra'].driverId, null);
  assert.equal(a.open, 2);
  assert.deepEqual((await admin('GET', '/business/support/issues', ctx.adminB, 'app_b')).body.data.items, [], 'Beta has none');
  const def = (await admin('GET', '/business/support/issues', ctx.adminDef, 'app_def')).body.data.items;
  assert.deepEqual(def.map((i) => i.reporterId), ['rold']);
  assert.equal((await admin('GET', '/business/support/issues?q=longer%20route', ctx.adminA, 'app_a')).body.data.items.length, 1, 'search finds the rider text');
});

test('support answers a rider: status and note, and the rider sees the answer; another business cannot touch it', async () => {
  const id = db.DriverIssue.rows.find((i) => i.riderId === 'ra')._id || (await admin('GET', '/business/support/issues', ctx.adminA, 'app_a')).body.data.items.find((i) => i.reporterId === 'ra').id;
  const issueId = String(id);
  assert.equal((await admin('POST', `/business/support/issues/${issueId}`, ctx.adminB, 'app_b', { status: 'complete' })).status, 404, 'Beta cannot answer Alpha\'s rider');
  const detail = (await admin('GET', `/business/support/issues/${issueId}`, ctx.adminA, 'app_a')).body.data;
  assert.equal(detail.reporterType, 'rider');
  assert.deepEqual(detail.imageUrls, ['https://img.example/a.png']);
  const upd = await admin('POST', `/business/support/issues/${issueId}`, ctx.adminA, 'app_a', { status: 'complete', note: 'We refunded the extra distance' });
  assert.equal(upd.status, 200);
  const mine = (await rider('GET', '/issues', 'ra')).body.data;
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].status, mine[0].statusLabel, mine[0].supportNote], ['complete', 'Resolved', 'We refunded the extra distance']);
  assert.ok(mine[0].resolvedAt);
  assert.deepEqual((await rider('GET', '/issues', 'ra2')).body.data, [], 'a rider sees only their own reports');
  assert.ok(!JSON.stringify(mine).includes('notes'), 'internal notes are not sent to the rider');
});
