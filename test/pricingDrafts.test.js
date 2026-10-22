// Pricing drafts and versions: a draft changes nothing until published; publishing is all-or-nothing; every live change is a version.
process.env.JWT_SECRET = 'test-secret-for-pricing';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const pd = require('../lib/pricingDrafts');
const biz = require('../controllers/businessController');
const P = require('../controllers/pricingController');
const { clearAppTenantCache } = require('../lib/appTenant');

const rule = (over = {}) => ({ baseFare: 10, perKm: 10, perMinute: 10, minimumFare: 50, bookingFee: 0, waitingFreeMinutes: 3, waitingPerMinute: 1.5, additionalCharges: [], taxes: [], surge: { enabled: false, maxMultiplier: 1 }, ...over });

const reset = async (mode) => {
  for (const m of ['Tenant', 'ServiceRegion', 'VehicleCategory', 'FareRule', 'FareRuleDraft', 'PricingVersion', 'PricingSchedule', 'ConfigVersion', 'AdminAudit']) db[m].rows.length = 0;
  clearAppTenantCache();
  await db.Tenant.create({ tenantId: 't1', slug: 'uride', packageName: 'in.uride.app', name: 'uRide', appName: 'uRide', isDefault: true, market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }, ...(mode ? { pricingWorkflow: mode } : {}) });
  await db.ServiceRegion.create({ regionId: 'r1', tenantId: 't1', key: 'noida', city: 'Noida', state: 'UP', zoneName: 'All areas', active: true });
  await db.VehicleCategory.create({ categoryId: 'c1', tenantId: 't1', name: 'VIP', nameKey: 'vip', regionIds: ['r1'], active: true });
  await db.VehicleCategory.create({ categoryId: 'c2', tenantId: 't1', name: 'Auto', nameKey: 'auto', regionIds: ['r1'], active: true });
};

const call = async (fn, { body = {}, params = {}, query = {} } = {}) => {
  // a copy, as a real database returns: the business as it was before the call
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
const liveOf = (cat, region = 'default') => db.FareRule.rows.find((r) => r.categoryId === cat && r.regionKey === region);

test('the diff and the draft changes name exactly what differs', () => {
  const a = pd.snapshotRules([{ categoryId: 'c1', regionKey: 'default', ...rule(), currency: 'INR' }]);
  const b = pd.snapshotRules([{ categoryId: 'c1', regionKey: 'default', ...rule({ baseFare: 25 }), currency: 'INR' }, { categoryId: 'c2', regionKey: 'default', ...rule(), currency: 'INR' }]);
  const rows = pd.diffSnapshots(a, b);
  assert.deepEqual(rows.map((r) => [r.kind, r.categoryId]), [['CHANGED', 'c1'], ['ADDED', 'c2']]);
  assert.deepEqual(rows[0].fields.map((f) => [f.field, f.from, f.to]), [['baseFare', 10, 25]]);
  assert.deepEqual(pd.summaryOf(rows), { added: 1, changed: 1, removed: 0 });
  assert.deepEqual(pd.diffSnapshots(a, a), []);
  const live = [{ categoryId: 'c1', regionKey: 'default', ...rule() }];
  const same = pd.draftChanges(live, [{ categoryId: 'c1', regionKey: 'default', op: 'SAVE', fields: rule() }]);
  assert.deepEqual(same, [], 'a draft that matches live changes nothing');
  assert.equal(pd.draftChanges(live, [{ categoryId: 'c1', regionKey: 'default', op: 'DELETE' }])[0].kind, 'REMOVED');
  assert.deepEqual(pd.draftChanges(live, [{ categoryId: 'c9', regionKey: 'default', op: 'DELETE' }]), [], 'removing a rule that is not live changes nothing');
});

test('direct mode (the default): a save is live at once and is kept as a version', async () => {
  await reset();
  const r = await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.data.draft, undefined);
  assert.equal(liveOf('c1').baseFare, 10);
  assert.equal(db.FareRuleDraft.rows.length, 0);
  const v = db.PricingVersion.rows.slice().sort((a, b) => a.version - b.version);
  assert.deepEqual(v.map((x) => x.source), ['baseline', 'direct']);
  assert.deepEqual(v[0].rules, [], 'the baseline: nothing was priced before');
  assert.equal(v[1].rules.length, 1);
});

