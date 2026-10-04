const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { createModel } = require('../../models/dynamicModel');
const { ServiceRegion, VehicleCategory } = require('../../models/businessModels');
const { DriverDocument, Vehicle, DriverVehicleAssignment, EntityHistory } = require('../../models/fleetModels');
const { can } = require('../../lib/adminPermissions');
const { driverEligibility } = require('../../lib/eligibility');
const { effectiveStoredStatus, computeVerification } = require('../../lib/verification');
const v = require('../../lib/fleetValidation');
const c = require('./common');

const Driver = () => createModel('drivers');
const PROJECTION = '-passwordHash -accessToken -fcmToken -deviceId';

async function generateDriverId() {
  for (let i = 0; i < 10; i++) {
    const id = Date.now().toString().slice(-6) + crypto.randomInt(0, 10000).toString().padStart(4, '0'); // same 10-digit format as app sign-ups
    if (!(await Driver().findOne({ driverId: id }))) return id;
  }
  throw new Error('Unable to generate a unique driver ID');
}

/** The region and category a driver may be given must belong to this business, be active, and be offered together. */
async function checkOperatingChoices(req, { operatingRegionId, eligibleCategoryId }) {
  const errors = {};
  let region = null;
  if (operatingRegionId) {
    region = await req.data.findOne(ServiceRegion, { regionId: operatingRegionId });
    if (!region) errors.operatingRegionId = 'Region not found';
    else if (!region.active) errors.operatingRegionId = 'That region is not active';
  }
  if (eligibleCategoryId) {
    const category = await req.data.findOne(VehicleCategory, { categoryId: eligibleCategoryId });
    if (!category) errors.eligibleCategoryId = 'Vehicle category not found';
    else if (!category.active) errors.eligibleCategoryId = 'That category is not active';
    else if (region && !(category.regionIds || []).includes(region.regionId)) errors.eligibleCategoryId = 'That category is not offered in the chosen region';
  }
  return errors;
}

/**
 * Phone numbers and emails are unique across every business (the driver record has always worked that way), so the
 * check looks at all drivers. The message deliberately does not say whose record it is.
 */
async function duplicateErrors(phone, email, selfDriverId) {
  const errors = {};
  const notSelf = (hit) => hit && hit.driverId !== selfDriverId;
  if (phone && notSelf(await Driver().findOne({ phone: { $in: v.phoneVariants(phone) } }))) errors.phone = 'This phone number is already registered';
  if (email && notSelf(await Driver().findOne({ email }))) errors.email = 'This email address is already registered';
  return errors;
}

/** Everything the eligibility check needs for one driver (the vehicle with an active assignment, and the region). */
async function loadContext(req, driver) {
  const assignment = await req.data.findOne(DriverVehicleAssignment, { driverId: driver.driverId, active: true });
  const vehicle = assignment ? await req.data.findOne(Vehicle, { vehicleId: assignment.vehicleId }) : null;
  const region = driver.operatingRegionId ? await req.data.findOne(ServiceRegion, { regionId: driver.operatingRegionId }) : null;
  return { assignment, vehicle, region, eligibility: driverEligibility({ driver, vehicle, region }) };
}

const vehicleBrief = (vh) => (vh ? { id: vh.vehicleId, registrationNumber: vh.registrationNumber, make: vh.make, model: vh.model, categoryId: vh.categoryId, status: vh.status } : null);

function listItem(d, { vehicle, photoDoc, eligibility }) {
  return {
    id: d.driverId,
    name: c.driverName(d),
    phone: d.phone,
    photoUrl: c.photoUrl(photoDoc),
    vehicle: vehicleBrief(vehicle),
    operatingRegionId: d.operatingRegionId || null,
    eligibleCategoryId: d.eligibleCategoryId || null,
    verificationStatus: effectiveStoredStatus({ verificationStatus: d.driverVerificationStatus, verificationExpiresAt: d.verificationExpiresAt }),
    accountStatus: d.accountStatus || 'ACTIVE',
    eligible: eligibility.eligible,
    registeredAt: d.createdAt
  };
}

