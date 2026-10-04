// Admin actions: suspending riders (and what that stops), cancelling stuck trips, and driver cancellations in the
// numbers. In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-admin-action-tests';
process.env.RATE_LIMIT_DISABLED = '1';
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
const { requireAuth } = require('../lib/authMiddleware');
const { buildReport } = require('../lib/reports');
const { groupOf } = require('../lib/tripStatus');
const { can } = require('../lib/adminPermissions');

const ago = (ms) => new Date(Date.now() - ms);

test('permissions: only operations and the business admin may suspend riders or cancel trips', () => {
  const as = (role) => ({ role });
  for (const p of ['riders.manage', 'trips.manage']) {
    assert.equal(can(as('client_admin'), p), true);
    assert.equal(can(as('super_admin'), p), true);
    assert.equal(can(as('operations'), p), true);
    assert.equal(can(as('support'), p), false);
    assert.equal(can(as('finance'), p), false);
  }
});

test('a driver cancelling a request is a cancellation in every group and count', () => {
  assert.equal(groupOf('CANCELLED_BY_DRIVER'), 'cancelled');
  const trips = [
    { trip_id: 'a', status: 'CANCELLED_BY_DRIVER', driver_id: 'd1', requested_at: ago(1000) },
    { trip_id: 'b', status: 'CANCELLED_BY_USER', driver_id: 'd1', requested_at: ago(1000) },
    { trip_id: 'c', status: 'COMPLETED', driver_id: 'd1', fare: 50, requested_at: ago(1000) }
  ];
  const r = buildReport({ trips, from: ago(86400000), to: new Date(), tz: 'UTC' });
  assert.equal(r.rides.cancelled, 2);
  assert.equal(r.rides.cancelledByDrivers, 1);
  assert.equal(r.rides.cancelledByRiders, 1);
  const d = r.drivers[0];
  assert.equal(d.declined, 1, 'cancelling before accepting is a decline for that driver');
  assert.equal(d.offered, 2, 'the rider-cancelled request was never answered by the driver, so it is not counted');
});

// ---------- enforcement for riders ----------

