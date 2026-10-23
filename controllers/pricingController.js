/**
 * Pricing drafts, publishing and history (admin dashboard, Pricing).
 *
 * A business chooses how its fare rules change (`pricingWorkflow` on the business):
 *   direct  a save goes live at once (how it has always worked); each save is still kept as a pricing version
 *   draft   a save becomes a draft; nothing changes for riders until the drafts are published together
 *
 *   GET    /api/admin/business/pricing/draft                 the workflow, the drafts, what publishing would change, and what is stale
 *   DELETE /api/admin/business/pricing/draft/:key            discard one draft (key = categoryId|regionKey)
 *   DELETE /api/admin/business/pricing/draft                 discard all drafts
 *   POST   /api/admin/business/pricing/publish               make every draft live at once (all checked first), recorded as a version;
 *                                                            with effectiveAt (a future time) the set is scheduled instead and applied then
 *   GET    /api/admin/business/pricing/schedules             scheduled and recent publishes
 *   POST   /api/admin/business/pricing/schedules/:id/cancel  cancel a scheduled publish; its changes come back as drafts
 *   PUT    /api/admin/business/pricing/workflow              { mode: direct | draft }
 *   GET    /api/admin/business/pricing/versions              history, newest first
 *   GET    /api/admin/business/pricing/versions/:n           what it changed and what going back to it would change
 *   POST   /api/admin/business/pricing/versions/:n/rollback  put those rules live again; recorded as a new version
 *
 * Saving or removing one rule goes through the existing /fare-rules routes, which write a draft instead when the workflow is draft.
 */
const crypto = require('crypto');
const { Tenant, AdminAudit } = require('../models/adminModels');
const { ServiceRegion, VehicleCategory, FareRule } = require('../models/businessModels');
const { FareRuleDraft, PricingVersion, PricingSchedule } = require('../models/pricingModels');
const { forTenant } = require('../lib/tenantData');
const { validateFareRuleInput } = require('../lib/fareRules');
const { clearAppTenantCache } = require('../lib/appTenant');
const shapes = require('../lib/adminShapes');
const pd = require('../lib/pricingDrafts');
const configHistory = require('./configHistoryController');
const c = require('./fleet/common');

const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const MODES = ['direct', 'draft'];
const modeOf = (tenant) => (tenant && tenant.pricingWorkflow === 'draft' ? 'draft' : 'direct');

async function audit(req, action, meta) {
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType: 'pricing', targetId: req.business.tenantId, meta: meta || null, ip: req.ip || null });
  } catch (e) { console.warn('[pricing] audit write failed:', e.message); }
}

const liveRules = (req) => req.data.find(FareRule).lean();
const drafts = (req) => req.data.find(FareRuleDraft).lean();

/** What the dashboard shows for a draft: shaped like a fare rule, plus what kind of change it is. */
const draftView = (d) => ({
  id: d.draftId, key: pd.keyOf(d.categoryId, d.regionKey), categoryId: d.categoryId, regionId: d.regionId || null, op: d.op, currency: d.currency,
  ...(d.op === 'SAVE' ? pd.fieldsOf(d.fields) : {}), updatedAt: d.updatedAt, by: d.createdBy || null
});

/** Records the version for a change to live pricing. Never throws: a failure here must not undo a pricing change that already happened. */
async function recordVersion(req, { before, source, note = '', rollbackOf = null }) {
  try {
    const after = pd.snapshotRules(await liveRules(req));
    const rows = pd.diffSnapshots(before, after);
    if (!rows.length) return null;
    const tenantId = req.business.tenantId;
    const latest = (await PricingVersion.find({ tenantId }).sort({ version: -1 }).limit(1).lean())[0] || null;
    const who = { actorId: req.admin ? req.admin.adminId : null, actorEmail: req.admin ? req.admin.email : null };
    let next = latest ? latest.version + 1 : 1;
    if (!latest) { await PricingVersion.create({ tenantId, version: 1, rules: before, summary: null, source: 'baseline', ...who, createdAt: new Date() }); next = 2; }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await PricingVersion.create({ tenantId, version: next, rules: after, summary: pd.summaryOf(rows), source, note: String(note || '').slice(0, 200), rollbackOf, ...who, createdAt: new Date() });
      } catch (e) {
        if (e && e.code === 11000) {
          // another change took this number at the same moment. If it left the pricing exactly as ours does (two admins publishing the
          // same drafts together), that version already says it: do not write the same history entry again.
          const taken = (await PricingVersion.find({ tenantId }).sort({ version: -1 }).limit(1).lean())[0];
          if (taken && pd.diffSnapshots(taken.rules, after).length === 0) return taken;
          next = (taken ? taken.version : next) + 1;
          continue;
        }
        throw e;
      }
    }
    return null;
  } catch (e) {
    console.warn('[pricing] could not record a version:', e.message);
    return null;
  }
}

