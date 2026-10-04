const multer = require('multer');
const { Tenant, AdminAudit } = require('../../models/adminModels');
const { DriverDocument, VehicleDocument } = require('../../models/fleetModels');
const { can } = require('../../lib/adminPermissions');
const { computeVerification, validateRequirementsUpdate, resolveRequirements, effectiveDocumentStatus } = require('../../lib/verification');
const { MAX_UPLOAD_BYTES, detectMime, safeFileName, PHOTO_MIMES } = require('../../lib/fileValidation');
const { putPrivate, signedUrl, isAvailable, SIGNED_URL_TTL_SECONDS } = require('../../lib/privateStorage');
const v = require('../../lib/fleetValidation');
const c = require('./common');
const { helpers: dh } = require('./drivers');
const { helpers: vh } = require('./vehicles');

/** Driver and vehicle documents work the same way; this describes the differences. */
const SUBJECTS = {
  driver: {
    Model: DriverDocument, idField: 'driverId',
    find: (req, id) => dh.findDriver(req, id),
    idOf: (rec) => rec.driverId,
    notFound: 'Driver not found',
    update: (req, rec, patch) => req.legacyData.update(dh.Driver(), { driverId: rec.driverId }, { ...patch, updatedAt: new Date() })
  },
  vehicle: {
    Model: VehicleDocument, idField: 'vehicleId',
    find: (req, id) => vh.findVehicle(req, id),
    idOf: (rec) => rec.vehicleId,
    notFound: 'Vehicle not found',
    update: (req, rec, patch) => req.data.update(require('../../models/fleetModels').Vehicle, { vehicleId: rec.vehicleId }, { ...patch, updatedAt: new Date() })
  }
};

/** multipart parser: one file in memory, size-limited; its errors become clear 4xx answers. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 2000 } }).single('file');
function parseUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return c.fail(res, 413, `The file is too large (${MAX_UPLOAD_BYTES / 1024 / 1024} MB at most)`, { file: 'The file is too large' });
    return c.fail(res, 400, 'The upload could not be read', { file: 'Choose a single JPEG, PNG, WebP or PDF file' });
  });
}

const requirementList = (req, subject) => c.requirementsFor(req)[subject];

/** The documents screen payload: every requirement with the submitted document (if any) and the overall verification. */
function documentsPayload(req, subject, docs) {
  const requirements = requirementList(req, subject);
  const byType = new Map(docs.map((d) => [d.type, d]));
  const verification = computeVerification(docs, requirements);
  return {
    verificationStatus: verification.status,
    verification: { missing: verification.missing, rejected: verification.rejected, expired: verification.expired, pending: verification.pending },
    canView: can(req.admin, 'documents.view'),
    canReview: can(req.admin, 'verification.review'),
    requirements: requirements.map((r) => ({
      type: r.type, label: r.label, mandatory: r.mandatory, needsNumber: r.needsNumber, needsExpiry: r.needsExpiry, photo: !!r.photo,
      document: byType.has(r.type) ? c.serializeDocument(byType.get(r.type), req.admin) : null
    }))
  };
}

const list = (subject) => c.handle(async (req, res) => {
  const S = SUBJECTS[subject];
  const rec = await S.find(req, req.params.id);
  if (!rec) return c.fail(res, 404, S.notFound);
  return c.ok(res, documentsPayload(req, subject, await c.loadDocuments(req, subject, S.idOf(rec))));
});

const submit = (subject) => c.handle(async (req, res) => {
  const S = SUBJECTS[subject];
  const rec = await S.find(req, req.params.id);
  if (!rec) return c.fail(res, 404, S.notFound);
  const subjectId = S.idOf(rec);

  const def = requirementList(req, subject).find((r) => r.type === String((req.body && req.body.type) || ''));
  if (!def) return c.invalid(res, { type: 'Choose a document type' });
  if (!req.file || !req.file.buffer || req.file.size === 0) return c.invalid(res, { file: 'Choose a file to upload' });

  // the file's own bytes decide what it is; the name and the browser's content type are not trusted
  const mime = detectMime(req.file.buffer);
  if (!mime) return c.invalid(res, { file: 'Only JPEG, PNG, WebP or PDF files are accepted' });
  if (def.photo && !PHOTO_MIMES.has(mime)) return c.invalid(res, { file: 'A photo must be a JPEG, PNG or WebP image' });

  const meta = def.photo ? { value: { number: '', expiryDate: null }, errors: {} } : v.validateDocumentMeta(req.body, def);
  if (Object.keys(meta.errors).length) return c.invalid(res, meta.errors);
  if (!isAvailable()) return c.fail(res, 503, 'Document storage is not configured, so files cannot be uploaded yet');

  const key = await putPrivate(req.file.buffer, { tenantId: req.business.tenantId, kind: `${subject}-documents`, mime });
  const file = { key, mime, size: req.file.size, originalName: safeFileName(req.file.originalname) };
  const now = new Date();
  const statusOnSubmit = def.photo ? 'APPROVED' : 'SUBMITTED'; // photos are not part of verification, so they need no review

  let doc = await req.data.findOne(S.Model, { [S.idField]: subjectId, type: def.type });
  let resubmitted = false;
  if (doc) {
    resubmitted = true;
    const previous = { key: doc.file.key, mime: doc.file.mime, replacedAt: now, status: doc.status, rejectionReason: doc.rejectionReason || '' };
    doc = await req.data.update(S.Model, { docId: doc.docId }, {
      file, number: meta.value.number, expiryDate: meta.value.expiryDate, status: statusOnSubmit, rejectionReason: '',
      submittedAt: now, reviewedAt: null, reviewedBy: null, version: (doc.version || 1) + 1, updatedAt: now,
      previousFiles: [...(doc.previousFiles || []), previous].slice(-10)
    });
  } else {
    try {
      doc = await req.data.create(S.Model, {
        docId: c.newId('doc'), [S.idField]: subjectId, type: def.type, number: meta.value.number, expiryDate: meta.value.expiryDate, file,
        status: statusOnSubmit, submittedAt: now, version: 1, previousFiles: [], createdAt: now, updatedAt: now
      });
    } catch (e) {
      if (c.DUP(e)) return c.fail(res, 409, 'This document was just submitted from another session. Please reload and try again.');
      throw e;
    }
  }

  await c.record(req, {
    subjectType: subject, subjectId, kind: 'DOCUMENT', action: resubmitted ? 'DOCUMENT_RESUBMITTED' : 'DOCUMENT_SUBMITTED',
    to: statusOnSubmit, detail: def.label
  });
  const verification = await c.refreshVerification(req, subject, rec, (patch) => S.update(req, rec, patch));
  return c.ok(res, { document: c.serializeDocument(doc, req.admin), verificationStatus: verification.status }, resubmitted ? 200 : 201);
});

