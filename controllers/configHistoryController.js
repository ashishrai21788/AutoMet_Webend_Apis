const { Tenant, AdminAudit } = require('../models/adminModels');
const { ConfigVersion } = require('../models/configVersionModel');
const { clearAppTenantCache } = require('../lib/appTenant');
const versions = require('../lib/configVersions');
const c = require('./fleet/common');

/**
 * Called by every save of a tracked setting, after the save: records the version. `patch` is what the save wrote.
 * Safe to call always; it writes nothing when no tracked setting changed and never throws.
 */
async function track(req, source, patch) {
  const before = req.business;
  // read the tracked fields through the same accessors for both sides (a business record may hold defaults as getters, which a plain spread would drop)
  const after = { ...versions.snapshotOf(before), ...patch };
  return versions.record({ ConfigVersion, tenantId: req.business.tenantId, before, after, source, actor: req.admin });
}

const item = (v) => ({
  version: v.version, at: v.createdAt, by: v.actorEmail || null, source: v.source || '',
  changed: (v.changed || []).map((g) => versions.LABELS[g] || g), rollbackOf: v.rollbackOf || null
});

/** GET /api/admin/business/config-history?page&pageSize : newest first */
exports.list = c.handle(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const filter = { tenantId: req.business.tenantId };
  const [total, rows] = await Promise.all([
    ConfigVersion.countDocuments(filter),
    ConfigVersion.find(filter).sort({ version: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean()
  ]);
  const current = total ? (await ConfigVersion.find(filter).sort({ version: -1 }).limit(1).lean())[0] || null : null;
  return c.ok(res, { items: rows.map(item), total, page, pageSize, current: current ? current.version : null });
});

/** GET /api/admin/business/config-history/:version : what changed in it, and how it differs from the settings now */
exports.get = c.handle(async (req, res) => {
  const n = parseInt(req.params.version, 10);
  const filter = { tenantId: req.business.tenantId };
  const v = Number.isInteger(n) ? await ConfigVersion.findOne({ ...filter, version: n }).lean() : null;
  if (!v) return c.fail(res, 404, 'That version does not exist');
  const prev = n > 1 ? await ConfigVersion.findOne({ ...filter, version: n - 1 }).lean() : null;
  return c.ok(res, {
    ...item(v),
    changes: prev ? versions.diff(prev.snapshot, v.snapshot) : [],
    comparedToNow: versions.diff(versions.snapshotOf(req.business), v.snapshot) // what applying this version would change
  });
});

/** POST /api/admin/business/config-history/:version/rollback : apply that version's settings; recorded as a new version */
exports.rollback = c.handle(async (req, res) => {
  const n = parseInt(req.params.version, 10);
  const filter = { tenantId: req.business.tenantId };
  const v = Number.isInteger(n) ? await ConfigVersion.findOne({ ...filter, version: n }).lean() : null;
  if (!v) return c.fail(res, 404, 'That version does not exist');
  const update = versions.restoreUpdate(v.snapshot, req.business);
  if (!Object.keys(update).length) return c.fail(res, 409, 'The settings already match that version');
  try {
    await req.data.update(Tenant, {}, update);
  } catch (e) {
    if (e && e.code === 11000) return c.fail(res, 409, 'That version uses a business name another business has taken since');
    throw e;
  }
  clearAppTenantCache(); // the apps' servers see the restored settings now
  const made = await track(req, `config.rollback`, update);
  if (made) { try { await ConfigVersion.updateOne({ tenantId: made.tenantId, version: made.version }, { $set: { rollbackOf: n } }); } catch (_) { /* the version stands without the link */ } }
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action: 'config.rolled_back', targetType: 'business', targetId: req.business.tenantId, meta: { toVersion: n, newVersion: made ? made.version : null, fields: Object.keys(update) }, ip: req.ip || null });
  } catch (e) { console.warn('[configHistory] audit write failed:', e.message); }
  return c.ok(res, { restoredFrom: n, version: made ? made.version : null, fields: Object.keys(update) });
});

exports.track = track;
