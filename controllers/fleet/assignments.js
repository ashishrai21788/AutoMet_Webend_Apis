const { DriverVehicleAssignment } = require('../../models/fleetModels');
const c = require('./common');
const { helpers: dh } = require('./drivers');
const { helpers: vh } = require('./vehicles');

const refuse = (status, message, errors) => ({ ok: false, status, message, errors });

/**
 * Gives a vehicle to a driver, enforcing the business rules. Both records must belong to this business (the lookups are
 * tenant-scoped, so another business's driver or vehicle simply is not found).
 *  - a suspended driver or vehicle cannot be assigned
 *  - the vehicle's category must be the driver's eligible category, and its region the driver's region
 *  - one active vehicle per driver and one active driver per vehicle; moving needs `reassign`, and ends the old assignment
 */
async function assign(req, { driverId, vehicleId, reassign }) {
  const driver = await dh.findDriver(req, driverId);
  if (!driver) return refuse(404, 'Driver not found');
  const vehicle = await vh.findVehicle(req, vehicleId);
  if (!vehicle) return refuse(404, 'Vehicle not found');

  if ((driver.accountStatus || 'ACTIVE') === 'SUSPENDED') return refuse(409, 'A suspended driver cannot be assigned a vehicle');
  if (vehicle.status === 'SUSPENDED') return refuse(409, 'A suspended vehicle cannot be assigned to a driver');
  if (driver.eligibleCategoryId && vehicle.categoryId !== driver.eligibleCategoryId) {
    return refuse(409, 'This vehicle is not of the category the driver is eligible for', { vehicleId: 'Category does not match the driver' });
  }
  if (vehicle.operatingRegionId && driver.operatingRegionId && vehicle.operatingRegionId !== driver.operatingRegionId) {
    return refuse(409, 'This vehicle operates in a different region from the driver', { vehicleId: 'Region does not match the driver' });
  }

  const [driverActive, vehicleActive] = await Promise.all([
    req.data.findOne(DriverVehicleAssignment, { driverId: driver.driverId, active: true }),
    req.data.findOne(DriverVehicleAssignment, { vehicleId: vehicle.vehicleId, active: true })
  ]);
  if (driverActive && vehicleActive && driverActive.assignmentId === vehicleActive.assignmentId) {
    return { ok: true, unchanged: true, assignmentId: driverActive.assignmentId };
  }
  const conflicts = [driverActive, vehicleActive].filter(Boolean);
  if (conflicts.length && !reassign) {
    const which = driverActive ? 'This driver already has a vehicle assigned' : 'This vehicle is already assigned to another driver';
    return refuse(409, `${which}. Reassign to move it.`, { conflict: driverActive ? 'driver' : 'vehicle' });
  }

  const now = new Date();
  const ended = [];
  for (const old of conflicts) {
    await req.data.update(DriverVehicleAssignment, { assignmentId: old.assignmentId }, { active: false, endedAt: now, endedBy: req.admin.adminId, endReason: 'Reassigned' });
    ended.push(old);
  }
  let created;
  try {
    created = await req.data.create(DriverVehicleAssignment, {
      assignmentId: c.newId('as'), driverId: driver.driverId, vehicleId: vehicle.vehicleId, active: true, assignedAt: now, assignedBy: req.admin.adminId
    });
  } catch (e) {
    // lost a race with another assignment: put the ended ones back and report the conflict
    for (const old of ended) await req.data.update(DriverVehicleAssignment, { assignmentId: old.assignmentId }, { active: true, endedAt: null, endedBy: null, endReason: '' });
    if (c.DUP(e)) return refuse(409, 'This driver or vehicle was just assigned elsewhere. Please try again.');
    throw e;
  }

  for (const old of ended) {
    await c.record(req, { subjectType: 'driver', subjectId: old.driverId, kind: 'ASSIGNMENT', action: 'VEHICLE_UNASSIGNED', detail: `Vehicle ${old.vehicleId} (reassigned)` });
    await c.record(req, { subjectType: 'vehicle', subjectId: old.vehicleId, kind: 'ASSIGNMENT', action: 'DRIVER_UNASSIGNED', detail: `Driver ${old.driverId} (reassigned)` });
  }
  await c.record(req, { subjectType: 'driver', subjectId: driver.driverId, kind: 'ASSIGNMENT', action: 'VEHICLE_ASSIGNED', to: vehicle.vehicleId, detail: `Vehicle ${vehicle.registrationNumber}` });
  await c.record(req, { subjectType: 'vehicle', subjectId: vehicle.vehicleId, kind: 'ASSIGNMENT', action: 'DRIVER_ASSIGNED', to: driver.driverId, detail: `Driver ${c.driverName(driver)}` });
  return { ok: true, assignmentId: created.assignmentId };
}

async function unassign(req, { driverId, vehicleId, reason }) {
  const filter = driverId ? { driverId, active: true } : { vehicleId, active: true };
  const current = await req.data.findOne(DriverVehicleAssignment, filter);
  if (!current) return refuse(404, driverId ? 'This driver has no vehicle assigned' : 'This vehicle has no driver assigned');
  await req.data.update(DriverVehicleAssignment, { assignmentId: current.assignmentId }, { active: false, endedAt: new Date(), endedBy: req.admin.adminId, endReason: reason || 'Unassigned' });
  await c.record(req, { subjectType: 'driver', subjectId: current.driverId, kind: 'ASSIGNMENT', action: 'VEHICLE_UNASSIGNED', from: current.vehicleId, reason });
  await c.record(req, { subjectType: 'vehicle', subjectId: current.vehicleId, kind: 'ASSIGNMENT', action: 'DRIVER_UNASSIGNED', from: current.driverId, reason });
  return { ok: true };
}

const answer = (res, r) => (r.ok ? c.ok(res, { assignmentId: r.assignmentId, unchanged: !!r.unchanged }) : c.fail(res, r.status, r.message, r.errors));
const reasonOf = (req) => String((req.body && req.body.reason) || '').trim().slice(0, 300);

exports.assignVehicleToDriver = c.handle(async (req, res) => {
  const vehicleId = String((req.body && req.body.vehicleId) || '').trim();
  if (!vehicleId) return c.invalid(res, { vehicleId: 'Choose a vehicle' });
  return answer(res, await assign(req, { driverId: req.params.id, vehicleId, reassign: !!(req.body && req.body.reassign) }));
});

exports.assignDriverToVehicle = c.handle(async (req, res) => {
  const driverId = String((req.body && req.body.driverId) || '').trim();
  if (!driverId) return c.invalid(res, { driverId: 'Choose a driver' });
  return answer(res, await assign(req, { driverId, vehicleId: req.params.id, reassign: !!(req.body && req.body.reassign) }));
});

exports.unassignFromDriver = c.handle(async (req, res) => {
  const r = await unassign(req, { driverId: req.params.id, reason: reasonOf(req) });
  return r.ok ? c.ok(res, { ok: true }) : c.fail(res, r.status, r.message);
});

exports.unassignFromVehicle = c.handle(async (req, res) => {
  const r = await unassign(req, { vehicleId: req.params.id, reason: reasonOf(req) });
  return r.ok ? c.ok(res, { ok: true }) : c.fail(res, r.status, r.message);
});

module.exports.assign = assign;