/** Puts one draft in place (upsert), remembering which live rule it was made against. */
async function saveDraft(req, target, op, fields) {
  const live = await req.data.findOne(FareRule, { categoryId: target.categoryId, regionKey: target.regionKey }).lean();
  const now = new Date();
  const set = { regionId: target.regionId || null, op, fields: op === 'SAVE' ? fields : null, currency: target.currency, baseUpdatedAt: live ? live.updatedAt : null, createdBy: req.admin.email || req.admin.adminId, updatedAt: now };
  return req.data.update(FareRuleDraft, { categoryId: target.categoryId, regionKey: target.regionKey }, set, { upsert: true, setOnInsert: { draftId: newId('fd'), createdAt: now } });
}

/** GET .../pricing/draft */
exports.getDraft = c.handle(async (req, res) => {
  const [live, rows] = await Promise.all([liveRules(req), drafts(req)]);
  return c.ok(res, {
    mode: modeOf(req.business),
    drafts: rows.map(draftView),
    changes: pd.draftChanges(live, rows),
    stale: pd.staleDrafts(live, rows)
  });
});

/** DELETE .../pricing/draft/:key and DELETE .../pricing/draft */
exports.discard = c.handle(async (req, res) => {
  const rows = await drafts(req);
  const key = req.params.key ? String(req.params.key) : null;
  const target = key ? rows.filter((d) => pd.keyOf(d.categoryId, d.regionKey) === key) : rows;
  if (key && !target.length) return c.fail(res, 404, 'That draft does not exist');
  for (const d of target) await req.data.remove(FareRuleDraft, { draftId: d.draftId });
  if (target.length) await audit(req, 'pricing.drafts_discarded', { count: target.length, key: key || null });
  return c.ok(res, { discarded: target.length });
});

/** PUT .../pricing/workflow { mode } */
exports.setWorkflow = c.handle(async (req, res) => {
  const mode = String((req.body && req.body.mode) || '');
  if (!MODES.includes(mode)) return c.invalid(res, { mode: 'Choose direct or draft' });
  if (mode === 'direct' && ((await drafts(req)).length || (await PricingSchedule.countDocuments({ tenantId: req.business.tenantId, status: 'SCHEDULED' })))) return c.fail(res, 409, 'Publish, cancel or discard the pending pricing changes first', { mode: 'Pending changes exist' });
  const before = modeOf(req.business);
  if (before === mode) return c.ok(res, { mode });
  await req.data.update(Tenant, {}, { pricingWorkflow: mode });
  clearAppTenantCache();
  await configHistory.track(req, 'pricing.workflow_changed', { pricingWorkflow: mode });
  await audit(req, 'pricing.workflow_changed', { from: before, to: mode });
  return c.ok(res, { mode });
});

/** Everything about the drafts that must hold for them to go live together; returns { problems, plan }. */
async function checkDrafts(req, rows) {
  const problems = [];
  const plan = [];
  const market = req.business.market && req.business.market.country ? req.business.market : null;
  if (!market) return { problems: [{ key: null, message: 'Choose the operating country and currency first' }], plan };
  for (const d of rows) {
    const key = pd.keyOf(d.categoryId, d.regionKey);
    const category = await req.data.findOne(VehicleCategory, { categoryId: d.categoryId }).lean();
    if (!category) { problems.push({ key, message: 'That vehicle category no longer exists' }); continue; }
    if (d.regionId) {
      const region = await req.data.findOne(ServiceRegion, { regionId: d.regionId }).lean();
      if (!region) { problems.push({ key, message: 'That region no longer exists' }); continue; }
      if (!(category.regionIds || []).includes(d.regionId)) { problems.push({ key, message: 'That category is no longer available in that region' }); continue; }
    }
    if (d.op === 'SAVE') {
      const { value, errors } = validateFareRuleInput(d.fields || {});
      if (Object.keys(errors).length) { problems.push({ key, message: Object.values(errors)[0] }); continue; }
      plan.push({ draft: d, op: 'SAVE', value, category });
    } else plan.push({ draft: d, op: 'DELETE', category });
  }
  return { problems, plan, market };
}

