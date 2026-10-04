// Business reports and CSV exports: the report maths (checked by hand against a small fixture), the date range rules,
// the CSV safety rules, and who may read or export what. In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-report-tests';
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
const { cell, toCsv } = require('../lib/csv');
const { buildReport, dayKeys } = require('../lib/reports');
const { helpers: { parseRange } } = require('../controllers/reportsController');
const { buildAuditFilter } = require('../lib/auditQuery');

const MIN = 60000;
const DAY = 86400000;
const ago = (ms) => new Date(Date.now() - ms);

// ---------- csv ----------

test('csv: quoting, formula protection, dates and the byte-order mark', () => {
  assert.equal(cell('plain'), 'plain');
  assert.equal(cell('a,b'), '"a,b"');
  assert.equal(cell('say "hi"'), '"say ""hi"""');
  assert.equal(cell('two\nlines'), '"two\nlines"');
  assert.equal(cell(null), '');
  assert.equal(cell(undefined), '');
  assert.equal(cell(12.5), '12.5');
  assert.equal(cell(-3), '-3', 'a negative number is a number');
  assert.equal(cell(new Date('2026-10-04T00:00:00Z')), '2026-10-04T00:00:00.000Z');
  for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '=HYPERLINK("http://evil","x")']) {
    assert.ok(cell(evil).replace(/^"/, '').startsWith("'"), `${JSON.stringify(evil)} is neutralised`);
  }
  assert.equal(cell('-'), "'-");
  const csv = toCsv([{ n: 'Ann', v: 1 }, { n: '=bad', v: null }], [{ header: 'Name', value: (r) => r.n }, { header: 'Value', value: (r) => r.v }]);
  assert.ok(csv.startsWith('﻿Name,Value\r\n'));
  assert.equal(csv, "﻿Name,Value\r\nAnn,1\r\n'=bad,\r\n");
});

// ---------- date ranges ----------

test('range: default is the last 30 days of the business time zone; both ends included; limits enforced', () => {
  const now = new Date('2026-10-04T20:00:00Z'); // 5 October 01:30 in India
  const r = parseRange({}, 'Asia/Kolkata', now);
  assert.equal(r.toDay, '2026-10-05');
  assert.equal(r.fromDay, '2026-09-06');
  assert.equal(r.from.toISOString(), '2026-09-05T18:30:00.000Z', 'starts at local midnight');
  assert.equal(r.to.toISOString(), '2026-10-05T18:29:59.999Z', 'ends at the last millisecond of the local day');
  assert.equal(dayKeys(r.from, r.to, 'Asia/Kolkata').length, 30);

  const one = parseRange({ from: '2026-10-01', to: '2026-10-01' }, 'UTC', now);
  assert.equal(dayKeys(one.from, one.to, 'UTC').length, 1);
  assert.ok(parseRange({ from: '2026-10-05', to: '2026-10-01' }, 'UTC', now).error.to);
  assert.ok(parseRange({ from: 'yesterday' }, 'UTC', now).error.from);
  assert.ok(parseRange({ to: '2026-13-45' }, 'UTC', now).error.to);
  assert.ok(parseRange({ from: '2026-01-01', to: '2026-10-01' }, 'UTC', now).error.from, 'more than 92 days');
  assert.equal(parseRange({ from: '2026-07-04', to: '2026-10-03' }, 'UTC', now).error, undefined, 'exactly 92 days is allowed');
});

test('audit filter: shared by the log, its export and the platform log', () => {
  assert.deepEqual(buildAuditFilter({}, 'app_a').filter, { tenantId: 'app_a' });
  assert.deepEqual(buildAuditFilter({ targetType: 'driver', actor: 'A@B.com' }, 'app_a').filter, { tenantId: 'app_a', targetType: 'driver', actorEmail: 'a@b.com' });
  assert.deepEqual(buildAuditFilter({}, null).filter, {}, 'the platform log has no business filter');
  assert.deepEqual(buildAuditFilter({ tenantId: 'app_x' }, null).filter, { tenantId: 'app_x' });
  assert.equal(buildAuditFilter({ tenantId: 'app_x' }, 'app_a').filter.tenantId, 'app_a', 'a business log cannot be pointed at another business');
  assert.ok(buildAuditFilter({ from: 'nope' }, 'app_a').errors.from);
});

