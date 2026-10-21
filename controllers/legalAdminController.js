/**
 * The business's legal documents (admin dashboard, Settings).
 *
 *   GET  /api/admin/business/legal                       every type with its version in force, any draft, and the history
 *   GET  /api/admin/business/legal/:type/versions        all versions of one type (paged)
 *   POST /api/admin/business/legal/:type                 start a new draft (from the one in force when there is one)
 *   PUT  /api/admin/business/legal/doc/:id               change a DRAFT
 *   POST /api/admin/business/legal/doc/:id/publish       publish a draft with its effective date
 *   DELETE /api/admin/business/legal/doc/:id             delete a DRAFT
 *   GET  /api/admin/business/legal/acceptances           how many riders and drivers have agreed to each version
 *
 * A published version is never edited or deleted: a correction is a new version. Every change is in the audit log.
 */
const { LegalDocument, LegalAcceptance } = require('../models/legalModel');
const { AdminAudit } = require('../models/adminModels');
const legal = require('../lib/legal');
const c = require('./fleet/common');

async function audit(req, action, id, meta) {
  try { await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType: 'legal_document', targetId: id, meta: meta || null, ip: req.ip || null }); } catch (e) { console.warn('[legal] audit write failed:', e.message); }
}

const view = (d) => ({
  id: d.docId, type: d.type, version: d.version, title: d.title, content: d.content, status: d.status, effectiveAt: d.effectiveAt, consentRequired: !!d.consentRequired,
  changeNote: d.changeNote || '', publishedAt: d.publishedAt || null, publishedBy: d.publishedBy || null, createdAt: d.createdAt, updatedAt: d.updatedAt
});

const MAX = 60000;

function validate(body, { partial = false } = {}) {
  const errors = {}; const out = {};
  const b = body || {};
  if (!partial || b.title !== undefined) { const t = String(b.title || '').trim(); if (t.length < 3 || t.length > 120) errors.title = 'Give it a title of 3 to 120 characters'; else out.title = t; }
  if (b.content !== undefined) { const t = String(b.content); if (t.length > MAX) errors.content = `At most ${MAX} characters`; else out.content = t.replace(/\u0000/g, ''); }
  if (b.consentRequired !== undefined) out.consentRequired = !!b.consentRequired;
  if (b.changeNote !== undefined) { const t = String(b.changeNote || '').trim(); if (t.length > 200) errors.changeNote = 'At most 200 characters'; else out.changeNote = t; }
  return { out, errors };
}

exports.overview = c.handle(async (req, res) => {
  const all = await LegalDocument.find({ tenantId: req.business.tenantId }).lean();
  const current = legal.inForce(all);
  const items = legal.TYPE_KEYS.map((type) => {
    const docs = all.filter((d) => d.type === type).sort((a, b) => b.version - a.version);
    const now = current.get(type);
    const scheduled = docs.find((d) => d.status === 'PUBLISHED' && d.effectiveAt && new Date(d.effectiveAt) > new Date());
    const draft = docs.find((d) => d.status === 'DRAFT');
    return {
      type, label: legal.TYPES[type].label, audience: legal.TYPES[type].audience, suggestConsent: legal.TYPES[type].suggestConsent,
      inForce: now ? view(now) : null, scheduled: scheduled ? view(scheduled) : null, draft: draft ? view(draft) : null, versions: docs.length
    };
  });
  return c.ok(res, { items });
});

exports.versions = c.handle(async (req, res) => {
  const type = String(req.params.type).toUpperCase();
  if (!legal.TYPES[type]) return c.fail(res, 404, 'Unknown document type');
  const { page, pageSize, skip } = c.pageParams(req.query);
  const filter = { tenantId: req.business.tenantId, type };
  const [rows, total] = await Promise.all([LegalDocument.find(filter).sort({ version: -1 }).skip(skip).limit(pageSize).lean(), LegalDocument.countDocuments(filter)]);
  return c.ok(res, { items: rows.map(view), total, page, pageSize });
});

exports.createDraft = c.handle(async (req, res) => {
  const type = String(req.params.type).toUpperCase();
  if (!legal.TYPES[type]) return c.fail(res, 404, 'Unknown document type');
  const tenantId = req.business.tenantId;
  if (await LegalDocument.findOne({ tenantId, type, status: 'DRAFT' }).lean()) return c.fail(res, 409, 'There is already a draft of this document. Finish or delete it first.');
  const existing = await LegalDocument.find({ tenantId, type }).sort({ version: -1 }).limit(1).lean();
  const current = legal.inForce(await LegalDocument.find({ tenantId, type, status: 'PUBLISHED' }).lean()).get(type);
  const { out, errors } = validate({ title: legal.TYPES[type].label, content: current ? current.content : '', consentRequired: current ? current.consentRequired : legal.TYPES[type].suggestConsent, ...(req.body || {}) });
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const now = new Date();
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = (existing[0] ? existing[0].version : 0) + 1 + attempt;
    try {
      const doc = await LegalDocument.create({ tenantId, docId: c.newId('ld'), type, version: next, status: 'DRAFT', effectiveAt: null, content: '', ...out, createdBy: req.admin.adminId, createdAt: now, updatedAt: now });
      await audit(req, 'legal.draft_created', doc.docId, { type, version: next });
      return c.ok(res, view(doc.toObject ? doc.toObject() : doc));
    } catch (e) { if (!c.DUP(e)) throw e; }
  }
  return c.fail(res, 409, 'Someone else started a draft at the same time. Please try again.');
});