/** Writes a checked plan to live pricing: upserts and removals only, so running it again after an interruption finishes the job. */
async function applyPlan(req, plan, market, now) {
  for (const step of plan) {
    const d = step.draft;
    if (step.op === 'DELETE') await req.data.remove(FareRule, { categoryId: d.categoryId, regionKey: d.regionKey });
    else {
      await req.data.update(FareRule, { categoryId: d.categoryId, regionKey: d.regionKey },
        { ...step.value, regionId: d.regionId || null, currency: market.currency, active: true, updatedAt: now },
        { upsert: true, setOnInsert: { ruleId: newId('fr'), createdAt: now } });
    }
  }
}

const MIN_AHEAD_MS = 2 * 60 * 1000;
const MAX_AHEAD_MS = 366 * 24 * 3600 * 1000;

/** POST .../pricing/publish { note?, effectiveAt? } */
exports.publish = c.handle(async (req, res) => {
  const rows = await drafts(req);
  if (!rows.length) return c.fail(res, 409, 'There are no pending pricing changes');
  let effectiveAt = null;
  if (req.body && req.body.effectiveAt !== undefined && req.body.effectiveAt !== null && req.body.effectiveAt !== '') {
    effectiveAt = new Date(req.body.effectiveAt);
    if (Number.isNaN(effectiveAt.getTime())) return c.invalid(res, { effectiveAt: 'Enter a valid date and time' });
    const ahead = effectiveAt.getTime() - Date.now();
    if (ahead < MIN_AHEAD_MS) return c.invalid(res, { effectiveAt: 'Choose a time at least 2 minutes from now, or publish now' });
    if (ahead > MAX_AHEAD_MS) return c.invalid(res, { effectiveAt: 'Choose a time within the next year' });
  }
  const live = await liveRules(req);
  const changes = pd.draftChanges(live, rows);
  const stale = pd.staleDrafts(live, rows);
  if (stale.length) return c.fail(res, 409, 'Live pricing changed after some drafts were made. Discard those drafts and make them again.', { stale });
  const { problems, plan, market } = await checkDrafts(req, rows);
  if (problems.length) return c.fail(res, 409, 'Some drafts cannot be published', { problems });
  if (!changes.length) {
    for (const d of rows) await req.data.remove(FareRuleDraft, { draftId: d.draftId }); // they already match live pricing
    return c.fail(res, 409, 'The drafts match the live pricing, so there is nothing to publish');
  }

  const note = String((req.body && req.body.note) || '').slice(0, 200);
  if (effectiveAt) {
    // frozen now, applied then: the drafts become a schedule and are cleared, so later edits make new drafts
    const items = plan.map((p) => ({ op: p.op, categoryId: p.draft.categoryId, regionId: p.draft.regionId || null, regionKey: p.draft.regionKey, fields: p.op === 'SAVE' ? p.value : null, currency: market.currency }));
    const schedule = await req.data.create(PricingSchedule, { scheduleId: newId('ps'), effectiveAt, note, status: 'SCHEDULED', items, summary: pd.summaryOf(changes), createdBy: req.admin.email || req.admin.adminId, createdAt: new Date() });
    for (const d of rows) await req.data.remove(FareRuleDraft, { draftId: d.draftId });
    await audit(req, 'pricing.scheduled', { scheduleId: schedule.scheduleId, effectiveAt, ...pd.summaryOf(changes), note: note || undefined });
    return c.ok(res, { scheduled: true, scheduleId: schedule.scheduleId, effectiveAt, ...pd.summaryOf(changes) });
  }

  const before = pd.snapshotRules(live);
  const now = new Date();
  await applyPlan(req, plan, market, now);
  for (const d of rows) await req.data.remove(FareRuleDraft, { draftId: d.draftId });
  const made = await recordVersion(req, { before, source: 'publish', note });
  await audit(req, 'pricing.published', { version: made ? made.version : null, ...pd.summaryOf(changes), note: note || undefined });
  return c.ok(res, { published: changes.length, version: made ? made.version : null, ...pd.summaryOf(changes) });
});

const item = (v) => ({ version: v.version, at: v.createdAt, by: v.actorEmail || null, source: v.source || '', note: v.note || '', summary: v.summary || null, rollbackOf: v.rollbackOf || null });