// ---------- the report maths ----------

const T0 = ago(2 * DAY);
const trip = (id, status, driver, category, extra = {}) => ({
  trip_id: id, status, driver_id: driver, user_id: 'usr', category_id: category, region_id: 'rg_a', payment_mode: 'CASH', currency: 'INR',
  requested_at: T0, ...extra
});
const at = (min) => new Date(T0.getTime() + min * MIN);
const FIXTURE = [
  trip('T1', 'COMPLETED', 'd1', 'vc_a', { fare: 300, fare_basis: 'ACTUAL', distance_km: 10, responded_at: at(3), started_at: at(10), completed_at: at(50), fare_breakdown: { feesTotal: 5, taxesTotal: 15 } }),
  trip('T2', 'COMPLETED', 'd1', 'vc_b', { fare: 100, fare_basis: 'ESTIMATE', distance_km: 4, responded_at: at(1), started_at: at(5), completed_at: at(25) }),
  trip('T3', 'COMPLETED', 'd2', 'vc_a', { fare: 200, fare_basis: 'ESTIMATE', payment_mode: 'UPI', distance_km: 6, responded_at: at(5), started_at: at(5), completed_at: at(35) }),
  trip('T4', 'CANCELLED_BY_USER', 'd2', 'vc_a'),
  trip('T5', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE', 'd1', 'vc_a', { responded_at: at(2) }),
  trip('T6', 'NO_RESPONSE', 'd2', 'vc_a'),
  trip('T7', 'REJECTED', 'd1', 'vc_b'),
  trip('T8', 'REQUESTED', 'd2', 'vc_a'),
  trip('T9', 'ON_GOING', 'd1', 'vc_a', { started_at: at(20) })
];
const RANGE = { from: new Date(Date.now() - 3 * DAY), to: new Date() };

test('report: outcome counts and rates over the trips that have reached an outcome', () => {
  const r = buildReport({ trips: FIXTURE, ...RANGE, tz: 'UTC' });
  assert.deepEqual([r.rides.requested, r.rides.completed, r.rides.cancelled, r.rides.noDriver, r.rides.stillOpen], [9, 3, 2, 2, 2]);
  assert.equal(r.rides.completionRate, 42.9, '3 of the 7 that are finished');
  assert.equal(r.rides.cancellationRate, 28.6);
  assert.equal(r.rides.noDriverRate, 28.6);
  assert.equal(r.rides.avgResponseMinutes, 2.75, '(3 + 1 + 5 + 2) / 4');
  assert.equal(r.rides.avgTripMinutes, 30, '(40 + 20 + 30) / 3');
  assert.equal(r.rides.avgDistanceKm, 6.67);
  assert.equal(r.rides.avgFare, 200);
});

test('report: money is only completed trips, and says whether it is estimated; unrecorded things are listed as unavailable', () => {
  const { finance } = buildReport({ trips: FIXTURE, ...RANGE, tz: 'UTC' });
  assert.equal(finance.grossFares, 600);
  assert.equal(finance.bookingFees, 5);
  assert.equal(finance.taxes, 15);
  assert.equal(finance.completedTrips, 3);
  assert.equal(finance.estimatedFares, 2);
  assert.equal(finance.basis, 'a mix of estimates and final fares');
  assert.deepEqual(finance.byPaymentMode, [{ mode: 'CASH', trips: 2, fares: 400 }, { mode: 'UPI', trips: 1, fares: 200 }]);
  assert.ok(finance.unavailable.includes('platform commission') && finance.unavailable.includes('payments received'));
  const allEstimates = buildReport({ trips: [FIXTURE[1], FIXTURE[2]], ...RANGE, tz: 'UTC' }).finance;
  assert.equal(allEstimates.basis, 'estimates');
  assert.equal(buildReport({ trips: [FIXTURE[0]], ...RANGE, tz: 'UTC' }).finance.basis, 'final fares');
});

test('report: by category, by region, by driver (what each driver did with the requests they could answer)', () => {
  const r = buildReport({ trips: FIXTURE, ...RANGE, tz: 'UTC', categoryNames: new Map([['vc_a', 'Sedan'], ['vc_b', 'Bike']]), regionNames: new Map([['rg_a', 'Pune']]), driverNames: new Map([['d1', 'Asha'], ['d2', 'Ravi']]) });
  const a = r.byCategory.find((x) => x.id === 'vc_a');
  assert.deepEqual([a.name, a.requested, a.completed, a.cancelled, a.unanswered, a.fares], ['Sedan', 7, 2, 2, 1, 500]);
  const b = r.byCategory.find((x) => x.id === 'vc_b');
  assert.deepEqual([b.name, b.requested, b.completed, b.unanswered, b.fares], ['Bike', 2, 1, 1, 100]);
  assert.equal(r.byRegion.length, 1);
  assert.equal(r.byRegion[0].name, 'Pune');

  const [d1, d2] = r.drivers;
  assert.deepEqual([d1.name, d1.offered, d1.accepted, d1.declined, d1.noResponse, d1.completed, d1.cancelled, d1.fares, d1.acceptanceRate], ['Asha', 5, 4, 1, 0, 2, 1, 400, 80]);
  assert.deepEqual([d2.name, d2.offered, d2.accepted, d2.declined, d2.noResponse, d2.completed, d2.fares, d2.acceptanceRate], ['Ravi', 2, 1, 0, 1, 1, 200, 50], 'a request cancelled by the rider before an answer, and one still waiting, are not counted');
});

test('report: one row per calendar day of the range, in the business time zone', () => {
  const r = buildReport({ trips: FIXTURE, ...RANGE, tz: 'UTC' });
  assert.equal(r.byDay.length, dayKeys(RANGE.from, RANGE.to, 'UTC').length);
  assert.equal(r.byDay.reduce((n, d) => n + d.requested, 0), 9);
  assert.equal(r.byDay.reduce((n, d) => n + d.completed, 0), 3);
  assert.equal(r.byDay.reduce((n, d) => n + d.fares, 0), 600);
  const empty = buildReport({ trips: [], ...RANGE, tz: 'UTC' });
  assert.equal(empty.rides.completionRate, 0);
  assert.equal(empty.rides.avgFare, null);
  assert.equal(empty.finance.grossFares, 0);
  assert.deepEqual(empty.drivers, []);
});

// ---------- over HTTP ----------

let server;
let base;
const ctx = {};

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

  await db.VehicleCategory.create({ tenantId: 'app_a', categoryId: 'vc_a', name: 'Sedan', nameKey: 'sedan', active: true, regionIds: ['rg_a'], passengerCapacity: 4, rideType: 'economy' });
  await db.VehicleCategory.create({ tenantId: 'app_a', categoryId: 'vc_b', name: 'Bike', nameKey: 'bike', active: true, regionIds: ['rg_a'], passengerCapacity: 1, rideType: 'two_wheeler' });
  await db.ServiceRegion.create({ tenantId: 'app_a', regionId: 'rg_a', country: 'IN', state: 'MH', city: 'Pune', zoneName: 'All areas', key: 'pune', active: true });
  await db.Driver.create({ driverId: 'd1', tenantId: 'app_a', firstName: 'Asha', lastName: 'Verma', email: 'd1@x.test', phone: '+9111', passwordHash: 'x', accountStatus: 'ACTIVE' });
  await db.Driver.create({ driverId: 'd2', tenantId: 'app_a', firstName: 'Ravi', lastName: 'Kumar', email: 'd2@x.test', phone: '+9122', passwordHash: 'x', accountStatus: 'SUSPENDED' });
  await db.User.create({ userId: 'usr', tenantId: 'app_a', firstName: '=cmd|calc', lastName: 'Rider', phone: '+9199', email: 'u@x.test', createdAt: ago(5 * DAY) });
  await db.User.create({ userId: 'usr_b', tenantId: 'app_b', firstName: 'Bella', lastName: 'B', phone: '+9188', createdAt: ago(5 * DAY) });

  for (const t of FIXTURE) {
    await db.TripDetails.create({ ...t, request_id: `req_${t.trip_id}`, tenant_id: 'app_a', pickup: { address: 'FC Road, Pune', lat: 18.5, lng: 73.8 }, drop: { address: 'Airport', lat: 18.6, lng: 73.9 }, timeout_at: new Date() });
  }
  await db.TripDetails.create({ ...trip('T_old', 'COMPLETED', 'd1', 'vc_a', { fare: 999, requested_at: ago(100 * DAY) }), request_id: 'r_old', tenant_id: 'app_a', pickup: { address: 'a', lat: 1, lng: 1 }, drop: { address: 'b', lat: 1, lng: 1 }, timeout_at: new Date() });
  await db.TripDetails.create({ ...trip('T_b', 'COMPLETED', 'db', 'vc_x', { fare: 777 }), request_id: 'r_b', tenant_id: 'app_b', user_id: 'usr_b', pickup: { address: 'a', lat: 1, lng: 1 }, drop: { address: 'b', lat: 1, lng: 1 }, timeout_at: new Date() });

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

const call = (path, { token = ctx.admin, appId = 'app_a' } = {}) => fetch(base + '/api/admin' + path, { headers: { Authorization: `Bearer ${token}`, 'X-App-Id': appId } });
// fetch's text() drops a leading byte-order mark, and the mark is part of what is being tested
const csvText = async (res) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
const json = async (path, opts) => { const r = await call(path, opts); return { status: r.status, body: await r.json() }; };

test('summary endpoint: this business only, default range, with names filled in', async () => {
  const r = await json('/business/reports/summary');
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.deepEqual([d.rides.requested, d.rides.completed, d.rides.cancelled, d.rides.noDriver, d.rides.stillOpen], [9, 3, 2, 2, 2], 'the 100-day-old trip and the other business are left out');
  assert.equal(d.finance.grossFares, 600);
  assert.equal(d.currency, 'INR');
  assert.equal(d.byDay.length, 30);
  assert.equal(d.range.timezone, 'Asia/Kolkata');
  assert.equal(d.partial, false);
  assert.deepEqual(d.byCategory.map((c) => c.name).sort(), ['Bike', 'Sedan']);
  assert.equal(d.byRegion[0].name, 'Pune');
  assert.deepEqual(d.drivers.map((x) => x.name), ['Asha Verma', 'Ravi Kumar']);
  assert.ok(!JSON.stringify(d).includes('777') && !JSON.stringify(d).includes('usr_b'));
});

test('summary endpoint: filters and date range', async () => {
  assert.equal((await json('/business/reports/summary?categoryId=vc_b')).body.data.rides.requested, 2);
  assert.equal((await json('/business/reports/summary?driverId=d2')).body.data.rides.requested, 4);
  assert.equal((await json('/business/reports/summary?regionId=rg_none')).body.data.rides.requested, 0);
  const wide = (await json(`/business/reports/summary?from=${new Date(Date.now() - 120 * DAY).toISOString().slice(0, 10)}&to=${new Date(Date.now() - 95 * DAY).toISOString().slice(0, 10)}`)).body.data;
  assert.equal(wide.rides.requested, 1, 'the old trip is found by its own range');
  assert.equal((await json('/business/reports/summary?from=2026-01-01&to=2026-10-01')).status, 400, 'over 92 days');
  assert.equal((await json('/business/reports/summary?from=garbage')).status, 400);
  assert.equal((await json('/business/reports/summary?from=2026-10-05&to=2026-10-01')).status, 400);
});

test('reports and exports: who may use them', async () => {
  assert.equal((await fetch(base + '/api/admin/business/reports/summary')).status, 401);
  assert.equal((await call('/business/reports/summary', { token: ctx.b, appId: 'app_a' })).status, 403, "another business's admin");
  for (const role of ['ops', 'support', 'finance']) assert.equal((await call('/business/reports/summary', { token: ctx[role] })).status, 200, `${role} sees reports`);
  assert.equal((await call('/business/export/trips.csv', { token: ctx.finance })).status, 200, 'finance may export trips');
  assert.equal((await call('/business/export/riders.csv', { token: ctx.finance })).status, 403, 'finance cannot export riders');
  assert.equal((await call('/business/export/drivers.csv', { token: ctx.finance })).status, 403);
  assert.equal((await call('/business/export/riders.csv', { token: ctx.support })).status, 200);
  assert.equal((await call('/business/audit.csv', { token: ctx.ops })).status, 403, 'audit export needs the audit permission');
  assert.equal((await call('/business/audit.csv', { token: ctx.admin })).status, 200);
});

test('trips export: a safe CSV of this business with names, correct headers, and an audit record', async () => {
  const res = await call('/business/export/trips.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="trips_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal(res.headers.get('x-row-count'), '9');
  assert.equal(res.headers.get('x-truncated'), 'false');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await csvText(res);
  assert.ok(text.startsWith('﻿Trip ID,Requested at (UTC),Status,Rider,'));
  const lines = text.trim().split('\r\n');
  assert.equal(lines.length, 10, 'header and nine trips');
  assert.ok(lines.some((l) => l.startsWith('T1,') && l.includes('300') && l.includes('Asha Verma') && l.includes('Sedan') && l.includes('Pune') && l.includes('FC Road')));
  assert.ok(lines.every((l) => !l.includes('T_b') && !l.includes('T_old') && !l.includes('Bella')));
  assert.ok(text.includes("'=cmd|calc Rider"), 'the rider whose name starts with = cannot run as a formula');
  const filtered = await csvText(await call('/business/export/trips.csv?statusGroup=completed'));
  assert.equal(filtered.trim().split('\r\n').length, 4, 'header and the three completed trips');
  assert.equal((await call('/business/export/trips.csv?from=bad')).status, 400);
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'export.trips' && a.actorEmail === 'admin@a.test' && a.meta.rows === 9), 'exports are audited');
});

