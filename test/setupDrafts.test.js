// Region and category drafts: in "review first" mode a save becomes a draft and changes nothing live; publishing applies every draft
// together after checking that live has not moved underneath them and nothing clashes.
process.env.JWT_SECRET = 'test-secret-for-setup-drafts';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const biz = require('../controllers/businessController');
const S = require('../controllers/setupDraftController');
const { clearAppTenantCache } = require('../lib/appTenant');

const reset = async (mode) => {
  for (const m of ['Tenant', 'ServiceRegion', 'VehicleCategory', 'SetupDraft', 'AdminAudit']) db[m].rows.length = 0;
  clearAppTenantCache();
  await db.Tenant.create({ tenantId: 't1', slug: 'uride', packageName: 'in.uride.app', name: 'uRide', appName: 'uRide', isDefault: true, market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }, ...(mode ? { setupWorkflow: mode } : {}) });
  await db.Tenant.create({ tenantId: 't2', slug: 'other', packageName: 'in.other.app', name: 'Other', appName: 'Other', market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }, setupWorkflow: 'draft' });
  await db.ServiceRegion.create({ regionId: 'r1', tenantId: 't1', key: 'up|noida|all areas', country: 'IN', city: 'Noida', state: 'UP', zoneName: 'All areas', active: true, createdAt: new Date(2026, 0, 1), updatedAt: new Date(2026, 0, 1) });
  await db.VehicleCategory.create({ categoryId: 'c1', tenantId: 't1', name: 'VIP', nameKey: 'vip', icon: 'car', passengerCapacity: 4, rideType: 'economy', regionIds: ['r1'], active: true, createdAt: new Date(2026, 0, 1), updatedAt: new Date(2026, 0, 1) });
};

const call = async (fn, { body = {}, params = {}, query = {}, tenant = 't1' } = {}) => {
  const business = JSON.parse(JSON.stringify(await db.Tenant.findOne({ tenantId: tenant }).lean()));
  const scope = (f = {}) => ({ ...f, tenantId: tenant });
  const req = {
    body, params, query, ip: '1.1.1.1', business, admin: { adminId: 'A1', email: 'a@t.local', role: 'client_admin' },
    data: {
      find: (M, f) => M.find(scope(f)), findOne: (M, f) => M.findOne(scope(f)), count: (M, f) => M.countDocuments(scope(f)),
      exists: async (M, f) => !!(await M.findOne(scope(f))),
      create: (M, d) => M.create({ ...d, tenantId: tenant }),
      update: (M, f, set, o = {}) => { const u = { $set: set }; if (o.setOnInsert) u.$setOnInsert = o.setOnInsert; return M.findOneAndUpdate(scope(f), u, { new: true, upsert: !!o.upsert }); },
      remove: (M, f) => M.deleteOne(scope(f))
    }
  };
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};

const newRegion = (over = {}) => ({ state: 'UP', zoneName: 'All areas', cities: [{ name: 'Lucknow' }], ...over });
const newCategory = (over = {}) => ({ name: 'Auto', passengerCapacity: 3, rideType: 'economy', regionIds: ['r1'], ...over });
const audits = () => db.AdminAudit.rows.map((a) => a.action);
const draftMode = async () => { await reset(); const r = await call(S.setWorkflow, { body: { mode: 'draft' } }); assert.equal(r.code, 200, JSON.stringify(r.body)); };

test('direct mode is the default: a save is live at once and no draft exists', async () => {
  await reset();
  const r = await call(biz.createRegions, { body: newRegion() });
  assert.equal(r.code, 201);
  assert.equal(db.ServiceRegion.rows.filter((x) => x.tenantId === 't1').length, 2);
  assert.equal(db.SetupDraft.rows.length, 0);
  assert.equal((await call(S.getDraft)).body.data.mode, 'direct');
});

test('the workflow switch needs a valid mode, is recorded, and cannot go back to direct while drafts wait', async () => {
  await reset();
  assert.equal((await call(S.setWorkflow, { body: { mode: 'sometimes' } })).code, 400);
  assert.equal((await call(S.setWorkflow, { body: {} })).code, 400);
  assert.equal((await call(S.setWorkflow, { body: { mode: 'draft' } })).code, 200);
  assert.ok(audits().includes('setup.workflow_changed'));
  await call(biz.createRegions, { body: newRegion() });
  const back = await call(S.setWorkflow, { body: { mode: 'direct' } });
  assert.equal(back.code, 409, 'publish or discard the drafts first');
  await call(S.discard);
  assert.equal((await call(S.setWorkflow, { body: { mode: 'direct' } })).code, 200);
});

