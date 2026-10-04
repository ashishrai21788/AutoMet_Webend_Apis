/**
 * Whether a driver may be offered rides. Pure and database-free so the future dispatch service can reuse it as it is.
 *
 * Account status, verification status and operational eligibility are three different things; eligibility is derived
 * from the other two plus the vehicle, and is never stored. A driver is eligible only when ALL of these hold:
 *   - the account is ACTIVE (not inactive, not suspended)
 *   - verification is APPROVED (all mandatory documents approved and unexpired)
 *   - an operating region is set and active
 *   - the driver has an active assignment to a vehicle that is ACTIVE, APPROVED (unexpired), not suspended,
 *     of the driver's eligible category (when one is set) and in the driver's region (when the vehicle has one)
 * Creating an account, or assigning a vehicle, never makes a driver eligible on its own.
 */
const { effectiveStoredStatus } = require('./verification');

const REASONS = {
  ACCOUNT_NOT_ACTIVE: 'The driver account is not active',
  DRIVER_NOT_VERIFIED: 'The driver is not verified',
  NO_REGION: 'The driver has no operating region',
  REGION_INACTIVE: 'The driver\'s operating region is not active',
  NO_VEHICLE: 'No vehicle is assigned',
  VEHICLE_NOT_ACTIVE: 'The assigned vehicle is not active',
  VEHICLE_NOT_VERIFIED: 'The assigned vehicle is not verified',
  CATEGORY_MISMATCH: 'The vehicle is not of the category this driver is eligible for',
  REGION_MISMATCH: 'The vehicle operates in a different region'
};

/**
 * @param {{ driver: object, vehicle: object|null, region: object|null, now?: Date }} input
 *   `vehicle` is the vehicle with an ACTIVE assignment to the driver, if any.
 * @returns {{ eligible: boolean, reasons: {code:string, message:string}[] }}
 */
function driverEligibility({ driver, vehicle, region, now = new Date() }) {
  const reasons = [];
  const add = (code) => reasons.push({ code, message: REASONS[code] });

  if ((driver.accountStatus || 'ACTIVE') !== 'ACTIVE') add('ACCOUNT_NOT_ACTIVE');
  if (effectiveStoredStatus({ verificationStatus: driver.driverVerificationStatus, verificationExpiresAt: driver.verificationExpiresAt }, now) !== 'APPROVED') add('DRIVER_NOT_VERIFIED');

  if (!driver.operatingRegionId) add('NO_REGION');
  else if (!region || !region.active) add('REGION_INACTIVE');

  if (!vehicle) {
    add('NO_VEHICLE');
  } else {
    if (vehicle.status !== 'ACTIVE') add('VEHICLE_NOT_ACTIVE');
    if (effectiveStoredStatus(vehicle, now) !== 'APPROVED') add('VEHICLE_NOT_VERIFIED');
    if (driver.eligibleCategoryId && vehicle.categoryId !== driver.eligibleCategoryId) add('CATEGORY_MISMATCH');
    if (vehicle.operatingRegionId && driver.operatingRegionId && vehicle.operatingRegionId !== driver.operatingRegionId) add('REGION_MISMATCH');
  }
  return { eligible: reasons.length === 0, reasons };
}

module.exports = { driverEligibility, ELIGIBILITY_REASONS: REASONS };