test('riders, drivers and audit exports', async () => {
  const riders = await csvText(await call('/business/export/riders.csv'));
  assert.ok(riders.startsWith('﻿Rider ID,Name,Phone,Email,'));
  const rl = riders.trim().split('\r\n');
  assert.equal(rl.length, 2, "one rider; the other business's rider is not included");
  assert.ok(rl[1].includes("'=cmd|calc Rider") && rl[1].endsWith(',10,4'), 'trip counts are all-time: ten trips including the old one, four completed');
  assert.ok(!riders.includes('Bella'));

  const drivers = await csvText(await call('/business/export/drivers.csv'));
  const dl = drivers.trim().split('\r\n');
  assert.equal(dl.length, 3);
  assert.ok(dl.some((l) => l.includes('Asha Verma') && l.includes('ACTIVE')) && dl.some((l) => l.includes('Ravi Kumar') && l.includes('SUSPENDED')));
  assert.ok(!drivers.includes('passwordHash') && !drivers.includes('accessToken'));

  const audit = await call('/business/audit.csv');
  const text = await csvText(audit);
  assert.ok(text.startsWith('﻿When (UTC),Who,Action,Target type,Target,Details'));
  assert.ok(text.includes('export.trips'), 'the earlier export shows in the log');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'export.audit'));
});