test('draft mode: a save changes nothing live; it waits as a draft', async () => {
  await reset('draft');
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } }); // pretend it is the first rule
  assert.equal(db.FareRule.rows.length, 0, 'riders are not affected');
  assert.equal(db.FareRuleDraft.rows.length, 1);
  assert.equal(db.PricingVersion.rows.length, 0, 'no version: live pricing did not change');
  const d = (await call(P.getDraft)).body.data;
  assert.equal(d.mode, 'draft');
  assert.equal(d.drafts.length, 1);
  assert.equal(d.drafts[0].baseFare, 10);
  assert.deepEqual(d.changes.map((c) => c.kind), ['ADDED']);
});

test('saving a draft again replaces it; a draft is validated like a live save', async () => {
  await reset('draft');
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ baseFare: 99 }) } });
  assert.equal(db.FareRuleDraft.rows.length, 1);
  assert.equal(db.FareRuleDraft.rows[0].fields.baseFare, 99);
  const bad = await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ baseFare: -5 }) } });
  assert.equal(bad.code, 400);
  assert.equal(db.FareRuleDraft.rows[0].fields.baseFare, 99, 'a refused save leaves the draft alone');
});

test('publishing makes every draft live together, clears the drafts and records one version with a note', async () => {
  await reset('draft');
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  await call(biz.saveFareRule, { body: { categoryId: 'c2', regionId: null, ...rule({ baseFare: 5 }) } });
  const r = await call(P.publish, { body: { note: 'Diwali prices' } });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 300));
  assert.deepEqual([r.body.data.added, r.body.data.changed, r.body.data.removed], [2, 0, 0]);
  assert.equal(liveOf('c1').baseFare, 10);
  assert.equal(liveOf('c2').baseFare, 5);
  assert.equal(db.FareRuleDraft.rows.length, 0);
  const v = db.PricingVersion.rows.find((x) => x.source === 'publish');
  assert.equal(v.note, 'Diwali prices');
  assert.equal(v.rules.length, 2);
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'pricing.published'));
});

test('a draft of a change to a live rule, and a draft removal, are both applied on publish', async () => {
  await reset();
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  await call(biz.saveFareRule, { body: { categoryId: 'c2', regionId: null, ...rule() } });
  await call(P.setWorkflow, { body: { mode: 'draft' } });
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ perKm: 14 }) } });
  const c2 = liveOf('c2');
  const del = await call(biz.deleteFareRule, { params: { id: c2.ruleId } });
  assert.equal(del.code, 200);
  assert.equal(del.body.data.draft, true);
  assert.ok(liveOf('c2'), 'still live until published');
  assert.equal(liveOf('c1').perKm, 10);
  const preview = (await call(P.getDraft)).body.data.changes.map((c) => c.kind).sort();
  assert.deepEqual(preview, ['CHANGED', 'REMOVED']);
  const r = await call(P.publish, { body: {} });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(liveOf('c1').perKm, 14);
  assert.equal(liveOf('c2'), undefined);
});

test('publishing is all or nothing: one bad draft stops the lot and nothing goes live', async () => {
  await reset('draft');
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  await call(biz.saveFareRule, { body: { categoryId: 'c2', regionId: null, ...rule() } });
  db.VehicleCategory.rows.splice(db.VehicleCategory.rows.findIndex((x) => x.categoryId === 'c2'), 1); // the category was deleted after the draft was made
  const r = await call(P.publish, { body: {} });
  assert.equal(r.code, 409);
  assert.ok(r.body.errors.problems.some((p) => /no longer exists/.test(p.message)));
  assert.equal(db.FareRule.rows.length, 0, 'the good draft did not go live either');
  assert.equal(db.FareRuleDraft.rows.length, 2, 'the drafts are kept so they can be fixed');
});