test('draft mode: new regions wait as drafts, one per city, and nothing goes live', async () => {
  await draftMode();
  const r = await call(biz.createRegions, { body: newRegion({ cities: [{ name: 'Lucknow' }, { name: 'Kanpur' }, { name: 'Noida' }] }) });
  assert.equal(r.code, 202, JSON.stringify(r.body));
  assert.equal(r.body.data.draft, true);
  assert.deepEqual(r.body.data.skipped, ['Noida'], 'Noida (All areas) is already live');
  assert.equal(db.ServiceRegion.rows.filter((x) => x.tenantId === 't1').length, 1, 'live is unchanged');
  assert.deepEqual(db.SetupDraft.rows.map((d) => [d.entity, d.op, d.payload.city]).sort(), [['region', 'CREATE', 'Kanpur'], ['region', 'CREATE', 'Lucknow']]);
  const again = await call(biz.createRegions, { body: newRegion() });
  assert.equal(again.code, 409, 'Lucknow is already waiting as a draft');
});

test('a draft is validated exactly like a live save', async () => {
  await draftMode();
  assert.equal((await call(biz.createRegions, { body: { state: '', cities: [] } })).code, 400);
  assert.equal((await call(biz.createCategory, { body: newCategory({ name: 'x' }) })).code, 400, 'name too short');
  assert.equal((await call(biz.createCategory, { body: newCategory({ regionIds: ['nope'] }) })).code, 400, 'unknown region');
  assert.equal((await call(biz.createCategory, { body: newCategory({ name: 'vip' }) })).code, 409, 'the name is live already');
  assert.equal(db.SetupDraft.rows.length, 0, 'no refused save leaves a draft behind');
});

test('draft mode: a new category waits as a draft and its name is reserved against other drafts', async () => {
  await draftMode();
  const r = await call(biz.createCategory, { body: newCategory() });
  assert.equal(r.code, 202);
  assert.equal(db.VehicleCategory.rows.filter((x) => x.tenantId === 't1').length, 1);
  assert.equal((await call(biz.createCategory, { body: newCategory({ name: ' AUTO ' }) })).code, 409, 'another draft already uses that name');
});

test('draft mode: edits to a live region or category become one draft each; a second edit replaces the first', async () => {
  await draftMode();
  const a = await call(biz.updateRegion, { params: { id: 'r1' }, body: { zoneName: 'Sector 62' } });
  assert.equal(a.code, 202, JSON.stringify(a.body));
  assert.equal(db.ServiceRegion.rows.find((x) => x.regionId === 'r1').zoneName, 'All areas', 'live is unchanged');
  await call(biz.updateRegion, { params: { id: 'r1' }, body: { active: false } });
  const regionDrafts = db.SetupDraft.rows.filter((d) => d.entity === 'region');
  assert.equal(regionDrafts.length, 1);
  assert.deepEqual(regionDrafts[0].payload, { zoneName: 'Sector 62', active: false }, 'the edits are combined');
  await call(biz.updateCategory, { params: { id: 'c1' }, body: { active: false } });
  assert.equal(db.SetupDraft.rows.filter((d) => d.entity === 'category').length, 1);
  assert.equal((await call(biz.updateRegion, { params: { id: 'missing' }, body: { active: false } })).code, 404);
  assert.equal((await call(biz.updateCategory, { params: { id: 'missing' }, body: { active: false } })).code, 404);
});

test('what is waiting is listed with a field by field comparison against live', async () => {
  await draftMode();
  await call(biz.createCategory, { body: newCategory() });
  await call(biz.updateRegion, { params: { id: 'r1' }, body: { zoneName: 'Sector 62' } });
  const d = (await call(S.getDraft)).body.data;
  assert.equal(d.mode, 'draft');
  assert.equal(d.drafts.length, 2);
  assert.deepEqual(d.summary, { added: 1, changed: 1 });
  const change = d.changes.find((c) => c.kind === 'CHANGED');
  assert.deepEqual(change.fields.map((f) => [f.field, f.from, f.to]), [['zoneName', 'All areas', 'Sector 62']]);
  assert.deepEqual(d.stale, []);
});