test('a suspended rider\'s token stops working at once; an active rider\'s works', async () => {
  const app = express();
  app.use(jsonBodyParser());
  app.get('/me', requireAuth({ roles: ['user'] }), (req, res) => res.json({ ok: true, user: req.authActorId }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const token = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const t1 = token('u_ok');
    const t2 = token('u_susp');
    await db.User.create({ userId: 'u_ok', firstName: 'Ok', lastName: 'R', phone: '+91001', accessToken: t1, accountStatus: 'ACTIVE' });
    await db.User.create({ userId: 'u_susp', firstName: 'No', lastName: 'R', phone: '+91002', accessToken: t2, accountStatus: 'SUSPENDED' });
    const get = (t) => fetch(`http://127.0.0.1:${server.address().port}/me`, { headers: { Authorization: `Bearer ${t}` } });
    assert.equal((await get(t1)).status, 200);
    const blocked = await get(t2);
    assert.equal(blocked.status, 403);
    assert.match((await blocked.json()).message, /suspended/i);
  } finally { server.close(); }
});

// ---------- over HTTP ----------

let server;
let base;
const ctx = {};
const row = (rows, key, id) => rows.find((r) => r[key] === id);

test.before(async () => {
  const market = { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' };
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha', slug: 'a', appName: 'A', packageName: 'com.a', status: 'active', market });
  await db.Tenant.create({ tenantId: 'app_b', name: 'Beta', slug: 'b', appName: 'B', packageName: 'com.b', status: 'active', market });
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: bcrypt.hashSync(pw, 4) });
  await mk('u_a', 'admin@a.test', 'client_admin', 'app_a', 'password-a-admin');
  await mk('u_ops', 'ops@a.test', 'operations', 'app_a', 'password-a-ops1');
  await mk('u_sup', 'support@a.test', 'support', 'app_a', 'password-a-supp');
  await mk('u_fin', 'finance@a.test', 'finance', 'app_a', 'password-a-fin1');
  await mk('u_b', 'admin@b.test', 'client_admin', 'app_b', 'password-b-admin');

  await db.User.create({ userId: 'rid_a', tenantId: 'app_a', firstName: 'Anita', lastName: 'R', phone: '+9101', accessToken: 'tok-a', isLoggedin: true });
  await db.User.create({ userId: 'rid_b', tenantId: 'app_b', firstName: 'Bella', lastName: 'R', phone: '+9102' });
  await db.Driver.create({ driverId: 'd1', tenantId: 'app_a', firstName: 'Asha', lastName: 'V', email: 'd1@x.test', phone: '+9111', passwordHash: 'x' });

  const trip = (id, tenantId, status, extra = {}) => db.TripDetails.create({
    trip_id: id, request_id: `req_${id}`, user_id: 'rid_a', driver_id: 'd1', tenant_id: tenantId, status,
    pickup: { address: 'a', lat: 1, lng: 1 }, drop: { address: 'b', lat: 1, lng: 1 }, requested_at: ago(60000), timeout_at: new Date(), ...extra
  });
  await trip('T_req', 'app_a', 'REQUESTED');
  await trip('T_on', 'app_a', 'ON_GOING', { started_at: ago(30000) });
  await trip('T_acc', 'app_a', 'ACCEPTED');
  await trip('T_done', 'app_a', 'COMPLETED', { completed_at: ago(1000) });
  await trip('T_drv', 'app_a', 'CANCELLED_BY_DRIVER', { cancelled_by: 'DRIVER' });
  await trip('T_other', 'app_b', 'REQUESTED', { user_id: 'rid_b' });

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => (await (await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  ctx.admin = await login('admin@a.test', 'password-a-admin');
  ctx.ops = await login('ops@a.test', 'password-a-ops1');
  ctx.support = await login('support@a.test', 'password-a-supp');
  ctx.finance = await login('finance@a.test', 'password-a-fin1');
  ctx.b = await login('admin@b.test', 'password-b-admin');
});
test.after(() => server.close());

const post = async (path, body, { token = ctx.admin, appId = 'app_a' } = {}) => {
  const res = await fetch(base + '/api/admin' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-App-Id': appId }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const get = async (path, { token = ctx.admin, appId = 'app_a' } = {}) => {
  const res = await fetch(base + '/api/admin' + path, { headers: { Authorization: `Bearer ${token}`, 'X-App-Id': appId } });
  return { status: res.status, body: await res.json() };
};

test('suspend a rider: needs a reason, signs them out, is audited, and can be reversed', async () => {
  assert.equal((await post('/business/riders/rid_a/status', { status: 'SUSPENDED' })).status, 400, 'a reason is required');
  assert.equal((await post('/business/riders/rid_a/status', { status: 'SUSPENDED', reason: 'abc' })).status, 400, 'too short');
  assert.equal((await post('/business/riders/rid_a/status', { status: 'BANNED', reason: 'whatever it is' })).status, 400);
  assert.equal((await post('/business/riders/rid_a/status', { status: 'ACTIVE' })).status, 409, 'already active');

  const r = await post('/business/riders/rid_a/status', { status: 'SUSPENDED', reason: '  Repeated   abuse of drivers ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.accountStatus, 'SUSPENDED');
  const u = row(db.User.rows, 'userId', 'rid_a');
  assert.equal(u.accountStatus, 'SUSPENDED');
  assert.equal(u.suspendedReason, 'Repeated abuse of drivers', 'whitespace is tidied');
  assert.equal(u.accessToken, null, 'the rider is signed out');
  assert.equal(u.isLoggedin, false);
  const audit = db.AdminAudit.rows.find((a) => a.action === 'rider.status_changed');
  assert.deepEqual([audit.tenantId, audit.targetId, audit.meta.from, audit.meta.to, audit.actorEmail], ['app_a', 'rid_a', 'ACTIVE', 'SUSPENDED', 'admin@a.test']);

  const detail = (await get('/business/riders/rid_a')).body.data;
  assert.equal(detail.accountStatus, 'SUSPENDED');
  assert.equal(detail.suspendedReason, 'Repeated abuse of drivers');
  assert.equal((await post('/business/riders/rid_a/status', { status: 'SUSPENDED', reason: 'again please' })).status, 409);

  assert.equal((await post('/business/riders/rid_a/status', { status: 'ACTIVE' })).status, 200, 'no reason needed to reactivate');
  assert.equal(row(db.User.rows, 'userId', 'rid_a').accountStatus, 'ACTIVE');
  assert.equal(row(db.User.rows, 'userId', 'rid_a').suspendedReason, null);
});

test('rider actions: who may, and only this business\'s riders', async () => {
  const body = { status: 'SUSPENDED', reason: 'Testing the roles' };
  assert.equal((await post('/business/riders/rid_a/status', body, { token: ctx.support })).status, 403);
  assert.equal((await post('/business/riders/rid_a/status', body, { token: ctx.finance })).status, 403);
  assert.equal((await post('/business/riders/rid_b/status', body)).status, 404, "another business's rider");
  assert.equal((await post('/business/riders/rid_a/status', body, { token: ctx.b, appId: 'app_a' })).status, 403);
  assert.equal((await post('/business/riders/rid_a/status', body, { token: ctx.ops })).status, 200, 'operations may');
  await post('/business/riders/rid_a/status', { status: 'ACTIVE' });
  assert.equal(row(db.User.rows, 'userId', 'rid_b').accountStatus, undefined, 'the other business was not touched');
});

test('cancel a trip: before and after a driver accepted, atomic, audited, and the apps are told', async () => {
  assert.equal((await post('/business/trips/T_req/cancel', {})).status, 400, 'a reason is required');
  assert.equal((await post('/business/trips/T_req/cancel', { reason: 'no' })).status, 400);

  const before = await post('/business/trips/T_req/cancel', { reason: 'Rider asked support to cancel' });
  assert.equal(before.status, 200);
  assert.equal(before.body.data.status, 'CANCELLED_BY_USER');
  const t = row(db.TripDetails.rows, 'trip_id', 'T_req');
  assert.deepEqual([t.cancelled_by, t.cancel_stage, t.cancellation_reason], ['ADMIN', 'before_accept', 'Cancelled by support: Rider asked support to cancel']);
  assert.ok(t.cancelled_at);

  const after = await post('/business/trips/T_on/cancel', { reason: 'Driver phone died mid-trip' }, { token: ctx.ops });
  assert.equal(after.body.data.status, 'CANCELLED_BY_USER_AFTER_ACCEPTANCE');
  assert.equal(row(db.TripDetails.rows, 'trip_id', 'T_on').cancel_stage, 'after_accept');
  assert.equal(row(db.TripDetails.rows, 'trip_id', 'T_acc').status, 'ACCEPTED', 'other trips are untouched');

  assert.ok(db.TripEvent.rows.some((e) => e.trip_id === 'T_req' && e.event === 'ride_cancelled_by_admin' && e.payload.by === 'admin@a.test'));
  const a = db.AdminAudit.rows.find((x) => x.action === 'trip.cancelled_by_admin' && x.targetId === 'T_req');
  assert.deepEqual([a.meta.from, a.meta.reason], ['REQUESTED', 'Rider asked support to cancel']);

  const detail = (await get('/business/trips/T_req')).body.data;
  assert.equal(detail.cancellation.by, 'ADMIN');
  assert.equal(detail.statusGroup, 'cancelled');
});

test('cancel a trip: finished trips and a second cancel are refused; roles and business isolation', async () => {
  const done = await post('/business/trips/T_done/cancel', { reason: 'Trying to cancel a finished trip' });
  assert.equal(done.status, 409);
  assert.match(done.body.message, /completed/);
  assert.equal(row(db.TripDetails.rows, 'trip_id', 'T_done').status, 'COMPLETED');
  assert.equal((await post('/business/trips/T_drv/cancel', { reason: 'Already cancelled by the driver' })).status, 409);
  assert.equal((await post('/business/trips/T_req/cancel', { reason: 'Cancelling the same trip again' })).status, 409, 'cannot cancel twice');
  assert.equal((await post('/business/trips/NOPE/cancel', { reason: 'There is no such trip' })).status, 404);
  assert.equal((await post('/business/trips/T_other/cancel', { reason: 'Another business trip' })).status, 404, "another business's trip");
  assert.equal(row(db.TripDetails.rows, 'trip_id', 'T_other').status, 'REQUESTED');
  assert.equal((await post('/business/trips/T_acc/cancel', { reason: 'Support may not do this' }, { token: ctx.support })).status, 403);
  assert.equal((await post('/business/trips/T_acc/cancel', { reason: 'Finance may not do this' }, { token: ctx.finance })).status, 403);
  assert.equal((await post('/business/trips/T_acc/cancel', { reason: 'Wrong business admin' }, { token: ctx.b, appId: 'app_a' })).status, 403);
  assert.equal(row(db.TripDetails.rows, 'trip_id', 'T_acc').status, 'ACCEPTED');
});

test('the dashboard lists a driver-cancelled trip as cancelled', async () => {
  const list = (await get('/business/trips?statusGroup=cancelled')).body.data.items.map((t) => t.id).sort();
  assert.ok(list.includes('T_drv'));
  assert.equal((await get('/business/trips/T_drv')).body.data.statusGroup, 'cancelled');
});
