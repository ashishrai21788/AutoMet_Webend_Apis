/**
 * Cancellation policy history (admin dashboard, Pricing).
 *
 *   GET  /api/admin/business/cancellation-policies/history[?categoryId=&regionId=]   changes, newest first, with what each changed
 *   POST /api/admin/business/cancellation-policies/history/:id/restore               put the terms from before that change back
 *
 * Every save and removal of a policy is recorded with the terms before and after. A restore is itself recorded, so it can be undone
 * the same way. If the policy has been changed again since, the restore asks for confirmation first (`force: true`).
 */
const crypto = require('crypto');
const { AdminAudit } = require('../models/adminModels');
const { VehicleCategory, ServiceRegion, CancellationPolicy } = require('../models/businessModels');
const { CancellationPolicyChange } = require('../models/pricingModels');
const ch = require('../lib/cancellationHistory');
const c = require('./fleet/common');

const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const PAGE = 50;

/** A plain copy, taken before a write, so what is recorded as "before" cannot change underneath us. */
const snapshot = (policy) => (policy ? JSON.parse(JSON.stringify(policy)) : null);

/** Two changes in the same millisecond would have no order; each stamp is at least one millisecond after the last. */
let lastStamp = 0;
const stamp = () => { lastStamp = Math.max(Date.now(), lastStamp + 1); return new Date(lastStamp); };

/** Records one change. Never throws: a failure here must not undo a policy change that already happened. */
async function record(req, { op, before, after, policy, restoreOf = null }) {
  try {
    const src = policy || before || after;
    if (!src) return null;
    return await CancellationPolicyChange.create({
      tenantId: req.business.tenantId, changeId: newId('cpc'), policyId: src.policyId || null,
      categoryId: src.categoryId, regionId: src.regionId || null, regionKey: src.regionKey || src.regionId || 'default',
      op, before: ch.termsOf(before), after: ch.termsOf(after), restoreOf,
      actorId: req.admin ? req.admin.adminId : null, actorEmail: req.admin ? req.admin.email : null, createdAt: stamp()
    });
  } catch (e) {
    console.warn('[cancellation] could not record a change:', e.message);
    return null;
  }
}

async function audit(req, action, targetId, meta) {
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType: 'cancellation_policy', targetId, meta: meta || null, ip: req.ip || null });
  } catch (e) { console.warn('[cancellation] audit write failed:', e.message); }
}

const view = (row, names) => ({
  id: row.changeId, at: row.createdAt, by: row.actorEmail || null, op: row.op,
  categoryId: row.categoryId, category: names.categories.get(row.categoryId) || null,
  regionId: row.regionId || null, region: row.regionId ? (names.regions.get(row.regionId) || null) : null,
  changes: ch.changedFields(row.before, row.after), restoreOf: row.restoreOf || null
});

exports.record = record;
exports.snapshot = snapshot;

/** GET .../cancellation-policies/history */
exports.history = c.handle(async (req, res) => {
  const where = { tenantId: req.business.tenantId };
  if (req.query.categoryId) where.categoryId = String(req.query.categoryId);
  if (req.query.regionId) where.regionKey = String(req.query.regionId);
  const rows = await CancellationPolicyChange.find(where).sort({ createdAt: -1 }).limit(PAGE).lean();
  const [cats, regs] = await Promise.all([req.data.find(VehicleCategory).lean(), req.data.find(ServiceRegion).lean()]);
  const names = { categories: new Map(cats.map((x) => [x.categoryId, x.name])), regions: new Map(regs.map((x) => [x.regionId, `${x.city}${x.zoneName && x.zoneName !== 'All areas' ? ` (${x.zoneName})` : ''}`])) };
  return c.ok(res, { items: rows.map((r) => view(r, names)) });
});

/** POST .../cancellation-policies/history/:id/restore { force? } */
exports.restore = c.handle(async (req, res) => {
  const change = await CancellationPolicyChange.findOne({ tenantId: req.business.tenantId, changeId: String(req.params.id) }).lean();
  if (!change) return c.fail(res, 404, 'That change does not exist');
  const target = change.before || null;
  const live = snapshot(await req.data.findOne(CancellationPolicy, { categoryId: change.categoryId, regionKey: change.regionKey }));
  const liveTerms = ch.termsOf(live);
  if (ch.same(liveTerms, target)) return c.ok(res, { unchanged: true });
  if (!ch.same(liveTerms, change.after || null) && !(req.body && req.body.force === true)) {
    return c.fail(res, 409, 'This policy has been changed again since. Restoring would overwrite that.', { code: 'CHANGED_SINCE', changes: ch.changedFields(liveTerms, target) });
  }

  if (!target) {
    if (live) await req.data.remove(CancellationPolicy, { policyId: live.policyId });
  } else {
    const category = await req.data.findOne(VehicleCategory, { categoryId: change.categoryId });
    if (!category) return c.fail(res, 409, 'That vehicle category no longer exists');
    if (change.regionId && !(await req.data.findOne(ServiceRegion, { regionId: change.regionId }))) return c.fail(res, 409, 'That region no longer exists');
    const now = new Date();
    await req.data.update(
      CancellationPolicy,
      { categoryId: change.categoryId, regionKey: change.regionKey },
      { rider: target.rider, driver: target.driver, conditions: target.conditions, regionId: change.regionId || null, currency: target.currency || (live && live.currency) || 'INR', active: true, updatedAt: now },
      { upsert: true, setOnInsert: { policyId: newId('cp'), createdAt: now } }
    );
  }
  const after = target ? await req.data.findOne(CancellationPolicy, { categoryId: change.categoryId, regionKey: change.regionKey }) : null;
  await record(req, { op: 'RESTORE', before: live, after, policy: live || after || { categoryId: change.categoryId, regionId: change.regionId, regionKey: change.regionKey }, restoreOf: change.changeId });
  await audit(req, 'cancellation_policy.restored', (live || after || {}).policyId || null, { change: change.changeId });
  return c.ok(res, { restored: change.changeId, removed: !target });
});
