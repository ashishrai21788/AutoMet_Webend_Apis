const { ServiceRegion, VehicleCategory } = require('../../models/businessModels');
const { Vehicle, DriverVehicleAssignment, EntityHistory } = require('../../models/fleetModels');
const { can } = require('../../lib/adminPermissions');
const { effectiveStoredStatus, computeVerification } = require('../../lib/verification');
const v = require('../../lib/fleetValidation');
const c = require('./common');
const { helpers: driverHelpers } = require('./drivers');

async function checkVehicleChoices(req, { categoryId, operatingRegionId }) {
  const errors = {};
  let category = null;
  let region = null;
  if (categoryId) {
    category = await req.data.findOne(VehicleCategory, { categoryId });
    if (!category) errors.categoryId = 'Vehicle category not found';
    else if (!category.active) errors.categoryId = 'That category is not active';
  }
  if (operatingRegionId) {
    region = await req.data.findOne(ServiceRegion, { regionId: operatingRegionId });
    if (!region) errors.operatingRegionId = 'Region not found';
    else if (!region.active) errors.operatingRegionId = 'That region is not active';
    else if (category && !(category.regionIds || []).includes(region.regionId)) errors.operatingRegionId = 'That category is not offered in the chosen region';
  }
  return { errors, category, region };
}

async function findVehicle(req, id) {
  return req.data.findOne(Vehicle, { vehicleId: String(id) }).lean();
}

const driverBrief = (d) => (d ? { id: d.driverId, name: c.driverName(d), phone: d.phone, accountStatus: d.accountStatus || 'ACTIVE' } : null);

function listItem(vh, { driver, category, region }) {
  return {
    id: vh.vehicleId,
    registrationNumber: vh.registrationNumber,
    make: vh.make,
    model: vh.model,
    year: vh.year ?? null,
    colour: vh.colour || '',
    categoryId: vh.categoryId,
    categoryName: category ? category.name : null,
    driver: driverBrief(driver),
    operatingRegionId: vh.operatingRegionId || null,
    regionName: region ? `${region.city}${region.zoneName !== 'All areas' ? ` (${region.zoneName})` : ''}` : null,
    status: vh.status,
    verificationStatus: effectiveStoredStatus(vh),
    createdAt: vh.createdAt
  };
}