/** Mongo conditions for the list filters (legacy drivers have no accountStatus / driverVerificationStatus yet). */
function filtersFromQuery(query, now = new Date()) {
  const and = [];
  const term = String(query.search || '').trim().slice(0, 80);
  for (const word of term.split(/\s+/).filter(Boolean)) {
    const rx = { $regex: c.escapeRegex(word), $options: 'i' };
    and.push({ $or: [{ firstName: rx }, { lastName: rx }, { phone: rx }, { driverId: rx }, { email: rx }] });
  }
  if (query.regionId) and.push({ operatingRegionId: String(query.regionId) });
  if (query.categoryId) and.push({ eligibleCategoryId: String(query.categoryId) });
  if (query.account === 'ACTIVE') and.push({ accountStatus: { $in: ['ACTIVE', null] } });
  else if (['INACTIVE', 'SUSPENDED'].includes(query.account)) and.push({ accountStatus: query.account });
  switch (query.verification) {
    case 'INCOMPLETE': and.push({ driverVerificationStatus: { $in: ['INCOMPLETE', null] } }); break;
    case 'PENDING_REVIEW': case 'REJECTED': and.push({ driverVerificationStatus: query.verification }); break;
    case 'EXPIRED': and.push({ $or: [{ driverVerificationStatus: 'EXPIRED' }, { driverVerificationStatus: 'APPROVED', verificationExpiresAt: { $lt: now } }] }); break;
    case 'APPROVED': and.push({ driverVerificationStatus: 'APPROVED', $or: [{ verificationExpiresAt: null }, { verificationExpiresAt: { $gte: now } }] }); break;
    default: break;
  }
  return and.length ? { $and: and } : {};
}

exports.list = c.handle(async (req, res) => {
  const { page, pageSize, skip } = c.pageParams(req.query);
  const filter = filtersFromQuery(req.query);
  const sort = req.query.sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };
  const [rows, total] = await Promise.all([
    req.legacyData.find(Driver(), filter).select(PROJECTION).sort(sort).skip(skip).limit(pageSize).lean(),
    req.legacyData.count(Driver(), filter)
  ]);

  const ids = rows.map((d) => d.driverId);
  const [assignments, photos, regions] = await Promise.all([
    req.data.find(DriverVehicleAssignment, { driverId: { $in: ids }, active: true }),
    req.data.find(DriverDocument, { driverId: { $in: ids }, type: 'PROFILE_PHOTO' }),
    req.data.find(ServiceRegion)
  ]);
  const vehicles = assignments.length ? await req.data.find(Vehicle, { vehicleId: { $in: assignments.map((a) => a.vehicleId) } }) : [];
  const vehicleById = new Map(vehicles.map((x) => [x.vehicleId, x]));
  const assignmentByDriver = new Map(assignments.map((a) => [a.driverId, a]));
  const photoByDriver = new Map(photos.map((p) => [p.driverId, p]));
  const regionById = new Map(regions.map((r) => [r.regionId, r]));

  const items = rows.map((d) => {
    const a = assignmentByDriver.get(d.driverId);
    const vehicle = a ? vehicleById.get(a.vehicleId) || null : null;
    const region = d.operatingRegionId ? regionById.get(d.operatingRegionId) || null : null;
    return listItem(d, { vehicle, photoDoc: photoByDriver.get(d.driverId), eligibility: driverEligibility({ driver: d, vehicle, region }) });
  });
  return c.ok(res, { items, total, page, pageSize });
});

