// Super admin platform overview: per-business size and activity, totals, integration status, and who may see it.
process.env.JWT_SECRET = 'test-secret-for-platform-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');
const { createFakeDb } = require('./helpers/fakeDb');
const { jsonBodyParser } = require('../lib/jsonBody');

const db = createFakeDb();
db.install();
const adminRoutes = require('../routes/adminRoutes');
const { integrationStatus } = require('../lib/integrationStatus');

const ago = (ms) => new Date(Date.now() - ms);
let server;
let base;
const ctx = {};

test.before(async () => {
  const market = { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' };
  await db.Tenant.create({ tenantId: 'app_def', name: 'Default Co', slug: 'def', appName: 'D', packageName: 'in.def', status: 'active', isDefault: true, market });
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha', slug: 'a', appName: 'A', packageName: 'com.a', status: 'trial', market });
  await db.Tenant.create({ tenantId: 'app_s', name: 'Paused', slug: 's', appName: 'P', packageName: 'com.s', status: 'suspended' });
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: bcrypt.hashSync(pw, 4) });
  await mk('u_super', 'super@x.test', 'super_admin', null, 'password-super-1');
  await mk('u_a', 'admin@a.test', 'client_admin', 'app_a', 'password-a-admin');
  await mk('u_a2', 'ops@a.test', 'operations', 'app_a', 'password-a-ops1');

  await db.ServiceRegion.create({ tenantId: 'app_a', regionId: 'r', country: 'IN', state: 'S', city: 'Pune', zoneName: 'All areas', key: 'k', active: true, center: { lat: 1, lng: 1 }, radiusKm: 5 });
  const driver = (driverId, tenantId, extra = {}) => db.Driver.create({ driverId, tenantId, firstName: driverId, lastName: 'D', email: `${driverId}@x.test`, phone: `+91${driverId}`, passwordHash: 'x', ...extra });
  await driver('d1', 'app_a', { isOnline: true });
  await driver('d2', 'app_a', { accountStatus: 'SUSPENDED' });
  await driver('d3', null, { isOnline: true }); // before businesses: the default business
  await db.User.create({ userId: 'u1', tenantId: 'app_a', firstName: 'A', lastName: 'R', phone: '+911', createdAt: ago(86400000) });
  await db.User.create({ userId: 'u2', tenantId: null, firstName: 'B', lastName: 'R', phone: '+912', createdAt: ago(30 * 86400000) });
  const trip = (id, tenant, status, minsAgo) => db.TripDetails.create({ trip_id: id, request_id: id, user_id: 'u1', driver_id: 'd1', tenant_id: tenant, status, pickup: { address: 'a', lat: 1, lng: 1 }, drop: { address: 'b', lat: 1, lng: 1 }, requested_at: ago(minsAgo * 60000), timeout_at: new Date() });
  await trip('T1', 'app_a', 'ON_GOING', 5);
  await trip('T2', 'app_a', 'REQUESTED', 2);
  await trip('T3', 'app_a', 'COMPLETED', 3 * 1440);
  await trip('T4', null, 'COMPLETED', 1);

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const login = async (email, password) => (await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  ctx.super = await login('super@x.test', 'password-super-1');
  ctx.admin = await login('admin@a.test', 'password-a-admin');
});
test.after(() => server.close());

const get = async (token) => {
  const res = await fetch(base + '/platform/overview', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
};

test('only the platform owner may read the overview', async () => {
  assert.equal((await get()).status, 401);
  assert.equal((await get(ctx.admin)).status, 403, 'a business admin cannot');
  assert.equal((await get(ctx.super)).status, 200);
});

test('one row per business with counts from its own records, untagged records counted for the default business', async () => {
  const { data } = (await get(ctx.super)).body;
  const by = Object.fromEntries(data.businesses.map((b) => [b.appId, b]));
  assert.deepEqual(Object.keys(by).sort(), ['app_a', 'app_def', 'app_s']);

  assert.deepEqual(by.app_a.drivers, { total: 2, online: 1, suspended: 1 });
  assert.deepEqual(by.app_a.riders, { total: 1, newThisWeek: 1 });
  assert.equal(by.app_a.admins, 2);
  assert.deepEqual(by.app_a.trips, { requestedToday: 2, active: 1, searching: 1, last7Days: 3 });
  assert.equal(by.app_a.setup.percent > 0, true);

  assert.deepEqual(by.app_def.drivers, { total: 1, online: 1, suspended: 0 }, 'the untagged driver');
  assert.equal(by.app_def.riders.total, 1);
  assert.equal(by.app_def.riders.newThisWeek, 0);
  assert.equal(by.app_def.trips.last7Days, 1, 'the untagged trip');
  assert.deepEqual(by.app_s.drivers, { total: 0, online: 0, suspended: 0 });
  assert.equal(by.app_s.status, 'suspended');
});

test('totals add up, and the response holds counts only', async () => {
  const { data } = (await get(ctx.super)).body;
  assert.equal(data.totals.businesses, 3);
  assert.equal(data.totals.trial, 1);
  assert.equal(data.totals.suspended, 1);
  assert.equal(data.totals.active, 1);
  assert.equal(data.totals.drivers, 3);
  assert.equal(data.totals.driversOnline, 2);
  assert.equal(data.totals.riders, 2);
  assert.equal(data.totals.tripsLast7Days, 4);
  assert.equal(data.totals.activeTrips, 1);
  const text = JSON.stringify(data);
  for (const private_ of ['+911', 'd1@x.test', 'passwordHash', '"T1"', 'password-']) assert.ok(!text.includes(private_), `no ${private_}`);
});

test('integration status is yes/no only and never contains a value', () => {
  const on = integrationStatus({ CLOUDINARY_CLOUD_NAME: 'secret-cloud', CLOUDINARY_API_KEY: 'secret-key', CLOUDINARY_API_SECRET: 'secret-secret', JWT_SECRET: 'x', MONGODB_USERNAME: 'u', MONGODB_PASSWORD: 'p', MONGODB_CLUSTER: 'c', FIREBASE_SERVICE_ACCOUNT_KEY: '{"private_key":"zzz"}' }, { connection: { readyState: 1 } });
  assert.equal(on.documentStorage.configured, true);
  assert.equal(on.pushNotifications.configured, true);
  assert.equal(on.database.connected, true);
  assert.equal(on.adminSecurity.configured, true);
  assert.equal(on.otpDelivery.configured, false, 'no SMS provider exists yet');
  assert.equal(on.payments.configured, false);
  assert.ok(!JSON.stringify(on).includes('secret') && !JSON.stringify(on).includes('zzz'));
  const off = integrationStatus({}, { connection: { readyState: 0 } });
  assert.equal(off.documentStorage.configured, false);
  assert.equal(off.database.connected, false);
});
