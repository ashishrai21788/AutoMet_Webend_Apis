/**
 * Driver self-service onboarding.
 *
 * The business onboards drivers in its dashboard: operating region, category, vehicle, documents and approval. This is
 * the same data, written by the driver from the app, so a driver who registers in the app lands in exactly the records
 * the dashboard's Drivers, Vehicles and Verification pages work on. Nothing here approves anything: the driver only
 * supplies what the business asks for; its reviewers verify it and make the vehicle active.
 *
 * Every handler works on the signed-in driver's own record (the actor comes from the token, never from the request).
 * It builds the same request context the admin controllers use (business, tenant-bound data, an actor) and reuses their
 * validation, storage, history and verification code, so the two cannot drift apart.
 */
const { createModel } = require('../models/dynamicModel');
const { tenantForAccount } = require('../lib/appTenant');
const { forTenant, forTenantWithUntagged } = require('../lib/tenantData');
const { ServiceRegion, VehicleCategory } = require('../models/businessModels');
const { Vehicle, DriverVehicleAssignment, DriverDocument, VehicleDocument } = require('../models/fleetModels');
const { resolveRequirements, computeVerification, effectiveDocumentStatus } = require('../lib/verification');
const { checkDriverAvailable } = require('../lib/driverAvailability');
const v = require('../lib/fleetValidation');
const c = require('./fleet/common');
const fleetDocuments = require('./fleet/documents');
const { assign } = require('./fleet/assignments');

const Driver = () => createModel('drivers');

/** Attaches the business, tenant-bound data and an actor to the request, as the admin controllers expect. */
async function driverContext(req, res, next) {
  try {
    const driverId = req.authActorId || (req.driver && req.driver.driverId);
    if (!driverId) return c.fail(res, 401, 'Please sign in');
    const driver = await Driver().findOne({ driverId: String(driverId) }).lean();
    if (!driver) return c.fail(res, 404, 'Driver not found');
    const tenant = await tenantForAccount(driver);
    if (!tenant) return c.fail(res, 404, 'Business not found');
    req.business = tenant;
    req.data = forTenant(tenant.tenantId);
    req.legacyData = forTenantWithUntagged(tenant);
    req.admin = { adminId: driver.driverId, email: null, role: 'driver' }; // the actor in the timeline and audit log
    req.ownDriver = driver;
    return next();
  } catch (e) {
    console.error('[driver onboarding] context:', e.message);
    return c.fail(res, 500, 'Something went wrong. Please try again.');
  }
}

const maskNumber = (n) => (n && n.length > 4 ? `${'•'.repeat(Math.min(n.length - 4, 8))}${n.slice(-4)}` : n ? '••••' : '');

const ownDocument = (doc, now = new Date()) => (doc ? {
  status: effectiveDocumentStatus(doc, now),
  rejectionReason: doc.rejectionReason || '',
  number: maskNumber(doc.number || ''),
  expiryDate: doc.expiryDate || null,
  submittedAt: doc.submittedAt || null
} : null);

const requirementRows = (requirements, docs) => {
  const byType = new Map(docs.map((d) => [d.type, d]));
  return requirements.map((r) => ({
    type: r.type, label: r.label, mandatory: !!r.mandatory, needsNumber: !!r.needsNumber, needsExpiry: !!r.needsExpiry, photo: !!r.photo,
    document: ownDocument(byType.get(r.type))
  }));
};

/** The driver's current vehicle (the one with an active assignment), or null. */
async function currentVehicle(req, driverId) {
  const assignment = await req.data.findOne(DriverVehicleAssignment, { driverId, active: true });
  return assignment ? req.data.findOne(Vehicle, { vehicleId: assignment.vehicleId }) : null;
}

