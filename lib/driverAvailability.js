/**
 * Who may go online and receive ride requests.
 *
 * Two rules, applied wherever a driver goes online or a rider asks for a driver:
 *  1. ALWAYS: the account must be ACTIVE. A suspended or inactive driver is never available, whatever the business
 *     settings say (a suspension has to take effect immediately).
 *  2. WHEN THE BUSINESS TURNS IT ON (Ride Settings, `requireEligibleDrivers`): the driver must also be fully eligible
 *     (verified, region, an approved active vehicle: lib/eligibility.js). It is off by default so existing drivers,
 *     who were never put through verification, keep working until the business has onboarded its fleet.
 *
 * `evaluateAvailability` is pure; `checkDriverAvailable` loads what it needs.
 */
const { driverEligibility } = require('./eligibility');

const DEFAULT_RIDE_SETTINGS = { requireEligibleDrivers: false };

const rideSettingsOf = (tenant) => ({ ...DEFAULT_RIDE_SETTINGS, ...((tenant && tenant.rideSettings) || {}) });

const ACCOUNT_MESSAGES = {
  SUSPENDED: 'Your driver account is suspended. Please contact support.',
  INACTIVE: 'Your driver account is inactive. Please contact support.'
};

/**
 * @param {{ driver: object, tenant: object|null, vehicle: object|null, region: object|null }} input
 * @returns {{ available: boolean, code: string|null, message: string|null, reasons: {code:string,message:string}[], eligibility: object, enforced: boolean }}
 */
function evaluateAvailability({ driver, tenant, vehicle, region, now = new Date() }) {
  const eligibility = driverEligibility({ driver, vehicle, region, now });
  const enforced = rideSettingsOf(tenant).requireEligibleDrivers === true;
  const account = driver.accountStatus || 'ACTIVE';

  if (account !== 'ACTIVE') {
    return { available: false, code: 'DRIVER_ACCOUNT_NOT_ACTIVE', message: ACCOUNT_MESSAGES[account] || 'Your driver account is not active.', reasons: eligibility.reasons.filter((r) => r.code === 'ACCOUNT_NOT_ACTIVE'), eligibility, enforced };
  }
  if (enforced && !eligibility.eligible) {
    const first = eligibility.reasons[0];
    return {
      available: false, code: 'DRIVER_NOT_ELIGIBLE',
      message: `You cannot go online yet: ${first.message.charAt(0).toLowerCase()}${first.message.slice(1)}.`,
      reasons: eligibility.reasons, eligibility, enforced
    };
  }
  return { available: true, code: null, message: null, reasons: [], eligibility, enforced };
}

/** Loads the driver's business, assignment, vehicle and region, then evaluates. */
async function checkDriverAvailable(driver) {
  const { tenantForAccount } = require('./appTenant');
  const tenant = await tenantForAccount(driver);
  // A driver with no business at all (no default business exists yet) is treated as before: only the account status applies.
  if (!tenant) return evaluateAvailability({ driver, tenant: null, vehicle: null, region: null });

  const { forTenant } = require('./tenantData');
  const { Vehicle, DriverVehicleAssignment } = require('../models/fleetModels');
  const { ServiceRegion } = require('../models/businessModels');
  const data = forTenant(tenant.tenantId);
  const assignment = await data.findOne(DriverVehicleAssignment, { driverId: driver.driverId, active: true });
  const [vehicle, region] = await Promise.all([
    assignment ? data.findOne(Vehicle, { vehicleId: assignment.vehicleId }) : null,
    driver.operatingRegionId ? data.findOne(ServiceRegion, { regionId: driver.operatingRegionId }) : null
  ]);
  return evaluateAvailability({ driver, tenant, vehicle, region });
}

/** Express-style refusal for a failed check (403 with the reasons, so apps can show them). */
function refusal(result) {
  return { status: 403, body: { success: false, message: result.message, error: result.code, data: { code: result.code, reasons: result.reasons } } };
}

const validateRideSettings = (input = {}) => {
  const errors = {};
  const out = {};
  if ('requireEligibleDrivers' in input) {
    if (typeof input.requireEligibleDrivers !== 'boolean') errors.requireEligibleDrivers = 'Must be on or off';
    else out.requireEligibleDrivers = input.requireEligibleDrivers;
  }
  if (Object.keys(out).length === 0 && Object.keys(errors).length === 0) errors.requireEligibleDrivers = 'Nothing to update';
  return { value: out, errors };
};

module.exports = { DEFAULT_RIDE_SETTINGS, rideSettingsOf, evaluateAvailability, checkDriverAvailable, refusal, validateRideSettings };
