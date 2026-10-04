// The business-setup reset: exactly what it deletes and what it must never touch. Uses a small in-memory stand-in for the
// MongoDB driver (collection, countDocuments, find, deleteMany). Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { plan, execute, TARGETS, LEFT_ALONE } = require('../lib/resetBusinessSetup');

// a tiny driver stand-in that understands the three filters the reset uses: {} and { role: { $ne: 'super_admin' } }
function fakeDriverDb(data) {
  const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => (v && v.$ne !== undefined ? doc[k] !== v.$ne : doc[k] === v));
  return {
    data,
    collection: (name) => ({
      countDocuments: async (f = {}) => (data[name] || []).filter((d) => matches(d, f)).length,
      find: (f = {}) => ({ toArray: async () => (data[name] || []).filter((d) => matches(d, f)).map((d) => ({ ...d })) }),
      deleteMany: async (f = {}) => { const keep = (data[name] || []).filter((d) => !matches(d, f)); const n = (data[name] || []).length - keep.length; data[name] = keep; return { deletedCount: n }; }
    })
  };
}

const seed = () => ({
  tenants: [{ tenantId: 'app_def', name: 'AutoMet', isDefault: true }, { tenantId: 'app_a', name: 'Alpha' }, { tenantId: 'app_b', name: 'Beta' }],
  service_regions: [{ tenantId: 'app_a' }, { tenantId: 'app_def' }],
  vehicle_categories: [{ tenantId: 'app_a' }],
  fare_rules: [{ tenantId: 'app_a' }, { tenantId: 'app_a' }],
  cancellation_policies: [{ tenantId: 'app_a' }],
  business_setup_progress: [{ tenantId: 'app_def' }],
  admin_users: [{ adminId: 's1', role: 'super_admin', tenantId: null }, { adminId: 'a1', role: 'client_admin', tenantId: 'app_a' }, { adminId: 'o1', role: 'operations', tenantId: 'app_a' }],
  admin_audit_logs: [{ action: 'x' }, { action: 'y' }, { action: 'z' }],
  // what the apps created, and fleet data: must survive
  drivers: [{ driverId: 'd1' }, { driverId: 'd2' }],
  users: [{ userId: 'u1' }],
  trips_details: [{ trip_id: 't1' }],
  driver_issues_reports: [{ issueText: 'x' }],
  users_otp: [{ otp: '1' }],
  vehicles: [{ vehicleId: 'v1' }],
  driver_documents: [{ docId: 'dd1' }],
  vehicle_documents: [{ docId: 'vd1' }],
  driver_vehicle_assignments: [{ assignmentId: 'as1' }],
  entity_history: [{ subjectId: 'd1' }]
});

test('the dry run counts what would go, lists the businesses, and deletes nothing', async () => {
  const db = fakeDriverDb(seed());
  const p = await plan(db);
  const counts = Object.fromEntries(p.targets.map((t) => [t.name, t.count]));
  assert.deepEqual(counts, { tenants: 3, service_regions: 2, vehicle_categories: 1, fare_rules: 2, cancellation_policies: 1, business_setup_progress: 1, admin_users: 2, admin_audit_logs: 3 });
  assert.equal(p.superAdmins, 1);
  assert.deepEqual(p.tenants.map((t) => t.tenantId), ['app_def', 'app_a', 'app_b']);
  assert.equal(p.tenants[0].isDefault, true);
  assert.deepEqual(Object.fromEntries(p.leftAlone.map((t) => [t.name, t.count])), { vehicles: 1, driver_documents: 1, vehicle_documents: 1, driver_vehicle_assignments: 1, entity_history: 1 });
  assert.deepEqual(db.data, seed(), 'the data is exactly as it was');
});

test('execute deletes the setup, keeps super admins, and never touches what the apps or the fleet screens created', async () => {
  const db = fakeDriverDb(seed());
  const removed = [];
  const r = await execute(db, { removeLogo: async (id) => { removed.push(id); } });
  for (const t of TARGETS.filter((x) => x.name !== 'admin_users')) assert.equal(db.data[t.name].length, 0, `${t.name} is empty`);
  assert.deepEqual(db.data.admin_users.map((u) => u.adminId), ['s1'], 'only the super admin remains');
  const survived = seed();
  for (const name of ['drivers', 'users', 'trips_details', 'driver_issues_reports', 'users_otp', 'vehicles', 'driver_documents', 'vehicle_documents', 'driver_vehicle_assignments', 'entity_history']) {
    assert.deepEqual(db.data[name], survived[name], `${name} is untouched`);
  }
  assert.deepEqual(removed, ['app_def', 'app_a', 'app_b'], 'every business logo was asked to be removed');
  assert.equal(r.logosRemoved, 3);
  assert.deepEqual(r.deleted.map((d) => [d.name, d.deleted]), [['tenants', 3], ['service_regions', 2], ['vehicle_categories', 1], ['fare_rules', 2], ['cancellation_policies', 1], ['business_setup_progress', 1], ['admin_users', 2], ['admin_audit_logs', 3]]);
});

test('a logo that cannot be removed is reported, and the reset still completes', async () => {
  const db = fakeDriverDb(seed());
  const r = await execute(db, { removeLogo: async (id) => { if (id === 'app_a') throw new Error('network down'); } });
  assert.equal(r.logosRemoved, 2);
  assert.deepEqual(r.logoProblems, ['app_a: network down']);
  assert.equal(db.data.tenants.length, 0);
});

test('without a super admin the reset refuses, because nobody could sign in afterwards', async () => {
  const data = seed();
  data.admin_users = data.admin_users.filter((u) => u.role !== 'super_admin');
  const db = fakeDriverDb(data);
  await assert.rejects(() => execute(db), /No super admin account exists/);
  assert.equal(db.data.tenants.length, 3, 'nothing was deleted');
  assert.equal(db.data.admin_users.length, 2);
});

test('an empty database is a clean no-op', async () => {
  const db = fakeDriverDb({ admin_users: [{ adminId: 's1', role: 'super_admin' }] });
  const r = await execute(db);
  assert.ok(r.deleted.every((d) => d.deleted === 0 || d.name === 'x'));
  assert.deepEqual(db.data.admin_users.map((u) => u.adminId), ['s1']);
});

test('the lists name only collections that exist in the models', () => {
  const names = new Set([...TARGETS, ...LEFT_ALONE].map((t) => t.name));
  for (const expected of ['tenants', 'service_regions', 'vehicle_categories', 'fare_rules', 'cancellation_policies', 'business_setup_progress', 'admin_users', 'admin_audit_logs', 'vehicles', 'driver_documents']) assert.ok(names.has(expected), expected);
  assert.ok(!names.has('drivers') && !names.has('users') && !names.has('trips_details'), 'app data is never a target');
});

test('the command line tool refuses to run without database settings and says why', () => {
  const env = { ...process.env, MONGODB_USERNAME: '', MONGODB_PASSWORD: '', MONGODB_CLUSTER: '', DB_NAME: '' };
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'resetBusinessSetup.js'), '--execute', '--confirm=anything'], { env, encoding: 'utf8', timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /MONGODB_USERNAME.*must be set/);
});
