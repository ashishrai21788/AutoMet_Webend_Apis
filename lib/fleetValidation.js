/** Validation for driver, vehicle and document input. Each function returns { value, errors } (errors keyed by field). */
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);

const E164_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NO_EMAIL_DOMAIN = '@noreply.invalid'; // drivers created without an email get a unique placeholder (the driver record requires one)
const DRIVER_ACCOUNT_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'];
const VEHICLE_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'];
const MIN_DRIVER_AGE = 18;

/** "+91 98765-43210" -> "+919876543210"; anything that is not a plausible international number -> null. */
function normalizePhone(raw) {
  const compact = str(raw).replace(/[\s().-]/g, '');
  return E164_RE.test(compact) ? compact : null;
}

/** Every spelling an existing record might use for this number (international, or the national part only). */
function phoneVariants(e164, nationalDigitsMinLength = 7) {
  const digits = e164.slice(1);
  const out = new Set([e164, digits]);
  // national-number suffixes of plausible length, since older sign-ups stored the number without a country code
  for (let cc = 1; cc <= 3; cc++) if (digits.length - cc >= nationalDigitsMinLength) out.add(digits.slice(cc));
  return [...out];
}

const placeholderEmail = (driverId) => `driver-${driverId}${NO_EMAIL_DOMAIN}`;
const isPlaceholderEmail = (email) => typeof email === 'string' && email.endsWith(NO_EMAIL_DOMAIN);

function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v);
  return Number.isNaN(d.getTime()) ? undefined : d; // undefined = not a date
}

const startOfTodayUTC = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

function validateDriverInput(input = {}, { partial = false, now = new Date() } = {}) {
  const errors = {};
  const out = {};
  const has = (k) => !partial || k in input;

  if (has('fullName')) {
    const name = str(input.fullName).replace(/\s+/g, ' ');
    const parts = name.split(' ').filter(Boolean);
    if (name.length < 2 || name.length > 80 || parts.length === 0) errors.fullName = 'Full name is required (2 to 80 characters)';
    else { out.firstName = parts[0]; out.lastName = parts.slice(1).join(' ') || '-'; }
  }
  if (has('phone')) {
    const phone = normalizePhone(input.phone);
    if (!phone) errors.phone = 'Enter the phone number with its country code, for example +919876543210';
    else out.phone = phone;
  }
  if ('email' in input || !partial) {
    const email = str(input.email).toLowerCase();
    if (email && !EMAIL_RE.test(email)) errors.email = 'Enter a valid email address';
    else out.email = email; // '' means none
  }
  if ('dateOfBirth' in input) {
    const d = parseDate(input.dateOfBirth);
    if (d === undefined) errors.dateOfBirth = 'Enter a valid date';
    else if (d) {
      const eighteen = new Date(Date.UTC(now.getUTCFullYear() - MIN_DRIVER_AGE, now.getUTCMonth(), now.getUTCDate()));
      if (d > eighteen) errors.dateOfBirth = `The driver must be at least ${MIN_DRIVER_AGE} years old`;
      else if (d.getUTCFullYear() < 1930) errors.dateOfBirth = 'Enter a valid date of birth';
      else out.dateOfBirth = d;
    } else out.dateOfBirth = null;
  }
  if ('address' in input) {
    const a = input.address || {};
    const address = { country: str(a.country).toUpperCase(), state: str(a.state), city: str(a.city), line: str(a.line) };
    if (address.country && !/^[A-Z]{2}$/.test(address.country)) errors['address.country'] = 'Choose a country';
    if ([address.state, address.city].some((v) => v.length > 80) || address.line.length > 200) errors.address = 'Address parts are too long';
    out.address = address.country || address.state || address.city || address.line ? address : null;
  }
  if ('operatingRegionId' in input) out.operatingRegionId = str(input.operatingRegionId) || null;
  if ('eligibleCategoryId' in input) out.eligibleCategoryId = str(input.eligibleCategoryId) || null;
  if ('accountStatus' in input) {
    if (!DRIVER_ACCOUNT_STATUSES.includes(input.accountStatus)) errors.accountStatus = 'Choose Active, Inactive or Suspended';
    else out.accountStatus = input.accountStatus;
  }
  return { value: out, errors };
}