/** GET: everything the onboarding screen shows, in one payload. */
async function getState(req, res) {
  const fresh = await Driver().findOne({ driverId: req.ownDriver.driverId }).lean();
  const driver = fresh || req.ownDriver;
  const requirements = resolveRequirements(req.business);
  const [regions, categories, vehicle, driverDocs] = await Promise.all([
    req.data.find(ServiceRegion, { active: true }),
    req.data.find(VehicleCategory, { active: true }),
    currentVehicle(req, driver.driverId),
    req.data.find(DriverDocument, { driverId: driver.driverId })
  ]);
  const vehicleDocs = vehicle ? await req.data.find(VehicleDocument, { vehicleId: vehicle.vehicleId }) : [];
  const availability = await checkDriverAvailable(driver);
  const eligibility = availability.eligibility || { eligible: false, reasons: [] };
  const driverVerification = computeVerification(driverDocs, requirements.driver);
  const vehicleVerification = vehicle ? computeVerification(vehicleDocs, requirements.vehicle) : null;

  const area = !!(driver.operatingRegionId && driver.eligibleCategoryId);
  const locked = String(driver.driverVerificationStatus || '').toUpperCase() === 'APPROVED';
  return c.ok(res, {
    business: { name: req.business.name, appName: req.business.appName || req.business.name },
    driver: {
      driverId: driver.driverId, firstName: driver.firstName || '', lastName: driver.lastName || '', phone: driver.phone || '',
      email: driver.email && !require('../lib/fleetValidation').isPlaceholderEmail(driver.email) ? driver.email : '',
      accountStatus: driver.accountStatus || 'ACTIVE',
      verificationStatus: driver.driverVerificationStatus || driverVerification.status,
      operatingRegionId: driver.operatingRegionId || null, eligibleCategoryId: driver.eligibleCategoryId || null
    },
    choices: {
      regions: regions.map((r) => ({ regionId: r.regionId, city: r.city, state: r.state, zoneName: r.zoneName })),
      categories: categories.map((k) => ({
        categoryId: k.categoryId, name: k.name, description: k.description || '', passengerCapacity: k.passengerCapacity,
        regionIds: k.regionIds || []
      }))
    },
    requirements: {
      driver: requirementRows(requirements.driver, driverDocs),
      vehicle: requirementRows(requirements.vehicle, vehicleDocs)
    },
    vehicle: vehicle ? {
      vehicleId: vehicle.vehicleId, registrationNumber: vehicle.registrationNumber, make: vehicle.make, model: vehicle.model,
      year: vehicle.year ?? null, colour: vehicle.colour || '', categoryId: vehicle.categoryId, status: vehicle.status,
      verificationStatus: vehicle.verificationStatus || (vehicleVerification && vehicleVerification.status) || 'INCOMPLETE'
    } : null,
    eligibility: { eligible: !!eligibility.eligible, reasons: (eligibility.reasons || []).map((r) => ({ code: r.code, message: r.message })) },
    // what the driver may still change: nothing once the business has verified them
    editable: !locked,
    steps: {
      area: area,
      vehicle: !!vehicle,
      // done only when every required document is in and none is rejected or expired (those need the driver's attention)
      documents: !!vehicle && [driverVerification, vehicleVerification].every((x) => !x || (x.missing.length === 0 && x.rejected.length === 0 && x.expired.length === 0))
    }
  });
}

/** PUT area: operating region and category (validated against the business's own regions and categories). */
async function setArea(req, res) {
  const driver = req.ownDriver;
  if (String(driver.driverVerificationStatus || '').toUpperCase() === 'APPROVED') {
    return c.fail(res, 409, 'Your account is verified. Ask your business to change your area or ride type.');
  }
  const operatingRegionId = String((req.body && req.body.operatingRegionId) || '').trim();
  const eligibleCategoryId = String((req.body && req.body.eligibleCategoryId) || '').trim();
  const errors = {};
  if (!operatingRegionId) errors.operatingRegionId = 'Choose where you will drive';
  if (!eligibleCategoryId) errors.eligibleCategoryId = 'Choose your ride type';
  if (Object.keys(errors).length) return c.invalid(res, errors);

  const region = await req.data.findOne(ServiceRegion, { regionId: operatingRegionId });
  const category = await req.data.findOne(VehicleCategory, { categoryId: eligibleCategoryId });
  if (!region || !region.active) errors.operatingRegionId = 'That area is not available';
  if (!category || !category.active) errors.eligibleCategoryId = 'That ride type is not available';
  else if (region && !(category.regionIds || []).includes(region.regionId)) errors.eligibleCategoryId = 'That ride type is not offered in the chosen area';
  if (Object.keys(errors).length) return c.invalid(res, errors);

  const vehicle = await currentVehicle(req, driver.driverId);
  if (vehicle && vehicle.categoryId !== eligibleCategoryId) {
    if (String(vehicle.verificationStatus || '').toUpperCase() === 'APPROVED') {
      return c.fail(res, 409, 'Your vehicle is already verified for another ride type. Ask your business to change it.');
    }
    await req.data.update(Vehicle, { vehicleId: vehicle.vehicleId }, {
      categoryId: eligibleCategoryId, passengerCapacity: category.passengerCapacity, operatingRegionId, updatedAt: new Date()
    });
  } else if (vehicle && vehicle.operatingRegionId !== operatingRegionId) {
    await req.data.update(Vehicle, { vehicleId: vehicle.vehicleId }, { operatingRegionId, updatedAt: new Date() });
  }
  await req.legacyData.update(Driver(), { driverId: driver.driverId }, { operatingRegionId, eligibleCategoryId, updatedAt: new Date() });
  await c.record(req, { subjectType: 'driver', subjectId: driver.driverId, kind: 'ACCOUNT_STATUS', action: 'PROFILE_UPDATED', detail: 'Area and ride type chosen in the app' });
  req.ownDriver = { ...driver, operatingRegionId, eligibleCategoryId };
  return getState(req, res);
}

