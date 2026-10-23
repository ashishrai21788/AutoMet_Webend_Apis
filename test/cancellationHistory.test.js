// Cancellation policy history: every save and removal is recorded with before and after; a restore puts the earlier terms back.
process.env.JWT_SECRET = 'test-secret-for-cancellation-history';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const ch = require('../lib/cancellationHistory');
const biz = require('../controllers/businessController');
const H = require('../controllers/cancellationHistoryController');
const { clearAppTenantCache } = require('../lib/appTenant');

const terms = (over = {}) => ({ rider: { freeCancellationMinutes: 2, feeAfterWindow: 30, feeAfterDriverArrived: 50, noShowFee: 40 }, driver: { penaltyFee: 20, graceCancellations: 2 }, conditions: '', ...over });

const reset = async () => {
  for (const m of ['Tenant', 'ServiceRegion', 'VehicleCategory', 'CancellationPolicy', 'CancellationPolicyChange', 'AdminAudit']) db[m].rows.length = 0;
  clearAppTenantCache();
  await db.Tenant.create({ tenantId: 't1', slug: 'uride', packageName: 'in.uride.app', name: 'uRide', appName: 'uRide', isDefault: true, market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } });
  await db.ServiceRegion.create({ regionId: 'r1', tenantId: 't1', key: 'noida', city: 'Noida', state: 'UP', zoneName: 'All areas', active: true });
  await db.VehicleCategory.create({ categoryId: 'c1', tenantId: 't1', name: 'VIP', nameKey: 'vip', regionIds: ['r1'], active: true });
};

const call = async (fn, { body = {}, params = {}, query = {} } = {}) => {
  const business = JSON.parse(JSON.stringify(await db.Tenant.findOne({ tenantId: 't1' }).lean()));
  const scope = (f = {}) => ({ ...f, tenantId: 't1' });
  const req = {
    body, params, query, ip: '1.1.1.1', business, admin: { adminId: 'A1', email: 'a@t.local', role: 'client_admin' },
    data: {
      find: (M, f) => M.find(scope(f)), findOne: (M, f) => M.findOne(scope(f)), count: (M, f) => M.countDocuments(scope(f)),
      create: (M, d) => M.create({ ...d, tenantId: 't1' }),
      update: (M, f, set, o = {}) => { const u = { $set: set }; if (o.setOnInsert) u.$setOnInsert = o.setOnInsert; return M.findOneAndUpdate(scope(f), u, { new: true, upsert: !!o.upsert }); },
      remove: (M, f) => M.deleteOne(scope(f))
    }
  };
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};
const save = (over) => call(biz.savePolicy, { body: { categoryId: 'c1', regionId: null, ...terms(over) } });
const live = () => db.CancellationPolicy.rows.find((p) => p.categoryId === 'c1' && p.regionKey === 'default');
const feeNow = () => live() && live().rider.feeAfterWindow;
const changes = () => db.CancellationPolicyChange.rows.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

test('the terms of a policy and what differs between two', () => {
  const a = ch.termsOf({ currency: 'INR', ...terms() });
  const b = ch.termsOf({ currency: 'INR', ...terms({ rider: { freeCancellationMinutes: 5, feeAfterWindow: 30, feeAfterDriverArrived: 50, noShowFee: 40 } }) });
  assert.deepEqual(ch.changedFields(a, b).map((f) => [f.field, f.from, f.to]), [['rider.freeCancellationMinutes', 2, 5]]);
  assert.deepEqual(ch.changedFields(a, a), []);
  assert.equal(ch.changedFields(null, a).length, 7, 'a new policy changes every term');
  assert.equal(ch.same(null, null), true);
  assert.equal(ch.same(null, a), false);
  assert.equal(ch.termsOf(null), null);
  assert.equal(ch.termsOf({ rider: {}, driver: {} }).rider.noShowFee, 0, 'missing numbers read as 0, as the app uses them');
});

test('a save and a removal are recorded with the terms before and after', async () => {
  await reset();
  assert.equal((await save()).code, 200);
  assert.equal((await save({ rider: { freeCancellationMinutes: 2, feeAfterWindow: 45, feeAfterDriverArrived: 50, noShowFee: 40 } })).code, 200);
  await call(biz.deletePolicy, { params: { id: live().policyId } });
  const rows = changes();
  assert.deepEqual(rows.map((r) => r.op), ['SAVE', 'SAVE', 'DELETE']);
  assert.equal(rows[0].before, null, 'the first save had no policy before it');
  assert.equal(rows[1].before.rider.feeAfterWindow, 30);
  assert.equal(rows[1].after.rider.feeAfterWindow, 45);
  assert.equal(rows[2].after, null);
  assert.equal(rows[2].before.rider.feeAfterWindow, 45);

  const h = await call(H.history);
  assert.equal(h.code, 200);
  assert.deepEqual(h.body.data.items.map((i) => i.op), ['DELETE', 'SAVE', 'SAVE'], 'newest first');
  assert.equal(h.body.data.items[0].category, 'VIP');
  assert.deepEqual(h.body.data.items[1].changes.map((f) => [f.field, f.from, f.to]), [['rider.feeAfterWindow', 30, 45]]);
});