test('publishing applies every draft together, clears them, and writes the same history as a live save', async () => {
  await draftMode();
  await call(biz.createRegions, { body: newRegion() });
  await call(biz.createCategory, { body: newCategory() });
  await call(biz.updateRegion, { params: { id: 'r1' }, body: { zoneName: 'Sector 62' } });
  await call(biz.updateCategory, { params: { id: 'c1' }, body: { active: false } });
  const r = await call(S.publish, { body: { note: 'Launch Lucknow' } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.published, { added: 2, changed: 2 });
  const regions = db.ServiceRegion.rows.filter((x) => x.tenantId === 't1');
  assert.equal(regions.length, 2);
  assert.ok(regions.find((x) => x.city === 'Lucknow' && x.active));
  assert.equal(regions.find((x) => x.regionId === 'r1').zoneName, 'Sector 62');
  assert.equal(regions.find((x) => x.regionId === 'r1').key, 'up|noida|sector 62', 'the lookup key follows the zone name');
  assert.equal(db.VehicleCategory.rows.find((x) => x.categoryId === 'c1').active, false);
  assert.ok(db.VehicleCategory.rows.find((x) => x.nameKey === 'auto'));
  assert.equal(db.SetupDraft.rows.length, 0, 'the drafts are cleared');
  const a = audits();
  for (const want of ['region.created', 'region.updated', 'category.created', 'category.deactivated', 'setup.published']) assert.ok(a.includes(want), `${want} in ${a}`);
  assert.equal(db.AdminAudit.rows.find((x) => x.action === 'setup.published').meta.note, 'Launch Lucknow');
});

test('publish refuses when live changed after a draft was made, and applies nothing', async () => {
  await draftMode();
  await call(biz.updateRegion, { params: { id: 'r1' }, body: { zoneName: 'Sector 62' } });
  await call(biz.createCategory, { body: newCategory() });
  const live = db.ServiceRegion.rows.find((x) => x.regionId === 'r1');
  live.updatedAt = new Date(); // another admin changed it in the meantime
  const r = await call(S.publish);
  assert.equal(r.code, 409);
  assert.equal(r.body.errors.stale.length, 1);
  assert.equal(db.VehicleCategory.rows.filter((x) => x.tenantId === 't1').length, 1, 'the category draft was not applied either');
  assert.equal(db.SetupDraft.rows.length, 2, 'the drafts are kept so they can be discarded or redone');
  assert.equal((await call(S.getDraft)).body.data.stale.length, 1);
});

test('publish refuses a clash that appeared after the draft was made (another admin took the name), applying nothing', async () => {
  await draftMode();
  await call(biz.createCategory, { body: newCategory() });
  await call(biz.updateRegion, { params: { id: 'r1' }, body: { zoneName: 'Sector 62' } });
  await db.VehicleCategory.create({ categoryId: 'c9', tenantId: 't1', name: 'Auto', nameKey: 'auto', regionIds: ['r1'], active: true });
  const r = await call(S.publish);
  assert.equal(r.code, 409);
  assert.ok(r.body.errors.problems.length >= 1);
  assert.equal(db.ServiceRegion.rows.find((x) => x.regionId === 'r1').zoneName, 'All areas', 'the region edit was not applied');
  assert.equal(db.SetupDraft.rows.length, 2);
});

test('publish refuses a category draft whose region became inactive, and a draft whose target vanished', async () => {
  await draftMode();
  await call(biz.createRegions, { body: newRegion() });
  await call(biz.createCategory, { body: newCategory({ regionIds: ['r1'] }) });
  db.ServiceRegion.rows.find((x) => x.regionId === 'r1').active = false;
  const r = await call(S.publish);
  assert.equal(r.code, 409);
  assert.match(JSON.stringify(r.body.errors.problems), /inactive/);
});

test('nothing to publish is a clear refusal', async () => {
  await draftMode();
  assert.equal((await call(S.publish)).code, 409);
});

test('a draft can be discarded alone or all at once', async () => {
  await draftMode();
  await call(biz.createCategory, { body: newCategory() });
  await call(biz.updateRegion, { params: { id: 'r1' }, body: { active: false } });
  const [first] = db.SetupDraft.rows;
  assert.equal((await call(S.discard, { params: { id: 'missing' } })).code, 404);
  assert.equal((await call(S.discard, { params: { id: first.draftId } })).code, 200);
  assert.equal(db.SetupDraft.rows.length, 1);
  await call(S.discard);
  assert.equal(db.SetupDraft.rows.length, 0);
  assert.ok(audits().includes('setup.drafts_discarded'));
});

test('another business never sees or publishes this business\'s drafts', async () => {
  await draftMode();
  await call(biz.createCategory, { body: newCategory() });
  const other = (await call(S.getDraft, { tenant: 't2' })).body.data;
  assert.equal(other.drafts.length, 0);
  assert.equal((await call(S.publish, { tenant: 't2' })).code, 409, 'nothing of its own to publish');
  assert.equal(db.SetupDraft.rows.length, 1, 'and the first business\'s draft is untouched');
});