test('a draft made against a rule that has since changed is stale and blocks publishing until discarded', async () => {
  await reset();
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  await call(P.setWorkflow, { body: { mode: 'draft' } });
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ baseFare: 77 }) } });
  // live pricing moves underneath the draft (a rollback, or a direct change made through the API before the switch)
  db.FareRule.rows.find((r) => r.categoryId === 'c1').updatedAt = new Date(Date.now() + 5000);
  const d = (await call(P.getDraft)).body.data;
  assert.deepEqual(d.stale, ['c1|default']);
  const r = await call(P.publish, { body: {} });
  assert.equal(r.code, 409);
  assert.deepEqual(r.body.errors.stale, ['c1|default']);
  const gone = await call(P.discard, { params: { key: 'c1|default' } });
  assert.equal(gone.body.data.discarded, 1);
  assert.equal((await call(P.getDraft)).body.data.drafts.length, 0);
  assert.equal((await call(P.discard, { params: { key: 'nope|default' } })).code, 404);
});

test('publishing with nothing pending, or with drafts that already match live pricing, is refused and clears the no-ops', async () => {
  await reset();
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  await call(P.setWorkflow, { body: { mode: 'draft' } });
  assert.equal((await call(P.publish, { body: {} })).code, 409);
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } }); // identical to live
  const r = await call(P.publish, { body: {} });
  assert.equal(r.code, 409);
  assert.match(r.body.message, /nothing to publish/);
  assert.equal(db.FareRuleDraft.rows.length, 0);
});

test('switching back to direct is refused while drafts are pending; switching is recorded in the settings history', async () => {
  await reset();
  assert.equal((await call(P.setWorkflow, { body: { mode: 'draft' } })).code, 200);
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  const refused = await call(P.setWorkflow, { body: { mode: 'direct' } });
  assert.equal(refused.code, 409);
  assert.equal(db.Tenant.rows[0].pricingWorkflow, 'draft');
  assert.equal((await call(P.setWorkflow, { body: { mode: 'sideways' } })).code, 400);
  assert.ok(db.ConfigVersion.rows.some((v) => v.changed.includes('pricing')), 'the switch is a settings version');
});

test('versions list newest first; a version shows what it changed and what going back would change', async () => {
  await reset();
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } }); // v2 (v1 baseline)
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ baseFare: 20 }) } }); // v3
  const list = (await call(P.listVersions)).body.data;
  assert.deepEqual(list.items.map((i) => i.version), [3, 2, 1]);
  assert.equal(list.current, 3);
  assert.deepEqual(list.items[0].summary, { added: 0, changed: 1, removed: 0 });
  const v2 = (await call(P.getVersion, { params: { version: '2' } })).body.data;
  assert.equal(v2.changes[0].kind, 'ADDED');
  assert.equal(v2.comparedToNow[0].kind, 'CHANGED', 'going back to v2 would change the base fare back');
  assert.equal((await call(P.getVersion, { params: { version: '42' } })).code, 404);
});

test('rolling back puts the old rules live, adds and removes rules as needed, and is itself a version that can be undone', async () => {
  await reset();
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } }); // v2
  await call(biz.saveFareRule, { body: { categoryId: 'c2', regionId: null, ...rule({ baseFare: 7 }) } }); // v3
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ baseFare: 30 }) } }); // v4
  const r = await call(P.rollback, { params: { version: '2' } });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(liveOf('c1').baseFare, 10, 'the changed rule is back');
  assert.equal(liveOf('c2'), undefined, 'the rule added later is removed');
  const v5 = db.PricingVersion.rows.find((x) => x.version === 5);
  assert.equal(v5.source, 'rollback');
  assert.equal(v5.rollbackOf, 2);
  assert.equal(db.PricingVersion.rows.find((x) => x.version === 4).rules.find((x) => x.categoryId === 'c1').baseFare, 30, 'history was not rewritten');
  assert.equal((await call(P.rollback, { params: { version: '2' } })).code, 409, 'already matches');
  const undo = await call(P.rollback, { params: { version: '4' } });
  assert.equal(undo.code, 200);
  assert.equal(liveOf('c1').baseFare, 30);
  assert.equal(liveOf('c2').baseFare, 7);
  assert.equal((await call(P.rollback, { params: { version: 'x' } })).code, 404);
});