/** Upper-case letters and digits only: "mh 12-ab 1234" and "MH12AB1234" are the same registration. */
function normalizeRegistration(raw) {
  return str(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function validateVehicleInput(input = {}, { partial = false, now = new Date() } = {}) {
  const errors = {};
  const out = {};
  const has = (k) => !partial || k in input;

  if (has('registrationNumber')) {
    const display = str(input.registrationNumber).toUpperCase().replace(/\s+/g, ' ');
    const key = normalizeRegistration(display);
    if (key.length < 4 || key.length > 15 || !/^[A-Z0-9 -]+$/.test(display)) errors.registrationNumber = 'Enter the registration number (4 to 15 letters and digits)';
    else { out.registrationNumber = display; out.registrationKey = key; }
  }
  for (const [field, label] of [['make', 'Make'], ['model', 'Model']]) {
    if (has(field)) {
      const v = str(input[field]);
      if (v.length < 1 || v.length > 40) errors[field] = `${label} is required (40 characters at most)`;
      else out[field] = v;
    }
  }
  if ('year' in input) {
    if (input.year === null || input.year === '') out.year = null;
    else {
      const y = num(input.year);
      if (!Number.isInteger(y) || y < 1980 || y > now.getUTCFullYear() + 1) errors.year = 'Enter a valid year';
      else out.year = y;
    }
  }
  if ('colour' in input) {
    const c = str(input.colour);
    if (c.length > 30) errors.colour = 'Colour is 30 characters at most';
    else out.colour = c;
  }
  if (has('categoryId')) {
    const c = str(input.categoryId);
    if (!c) errors.categoryId = 'Choose a vehicle category';
    else out.categoryId = c;
  }
  if (has('passengerCapacity')) {
    const n = num(input.passengerCapacity);
    if (!Number.isInteger(n) || n < 1 || n > 20) errors.passengerCapacity = 'Passenger capacity must be a whole number from 1 to 20';
    else out.passengerCapacity = n;
  }
  if ('luggageCapacity' in input) {
    if (input.luggageCapacity === null || input.luggageCapacity === '') out.luggageCapacity = null;
    else {
      const n = num(input.luggageCapacity);
      if (!Number.isInteger(n) || n < 0 || n > 20) errors.luggageCapacity = 'Luggage capacity must be a whole number from 0 to 20';
      else out.luggageCapacity = n;
    }
  }
  if ('operatingRegionId' in input) out.operatingRegionId = str(input.operatingRegionId) || null;
  if ('status' in input) {
    if (!VEHICLE_STATUSES.includes(input.status)) errors.status = 'Choose Active, Inactive or Suspended';
    else out.status = input.status;
  }
  return { value: out, errors };
}

/**
 * Metadata that accompanies an uploaded document. `def` is the requirement definition for the type.
 * An expiry date must be in the future: an already expired document cannot be submitted.
 */
function validateDocumentMeta(input = {}, def, { now = new Date() } = {}) {
  const errors = {};
  const out = { number: '', expiryDate: null };
  const number = str(input.number);
  if (number.length > 60) errors.number = 'The document number is 60 characters at most';
  else out.number = number;
  if (def.needsNumber && !number) errors.number = `${def.label} number is required`;

  const expiry = parseDate(input.expiryDate);
  if (expiry === undefined) errors.expiryDate = 'Enter a valid expiry date';
  else if (expiry) {
    if (expiry < startOfTodayUTC(now)) errors.expiryDate = 'This document has already expired';
    else out.expiryDate = expiry;
  } else if (def.needsExpiry) errors.expiryDate = `${def.label} expiry date is required`;
  return { value: out, errors };
}

function validateReview(input = {}) {
  const errors = {};
  const decision = input.decision;
  const reason = str(input.reason);
  if (decision !== 'APPROVE' && decision !== 'REJECT') errors.decision = 'Choose approve or reject';
  if (decision === 'REJECT') {
    if (reason.length < 5) errors.reason = 'Give a reason the driver can understand (at least 5 characters)';
    else if (reason.length > 300) errors.reason = 'The reason is 300 characters at most';
  }
  return { value: { decision, reason: decision === 'REJECT' ? reason : '' }, errors };
}

function validateStatusChange(input = {}, allowed) {
  const errors = {};
  const status = input.status;
  const reason = str(input.reason);
  if (!allowed.includes(status)) errors.status = 'Choose a valid status';
  if (status === 'SUSPENDED' && reason.length < 5) errors.reason = 'Give a reason for the suspension (at least 5 characters)';
  if (reason.length > 300) errors.reason = 'The reason is 300 characters at most';
  return { value: { status, reason }, errors };
}

module.exports = {
  DRIVER_ACCOUNT_STATUSES, VEHICLE_STATUSES, normalizePhone, phoneVariants, placeholderEmail, isPlaceholderEmail,
  normalizeRegistration, validateDriverInput, validateVehicleInput, validateDocumentMeta, validateReview,
  validateStatusChange, parseDate, startOfTodayUTC
};