exports.updateDraft = c.handle(async (req, res) => {
  const { out, errors } = validate(req.body, { partial: true });
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const updated = await LegalDocument.findOneAndUpdate({ tenantId: req.business.tenantId, docId: String(req.params.id), status: 'DRAFT' }, { $set: { ...out, updatedAt: new Date() } }, { new: true });
  if (!updated) {
    const found = await LegalDocument.findOne({ tenantId: req.business.tenantId, docId: String(req.params.id) }).lean();
    return found ? c.fail(res, 409, 'A published version cannot be changed. Start a new version instead.') : c.fail(res, 404, 'Document not found');
  }
  await audit(req, 'legal.draft_updated', updated.docId, { fields: Object.keys(out) });
  return c.ok(res, view(updated.toObject ? updated.toObject() : updated));
});

exports.publish = c.handle(async (req, res) => {
  const found = await LegalDocument.findOne({ tenantId: req.business.tenantId, docId: String(req.params.id) }).lean();
  if (!found) return c.fail(res, 404, 'Document not found');
  if (found.status !== 'DRAFT') return c.fail(res, 409, 'This version is already published.');
  const errors = {};
  if (String(found.content || '').trim().length < 100) errors.content = 'Write the document first: at least 100 characters';
  const when = req.body && req.body.effectiveAt ? new Date(req.body.effectiveAt) : new Date();
  if (Number.isNaN(when.getTime())) errors.effectiveAt = 'Choose a valid date';
  else if (when.getTime() > Date.now() + 366 * 86400_000) errors.effectiveAt = 'At most one year ahead';
  // a version must not start before the one it replaces, or people could be shown older text than they agreed to
  const latest = (await LegalDocument.find({ tenantId: req.business.tenantId, type: found.type, status: 'PUBLISHED' }).lean()).reduce((m, d) => (!m || new Date(d.effectiveAt) > new Date(m) ? d.effectiveAt : m), null);
  if (!errors.effectiveAt && latest && when < new Date(latest)) errors.effectiveAt = 'It cannot start before the version it replaces';
  if (Object.keys(errors).length) return c.invalid(res, errors);
  // the effective date is stored as given; "now" is rounded down a second so it is already in force when read straight after
  const effectiveAt = !(req.body && req.body.effectiveAt) ? new Date(Date.now() - 1000) : when;
  const moved = await LegalDocument.findOneAndUpdate({ tenantId: req.business.tenantId, docId: found.docId, status: 'DRAFT' }, { $set: { status: 'PUBLISHED', effectiveAt, publishedAt: new Date(), publishedBy: req.admin.adminId, updatedAt: new Date() } }, { new: true });
  if (!moved) return c.fail(res, 409, 'This version is already published.');
  await audit(req, 'legal.published', moved.docId, { type: moved.type, version: moved.version, effectiveAt, consentRequired: moved.consentRequired });
  return c.ok(res, view(moved.toObject ? moved.toObject() : moved));
});

exports.deleteDraft = c.handle(async (req, res) => {
  const gone = await LegalDocument.findOne({ tenantId: req.business.tenantId, docId: String(req.params.id), status: 'DRAFT' }).lean();
  if (!gone) return c.fail(res, 409, 'Only a draft can be deleted. A published version stays as the record.');
  await LegalDocument.deleteOne({ tenantId: req.business.tenantId, docId: gone.docId, status: 'DRAFT' });
  await audit(req, 'legal.draft_deleted', gone.docId, { type: gone.type, version: gone.version });
  return c.ok(res, { id: gone.docId });
});

exports.acceptances = c.handle(async (req, res) => {
  const rows = await LegalAcceptance.find({ tenantId: req.business.tenantId }).limit(200000).lean();
  const map = new Map();
  for (const r of rows) { const k = `${r.type}|${r.version}`; const x = map.get(k) || { type: r.type, version: r.version, riders: 0, drivers: 0 }; if (r.role === 'driver') x.drivers += 1; else x.riders += 1; map.set(k, x); }
  return c.ok(res, { items: [...map.values()].sort((a, b) => a.type.localeCompare(b.type) || b.version - a.version) });
});
