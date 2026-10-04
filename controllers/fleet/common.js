const crypto = require('crypto');
const { AdminAudit } = require('../../models/adminModels');
const { EntityHistory, DriverDocument, VehicleDocument } = require('../../models/fleetModels');
const { can } = require('../../lib/adminPermissions');
const { resolveRequirements, computeVerification, effectiveDocumentStatus, effectiveStoredStatus } = require('../../lib/verification');
const { signedUrl } = require('../../lib/privateStorage');
const { isPlaceholderEmail } = require('../../lib/fleetValidation');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, message: 'OK', data });
const fail = (res, status, message, errors) => res.status(status).json({ success: false, message, errors: errors || undefined, data: null });
const invalid = (res, errors) => fail(res, 400, 'Please fix the highlighted fields', errors);
const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const DUP = (e) => e && e.code === 11000;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Wraps a handler so an unexpected error becomes a clean 500 and never leaks internals. */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e && e.status && e.expose) return fail(res, e.status, e.message);
    console.error(`[fleet] ${req.method} ${req.path}:`, e && e.message);
    fail(res, 500, 'Something went wrong. Please try again.');
  }
};

/**
 * Records an event on the driver's or vehicle's timeline (what the screens show) and in the audit log.
 * Secrets, document numbers and file links are never written to either.
 */
async function record(req, { subjectType, subjectId, kind, action, from = null, to = null, detail = '', reason = '' }) {
  try {
    await EntityHistory.create({
      tenantId: req.business.tenantId, subjectType, subjectId, kind, action, from, to, detail, reason,
      actorId: req.admin.adminId, actorEmail: req.admin.email, at: new Date()
    });
    await AdminAudit.create({
      tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email,
      action: `${subjectType}.${action.toLowerCase()}`, targetType: subjectType, targetId: subjectId,
      meta: { kind, from, to, reason: reason || undefined, detail: detail || undefined }, ip: req.ip || null
    });
  } catch (e) {
    console.warn('[fleet] history write failed:', e.message);
  }
}

const requirementsFor = (req) => resolveRequirements(req.business);

/** The documents of one driver or vehicle (all of its types). */
async function loadDocuments(req, subject, subjectId) {
  const Model = subject === 'driver' ? DriverDocument : VehicleDocument;
  const key = subject === 'driver' ? 'driverId' : 'vehicleId';
  return req.data.find(Model, { [key]: subjectId });
}

/**
 * Recomputes a driver's or vehicle's verification from its documents, stores it, and records a timeline entry when the
 * status changed. Returns the computed result. `record` is the driver or vehicle document, `update` writes to it.
 */
async function refreshVerification(req, subject, record_, update) {
  const id = subject === 'driver' ? record_.driverId : record_.vehicleId;
  const docs = await loadDocuments(req, subject, id);
  const result = computeVerification(docs, requirementsFor(req)[subject]);
  const field = subject === 'driver' ? 'driverVerificationStatus' : 'verificationStatus';
  const previous = record_[field] || 'INCOMPLETE';
  await update({ [field]: result.status, verificationExpiresAt: result.expiresAt });
  if (previous !== result.status) {
    await record(req, { subjectType: subject, subjectId: id, kind: 'VERIFICATION', action: 'VERIFICATION_STATUS_CHANGED', from: previous, to: result.status });
  }
  return { ...result, previous };
}

const maskNumber = (n) => (n && n.length > 4 ? `${'•'.repeat(Math.min(n.length - 4, 8))}${n.slice(-4)}` : n ? '••••' : '');

/** A document as the dashboard receives it. Roles that cannot open documents get the number masked and no file details. */
function serializeDocument(doc, admin, now = new Date()) {
  const full = can(admin, 'documents.view');
  return {
    id: doc.docId,
    type: doc.type,
    number: full ? doc.number : maskNumber(doc.number),
    expiryDate: doc.expiryDate ? new Date(doc.expiryDate).toISOString().slice(0, 10) : null,
    status: doc.status,
    effectiveStatus: effectiveDocumentStatus(doc, now),
    rejectionReason: doc.rejectionReason || '',
    submittedAt: doc.submittedAt,
    reviewedAt: doc.reviewedAt,
    reviewedBy: doc.reviewedBy,
    version: doc.version || 1,
    mime: full ? doc.file && doc.file.mime : null,
    fileName: full ? doc.file && doc.file.originalName : null,
    viewable: full
  };
}

const driverName = (d) => [d.firstName, d.lastName && d.lastName !== '-' ? d.lastName : ''].filter(Boolean).join(' ').trim();
const cleanEmail = (d) => (d.email && !isPlaceholderEmail(d.email) ? d.email : null);

/** A short-lived link to a driver's profile photo for list screens (null when there is none). */
function photoUrl(photoDoc) {
  if (!photoDoc || !photoDoc.file) return null;
  return signedUrl(photoDoc.file.key, { mime: photoDoc.file.mime, ttlSeconds: 10 * 60 });
}

function pageParams(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 20));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

module.exports = {
  ok, fail, invalid, newId, DUP, escapeRegex, handle, record, requirementsFor, loadDocuments, refreshVerification,
  maskNumber, serializeDocument, driverName, cleanEmail, photoUrl, pageParams, effectiveStoredStatus
};