test('the rules riders are priced with are the live ones only: a draft never reaches the fare engine', async () => {
  await reset('draft');
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ baseFare: 1000 }) } });
  const livePricingRows = await db.FareRule.find({ tenantId: 't1' });
  assert.equal(livePricingRows.length, 0, 'the collection every fare calculation reads has nothing from the draft');
});

// ---- scheduled publish ----
const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
const scheduleOne = async (over = {}) => {
  await call(P.setWorkflow, { body: { mode: 'draft' } });
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ baseFare: 55 }) } });
  return call(P.publish, { body: { note: 'New year', effectiveAt: hoursAhead(2), ...over } });
};

test('a publish can be scheduled: the drafts are frozen into a schedule, live pricing does not change, bad times are refused', async () => {
  await reset();
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  await call(P.setWorkflow, { body: { mode: 'draft' } });
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ baseFare: 55 }) } });
  for (const bad of ['not a date', new Date(Date.now() + 30 * 1000).toISOString(), new Date(Date.now() - 3600 * 1000).toISOString(), hoursAhead(24 * 400)]) {
    const r = await call(P.publish, { body: { effectiveAt: bad } });
    assert.equal(r.code, 400, String(bad));
  }
  assert.equal(db.FareRuleDraft.rows.length, 1, 'refused times leave the draft alone');
  const r = await call(P.publish, { body: { note: 'New year', effectiveAt: hoursAhead(2) } });
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.data.scheduled, true);
  assert.equal(liveOf('c1').baseFare, 10, 'not live yet');
  assert.equal(db.FareRuleDraft.rows.length, 0, 'frozen into the schedule');
  assert.equal(db.PricingSchedule.rows[0].status, 'SCHEDULED');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'pricing.scheduled'));
  const list = (await call(P.listSchedules)).body.data;
  assert.equal(list.waiting.length, 1);
  assert.equal(list.waiting[0].note, 'New year');
});

test('when the time comes the server applies the schedule once, records a version, and does nothing the second time', async () => {
  await reset();
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  await scheduleOne();
  assert.equal(await P.runDueSchedules(new Date()), 0, 'before its time nothing happens');
  assert.equal(liveOf('c1').baseFare, 10);
  const later = new Date(Date.now() + 3 * 3600 * 1000);
  const [a, b] = await Promise.all([P.runDueSchedules(later), P.runDueSchedules(later)]);
  assert.equal(a + b, 1, 'two servers running together apply it once');
  assert.equal(liveOf('c1').baseFare, 55);
  const sch = db.PricingSchedule.rows[0];
  assert.equal(sch.status, 'DONE');
  const v = db.PricingVersion.rows.find((x) => x.source === 'scheduled');
  assert.ok(v, 'a pricing version records it');
  assert.equal(v.note, 'New year');
  assert.equal(sch.version, v.version);
  assert.equal(await P.runDueSchedules(later), 0);
});

test('a schedule whose category was deleted meanwhile fails as a whole: nothing is applied and the reason is kept', async () => {
  await reset();
  await call(P.setWorkflow, { body: { mode: 'draft' } });
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  await call(biz.saveFareRule, { body: { categoryId: 'c2', regionId: null, ...rule() } });
  await call(P.publish, { body: { effectiveAt: hoursAhead(1) } });
  db.VehicleCategory.rows.splice(db.VehicleCategory.rows.findIndex((x) => x.categoryId === 'c2'), 1);
  await P.runDueSchedules(new Date(Date.now() + 2 * 3600 * 1000));
  assert.equal(db.PricingSchedule.rows[0].status, 'FAILED');
  assert.match(db.PricingSchedule.rows[0].failure, /no longer exists/);
  assert.equal(db.FareRule.rows.length, 0, 'the good change did not go live either');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'pricing.schedule_failed'));
});