/** PUT vehicle: the driver's own vehicle, created on first save (never active until the business activates it). */
async function saveVehicle(req, res) {
  const driver = req.ownDriver;
  if (!driver.eligibleCategoryId || !driver.operatingRegionId) {
    return c.invalid(res, { area: 'Choose where you will drive and your ride type first' });
  }
  const body = req.body || {};
  const input = {
    registrationNumber: body.registrationNumber,
    make: body.make,
    model: body.model,
    categoryId: driver.eligibleCategoryId,
    passengerCapacity: 1 // the category's capacity is used when the vehicle is saved
  };
  // optional fields are only validated when the driver gave them
  if (body.year !== undefined && body.year !== null && body.year !== '') input.year = body.year;
  if (body.colour !== undefined && body.colour !== null && String(body.colour).trim() !== '') input.colour = body.colour;
  const { value, errors } = v.validateVehicleInput(input);
  if (Object.keys(errors).length) return c.invalid(res, errors);

  const category = await req.data.findOne(VehicleCategory, { categoryId: driver.eligibleCategoryId });
  if (!category || !category.active) return c.invalid(res, { area: 'Your ride type is no longer available. Choose another one.' });
  const existing = await currentVehicle(req, driver.driverId);

  if (existing) {
    if (String(existing.verificationStatus || '').toUpperCase() === 'APPROVED') {
      return c.fail(res, 409, 'Your vehicle is already verified. Ask your business to change its details.');
    }
    if (value.registrationKey !== existing.registrationKey && (await req.data.exists(Vehicle, { registrationKey: value.registrationKey }))) {
      return c.fail(res, 409, 'This registration number is already registered in this business. If it is your vehicle, ask your business to assign it to you.', { registrationNumber: 'Already registered' });
    }
    await req.data.update(Vehicle, { vehicleId: existing.vehicleId }, {
      registrationNumber: value.registrationNumber, registrationKey: value.registrationKey, make: value.make, model: value.model,
      year: value.year ?? null, colour: value.colour || '', updatedAt: new Date()
    });
    await c.record(req, { subjectType: 'vehicle', subjectId: existing.vehicleId, kind: 'ACCOUNT_STATUS', action: 'PROFILE_UPDATED', detail: 'Updated in the app' });
    return getState(req, res);
  }

  if (await req.data.exists(Vehicle, { registrationKey: value.registrationKey })) {
    return c.fail(res, 409, 'This registration number is already registered in this business. If it is your vehicle, ask your business to assign it to you.', { registrationNumber: 'Already registered in this business' });
  }
  const vehicleId = c.newId('veh');
  try {
    await req.data.create(Vehicle, {
      vehicleId, registrationNumber: value.registrationNumber, registrationKey: value.registrationKey, make: value.make, model: value.model,
      year: value.year ?? null, colour: value.colour || '', categoryId: category.categoryId, passengerCapacity: category.passengerCapacity,
      luggageCapacity: category.luggageCapacity ?? null, operatingRegionId: driver.operatingRegionId,
      status: 'INACTIVE', verificationStatus: 'INCOMPLETE', verificationExpiresAt: null,
      createdBy: driver.driverId, createdAt: new Date(), updatedAt: new Date()
    });
  } catch (e) {
    if (c.DUP(e)) return c.fail(res, 409, 'This registration number is already registered in this business. If it is your vehicle, ask your business to assign it to you.', { registrationNumber: 'Already registered in this business' });
    throw e;
  }
  await c.record(req, { subjectType: 'vehicle', subjectId: vehicleId, kind: 'ACCOUNT_STATUS', action: 'CREATED', to: 'INACTIVE', detail: 'Added by the driver in the app' });
  const assigned = await assign(req, { driverId: driver.driverId, vehicleId, reassign: false });
  if (!assigned.ok) return c.fail(res, assigned.status || 409, assigned.message || 'Could not assign the vehicle', assigned.errors);
  return getState(req, res);
}

/** POST document: a driver document or one of the driver's vehicle's documents; the dashboard's own submit logic. */
async function submitDocument(req, res) {
  const driver = req.ownDriver;
  const subject = String((req.body && req.body.subject) || 'driver').toLowerCase();
  if (subject !== 'driver' && subject !== 'vehicle') return c.invalid(res, { subject: 'Choose driver or vehicle' });
  if (subject === 'driver') {
    req.params = { ...req.params, id: driver.driverId };
    return fleetDocuments.submitDriverDocument(req, res);
  }
  const vehicle = await currentVehicle(req, driver.driverId);
  if (!vehicle) return c.invalid(res, { subject: 'Add your vehicle before uploading its documents' });
  req.params = { ...req.params, id: vehicle.vehicleId };
  return fleetDocuments.submitVehicleDocument(req, res);
}

const safe = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (e) {
    console.error(`[driver onboarding] ${req.method} ${req.path}:`, e && e.message);
    return c.fail(res, 500, 'Something went wrong. Please try again.');
  }
};

module.exports = {
  driverContext,
  parseUpload: fleetDocuments.parseUpload,
  getState: safe(getState),
  setArea: safe(setArea),
  saveVehicle: safe(saveVehicle),
  submitDocument: safe(submitDocument)
};
