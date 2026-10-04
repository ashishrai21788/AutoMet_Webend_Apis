// Operations screens: audit log, alerts, statistics, riders and trips, over HTTP with in-memory stand-ins for the
// database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-ops-tests';
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
const { computeAlerts, summarize } = require('../lib/alerts');
const { startOfDay, dateKey } = require('../lib/timeZone');
const { helpers: { safeMeta } } = require('../controllers/opsController');

const DAY = 86400000;
const now = Date.now();
const ago = (ms) => new Date(now - ms);
const ahead = (days) => new Date(now + days * DAY);

// ---------- pure: alerts and time zones ----------

test('time zones: a business day starts at its own local midnight', () => {
  const t = new Date('2026-10-04T20:00:00Z'); // 01:30 on 5 October in India
  assert.equal(dateKey(t, 'Asia/Kolkata'), '2026-10-05');
  assert.equal(startOfDay(t, 'Asia/Kolkata').toISOString(), '2026-10-04T18:30:00.000Z');
  assert.equal(startOfDay(t, 'UTC').toISOString(), '2026-10-04T00:00:00.000Z');
  assert.equal(startOfDay(t, 'Not/AZone').toISOString(), '2026-10-04T00:00:00.000Z', 'an unknown zone falls back to UTC');
  assert.equal(startOfDay(new Date('2026-07-01T12:00:00Z'), 'America/New_York').toISOString(), '2026-07-01T04:00:00.000Z', 'daylight saving');
});

test('alerts: each problem in the records is reported once, with a link and the affected items', () => {
  const regions = [
    { regionId: 'r1', city: 'Pune', zoneName: 'All areas', active: true, center: { lat: 1, lng: 1 }, radiusKm: 10 },
    { regionId: 'r2', city: 'Nashik', zoneName: 'All areas', active: true, center: null, radiusKm: null }
  ];
  const categories = [
    { categoryId: 'c1', name: 'Sedan', active: true, regionIds: ['r1'] },
    { categoryId: 'c2', name: 'Bike', active: true, regionIds: ['r1'] },
    { categoryId: 'c3', name: 'Van', active: true, regionIds: ['gone'] },
    { categoryId: 'c4', name: 'Retired', active: false, regionIds: [] }
  ];
  const fareRules = [{ categoryId: 'c1', active: true }, { categoryId: 'c3', active: true }];
  const drivers = [
    { driverId: 'd1', firstName: 'Asha', accountStatus: 'ACTIVE', driverVerificationStatus: 'APPROVED' },
    { driverId: 'd2', firstName: 'Ravi', accountStatus: 'SUSPENDED', driverVerificationStatus: 'APPROVED' },
    { driverId: 'd3', firstName: 'Meena', accountStatus: 'ACTIVE', driverVerificationStatus: 'APPROVED' }
  ];
  const vehicles = [{ vehicleId: 'v1', registrationNumber: 'MH12AB1' }];
  const driverDocs = [
    { driverId: 'd1', type: 'DRIVING_LICENSE', status: 'APPROVED', expiryDate: ahead(-3) },
    { driverId: 'd3', type: 'IDENTITY', status: 'APPROVED', expiryDate: ahead(10) },
    { driverId: 'd3', type: 'DRIVING_LICENSE', status: 'APPROVED', expiryDate: ahead(200) },
    { driverId: 'd1', type: 'ADDRESS_PROOF', status: 'REJECTED', expiryDate: ahead(-30) }, // rejected: not an expiry problem
    { driverId: 'd2', type: 'IDENTITY', status: 'SUBMITTED', expiryDate: null, submittedAt: ago(60 * 3600000) }
  ];
  const vehicleDocs = [{ vehicleId: 'v1', type: 'INSURANCE', status: 'APPROVED', expiryDate: ahead(0) }];
  const alerts = computeAlerts({ regions, categories, fareRules, drivers, vehicles, driverDocs, vehicleDocs, assignedDriverIds: ['d1'], now: new Date(now) });
  const by = Object.fromEntries(alerts.map((a) => [a.id, a]));

  assert.deepEqual(by['config.region_no_area'].items.map((i) => i.label), ['Nashik']);
  assert.deepEqual(by['config.category_no_price'].items.map((i) => i.label), ['Bike'], 'Retired is inactive, Van is priced');
  assert.deepEqual(by['config.category_no_region'].items.map((i) => i.label), ['Van']);
  assert.deepEqual(by['drivers.suspended'].items.map((i) => i.id), ['d2']);
  assert.deepEqual(by['drivers.no_vehicle'].items.map((i) => i.id), ['d3'], 'd1 has a vehicle, d2 is suspended');
  assert.equal(by['docs.driver_expired'].severity, 'critical');
  assert.deepEqual(by['docs.driver_expired'].items.map((i) => i.detail), ['Expired 3 days ago']);
  assert.deepEqual(by['docs.driver_expiring'].items.map((i) => i.label), ['Meena · Identity document']);
  assert.equal(by['docs.driver_expiring'].items[0].detail, 'Expires in 10 days');
  assert.deepEqual(by['docs.vehicle_expiring'].items.map((i) => i.detail), ['Expires today']);
  assert.equal(by['docs.awaiting_review'].severity, 'warning', 'waiting more than 48 hours');
  assert.match(by['docs.awaiting_review'].detail, /oldest has waited 60 hours/);
  // most urgent first
  assert.equal(alerts[0].severity, 'critical');
  assert.deepEqual(alerts.map((a) => a.severity), [...alerts.map((a) => a.severity)].sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a] - { critical: 0, warning: 1, info: 2 }[b])));
  assert.deepEqual(summarize(alerts), { critical: 1, warning: alerts.filter((a) => a.severity === 'warning').length, info: alerts.filter((a) => a.severity === 'info').length });
});

