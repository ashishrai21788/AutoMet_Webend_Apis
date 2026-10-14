/**
 * What the driver app is told about the driver's onboarding.
 *
 * The driver app decides which screen to show (vehicle form, document upload, "under review", rejected, or Home) from
 * three flags in the driver record: isVehicleAdded, isDocumentsUploaded and verification_status. Those were set by the
 * driver's own self-onboarding. For a driver the business manages (it set the operating region and the category in the
 * dashboard, assigns the vehicle and approves the documents), the truth is in the business's records, so the flags are
 * derived from them: the same eligibility the server uses before it offers a ride (lib/eligibility.js).
 *
 *   eligible                      -> APPROVED          (the app opens Home)
 *   not eligible, verification
 *     rejected / expired          -> REJECTED          (the app shows the rejected screen)
 *   otherwise                     -> UNDER_REVIEW      (the app shows the waiting screen, with the reasons)
 *
 * The vehicle and documents steps are always reported as done for a managed driver: the app has nothing to fill in,
 * the business does it. The reasons travel in `onboarding.reasons` so the waiting screen can say what is missing.
 */
const MANAGED_REJECTED = new Set(['REJECTED', 'EXPIRED']);

/** A driver the business manages: it gave them an operating region or a category. */
const isManagedByBusiness = (driver) => !!(driver && (driver.eligibleCategoryId || driver.operatingRegionId));

/**
 * @param {{ driver: object, availability: { eligibility?: { eligible: boolean, reasons: {code:string,message:string}[] } } }} input
 * @returns {{ flags: { isVehicleAdded: boolean, isDocumentsUploaded: boolean, verification_status: string }, onboarding: object } | null}
 *   null for a driver approved under the old self-onboarding in a business that does not enforce eligibility
 */
function deriveOnboarding({ driver, availability }) {
  // An existing driver who was approved under the old self-onboarding, in a business that does not enforce eligibility,
  // keeps working exactly as before. Everyone else (managed by the business, or still onboarding) follows the records.
  const legacyApproved = String(driver.verification_status || '').toUpperCase() === 'APPROVED' && !!driver.isVehicleAdded && !!driver.isDocumentsUploaded;
  const enforced = !!(availability && availability.enforced);
  if (!isManagedByBusiness(driver) && legacyApproved && !enforced) return null;
  const eligibility = (availability && availability.eligibility) || { eligible: false, reasons: [] };
  const reasons = eligibility.reasons || [];

  let status = 'UNDER_REVIEW';
  if (eligibility.eligible) status = 'APPROVED';
  else if (MANAGED_REJECTED.has(String(driver.driverVerificationStatus || '').toUpperCase())) status = 'REJECTED';

  return {
    flags: { isVehicleAdded: true, isDocumentsUploaded: true, verification_status: status },
    onboarding: {
      managed_by_business: true,
      eligible: !!eligibility.eligible,
      status,
      reasons: reasons.map((r) => ({ code: r.code, message: r.message }))
    }
  };
}

/** The driver objects inside a response body: data itself, data.driver, or each of a list. */
function driverObjectsIn(body) {
  const out = [];
  const data = body && body.data;
  if (!data || typeof data !== 'object') return out;
  const add = (o) => { if (o && typeof o === 'object' && o.driverId && ('isVehicleAdded' in o || 'verification_status' in o || 'phone' in o)) out.push(o); };
  add(data);
  add(data.driver);
  return out;
}

/**
 * Express middleware: rewrites the driver object in the JSON response with the derived flags. A failure never blocks
 * the response; the original body is sent.
 */
function driverOnboardingResponse(loadDriver, loadAvailability) {
  return (req, res, next) => {
    const original = res.json.bind(res);
    res.json = (body) => {
      const targets = driverObjectsIn(body);
      if (!targets.length) return original(body);
      Promise.all(targets.map(async (target) => {
        const driver = await loadDriver(target.driverId);
        if (!driver) return;
        const availability = await loadAvailability(driver);
        const derived = deriveOnboarding({ driver, availability });
        if (!derived) return;
        Object.assign(target, derived.flags, { onboarding: derived.onboarding });
      }))
        .catch((e) => console.warn('[driverOnboarding] could not derive onboarding:', e.message))
        .finally(() => original(body));
      return res;
    };
    next();
  };
}

/** The middleware wired to the real driver and availability lookups (loaded lazily to avoid import cycles). */
function businessOnboardingResponse() {
  return driverOnboardingResponse(
    async (driverId) => require('../models/dynamicModel').createModel('drivers').findOne({ driverId: String(driverId) }).lean(),
    async (driver) => require('./driverAvailability').checkDriverAvailable(driver)
  );
}

module.exports = { deriveOnboarding, isManagedByBusiness, driverObjectsIn, driverOnboardingResponse, businessOnboardingResponse };
