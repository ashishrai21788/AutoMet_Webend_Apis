const { Tenant, AdminAudit } = require('../../models/adminModels');
const { ServiceRegion } = require('../../models/businessModels');
const { Vehicle, DriverVehicleAssignment } = require('../../models/fleetModels');
const { driverEligibility } = require('../../lib/eligibility');
const { presenceOf } = require('../../lib/driverLocation');
const { rideSettingsOf, validateRideSettings } = require('../../lib/driverAvailability');
const c = require('./common');
const { helpers: dh } = require('./drivers');

const MAX_DRIVERS = 10000; // the summary reads every driver of one business; beyond this it says it is partial

exports.getSettings = c.handle(async (req, res) => c.ok(res, rideSettingsOf(req.business)));

exports.updateSettings = c.handle(async (req, res) => {
  const { value, errors } = validateRideSettings(req.body);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const merged = { ...rideSettingsOf(req.business), ...value };
  const updated = await req.data.update(Tenant, {}, { rideSettings: merged });
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action: 'business.ride_settings_updated', targetType: 'business', targetId: req.business.tenantId, meta: value, ip: req.ip || null });
  } catch (e) { console.warn('[fleet] audit write failed:', e.message); }
  return c.ok(res, rideSettingsOf(updated));
});

/**
 * How many drivers are available, and how many would be blocked if eligibility were required. Computed from the records:
 * "online" is what the driver app reports (the backend does not receive live locations yet).
 */
async function computeSummary(req) {
  const [drivers, assignments, vehicles, regions] = await Promise.all([
    req.legacyData.find(dh.Driver(), {}).select('driverId accountStatus driverVerificationStatus verificationExpiresAt operatingRegionId eligibleCategoryId isOnline lastActive lastLocation locationUpdatedAt').limit(MAX_DRIVERS + 1).lean(),
    req.data.find(DriverVehicleAssignment, { active: true }),
    req.data.find(Vehicle),
    req.data.find(ServiceRegion)
  ]);
  const truncated = drivers.length > MAX_DRIVERS;
  const rows = truncated ? drivers.slice(0, MAX_DRIVERS) : drivers;
  const vehicleById = new Map(vehicles.map((v) => [v.vehicleId, v]));
  const vehicleByDriver = new Map(assignments.map((a) => [a.driverId, vehicleById.get(a.vehicleId) || null]));
  const regionById = new Map(regions.map((r) => [r.regionId, r]));

  const out = { totalDrivers: rows.length, activeAccounts: 0, eligible: 0, notEligible: 0, online: 0, onlineEligible: 0, onlineNotEligible: 0, onlineLive: 0, onlineStale: 0, onlineNoSignal: 0, blockedBy: {} };
  const now = new Date();
  for (const d of rows) {
    const active = (d.accountStatus || 'ACTIVE') === 'ACTIVE';
    const e = driverEligibility({ driver: d, vehicle: vehicleByDriver.get(d.driverId) || null, region: d.operatingRegionId ? regionById.get(d.operatingRegionId) || null : null });
    if (active) out.activeAccounts++;
    if (e.eligible) out.eligible++; else out.notEligible++;
    if (d.isOnline) {
      out.online++;
      const p = presenceOf(d, now).state;
      if (p === 'LIVE') out.onlineLive++; else if (p === 'STALE') out.onlineStale++; else out.onlineNoSignal++;
      if (e.eligible) out.onlineEligible++; else out.onlineNotEligible++;
    }
    // for active drivers, why they would be blocked once eligibility is required
    if (active && !e.eligible) for (const r of e.reasons) if (r.code !== 'ACCOUNT_NOT_ACTIVE') out.blockedBy[r.code] = (out.blockedBy[r.code] || 0) + 1;
  }
  return { ...out, truncated, settings: rideSettingsOf(req.business) };
}

exports.computeSummary = computeSummary;
exports.summary = c.handle(async (req, res) => c.ok(res, await computeSummary(req)));