test('alerts: a healthy business has none, and a long list is capped with a count of the rest', () => {
  const healthy = computeAlerts({
    regions: [{ regionId: 'r1', city: 'X', zoneName: 'All areas', active: true, center: { lat: 1, lng: 1 }, radiusKm: 5 }],
    categories: [{ categoryId: 'c1', name: 'Sedan', active: true, regionIds: ['r1'] }], fareRules: [{ categoryId: 'c1', active: true }], now: new Date(now)
  });
  assert.deepEqual(healthy, []);
  const many = Array.from({ length: 14 }, (_, i) => ({ driverId: `d${i}`, firstName: `D${i}`, accountStatus: 'SUSPENDED' }));
  const [alert] = computeAlerts({ drivers: many, now: new Date(now) });
  assert.equal(alert.count, 14);
  assert.equal(alert.items.length, 10);
  assert.equal(alert.more, 4);
  const none = computeAlerts({ regions: [{ regionId: 'r', active: false, city: 'Y', zoneName: 'All areas' }], now: new Date(now) });
  assert.equal(none[0].id, 'config.no_active_region');
});

test('audit details never show secrets, document numbers or links', () => {
  const out = safeMeta({ reason: 'blurry', password: 'x', temporaryPassword: 'y', fileUrl: 'https://a', number: 'KA01', token: 't', from: 'A', to: 'B', empty: '', nested: { a: 1 } });
  assert.deepEqual(out, { reason: 'blurry', from: 'A', to: 'B', nested: '{"a":1}' });
  assert.equal(safeMeta({ password: 'x' }), null);
  assert.equal(safeMeta(null), null);
});

// ---------- over HTTP ----------

let server;
let base;
const hash = (pw) => bcrypt.hashSync(pw, 4);
const ctx = {};