test('cancelling a schedule brings its changes back as drafts, without overwriting a newer draft', async () => {
  await reset();
  await call(P.setWorkflow, { body: { mode: 'draft' } });
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ baseFare: 55 }) } });
  await call(biz.saveFareRule, { body: { categoryId: 'c2', regionId: null, ...rule({ baseFare: 66 }) } });
  const r = await call(P.publish, { body: { effectiveAt: hoursAhead(2) } });
  const id = r.body.data.scheduleId;
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ baseFare: 77 }) } }); // a newer draft of c1
  const c = await call(P.cancelSchedule, { params: { id } });
  assert.equal(c.code, 200, JSON.stringify(c.body).slice(0, 200));
  assert.equal(c.body.data.restoredAsDrafts, 1, 'only c2 comes back');
  assert.equal(db.FareRuleDraft.rows.find((d) => d.categoryId === 'c1').fields.baseFare, 77, 'the newer draft is kept');
  assert.equal(db.FareRuleDraft.rows.find((d) => d.categoryId === 'c2').fields.baseFare, 66);
  assert.equal(db.PricingSchedule.rows[0].status, 'CANCELLED');
  assert.equal(await P.runDueSchedules(new Date(Date.now() + 5 * 3600 * 1000)), 0, 'a cancelled schedule never runs');
  assert.equal((await call(P.cancelSchedule, { params: { id } })).code, 409, 'only once');
  assert.equal((await call(P.cancelSchedule, { params: { id: 'nope' } })).code, 404);
});

test('a schedule half-applied by a server that stopped is picked up again after five minutes', async () => {
  await reset();
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule() } });
  await scheduleOne();
  const sch = db.PricingSchedule.rows[0];
  sch.status = 'APPLYING'; sch.claimedAt = new Date(Date.now() - 10 * 60 * 1000);
  assert.equal(await P.runDueSchedules(new Date(Date.now() + 3 * 3600 * 1000)), 1);
  assert.equal(liveOf('c1').baseFare, 55);
  assert.equal(sch.status, 'DONE');
});

test('switching back to direct is refused while a schedule is waiting', async () => {
  await reset();
  await scheduleOne();
  const r = await call(P.setWorkflow, { body: { mode: 'direct' } });
  assert.equal(r.code, 409);
});

// ---- what a trip remembers about its pricing ----
test('a priced trip carries the pricing version and the tax rates it was charged under', async () => {
  await reset();
  const { priceTrip, loadPricingConfig } = require('../lib/tripPricing');
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ taxes: [{ name: 'GST', ratePercent: 5, appliesTo: 'fare_and_fees' }] }) } }); // v2 (v1 baseline)
  const tenant = await db.Tenant.findOne({ tenantId: 't1' }).lean();
  const config = await loadPricingConfig(tenant);
  assert.equal(config.pricingVersion, 2);
  const r = priceTrip({ ...config, regions: [] }, { pickup: { lat: 28.57, lng: 77.48 }, drop: { lat: 28.6, lng: 77.5 }, categoryId: 'c1' });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.equal(r.estimate.pricing_version, 2);
  assert.deepEqual(r.estimate.pricing_rule.taxes, [{ name: 'GST', ratePercent: 5, appliesTo: 'fare_and_fees' }]);
  assert.ok(r.estimate.pricing_rule.rule_id);
  // the rate is on the trip, so a later change to the rule cannot rewrite what this trip was charged
  await call(biz.saveFareRule, { body: { categoryId: 'c1', regionId: null, ...rule({ taxes: [{ name: 'GST', ratePercent: 18, appliesTo: 'fare_and_fees' }] }) } });
  assert.equal(r.estimate.pricing_rule.taxes[0].ratePercent, 5);
  assert.equal((await loadPricingConfig(tenant)).pricingVersion, 3);
});

test('a business that never versioned its pricing prices trips without a version number', async () => {
  await reset();
  const { loadPricingConfig } = require('../lib/tripPricing');
  const tenant = await db.Tenant.findOne({ tenantId: 't1' }).lean();
  assert.equal((await loadPricingConfig(tenant)).pricingVersion, null);
});