exports.create = c.handle(async (req, res) => {
  const { value, errors } = v.validateDriverInput(req.body);
  if (!('operatingRegionId' in (req.body || {})) || !value.operatingRegionId) errors.operatingRegionId = errors.operatingRegionId || 'Choose the region this driver operates in';
  const eligibleCategoryId = String((req.body && req.body.eligibleCategoryId) || '').trim();
  if (!eligibleCategoryId) errors.eligibleCategoryId = 'Choose the vehicle category this driver is eligible for';
  value.eligibleCategoryId = eligibleCategoryId || null;
  if (Object.keys(errors).length) return c.invalid(res, errors);

  const operating = await checkOperatingChoices(req, value);
  const dupes = await duplicateErrors(value.phone, value.email, null);
  const all = { ...operating, ...dupes };
  if (Object.keys(all).length) return c.fail(res, Object.keys(dupes).length ? 409 : 400, Object.keys(dupes).length ? 'This driver is already registered' : 'Please fix the highlighted fields', all);

  const driverId = await generateDriverId();
  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10); // drivers sign in with their phone; this password is never used or shown
  let driver;
  try {
    driver = await req.legacyData.create(Driver(), {
      driverId, firstName: value.firstName, lastName: value.lastName, phone: value.phone,
      email: value.email || v.placeholderEmail(driverId), passwordHash,
      dateOfBirth: value.dateOfBirth || null, address: value.address || null,
      operatingRegionId: value.operatingRegionId, eligibleCategoryId: value.eligibleCategoryId,
      accountStatus: value.accountStatus || 'ACTIVE', driverVerificationStatus: 'INCOMPLETE', verificationExpiresAt: null,
      isPhoneVerified: false, createdByAdmin: req.admin.adminId, role: 'driver', isOnline: false
    });
  } catch (e) {
    if (c.DUP(e)) return c.fail(res, 409, 'This driver is already registered', { phone: 'This phone number or email is already registered' });
    throw e;
  }
  await c.record(req, { subjectType: 'driver', subjectId: driverId, kind: 'ACCOUNT_STATUS', action: 'CREATED', to: driver.accountStatus, detail: 'Added from the dashboard' });
  return c.ok(res, { id: driverId }, 201);
});

async function findDriver(req, id) {
  return req.legacyData.findOne(Driver(), { driverId: String(id) }).select(PROJECTION).lean();
}

exports.get = c.handle(async (req, res) => {
  const d = await findDriver(req, req.params.id);
  if (!d) return c.fail(res, 404, 'Driver not found');
  const ctx = await loadContext(req, d);
  const docs = await c.loadDocuments(req, 'driver', d.driverId);
  const requirements = c.requirementsFor(req).driver;
  const verification = computeVerification(docs, requirements);
  const category = d.eligibleCategoryId ? await req.data.findOne(VehicleCategory, { categoryId: d.eligibleCategoryId }) : null;
  const photoDoc = docs.find((x) => x.type === 'PROFILE_PHOTO');

  return c.ok(res, {
    id: d.driverId,
    name: c.driverName(d),
    fullName: c.driverName(d),
    phone: d.phone,
    email: c.cleanEmail(d),
    dateOfBirth: d.dateOfBirth ? new Date(d.dateOfBirth).toISOString().slice(0, 10) : null,
    address: d.address || null,
    photoUrl: c.photoUrl(photoDoc),
    operatingRegionId: d.operatingRegionId || null,
    eligibleCategoryId: d.eligibleCategoryId || null,
    eligibleCategoryName: category ? category.name : null,
    accountStatus: d.accountStatus || 'ACTIVE',
    verificationStatus: verification.status,
    verification: { missing: verification.missing, rejected: verification.rejected, expired: verification.expired, pending: verification.pending },
    eligibility: ctx.eligibility,
    vehicle: vehicleBrief(ctx.vehicle),
    assignedAt: ctx.assignment ? ctx.assignment.assignedAt : null,
    // what exists about the driver's activity today; no ride history, earnings or ratings are shown because none are recorded for the dashboard
    activity: {
      registeredAt: d.createdAt,
      createdByAdmin: !!d.createdByAdmin,
      phoneVerified: !!d.isPhoneVerified,
      lastActiveAt: d.lastActive || null,
      signedInOnApp: !!d.isLoggedin
    },
    // vehicle details the driver entered in the driver app before vehicles were managed here (information only)
    appReportedVehicle: d.vehicleNumber ? { registrationNumber: d.vehicleNumber, model: d.vehicleModel || null, type: d.vehicleType || null, colour: d.vehicleColor || null } : null,
    canViewDocuments: can(req.admin, 'documents.view'),
    createdAt: d.createdAt
  });
});