test.before(async () => {
  const market = { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' };
  await db.Tenant.create({ tenantId: 'app_def', name: 'Default', slug: 'def', appName: 'D', packageName: 'in.def', status: 'active', isDefault: true, market });
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha', slug: 'a', appName: 'A', packageName: 'com.a', status: 'active', market });
  await db.Tenant.create({ tenantId: 'app_b', name: 'Beta', slug: 'b', appName: 'B', packageName: 'com.b', status: 'active', market });
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: hash(pw) });
  await mk('u_a', 'admin@a.test', 'client_admin', 'app_a', 'password-a-admin');
  await mk('u_a_ops', 'ops@a.test', 'operations', 'app_a', 'password-a-ops1');
  await mk('u_a_sup', 'support@a.test', 'support', 'app_a', 'password-a-supp');
  await mk('u_a_fin', 'finance@a.test', 'finance', 'app_a', 'password-a-fin1');
  await mk('u_b', 'admin@b.test', 'client_admin', 'app_b', 'password-b-admin');
  await mk('u_super', 'super@x.test', 'super_admin', null, 'password-super-1');
  await mk('u_def', 'def@x.test', 'client_admin', 'app_def', 'password-def-1');

  await db.ServiceRegion.create({ tenantId: 'app_a', regionId: 'rg_a', country: 'IN', state: 'S', city: 'Pune', zoneName: 'All areas', key: 'a', active: true, center: { lat: 18.5, lng: 73.8 }, radiusKm: 20 });
  await db.VehicleCategory.create({ tenantId: 'app_a', categoryId: 'vc_a', name: 'Sedan', nameKey: 'sedan', active: true, regionIds: ['rg_a'], passengerCapacity: 4, rideType: 'economy' });

  const driver = (driverId, tenantId, extra = {}) => db.Driver.create({ driverId, tenantId, firstName: driverId, lastName: 'Driver', email: `${driverId}@x.test`, phone: `+91${driverId.length}00${driverId.slice(-4)}`, passwordHash: 'x', isOnline: false, ...extra });
  await driver('drv_a1', 'app_a', { isOnline: true, operatingRegionId: 'rg_a', eligibleCategoryId: 'vc_a', accountStatus: 'SUSPENDED' });
  await driver('drv_b1', 'app_b');
  await driver('drv_old', null); // before businesses: the default business
  const rider = (userId, tenantId, firstName, phone, extra = {}) => db.User.create({ userId, tenantId, firstName, lastName: 'Rider', phone, email: `${userId}@r.test`, passwordHash: 'secret-hash', accessToken: 'tok', fcmToken: 'fcm', isPhoneVerified: true, createdAt: ago(2 * DAY), ...extra });
  await rider('usr_a1', 'app_a', 'Anita', '+919000000001');
  await rider('usr_a2', 'app_a', 'Bhavna', '+919000000002', { createdAt: ago(20 * DAY) });
  await rider('usr_b1', 'app_b', 'Bella', '+919000000003');
  await rider('usr_old', null, 'Olga', '+919000000004');

  const trip = (id, tenantId, userId, driverId, status, extra = {}) => db.TripDetails.create({
    trip_id: id, request_id: `req_${id}`, user_id: userId, driver_id: driverId, tenant_id: tenantId, status,
    pickup: { address: 'FC Road', lat: 18.52, lng: 73.84 }, drop: { address: 'Airport', lat: 18.58, lng: 73.91 }, fare: 250, currency: 'INR',
    fare_basis: 'ESTIMATE', payment_mode: 'CASH', region_id: 'rg_a', category_id: 'vc_a', requested_at: ago(60 * 60000), timeout_at: ago(0), ...extra
  });
  await trip('T1', 'app_a', 'usr_a1', 'drv_a1', 'COMPLETED', { completed_at: ago(30 * 60000), started_at: ago(50 * 60000), arrived_at: ago(55 * 60000), responded_at: ago(58 * 60000), fare: 300 });
  await trip('T2', 'app_a', 'usr_a1', 'drv_a1', 'ON_GOING', { started_at: ago(5 * 60000) });
  await trip('T3', 'app_a', 'usr_a2', 'drv_a1', 'REQUESTED');
  await trip('T4', 'app_a', 'usr_a2', 'drv_a1', 'CANCELLED_BY_USER', { cancelled_by: 'USER', cancel_stage: 'before_accept', cancellation_reason: 'Changed my mind', cancelled_at: ago(10 * 60000) });
  await trip('T5', 'app_a', 'usr_a1', 'drv_a1', 'COMPLETED', { requested_at: ago(5 * DAY), completed_at: ago(5 * DAY), fare: 100 });
  await trip('TB', 'app_b', 'usr_b1', 'drv_b1', 'COMPLETED', { completed_at: ago(10 * 60000), fare: 999 });
  await trip('TD', null, 'usr_old', 'drv_old', 'COMPLETED', { completed_at: ago(10 * 60000), fare: 50 });
  await db.TripEvent.create({ trip_id: 'T1', event: 'ride_request_accepted', created_at: ago(58 * 60000) });

  await db.DriverDocument.create({ tenantId: 'app_a', docId: 'dd1', driverId: 'drv_a1', type: 'DRIVING_LICENSE', status: 'APPROVED', expiryDate: ahead(-2), file: { key: 'k', mime: 'image/jpeg', size: 1 } });

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
  ctx.super = await login('super@x.test', 'password-super-1');
  ctx.def = await login('def@x.test', 'password-def-1');

  const e = (action, targetType, targetId, actorEmail, tenantId, at, meta) => db.AdminAudit.create({ tenantId, actorEmail, actorId: actorEmail, action, targetType, targetId, meta, at });
  await e('driver.status_changed', 'driver', 'drv_a1', 'admin@a.test', 'app_a', ago(3600000), { reason: 'Test', password: 'leak' });
  await e('document.reviewed', 'driver_document', 'dd1', 'ops@a.test', 'app_a', ago(7200000), { number: 'KA0112345', decision: 'APPROVED' });
  await e('vehicle.created', 'vehicle', 'veh_1', 'admin@a.test', 'app_a', ago(10 * DAY));
  await e('driver.created', 'driver', 'drv_b1', 'admin@b.test', 'app_b', ago(3600000));
});
test.after(() => server.close());