/** A short-lived link to the file. Opening a document is itself recorded in the audit log. */
const link = (subject) => c.handle(async (req, res) => {
  const S = SUBJECTS[subject];
  const doc = await req.data.findOne(S.Model, { docId: String(req.params.docId) });
  if (!doc) return c.fail(res, 404, 'Document not found');
  if (!isAvailable()) return c.fail(res, 503, 'Document storage is not configured');
  const url = signedUrl(doc.file.key, { mime: doc.file.mime, ttlSeconds: SIGNED_URL_TTL_SECONDS });
  try {
    await AdminAudit.create({
      tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action: `${subject}_document.viewed`,
      targetType: `${subject}_document`, targetId: doc.docId, meta: { type: doc.type }, ip: req.ip || null // never the link itself
    });
  } catch (e) { console.warn('[fleet] audit write failed:', e.message); }
  return c.ok(res, { url, expiresInSeconds: SIGNED_URL_TTL_SECONDS, mime: doc.file.mime, fileName: doc.file.originalName });
});

const review = (subject) => c.handle(async (req, res) => {
  const S = SUBJECTS[subject];
  const doc = await req.data.findOne(S.Model, { docId: String(req.params.docId) });
  if (!doc) return c.fail(res, 404, 'Document not found');
  const rec = await S.find(req, doc[S.idField]);
  if (!rec) return c.fail(res, 404, S.notFound);

  const { value, errors } = v.validateReview(req.body);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const def = requirementList(req, subject).find((r) => r.type === doc.type);
  if (def && def.photo) return c.fail(res, 400, 'Photos are not part of verification');

  // SUBMITTED can be approved or rejected; an APPROVED document can still be rejected (to revoke it); a REJECTED one must be resubmitted
  if (doc.status === 'REJECTED') return c.fail(res, 409, 'This document was rejected. It needs to be resubmitted before it can be reviewed again.');
  if (doc.status === 'APPROVED' && value.decision === 'APPROVE') return c.fail(res, 409, 'This document is already approved');

  if (value.decision === 'APPROVE') {
    if (def && def.needsNumber && !doc.number) return c.fail(res, 409, `The ${def.label.toLowerCase()} number is missing. Ask for the document to be resubmitted.`);
    if (def && def.needsExpiry && !doc.expiryDate) return c.fail(res, 409, 'The expiry date is missing. Ask for the document to be resubmitted.');
    if (effectiveDocumentStatus({ status: 'APPROVED', expiryDate: doc.expiryDate }) === 'EXPIRED') return c.fail(res, 409, 'This document has already expired and cannot be approved');
  }

  const from = doc.status;
  const to = value.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const now = new Date();
  await req.data.update(S.Model, { docId: doc.docId }, { status: to, rejectionReason: value.reason, reviewedAt: now, reviewedBy: req.admin.adminId, updatedAt: now });
  await c.record(req, {
    subjectType: subject, subjectId: doc[S.idField], kind: 'VERIFICATION', action: to === 'APPROVED' ? 'DOCUMENT_APPROVED' : 'DOCUMENT_REJECTED',
    from, to, reason: value.reason, detail: def ? def.label : doc.type
  });
  const verification = await c.refreshVerification(req, subject, rec, (patch) => S.update(req, rec, patch));
  return c.ok(res, { documentStatus: to, verificationStatus: verification.status });
});

// ---- per-business requirements ----

exports.getRequirements = c.handle(async (req, res) => c.ok(res, resolveRequirements(req.business)));

exports.updateRequirements = c.handle(async (req, res) => {
  const { value, errors } = validateRequirementsUpdate(req.body);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const current = (req.business.verificationRequirements && JSON.parse(JSON.stringify(req.business.verificationRequirements))) || {};
  const merged = { driver: { ...(current.driver || {}), ...value.driver }, vehicle: { ...(current.vehicle || {}), ...value.vehicle } };
  const updated = await req.data.update(Tenant, {}, { verificationRequirements: merged });
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action: 'business.requirements_updated', targetType: 'business', targetId: req.business.tenantId, meta: value, ip: req.ip || null });
  } catch (e) { console.warn('[fleet] audit write failed:', e.message); }
  return c.ok(res, resolveRequirements(updated));
});

Object.assign(exports, {
  parseUpload,
  listDriverDocuments: list('driver'), listVehicleDocuments: list('vehicle'),
  submitDriverDocument: submit('driver'), submitVehicleDocument: submit('vehicle'),
  driverDocumentLink: link('driver'), vehicleDocumentLink: link('vehicle'),
  reviewDriverDocument: review('driver'), reviewVehicleDocument: review('vehicle')
});
