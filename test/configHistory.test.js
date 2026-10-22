// Settings history: every save is a numbered copy, the first save also keeps the "before", and a rollback is itself a new version.
process.env.JWT_SECRET = 'test-secret-for-config-history';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const versions = require('../lib/configVersions');
const H = require('../controllers/configHistoryController');
const tolls = require('../controllers/tollsAdminController');
const appVersions = require('../controllers/appVersionsController');
const payouts = require('../controllers/payoutsController');
const { clearAppTenantCache } = require('../lib/appTenant');

const reset = async (extra = {}) => {
  for (const m of ['Tenant', 'ConfigVersion', 'AdminAudit']) db[m].rows.length = 0;
  clearAppTenantCache();
  await db.Tenant.create({ tenantId: 't1', slug: 'uride', packageName: 'in.uride.app', name: 'uRide', appName: 'uRide', isDefault: true, brandColor: '#f5a300', market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }, ...extra });
};

const admin = async (fn, { body = {}, params = {}, query = {} } = {}) => {
  // a copy, as a real database returns: the business as it was before the save
  const business = JSON.parse(JSON.stringify(await db.Tenant.findOne({ tenantId: 't1' }).lean()));
  const req = {
    body, params, query, ip: '1.1.1.1', business, admin: { adminId: 'A1', email: 'a@t.local', role: 'client_admin' },
    data: { update: (M, f, v) => M.findOneAndUpdate({ tenantId: 't1' }, { $set: v }, { new: true }) }
  };
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};

test('the diff names the group and field that changed, and nothing else', () => {
  const a = versions.snapshotOf({ name: 'uRide', tollSettings: { enabled: false, maxTollMinor: 0 } });
  const b = versions.snapshotOf({ name: 'uRide', tollSettings: { enabled: true, maxTollMinor: 30000 } });
  const rows = versions.diff(a, b);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].group, rows[0].field], ['tolls', 'tollSettings']);
  assert.deepEqual(versions.diff(a, a), []);
  assert.deepEqual(versions.changedGroups(rows), ['tolls']);
});

test('only tracked settings are copied, never anything else on the business record', () => {
  const s = versions.snapshotOf({ name: 'x', billingDetails: { gstin: 'SECRET' }, status: 'suspended', tenantId: 't1', payoutSettings: { commissionPercent: 10 } });
  assert.ok(!('billingDetails' in s) && !('status' in s) && !('tenantId' in s));
  assert.deepEqual(s.payoutSettings, { commissionPercent: 10 });
});

test('the first save keeps the settings as they were (version 1) and the new ones (version 2)', async () => {
  await reset();
  const r = await admin(tolls.update, { body: { enabled: true, maxToll: 250 } });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200));
  const rows = db.ConfigVersion.rows.slice().sort((x, y) => x.version - y.version);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'baseline');
  assert.equal(rows[0].snapshot.tollSettings, null, 'before: nothing was set');
  assert.deepEqual(rows[1].snapshot.tollSettings, { enabled: true, maxTollMinor: 25000 });
  assert.deepEqual(rows[1].changed, ['tolls']);
  assert.equal(rows[1].actorEmail, 'a@t.local');
});

test('saving the same values again writes nothing', async () => {
  await reset();
  await admin(tolls.update, { body: { enabled: true, maxToll: 250 } });
  const n = db.ConfigVersion.rows.length;
  await admin(tolls.update, { body: { enabled: true, maxToll: 250 } });
  assert.equal(db.ConfigVersion.rows.length, n);
});

test('each kind of save is recorded under its own group', async () => {
  await reset();
  await admin(tolls.update, { body: { enabled: true, maxToll: 100 } });
  await admin(appVersions.update, { body: { rider: { minVersionCode: 5 }, driver: {} } });
  await admin(payouts.updateSettings, { body: { commissionPercent: 12, minWithdrawal: 100, cashWithdrawable: false, processingNote: '' } });
  const groups = db.ConfigVersion.rows.filter((r) => r.source !== 'baseline').sort((x, y) => x.version - y.version).map((r) => r.changed.join(','));
  assert.deepEqual(groups, ['tolls', 'appVersions', 'payout']);
});