const get = async (path, { token = ctx.admin, appId = 'app_a' } = {}) => {
  const res = await fetch(base + '/api/admin' + path, { headers: { Authorization: `Bearer ${token}`, ...(appId ? { 'X-App-Id': appId } : {}) } });
  return { status: res.status, body: await res.json() };
};

test('audit log: scoped to the business, newest first, filtered and paged, secrets removed', async () => {
  const all = await get('/business/audit');
  assert.equal(all.status, 200);
  // the four sign-ins made by this test setup are recorded too, newest first
  const events = all.body.data.items.filter((i) => !i.action.startsWith('auth.'));
  assert.deepEqual(events.map((i) => i.action), ['driver.status_changed', 'document.reviewed', 'vehicle.created']);
  assert.equal(all.body.data.total, 7);
  assert.ok(all.body.data.items.slice(0, 4).every((i) => i.action === 'auth.login'), 'sign-ins are the newest');
  const first = events[0];
  assert.deepEqual(first.details, { reason: 'Test' }, 'the password is not shown');
  assert.equal(events[1].details.decision, 'APPROVED');
  assert.equal(events[1].details.number, undefined, 'document numbers are not shown');
  assert.ok(!JSON.stringify(all.body).includes('leak') && !JSON.stringify(all.body).includes('KA0112345'));
  assert.ok(!JSON.stringify(all.body).includes('drv_b1'), "another business's events are not included");

  assert.equal((await get('/business/audit?action=driver.')).body.data.total, 1, 'an action prefix');
  assert.equal((await get('/business/audit?action=auth.')).body.data.total, 4);
  assert.equal((await get('/business/audit?targetType=vehicle')).body.data.total, 1);
  assert.equal((await get('/business/audit?actor=ops@a.test')).body.data.total, 2, 'its sign-in and the review');
  assert.equal((await get('/business/audit?q=dd1')).body.data.total, 1, 'free text over target');
  assert.equal((await get(`/business/audit?actor=admin@a.test&from=${encodeURIComponent(ago(5 * DAY).toISOString())}`)).body.data.total, 2, 'a date range: the sign-in and the status change, not the ten-day-old event');
  assert.equal((await get('/business/audit?from=not-a-date')).status, 400);
  const paged = (await get('/business/audit?pageSize=3&page=3')).body.data;
  assert.equal(paged.items.length, 1);
  assert.equal(paged.total, 7);
  assert.ok(all.body.data.facets.actions.includes('vehicle.created'));
});

test('audit log: needs the audit permission, and another business cannot read it', async () => {
  assert.equal((await get('/business/audit', { token: ctx.ops })).status, 403);
  assert.equal((await get('/business/audit', { token: ctx.support })).status, 403);
  assert.equal((await get('/business/audit', { token: ctx.finance })).status, 403);
  assert.equal((await get('/business/audit', { token: ctx.b, appId: 'app_a' })).status, 403);
  assert.equal((await get('/business/audit', { token: ctx.super })).status, 403, 'a super admin cannot open a business\'s own audit log');
  assert.equal((await get('/business/audit', { token: ctx.super, appId: 'app_a' })).status, 403);
  assert.equal((await get('/business/audit', { token: ctx.b, appId: 'app_b' })).body.data.total, 2, 'its own sign-in and its one event');
  assert.equal((await fetch(base + '/api/admin/business/audit')).status, 401);
});