/** GET .../pricing/versions */
exports.listVersions = c.handle(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const filter = { tenantId: req.business.tenantId };
  const [total, rows] = await Promise.all([
    PricingVersion.countDocuments(filter),
    PricingVersion.find(filter).sort({ version: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean()
  ]);
  const latest = total ? (await PricingVersion.find(filter).sort({ version: -1 }).limit(1).lean())[0] : null;
  return c.ok(res, { items: rows.map(item), total, page, pageSize, current: latest ? latest.version : null });
});

/** GET .../pricing/versions/:n */
exports.getVersion = c.handle(async (req, res) => {
  const n = parseInt(req.params.version, 10);
  const filter = { tenantId: req.business.tenantId };
  const v = Number.isInteger(n) ? await PricingVersion.findOne({ ...filter, version: n }).lean() : null;
  if (!v) return c.fail(res, 404, 'That version does not exist');
  const prev = n > 1 ? await PricingVersion.findOne({ ...filter, version: n - 1 }).lean() : null;
  const now = pd.snapshotRules(await liveRules(req));
  return c.ok(res, { ...item(v), changes: prev ? pd.diffSnapshots(prev.rules, v.rules) : [], comparedToNow: pd.diffSnapshots(now, v.rules) });
});

/** POST .../pricing/versions/:n/rollback */
exports.rollback = c.handle(async (req, res) => {
  const n = parseInt(req.params.version, 10);
  const filter = { tenantId: req.business.tenantId };
  const v = Number.isInteger(n) ? await PricingVersion.findOne({ ...filter, version: n }).lean() : null;
  if (!v) return c.fail(res, 404, 'That version does not exist');
  const live = await liveRules(req);
  const before = pd.snapshotRules(live);
  const rows = pd.diffSnapshots(before, v.rules);
  if (!rows.length) return c.fail(res, 409, 'The live pricing already matches that version');
  const now = new Date();
  const target = new Map((v.rules || []).map((r) => [pd.keyOf(r.categoryId, r.regionKey), r]));
  for (const r of live) if (!target.has(pd.keyOf(r.categoryId, r.regionKey))) await req.data.remove(FareRule, { ruleId: r.ruleId });
  for (const r of target.values()) {
    const { categoryId, regionId, regionKey, currency, active, ...fields } = r;
    await req.data.update(FareRule, { categoryId, regionKey }, { ...fields, regionId: regionId || null, currency: currency || (req.business.market && req.business.market.currency) || 'INR', active: active !== false, updatedAt: now }, { upsert: true, setOnInsert: { ruleId: newId('fr'), createdAt: now } });
  }
  const made = await recordVersion(req, { before, source: 'rollback', rollbackOf: n });
  await audit(req, 'pricing.rolled_back', { toVersion: n, newVersion: made ? made.version : null, ...pd.summaryOf(rows) });
  return c.ok(res, { restoredFrom: n, version: made ? made.version : null, ...pd.summaryOf(rows) });
});

const scheduleView = (x) => ({ id: x.scheduleId, effectiveAt: x.effectiveAt, note: x.note || '', status: x.status, summary: x.summary || null, by: x.createdBy || null, appliedAt: x.appliedAt || null, version: x.version ?? null, failure: x.failure || '', items: Array.isArray(x.items) ? x.items.length : 0 });

/** GET .../pricing/schedules : the waiting ones first, then the most recent finished ones */
exports.listSchedules = c.handle(async (req, res) => {
  const rows = await req.data.find(PricingSchedule).sort({ effectiveAt: -1 }).limit(30).lean();
  const waiting = rows.filter((r) => r.status === 'SCHEDULED' || r.status === 'APPLYING').sort((a, b) => new Date(a.effectiveAt) - new Date(b.effectiveAt));
  const done = rows.filter((r) => !(r.status === 'SCHEDULED' || r.status === 'APPLYING')).slice(0, 10);
  return c.ok(res, { waiting: waiting.map(scheduleView), recent: done.map(scheduleView) });
});

/** POST .../pricing/schedules/:id/cancel : the changes come back as drafts (a newer draft of the same rule is kept as it is) */
exports.cancelSchedule = c.handle(async (req, res) => {
  const id = String(req.params.id || '');
  const cur = await req.data.findOne(PricingSchedule, { scheduleId: id }).lean();
  if (!cur) return c.fail(res, 404, 'That schedule does not exist');
  const claimed = await PricingSchedule.findOneAndUpdate({ tenantId: req.business.tenantId, scheduleId: id, status: 'SCHEDULED' }, { $set: { status: 'CANCELLED' } }, { new: true });
  if (!claimed) return c.fail(res, 409, 'That schedule has already been applied or cancelled');
  let restored = 0;
  for (const it of claimed.items || []) {
    if (await req.data.findOne(FareRuleDraft, { categoryId: it.categoryId, regionKey: it.regionKey }).lean()) continue;
    await saveDraft(req, { categoryId: it.categoryId, regionId: it.regionId || null, regionKey: it.regionKey, currency: it.currency }, it.op, it.fields);
    restored += 1;
  }
  await audit(req, 'pricing.schedule_cancelled', { scheduleId: id, restoredAsDrafts: restored });
  return c.ok(res, { cancelled: id, restoredAsDrafts: restored });
});

/** Applies one claimed schedule (the server's own job, not a request). All checked first; on a problem nothing is applied and the schedule is FAILED with the reason. */
async function applySchedule(schedule, now = new Date()) {
  const tenant = await Tenant.findOne({ tenantId: schedule.tenantId }).lean();
  const finish = (set) => PricingSchedule.updateOne({ scheduleId: schedule.scheduleId }, { $set: set });
  if (!tenant) { await finish({ status: 'FAILED', failure: 'The business no longer exists' }); return { status: 'FAILED' }; }
  const ctx = { business: tenant, admin: { adminId: 'system', email: schedule.createdBy || 'scheduled publish' }, ip: null, data: forTenant(schedule.tenantId) };
  const items = (schedule.items || []).map((i) => ({ ...i, draftId: null }));
  const { problems, plan, market } = await checkDrafts(ctx, items);
  if (problems.length) {
    const failure = problems.map((p) => p.message).join('; ').slice(0, 300);
    await finish({ status: 'FAILED', failure });
    await audit(ctx, 'pricing.schedule_failed', { scheduleId: schedule.scheduleId, failure });
    return { status: 'FAILED', failure };
  }
  const live = await liveRules(ctx);
  const before = pd.snapshotRules(live);
  const changes = pd.draftChanges(live, items);
  await applyPlan(ctx, plan, market, now);
  const made = await recordVersion(ctx, { before, source: 'scheduled', note: schedule.note });
  await finish({ status: 'DONE', appliedAt: now, version: made ? made.version : null, failure: '' });
  await audit(ctx, 'pricing.published', { scheduleId: schedule.scheduleId, version: made ? made.version : null, ...pd.summaryOf(changes), note: schedule.note || undefined, scheduled: true });
  return { status: 'DONE', version: made ? made.version : null };
}

/** The server's job: apply every schedule that has come due (and any left half-way by a server that stopped), oldest first. One server claims each. */
async function runDueSchedules(now = new Date()) {
  const stuckBefore = new Date(now.getTime() - 5 * 60 * 1000);
  // what each one looked like when seen (id and status only), so a claim by another server in the meantime cannot be mistaken for the state we saw
  const seen = (rows) => rows.map((r) => ({ scheduleId: r.scheduleId, status: r.status }));
  const due = [
    ...seen(await PricingSchedule.find({ status: 'SCHEDULED', effectiveAt: { $lte: now } }).sort({ effectiveAt: 1 }).limit(20).lean()),
    ...seen(await PricingSchedule.find({ status: 'APPLYING', claimedAt: { $lt: stuckBefore } }).limit(20).lean())
  ];
  let applied = 0;
  for (const d of due) {
    const claim = await PricingSchedule.findOneAndUpdate({ scheduleId: d.scheduleId, status: d.status }, { $set: { status: 'APPLYING', claimedAt: now } }, { new: true });
    if (!claim) continue; // another server took it
    try { const r = await applySchedule(claim, now); if (r.status === 'DONE') applied += 1; } catch (e) { console.warn('[pricing] scheduled publish failed:', e.message); }
  }
  return applied;
}

exports.applySchedule = applySchedule;
exports.runDueSchedules = runDueSchedules;
exports.modeOf = modeOf;
exports.saveDraft = saveDraft;
exports.recordVersion = recordVersion;
exports.draftView = draftView;
exports.liveSnapshot = async (req) => pd.snapshotRules(await liveRules(req));
exports.publicRule = shapes.publicFareRule;