test('the list is newest first with who and what; a version shows its changes and how it differs from now', async () => {
  await reset();
  await admin(tolls.update, { body: { enabled: true, maxToll: 100 } });
  await admin(tolls.update, { body: { enabled: true, maxToll: 400 } });
  const list = await admin(H.list);
  assert.equal(list.code, 200);
  assert.deepEqual(list.body.data.items.map((i) => i.version), [3, 2, 1]);
  assert.equal(list.body.data.current, 3);
  assert.deepEqual(list.body.data.items[0].changed, ['Tolls']);
  const v2 = await admin(H.get, { params: { version: '2' } });
  assert.equal(v2.code, 200);
  assert.equal(v2.body.data.changes[0].group, 'tolls', 'what version 2 changed against version 1');
  assert.equal(v2.body.data.comparedToNow.length, 1, 'applying it now would change the toll limit back');
  assert.equal((await admin(H.get, { params: { version: '99' } })).code, 404);
});

test('rolling back restores the settings, is recorded as a new version, and can itself be rolled back', async () => {
  await reset();
  await admin(tolls.update, { body: { enabled: true, maxToll: 100 } }); // v2
  await admin(tolls.update, { body: { enabled: true, maxToll: 400 } }); // v3
  const r = await admin(H.rollback, { params: { version: '2' } });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.data.version, 4);
  assert.equal(db.Tenant.rows[0].tollSettings.maxTollMinor, 10000, 'the live setting is back to the old value');
  const v4 = db.ConfigVersion.rows.find((x) => x.version === 4);
  assert.equal(v4.rollbackOf, 2);
  assert.equal(v4.source, 'config.rollback');
  assert.equal(db.ConfigVersion.rows.find((x) => x.version === 3).snapshot.tollSettings.maxTollMinor, 40000, 'history was not rewritten');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'config.rolled_back' && a.meta.toVersion === 2));
  const back = await admin(H.rollback, { params: { version: '3' } });
  assert.equal(back.code, 200);
  assert.equal(db.Tenant.rows[0].tollSettings.maxTollMinor, 40000, 'a rollback can be undone');
});

test('rolling back to the baseline removes a setting that did not exist before', async () => {
  await reset();
  await admin(tolls.update, { body: { enabled: true, maxToll: 100 } });
  const r = await admin(H.rollback, { params: { version: '1' } });
  assert.equal(r.code, 200);
  assert.equal(db.Tenant.rows[0].tollSettings, null);
});

test('rolling back to settings that already match is refused, and an unknown version is a 404', async () => {
  await reset();
  await admin(tolls.update, { body: { enabled: true, maxToll: 100 } });
  const latest = db.ConfigVersion.rows.reduce((m, r) => Math.max(m, r.version), 0);
  const same = await admin(H.rollback, { params: { version: String(latest) } });
  assert.equal(same.code, 409);
  assert.equal((await admin(H.rollback, { params: { version: '77' } })).code, 404);
  assert.equal((await admin(H.rollback, { params: { version: 'abc' } })).code, 404);
});

test('a rollback only touches tracked settings: business details come back, billing details do not', async () => {
  await reset({ billingDetails: { gstin: 'KEEP' }, supportPhone: '+911111111111' });
  const biz = require('../controllers/businessController');
  await admin(biz.updateSettings, { body: { supportPhone: '+922222222222', appName: 'uRide Plus' } });
  assert.equal(db.Tenant.rows[0].supportPhone, '+922222222222');
  const r = await admin(H.rollback, { params: { version: '1' } });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(db.Tenant.rows[0].supportPhone, '+911111111111');
  assert.equal(db.Tenant.rows[0].appName, 'uRide');
  assert.equal(db.Tenant.rows[0].billingDetails.gstin, 'KEEP');
});

test('another business has its own history', async () => {
  await reset();
  await db.Tenant.create({ tenantId: 't2', slug: 'other', packageName: 'in.other.app', name: 'Other Co', appName: 'Other App', market: { country: 'IN', currency: 'INR' } });
  await admin(tolls.update, { body: { enabled: true, maxToll: 100 } });
  assert.ok(db.ConfigVersion.rows.every((r) => r.tenantId === 't1'));
});

test('a field the business record only exposes through a getter is not reported as changed by an unrelated save', async () => {
  await reset();
  // a record whose rideSettings default lives on the prototype, as a mongoose or postgres model instance can
  const proto = { get rideSettings() { return { requireEligibleDrivers: false }; } };
  const before = Object.assign(Object.create(proto), { tenantId: 't1', name: 'uRide', tollSettings: null });
  const made = await H.track({ business: before, admin: { adminId: 'A1', email: 'a@t.local' } }, 'business.toll_settings_updated', { tollSettings: { enabled: true, maxTollMinor: 100 } });
  assert.deepEqual(made.changed, ['tolls'], 'only the toll setting changed');
});
