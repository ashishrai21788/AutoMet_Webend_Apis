/** Filters and presentation of audit events, shared by the business audit log, its CSV export and the platform audit log. */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const validDate = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

const SECRET_KEY = /pass(word)?|token|secret|authorization|url|link|key|number|otp/i;

/** What the log shows of an event's details: never secrets, document numbers or links. */
function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_KEY.test(k) || v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

/** Returns { filter } or { errors }. `tenantId` null means every business (the platform log). */
function buildAuditFilter(query, tenantId) {
  const filter = tenantId ? { tenantId } : {};
  const q = String(query.q || '').trim().slice(0, 80);
  if (q) filter.$or = [{ actorEmail: { $regex: escapeRegex(q), $options: 'i' } }, { targetId: { $regex: escapeRegex(q), $options: 'i' } }, { action: { $regex: escapeRegex(q), $options: 'i' } }];
  const action = String(query.action || '').trim();
  if (action) filter.action = { $regex: `^${escapeRegex(action)}`, $options: 'i' };
  const targetType = String(query.targetType || '').trim();
  if (targetType) filter.targetType = targetType;
  const actor = String(query.actor || '').trim().toLowerCase();
  if (actor) filter.actorEmail = actor;
  const scope = String(query.tenantId || '').trim();
  if (!tenantId && scope) filter.tenantId = scope;
  const from = query.from ? validDate(query.from) : null;
  const to = query.to ? validDate(query.to) : null;
  const errors = {};
  if (query.from && !from) errors.from = 'Enter a valid date';
  if (query.to && !to) errors.to = 'Enter a valid date';
  if (Object.keys(errors).length) return { errors };
  if (from || to) filter.at = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  return { filter };
}

const shapeAudit = (r) => ({
  id: String(r._id || `${r.at && new Date(r.at).getTime()}-${r.action}-${r.targetId}`), at: r.at, action: r.action, actorEmail: r.actorEmail || null,
  targetType: r.targetType || null, targetId: r.targetId || null, tenantId: r.tenantId || null, details: safeMeta(r.meta)
});

module.exports = { buildAuditFilter, shapeAudit, safeMeta, escapeRegex };
