/**
 * Document requirements and verification status for drivers and vehicles.
 *
 * Requirements are per business (a country has its own rules), starting from sensible defaults that a business admin
 * can adjust: optional documents can be made mandatory and the other way round, but the driving licence and the vehicle
 * registration certificate are always mandatory so a driver or vehicle can never be "verified" with nothing to verify.
 * Nothing here claims a document is genuine: APPROVED means a reviewer accepted it, not that it was authenticated.
 *
 * Verification status of a driver or vehicle is computed from its mandatory documents:
 *   REJECTED        any mandatory document was rejected
 *   EXPIRED         any approved mandatory document is past its expiry date
 *   INCOMPLETE      a mandatory document has not been submitted
 *   PENDING_REVIEW  everything is submitted and something awaits review
 *   APPROVED        every mandatory document is approved and unexpired
 */
const DRIVER_DOCUMENT_TYPES = [
  { type: 'DRIVING_LICENCE', label: 'Driving licence', needsNumber: true, needsExpiry: true, mandatory: true, locked: true },
  { type: 'IDENTITY', label: 'Identity document', needsNumber: true, needsExpiry: false, mandatory: true },
  { type: 'ADDRESS_PROOF', label: 'Address proof', needsNumber: false, needsExpiry: false, mandatory: false },
  { type: 'PROFILE_PHOTO', label: 'Profile photo', needsNumber: false, needsExpiry: false, mandatory: false, photo: true },
  { type: 'OTHER', label: 'Other document', needsNumber: false, needsExpiry: false, mandatory: false }
];

const VEHICLE_DOCUMENT_TYPES = [
  { type: 'REGISTRATION_CERTIFICATE', label: 'Registration certificate', needsNumber: true, needsExpiry: false, mandatory: true, locked: true },
  { type: 'INSURANCE', label: 'Insurance', needsNumber: true, needsExpiry: true, mandatory: true },
  { type: 'POLLUTION_CERTIFICATE', label: 'Pollution certificate', needsNumber: false, needsExpiry: true, mandatory: false },
  { type: 'PERMIT', label: 'Permit', needsNumber: false, needsExpiry: true, mandatory: false },
  { type: 'FITNESS_CERTIFICATE', label: 'Fitness certificate', needsNumber: false, needsExpiry: true, mandatory: false },
  { type: 'OTHER', label: 'Other document', needsNumber: false, needsExpiry: false, mandatory: false }
];

const CATALOG = { driver: DRIVER_DOCUMENT_TYPES, vehicle: VEHICLE_DOCUMENT_TYPES };

/** The business's requirements: the catalog with its overrides ({ driver: {TYPE: true|false}, vehicle: {...} }) applied. */
function resolveRequirements(tenant) {
  const overrides = (tenant && tenant.verificationRequirements) || {};
  const build = (subject) => CATALOG[subject].map((d) => {
    const o = overrides[subject] && overrides[subject][d.type];
    return { ...d, mandatory: d.locked ? true : typeof o === 'boolean' ? o : d.mandatory };
  });
  return { driver: build('driver'), vehicle: build('vehicle') };
}

/** Validates a requirements update; returns { value, errors }. The locked types cannot be turned off. */
function validateRequirementsUpdate(input = {}) {
  const errors = {};
  const value = { driver: {}, vehicle: {} };
  for (const subject of ['driver', 'vehicle']) {
    const given = input[subject];
    if (given == null) continue;
    if (typeof given !== 'object' || Array.isArray(given)) { errors[subject] = 'Expected an object of document types'; continue; }
    for (const [type, mandatory] of Object.entries(given)) {
      const def = CATALOG[subject].find((d) => d.type === type);
      if (!def) errors[`${subject}.${type}`] = 'Unknown document type';
      else if (typeof mandatory !== 'boolean') errors[`${subject}.${type}`] = 'Must be true or false';
      else if (def.locked && mandatory === false) errors[`${subject}.${type}`] = `${def.label} is always required`;
      else if (def.photo && mandatory === true) errors[`${subject}.${type}`] = 'A photo cannot be a verification requirement';
      else value[subject][type] = mandatory;
    }
  }
  return { value, errors };
}

/** A document's status as of `now`: an approved document past its expiry date is EXPIRED. */
function effectiveDocumentStatus(doc, now = new Date()) {
  if (doc.status === 'APPROVED' && doc.expiryDate && new Date(doc.expiryDate).getTime() < now.getTime()) return 'EXPIRED';
  return doc.status;
}

/**
 * @param {object[]} docs the subject's documents ({type, status, expiryDate})
 * @param {{type:string, mandatory:boolean}[]} requirements the subject's requirement list
 * @returns {{ status: string, expiresAt: Date|null, missing: string[], rejected: string[], expired: string[], pending: string[] }}
 */
function computeVerification(docs, requirements, now = new Date()) {
  const mandatory = requirements.filter((r) => r.mandatory);
  const byType = new Map(docs.map((d) => [d.type, d]));
  const missing = [], rejected = [], expired = [], pending = [];
  let expiresAt = null;

  for (const req of mandatory) {
    const doc = byType.get(req.type);
    if (!doc) { missing.push(req.type); continue; }
    const status = effectiveDocumentStatus(doc, now);
    if (status === 'REJECTED') rejected.push(req.type);
    else if (status === 'EXPIRED') expired.push(req.type);
    else if (status === 'SUBMITTED') pending.push(req.type);
    else if (status === 'APPROVED' && doc.expiryDate) {
      const t = new Date(doc.expiryDate);
      if (!expiresAt || t < expiresAt) expiresAt = t;
    }
  }

  let status;
  if (rejected.length) status = 'REJECTED';
  else if (expired.length) status = 'EXPIRED';
  else if (missing.length) status = 'INCOMPLETE';
  else if (pending.length) status = 'PENDING_REVIEW';
  else status = 'APPROVED';
  return { status, expiresAt: status === 'APPROVED' ? expiresAt : null, missing, rejected, expired, pending };
}

/** Stored verification status as of `now`: an APPROVED record whose earliest expiry has passed is EXPIRED. */
function effectiveStoredStatus(record, now = new Date()) {
  const status = record.verificationStatus || record.driverVerificationStatus || 'INCOMPLETE';
  if (status === 'APPROVED' && record.verificationExpiresAt && new Date(record.verificationExpiresAt).getTime() < now.getTime()) return 'EXPIRED';
  return status;
}

module.exports = {
  DRIVER_DOCUMENT_TYPES, VEHICLE_DOCUMENT_TYPES, CATALOG, resolveRequirements, validateRequirementsUpdate,
  effectiveDocumentStatus, computeVerification, effectiveStoredStatus
};