test('alerts: built from the real records of this business only', async () => {
  const res = await get('/business/alerts');
  assert.equal(res.status, 200);
  const ids = res.body.data.alerts.map((a) => a.id);
  assert.ok(ids.includes('docs.driver_expired'));
  assert.ok(ids.includes('drivers.suspended'));
  const expired = res.body.data.alerts.find((a) => a.id === 'docs.driver_expired');
  assert.equal(expired.items[0].label, 'drv_a1 Driver · Driving licence');
  assert.equal(expired.link, '/verification');
  assert.equal(res.body.data.counts.critical >= 1, true);
  assert.equal((await get('/business/alerts', { token: ctx.b, appId: 'app_b' })).body.data.alerts.length, 0, 'business B has none of A\'s alerts');
  assert.equal((await get('/business/alerts', { token: ctx.support })).status, 200, 'any role that sees the dashboard');
});

test('statistics: live counts from this business\'s drivers, trips and riders', async () => {
  const res = await get('/business/stats');
  assert.equal(res.status, 200);
  const s = res.body.data;
  assert.equal(s.drivers.total, 1);
  assert.equal(s.drivers.online, 1);
  assert.equal(s.drivers.eligible, 0, 'the only driver is suspended');
  assert.equal(s.trips.active, 1, 'T2');
  assert.equal(s.trips.searching, 1, 'T3');
  assert.equal(s.trips.completedToday, 1, 'T1 (T5 was five days ago)');
  assert.equal(s.trips.cancelledToday, 1, 'T4');
  assert.equal(s.trips.requestedToday, 4);
  assert.equal(s.revenue.today, 300, 'only completed trips of this business today');
  assert.equal(s.revenue.currency, 'INR');
  assert.equal(s.riders.total, 2);
  assert.equal(s.riders.newThisWeek, 1);
  assert.equal(s.trips.last7Days.length, 7);
  assert.equal(s.trips.last7Days.reduce((n, d) => n + d.requested, 0), 5, 'all five trips of the week');
  assert.ok(s.notAvailable.includes('payments'));
  // the default business sees the untagged trip and nothing of A or B
  const def = (await get('/business/stats', { token: ctx.def, appId: null })).body.data;
  assert.equal(def.revenue.today, 50);
  assert.equal(def.riders.total, 1);
});

test('riders: list with search and trip counts, detail with recent trips, no private fields, isolated by business', async () => {
  const list = (await get('/business/riders')).body.data;
  assert.deepEqual(list.items.map((r) => r.id).sort(), ['usr_a1', 'usr_a2']);
  const anita = list.items.find((r) => r.id === 'usr_a1');
  assert.deepEqual(anita.trips, { total: 3, completed: 2, cancelled: 0 });
  assert.equal(list.items.find((r) => r.id === 'usr_a2').trips.cancelled, 1);
  const text = JSON.stringify(list);
  for (const secret of ['secret-hash', 'passwordHash', 'accessToken', 'fcmToken', 'tok']) assert.ok(!text.includes(`"${secret}"`) && !text.includes(secret === 'tok' ? '"tok"' : secret), `no ${secret}`);
  assert.equal((await get('/business/riders?q=bhav')).body.data.total, 1, 'search by name');
  assert.equal((await get('/business/riders?q=9000000001')).body.data.items[0].id, 'usr_a1', 'search by phone');
  assert.equal((await get('/business/riders?q=Bella')).body.data.total, 0, "another business's rider is not found");

  const detail = (await get('/business/riders/usr_a1')).body.data;
  assert.equal(detail.name, 'Anita Rider');
  assert.deepEqual(detail.recentTrips.map((t) => t.id), ['T2', 'T1', 'T5'].sort((a, b) => 0) && detail.recentTrips.map((t) => t.id), 'newest first');
  assert.equal(detail.recentTrips.length, 3);
  assert.equal(detail.recentTrips[0].driver.name, 'drv_a1 Driver');
  assert.equal((await get('/business/riders/usr_b1')).status, 404, "a rider of another business is not found");
  assert.equal((await get('/business/riders/nope')).status, 404);
  assert.equal((await get('/business/riders', { token: ctx.finance })).status, 403, 'finance cannot see riders');
  assert.equal((await get('/business/riders', { token: ctx.support })).status, 200);
});