function filtersFromQuery(query, now = new Date()) {
  const and = [];
  const term = String(query.search || '').trim().slice(0, 40);
  for (const word of term.split(/\s+/).filter(Boolean)) {
    const rx = { $regex: c.escapeRegex(word), $options: 'i' };
    const keyRx = { $regex: c.escapeRegex(v.normalizeRegistration(word)), $options: 'i' };
    and.push({ $or: [{ registrationKey: keyRx }, { registrationNumber: rx }, { make: rx }, { model: rx }] });
  }
  if (query.categoryId) and.push({ categoryId: String(query.categoryId) });
  if (query.regionId) and.push({ operatingRegionId: String(query.regionId) });
  if (['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(query.status)) and.push({ status: query.status });
  switch (query.verification) {
    case 'INCOMPLETE': and.push({ verificationStatus: { $in: ['INCOMPLETE', null] } }); break;
    case 'PENDING_REVIEW': case 'REJECTED': and.push({ verificationStatus: query.verification }); break;
    case 'EXPIRED': and.push({ $or: [{ verificationStatus: 'EXPIRED' }, { verificationStatus: 'APPROVED', verificationExpiresAt: { $lt: now } }] }); break;
    case 'APPROVED': and.push({ verificationStatus: 'APPROVED', $or: [{ verificationExpiresAt: null }, { verificationExpiresAt: { $gte: now } }] }); break;
    default: break;
  }
  return and;
}

exports.list = c.handle(async (req, res) => {
  const { page, pageSize, skip } = c.pageParams(req.query);
  const and = filtersFromQuery(req.query);

  // "assigned" / "unassigned" is decided by the active assignments
  if (req.query.assignment === 'assigned' || req.query.assignment === 'unassigned') {
    const active = await req.data.find(DriverVehicleAssignment, { active: true });
    const ids = active.map((a) => a.vehicleId);
    and.push({ vehicleId: req.query.assignment === 'assigned' ? { $in: ids } : { $nin: ids } });
  }
  const filter = and.length ? { $and: and } : {};
  const [rows, total] = await Promise.all([
    req.data.find(Vehicle, filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    req.data.count(Vehicle, filter)
  ]);

  const ids = rows.map((r) => r.vehicleId);
  const [assignments, categories, regions] = await Promise.all([
    req.data.find(DriverVehicleAssignment, { vehicleId: { $in: ids }, active: true }),
    req.data.find(VehicleCategory),
    req.data.find(ServiceRegion)
  ]);
  const drivers = assignments.length
    ? await req.legacyData.find(driverHelpers.Driver(), { driverId: { $in: assignments.map((a) => a.driverId) } }).select('driverId firstName lastName phone accountStatus').lean()
    : [];
  const driverById = new Map(drivers.map((d) => [d.driverId, d]));
  const driverByVehicle = new Map(assignments.map((a) => [a.vehicleId, driverById.get(a.driverId)]));
  const categoryById = new Map(categories.map((x) => [x.categoryId, x]));
  const regionById = new Map(regions.map((x) => [x.regionId, x]));

  return c.ok(res, {
    items: rows.map((vh) => listItem(vh, { driver: driverByVehicle.get(vh.vehicleId), category: categoryById.get(vh.categoryId), region: regionById.get(vh.operatingRegionId) })),
    total, page, pageSize
  });
});

exports.create = c.handle(async (req, res) => {
  const { value, errors } = v.validateVehicleInput(req.body);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const { errors: choiceErrors } = await checkVehicleChoices(req, value);
  if (Object.keys(choiceErrors).length) return c.invalid(res, choiceErrors);
  if (await req.data.exists(Vehicle, { registrationKey: value.registrationKey })) {
    return c.fail(res, 409, 'A vehicle with this registration number already exists', { registrationNumber: 'Already registered in this business' });
  }
  const vehicleId = c.newId('veh');
  try {
    await req.data.create(Vehicle, {
      vehicleId, registrationNumber: value.registrationNumber, registrationKey: value.registrationKey, make: value.make, model: value.model,
      year: value.year ?? null, colour: value.colour || '', categoryId: value.categoryId, passengerCapacity: value.passengerCapacity,
      luggageCapacity: value.luggageCapacity ?? null, operatingRegionId: value.operatingRegionId || null,
      status: value.status || 'INACTIVE', verificationStatus: 'INCOMPLETE', verificationExpiresAt: null,
      createdBy: req.admin.adminId, createdAt: new Date(), updatedAt: new Date()
    });
  } catch (e) {
    if (c.DUP(e)) return c.fail(res, 409, 'A vehicle with this registration number already exists', { registrationNumber: 'Already registered in this business' });
    throw e;
  }
  await c.record(req, { subjectType: 'vehicle', subjectId: vehicleId, kind: 'ACCOUNT_STATUS', action: 'CREATED', to: value.status || 'INACTIVE', detail: 'Added from the dashboard' });
  return c.ok(res, { id: vehicleId }, 201);
});

exports.get = c.handle(async (req, res) => {
  const vh = await findVehicle(req, req.params.id);
  if (!vh) return c.fail(res, 404, 'Vehicle not found');
  const [assignment, category, region, docs] = await Promise.all([
    req.data.findOne(DriverVehicleAssignment, { vehicleId: vh.vehicleId, active: true }),
    req.data.findOne(VehicleCategory, { categoryId: vh.categoryId }),
    vh.operatingRegionId ? req.data.findOne(ServiceRegion, { regionId: vh.operatingRegionId }) : null,
    c.loadDocuments(req, 'vehicle', vh.vehicleId)
  ]);
  const driver = assignment ? await driverHelpers.findDriver(req, assignment.driverId) : null;
  const verification = computeVerification(docs, c.requirementsFor(req).vehicle);
  return c.ok(res, {
    ...listItem(vh, { driver, category, region }),
    verificationStatus: verification.status,
    verification: { missing: verification.missing, rejected: verification.rejected, expired: verification.expired, pending: verification.pending },
    passengerCapacity: vh.passengerCapacity,
    luggageCapacity: vh.luggageCapacity ?? null,
    assignedAt: assignment ? assignment.assignedAt : null,
    // active and verified is what makes a vehicle usable; a driver also has to be eligible (see the driver's eligibility)
    operational: vh.status === 'ACTIVE' && verification.status === 'APPROVED',
    canViewDocuments: can(req.admin, 'documents.view')
  });
});

exports.update = c.handle(async (req, res) => {
  const vh = await findVehicle(req, req.params.id);
  if (!vh) return c.fail(res, 404, 'Vehicle not found');
  const body = { ...(req.body || {}) };
  delete body.status; // status changes have their own endpoint, with a reason and a history entry
  const { value, errors } = v.validateVehicleInput(body, { partial: true });
  if (Object.keys(errors).length) return c.invalid(res, errors);

  const next = {
    categoryId: 'categoryId' in value ? value.categoryId : vh.categoryId,
    operatingRegionId: 'operatingRegionId' in value ? value.operatingRegionId : vh.operatingRegionId
  };
  const { errors: choiceErrors } = await checkVehicleChoices(req, next);
  const reportable = {};
  if (choiceErrors.categoryId && 'categoryId' in value) reportable.categoryId = choiceErrors.categoryId;
  if (choiceErrors.operatingRegionId && ('operatingRegionId' in value || 'categoryId' in value)) reportable.operatingRegionId = choiceErrors.operatingRegionId;
  if (Object.keys(reportable).length) return c.invalid(res, reportable);

  if (value.registrationKey && value.registrationKey !== vh.registrationKey && (await req.data.exists(Vehicle, { registrationKey: value.registrationKey }))) {
    return c.fail(res, 409, 'A vehicle with this registration number already exists', { registrationNumber: 'Already registered in this business' });
  }

  // a change must not leave the assigned driver with a vehicle they are not eligible for
  const assignment = await req.data.findOne(DriverVehicleAssignment, { vehicleId: vh.vehicleId, active: true });
  if (assignment && ('categoryId' in value || 'operatingRegionId' in value)) {
    const driver = await driverHelpers.findDriver(req, assignment.driverId);
    const categoryClash = driver && driver.eligibleCategoryId && next.categoryId !== driver.eligibleCategoryId;
    const regionClash = driver && driver.operatingRegionId && next.operatingRegionId && next.operatingRegionId !== driver.operatingRegionId;
    if (categoryClash || regionClash) {
      return c.fail(res, 409, 'This change conflicts with the assigned driver. Unassign the driver first.', { [categoryClash ? 'categoryId' : 'operatingRegionId']: 'Conflicts with the assigned driver' });
    }
  }

  try {
    await req.data.update(Vehicle, { vehicleId: vh.vehicleId }, { ...value, updatedAt: new Date() });
  } catch (e) {
    if (c.DUP(e)) return c.fail(res, 409, 'A vehicle with this registration number already exists', { registrationNumber: 'Already registered in this business' });
    throw e;
  }
  await c.record(req, { subjectType: 'vehicle', subjectId: vh.vehicleId, kind: 'ACCOUNT_STATUS', action: 'PROFILE_UPDATED', detail: `Changed: ${Object.keys(value).filter((k) => k !== 'registrationKey').join(', ')}` });
  return c.ok(res, { id: vh.vehicleId });
});

exports.setStatus = c.handle(async (req, res) => {
  const vh = await findVehicle(req, req.params.id);
  if (!vh) return c.fail(res, 404, 'Vehicle not found');
  const { value, errors } = v.validateStatusChange(req.body, v.VEHICLE_STATUSES);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  if (vh.status === value.status) return c.fail(res, 409, `The vehicle is already ${value.status.toLowerCase()}`);

  // a vehicle with an expired mandatory document cannot be made operational
  if (value.status === 'ACTIVE') {
    const current = effectiveStoredStatus(vh);
    if (current === 'EXPIRED') return c.fail(res, 409, 'This vehicle has an expired mandatory document. Upload and approve a new one before activating it.', { status: 'A mandatory document has expired' });
  }
  await req.data.update(Vehicle, { vehicleId: vh.vehicleId }, { status: value.status, updatedAt: new Date() });
  await c.record(req, { subjectType: 'vehicle', subjectId: vh.vehicleId, kind: 'ACCOUNT_STATUS', action: 'VEHICLE_STATUS_CHANGED', from: vh.status, to: value.status, reason: value.reason });
  return c.ok(res, { id: vh.vehicleId, status: value.status });
});

exports.history = c.handle(async (req, res) => {
  const vh = await findVehicle(req, req.params.id);
  if (!vh) return c.fail(res, 404, 'Vehicle not found');
  const rows = await req.data.find(EntityHistory, { subjectType: 'vehicle', subjectId: vh.vehicleId }).sort({ at: -1 }).limit(200).lean();
  return c.ok(res, rows.map((r) => ({ id: String(r._id || r.at), kind: r.kind, action: r.action, from: r.from, to: r.to, detail: r.detail, reason: r.reason, actor: r.actorEmail, at: r.at })));
});

module.exports.helpers = { findVehicle, driverBrief };