exports.update = c.handle(async (req, res) => {
  const d = await findDriver(req, req.params.id);
  if (!d) return c.fail(res, 404, 'Driver not found');
  const body = { ...(req.body || {}) };
  delete body.accountStatus; // status changes have their own endpoint, with a reason and a history entry
  const { value, errors } = v.validateDriverInput(body, { partial: true });
  if (Object.keys(errors).length) return c.invalid(res, errors);

  const operating = await checkOperatingChoices(req, {
    operatingRegionId: 'operatingRegionId' in value ? value.operatingRegionId : d.operatingRegionId,
    eligibleCategoryId: 'eligibleCategoryId' in value ? value.eligibleCategoryId : d.eligibleCategoryId
  });
  // only complain about choices the admin is actually changing
  const operatingErrors = {};
  if (operating.operatingRegionId && 'operatingRegionId' in value) operatingErrors.operatingRegionId = operating.operatingRegionId;
  if (operating.eligibleCategoryId && ('eligibleCategoryId' in value || 'operatingRegionId' in value)) operatingErrors.eligibleCategoryId = operating.eligibleCategoryId;
  if ('operatingRegionId' in value && !value.operatingRegionId) operatingErrors.operatingRegionId = 'A driver needs an operating region';
  if ('eligibleCategoryId' in value && !value.eligibleCategoryId) operatingErrors.eligibleCategoryId = 'A driver needs an eligible category';

  const dupes = await duplicateErrors(value.phone && value.phone !== d.phone ? value.phone : null, value.email && value.email !== d.email ? value.email : null, d.driverId);
  const all = { ...operatingErrors, ...dupes };
  if (Object.keys(all).length) return c.fail(res, Object.keys(dupes).length ? 409 : 400, 'Please fix the highlighted fields', all);

  const set = { ...value, updatedAt: new Date() };
  if ('email' in set && !set.email) set.email = d.email && v.isPlaceholderEmail(d.email) ? d.email : v.placeholderEmail(d.driverId);
  try {
    await req.legacyData.update(Driver(), { driverId: d.driverId }, set);
  } catch (e) {
    if (c.DUP(e)) return c.fail(res, 409, 'This email address is already registered', { email: 'This email address is already registered' });
    throw e;
  }
  const changed = Object.keys(value);
  await c.record(req, { subjectType: 'driver', subjectId: d.driverId, kind: 'ACCOUNT_STATUS', action: 'PROFILE_UPDATED', detail: `Changed: ${changed.join(', ')}` });
  return c.ok(res, { id: d.driverId });
});

exports.setStatus = c.handle(async (req, res) => {
  const d = await findDriver(req, req.params.id);
  if (!d) return c.fail(res, 404, 'Driver not found');
  const { value, errors } = v.validateStatusChange(req.body, v.DRIVER_ACCOUNT_STATUSES);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const current = d.accountStatus || 'ACTIVE';
  if (current === value.status) return c.fail(res, 409, `The driver is already ${value.status.toLowerCase()}`);

  await req.legacyData.update(Driver(), { driverId: d.driverId }, { accountStatus: value.status, updatedAt: new Date() });
  await c.record(req, { subjectType: 'driver', subjectId: d.driverId, kind: 'ACCOUNT_STATUS', action: 'ACCOUNT_STATUS_CHANGED', from: current, to: value.status, reason: value.reason });
  return c.ok(res, { id: d.driverId, accountStatus: value.status });
});

exports.history = c.handle(async (req, res) => {
  const d = await findDriver(req, req.params.id);
  if (!d) return c.fail(res, 404, 'Driver not found');
  const rows = await req.data.find(EntityHistory, { subjectType: 'driver', subjectId: d.driverId }).sort({ at: -1 }).limit(200).lean();
  return c.ok(res, rows.map((r) => ({ id: String(r._id || r.at), kind: r.kind, action: r.action, from: r.from, to: r.to, detail: r.detail, reason: r.reason, actor: r.actorEmail, at: r.at })));
});

module.exports.helpers = { findDriver, loadContext, checkOperatingChoices, vehicleBrief, Driver, filtersFromQuery };