test('trips: filters, names, paging, detail with timeline and cancellation, isolated by business', async () => {
  const all = (await get('/business/trips')).body.data;
  assert.equal(all.total, 5, 'A has five trips; B and the default business are not included');
  assert.deepEqual(all.items.map((t) => t.id).includes('TB') || all.items.map((t) => t.id).includes('TD'), false);
  const t1 = all.items.find((t) => t.id === 'T1');
  assert.equal(t1.rider.name, 'Anita Rider');
  assert.equal(t1.rider.phone, '+919000000001');
  assert.equal(t1.driver.name, 'drv_a1 Driver');
  assert.equal(t1.fare, 300);
  assert.equal(t1.pickup, 'FC Road');
  assert.equal(t1.statusGroup, 'completed');

  assert.deepEqual((await get('/business/trips?statusGroup=active')).body.data.items.map((t) => t.id), ['T2']);
  assert.deepEqual((await get('/business/trips?statusGroup=searching')).body.data.items.map((t) => t.id), ['T3']);
  assert.deepEqual((await get('/business/trips?statusGroup=cancelled')).body.data.items.map((t) => t.id), ['T4']);
  assert.equal((await get('/business/trips?statusGroup=completed')).body.data.total, 2);
  assert.equal((await get('/business/trips?statusGroup=bogus')).status, 400);
  assert.equal((await get('/business/trips?status=COMPLETED&riderId=usr_a1')).body.data.total, 2);
  assert.equal((await get('/business/trips?driverId=drv_a1')).body.data.total, 5);
  assert.equal((await get('/business/trips?driverId=drv_b1')).body.data.total, 0, "another business's driver");
  assert.equal((await get('/business/trips?q=T3')).body.data.total, 1);
  assert.equal((await get(`/business/trips?from=${encodeURIComponent(ago(24 * 3600000).toISOString())}`)).body.data.total, 4, 'the five-day-old trip is excluded');
  assert.equal((await get('/business/trips?to=garbage')).status, 400);
  const page = (await get('/business/trips?pageSize=2&page=3')).body.data;
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 5);

  const d = (await get('/business/trips/T4')).body.data;
  assert.equal(d.cancellation.by, 'USER');
  assert.equal(d.cancellation.stage, 'before_accept');
  assert.equal(d.cancellation.reason, 'Changed my mind');
  assert.equal(d.region.name, 'Pune');
  assert.equal(d.category.name, 'Sedan');
  assert.deepEqual(d.timeline.map((x) => x.label), ['Ride requested', 'Cancelled']);
  const done = (await get('/business/trips/T1')).body.data;
  assert.deepEqual(done.timeline.map((x) => x.label), ['Ride requested', 'Driver responded', 'Driver arrived', 'Trip started', 'Trip completed']);
  assert.equal(done.cancellation, null);
  assert.equal(done.fareDetail.amount, 300);
  assert.equal(done.fareDetail.basis, 'ESTIMATE');
  assert.deepEqual(done.events.map((e) => e.event), ['ride_request_accepted']);
  assert.equal(done.payment.available, false, 'payments are not recorded yet, and the response says so');
  assert.deepEqual(done.pickupPoint, { lat: 18.52, lng: 73.84 });

  assert.equal((await get('/business/trips/TB')).status, 404, "another business's trip");
  assert.equal((await get('/business/trips/TD')).status, 404, 'the default business\'s untagged trip');
  assert.equal((await get('/business/trips/TB', { token: ctx.b, appId: 'app_a' })).status, 403);
  assert.equal((await get('/business/trips/TB', { token: ctx.b, appId: 'app_b' })).body.data.id, 'TB');
  assert.equal((await get('/business/trips', { token: ctx.finance })).status, 200, 'finance may see trips');
  assert.equal((await get('/business/trips', { token: ctx.ops })).status, 200);
});
