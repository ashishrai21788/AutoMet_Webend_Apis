// Deleting a business: only the platform owner, only an unused suspended business, only with the App ID typed.
process.env.JWT_SECRET = 'test-secret-for-delete-tests';
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
const mkTenant = (tenantId, status, extra = {}) => db.Tenant.create({ tenantId, name: tenantId, slug: tenantId, appName: tenantId, packageName: `com.${tenantId}`, status, plan: 'standard', ...extra });

test.before(async () => {
  await mkTenant('app_def', 'active', { isDefault: true });
  for (const id of ['app_b', 'app_c', 'app_d']) await mkTenant(id, 'suspended');
  await mkTenant('app_a', 'active');
  await mkTenant('app_live', 'active');
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: bcrypt.hashSync(pw, 4) });
  await mk('s1', 'super@x.test', 'super_admin', null, 'password-super-1');
  await mk('a1', 'owner@a.test', 'client_admin', 'app_a', 'password-a-owner');
  await mk('l1', 'owner@live.test', 'client_admin', 'app_live', 'password-l-owner');
  await db.ServiceRegion.create({ regionId: 'r1', tenantId: 'app_a', state: 'MH', city: 'Pune', cityKey: 'pune', zoneName: 'Z', zoneKey: 'z' });
  await db.Driver.create({ driverId: 'd1', tenantId: 'app_b', email: 'd1@x.test' });
  await db.PlatformInvoice.create({ invoiceId: 'i1', number: 'INV-000001', tenantId: 'app_c', amount: 10, currency: 'INR', status: 'issued', dueDate: new Date() });
  await db.PlatformInvoice.create({ invoiceId: 'i2', number: 'INV-000002', tenantId: 'app_d', amount: 10, currency: 'INR', status: 'void', dueDate: new Date() });
  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const login = async (email, password) => (await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  ctx.s = await login('super@x.test', 'password-super-1');
  ctx.owner = await login('owner@a.test', 'password-a-owner');
  db.Tenant.rows.find((t) => t.tenantId === 'app_a').status = 'suspended'; // signed in first, then suspended
});
test.after(() => server.close());