test('restoring a save puts the earlier terms back, and the restore is itself recorded', async () => {
  await reset();
  await save();
  await save({ rider: { freeCancellationMinutes: 2, feeAfterWindow: 99, feeAfterDriverArrived: 50, noShowFee: 40 } });
  assert.equal(feeNow(), 99);
  const bad = changes()[1];
  const r = await call(H.restore, { params: { id: bad.changeId } });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(feeNow(), 30, 'the fee is back to what it was before the change');
  const last = changes().pop();
  assert.equal(last.op, 'RESTORE');
  assert.equal(last.restoreOf, bad.changeId);
  assert.equal(last.before.rider.feeAfterWindow, 99);
  assert.equal(last.after.rider.feeAfterWindow, 30);
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'cancellation_policy.restored'));
  assert.equal((await call(H.restore, { params: { id: bad.changeId } })).body.data.unchanged, true, 'restoring what is already in place does nothing');
});

test('restoring the first save removes the policy; restoring a removal brings it back', async () => {
  await reset();
  await save();
  const first = changes()[0];
  await call(H.restore, { params: { id: first.changeId } });
  assert.equal(live(), undefined, 'there was no policy before the first save');
  await save();
  const id = live().policyId;
  await call(biz.deletePolicy, { params: { id } });
  assert.equal(live(), undefined);
  const del = changes().filter((c) => c.op === 'DELETE').pop();
  const r = await call(H.restore, { params: { id: del.changeId } });
  assert.equal(r.code, 200);
  assert.equal(feeNow(), 30, 'the removed policy is back with its terms');
  assert.equal(live().currency, 'INR');
});

test('restoring over a later change asks first, and force does it', async () => {
  await reset();
  await save();
  await save({ rider: { freeCancellationMinutes: 2, feeAfterWindow: 60, feeAfterDriverArrived: 50, noShowFee: 40 } });
  const second = changes()[1]; // 30 -> 60
  await save({ rider: { freeCancellationMinutes: 2, feeAfterWindow: 80, feeAfterDriverArrived: 50, noShowFee: 40 } });
  const r = await call(H.restore, { params: { id: second.changeId } });
  assert.equal(r.code, 409);
  assert.equal(r.body.errors.code, 'CHANGED_SINCE');
  assert.deepEqual(r.body.errors.changes.map((f) => [f.field, f.from, f.to]), [['rider.feeAfterWindow', 80, 30]], 'it says what would change');
  assert.equal(feeNow(), 80, 'nothing changed');
  assert.equal((await call(H.restore, { params: { id: second.changeId }, body: { force: true } })).code, 200);
  assert.equal(feeNow(), 30);
});

test('an unknown change is 404, and another business cannot see or restore this one', async () => {
  await reset();
  await save();
  assert.equal((await call(H.restore, { params: { id: 'cpc_nope' } })).code, 404);
  db.CancellationPolicyChange.rows[0].tenantId = 't2';
  assert.equal((await call(H.history)).body.data.items.length, 0);
  assert.equal((await call(H.restore, { params: { id: db.CancellationPolicyChange.rows[0].changeId } })).code, 404);
});

test('a restore needs the category to still exist', async () => {
  await reset();
  await save();
  await call(biz.deletePolicy, { params: { id: live().policyId } });
  db.VehicleCategory.rows.length = 0;
  const del = changes().filter((c) => c.op === 'DELETE').pop();
  const r = await call(H.restore, { params: { id: del.changeId } });
  assert.equal(r.code, 409);
  assert.equal(live(), undefined);
});

test('the history can be narrowed to one category and region', async () => {
  await reset();
  await db.VehicleCategory.create({ categoryId: 'c2', tenantId: 't1', name: 'Auto', nameKey: 'auto', regionIds: ['r1'], active: true });
  await save();
  await call(biz.savePolicy, { body: { categoryId: 'c2', regionId: 'r1', ...terms() } });
  assert.equal((await call(H.history)).body.data.items.length, 2);
  const one = await call(H.history, { query: { categoryId: 'c2' } });
  assert.deepEqual(one.body.data.items.map((i) => [i.category, i.region]), [['Auto', 'Noida']]);
  assert.equal((await call(H.history, { query: { categoryId: 'c1', regionId: 'r1' } })).body.data.items.length, 0);
});