const del = async (id, token, body) => {
  const res = await fetch(`${base}/tenants/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const exists = (id) => db.Tenant.rows.some((t) => t.tenantId === id);

test('only the platform owner can delete a business', async () => {
  assert.equal((await del('app_a', null, { confirm: 'app_a' })).status, 401);
  assert.equal((await del('app_a', ctx.owner, { confirm: 'app_a' })).status, 403, 'not even the business\'s own admin');
  assert.equal(exists('app_a'), true);
});

test('refused without the typed App ID, for an active business, for the default, and for an unknown one', async () => {
  assert.equal((await del('app_a', ctx.s, {})).status, 400);
  assert.equal((await del('app_a', ctx.s, { confirm: 'wrong' })).status, 400);
  const live = await del('app_live', ctx.s, { confirm: 'app_live' });
  assert.equal(live.status, 409);
  assert.match(live.body.message, /Suspend/);
  assert.equal((await del('app_def', ctx.s, { confirm: 'app_def' })).status, 400, 'default business');
  assert.equal((await del('app_nope', ctx.s, { confirm: 'app_nope' })).status, 404);
  assert.deepEqual(['app_a', 'app_live', 'app_def'].map(exists), [true, true, true]);
});

test('deleting a business deletes everything it owns, and nothing of any other business', async () => {
  const mine = 'app_b';
  await db.User.create({ userId: 'u1', tenantId: mine });
  await db.User.create({ userId: 'u2', tenantId: 'app_live' });
  await db.Driver.create({ driverId: 'd2', tenantId: 'app_live', email: 'd2@x.test' });
  await db.TripDetails.create({ trip_id: 't1', tenant_id: mine });
  await db.TripDetails.create({ trip_id: 't2', tenant_id: 'app_live' });
  await db.Vehicle.create({ vehicleId: 'v1', tenantId: mine, registrationKey: 'k1' });
  await db.Vehicle.create({ vehicleId: 'v2', tenantId: 'app_live', registrationKey: 'k2' });
  await db.DriverIssue.create({ tenantId: mine, driverId: 'd1', issueText: 'x' });
  await db.DriverIssue.create({ tenantId: 'app_live', driverId: 'd2', issueText: 'y' });
  await db.PlatformInvoice.create({ invoiceId: 'i9', number: 'INV-000009', tenantId: mine, amount: 10, currency: 'INR', status: 'paid', dueDate: new Date() });
  const r = await del(mine, ctx.s, { confirm: mine });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.data.removed.drivers, r.body.data.removed.riders, r.body.data.removed.trips, r.body.data.removed.vehicles, r.body.data.removed.supportReports, r.body.data.removed.invoices], [1, 1, 1, 1, 1, 1]);
  assert.equal(exists(mine), false);
  const left = (rows, k) => rows.filter((x) => x[k] === mine).length;
  assert.deepEqual([left(db.Driver.rows, 'tenantId'), left(db.User.rows, 'tenantId'), left(db.TripDetails.rows, 'tenant_id'), left(db.Vehicle.rows, 'tenantId'), left(db.DriverIssue.rows, 'tenantId'), left(db.PlatformInvoice.rows, 'tenantId')], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([db.User.rows.length, db.Driver.rows.length, db.TripDetails.rows.length, db.Vehicle.rows.length, db.DriverIssue.rows.length], [1, 1, 1, 1, 1], 'app_live keeps its own');
  const log = db.AdminAudit.rows.find((a) => a.action === 'tenant.deleted' && a.targetId === mine);
  assert.ok(log && log.tenantId === null && log.meta.drivers === 1);
});

test('an unused suspended business is removed with its setup, admins and invoices; others are untouched', async () => {
  const r = await del('app_a', ctx.s, { confirm: 'app_a' });
  assert.equal(r.status, 200);
  assert.equal(exists('app_a'), false);
  assert.equal(db.ServiceRegion.rows.some((x) => x.tenantId === 'app_a'), false);
  assert.equal(db.AdminUser.rows.some((x) => x.tenantId === 'app_a'), false);
  assert.equal((await del('app_d', ctx.s, { confirm: 'app_d' })).status, 200);
  assert.equal(db.PlatformInvoice.rows.some((x) => x.tenantId === 'app_d'), false);
  assert.deepEqual(['app_c', 'app_live', 'app_def'].map(exists), [true, true, true]);
  assert.ok(db.AdminUser.rows.some((x) => x.adminId === 'l1'), 'another business\'s admin remains');
  const gone = await fetch(base + '/business/overview', { headers: { Authorization: `Bearer ${ctx.owner}`, 'X-App-Id': 'app_a' } });
  assert.equal(gone.status, 401, 'the deleted business\'s admins can no longer sign in');
});

test('export: a JSON copy of the business without secrets, audited, super admin only; delete removes its stored files', async () => {
  await mkTenant('app_x', 'suspended');
  await db.Driver.create({ driverId: 'dx', tenantId: 'app_x', email: 'dx@x.test', passwordHash: 'SECRET-HASH', accessToken: 'SECRET-TOKEN', fullName: 'Dee' });
  await db.User.create({ userId: 'ux', tenantId: 'app_x', otpCode: '123456', name: 'Rae' });
  await db.TripDetails.create({ trip_id: 'tx', tenant_id: 'app_x' });
  const storage = require('../lib/privateStorage');
  const key1 = await storage.putPrivate(Buffer.from('a'), { tenantId: 'app_x', kind: 'driver-documents', mime: 'image/png' });
  const key2 = await storage.putPrivate(Buffer.from('b'), { tenantId: 'app_live', kind: 'driver-documents', mime: 'image/png' });

  const headers = (t) => ({ Authorization: `Bearer ${t}` });
  const liveOwner = (await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@live.test', password: 'password-l-owner' }) })).json()).data.token;
  assert.equal((await fetch(`${base}/tenants/app_x/export`, { headers: headers(liveOwner) })).status, 403);
  assert.equal((await fetch(`${base}/tenants/app_x/export`)).status, 401);
  assert.equal((await fetch(`${base}/tenants/nope/export`, { headers: headers(ctx.s) })).status, 404);
  const res = await fetch(`${base}/tenants/app_x/export`, { headers: headers(ctx.s) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /app_x-export\.json/);
  const text = await res.text();
  assert.ok(!/SECRET-HASH|SECRET-TOKEN|123456/.test(text), 'no secrets in the file');
  const out = JSON.parse(text);
  assert.deepEqual([out.business.tenantId, out.counts.drivers, out.counts.riders, out.counts.trips], ['app_x', 1, 1, 1]);
  assert.equal(out.data.drivers[0].fullName, 'Dee');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'tenant.exported' && a.targetId === 'app_x' && a.tenantId === null));

  const del2 = await del('app_x', ctx.s, { confirm: 'app_x' });
  assert.equal(del2.status, 200);
  assert.equal(del2.body.data.removed.files, 1);
  const files = require('../lib/privateStorage');
  void files;
  assert.ok(key1.startsWith('automet/app_x/') && key2.startsWith('automet/app_live/'));
});
