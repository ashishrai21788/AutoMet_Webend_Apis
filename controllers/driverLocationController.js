const { createModel } = require('../models/dynamicModel');
const { effectiveTenantId, tenantForAccount } = require('../lib/appTenant');
const { matchRegion, hasGeofence } = require('../lib/regionMatch');
const { regionsFor } = require('../lib/regionCache');
const { checkDriverAvailable } = require('../lib/driverAvailability');
const { config, validateHeartbeat, locationUpdate } = require('../lib/driverLocation');

const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, data: null, ...extra });

/**
 * POST /api/drivers/location
 * The driver app calls this every few seconds while online. The driver is the signed-in one (the token decides, the
 * body's driverId is only used when sign-in checks are switched off for development). The server keeps the last
 * position, works out which service region it is in, and answers with what the app should do next.
 */
exports.heartbeat = async (req, res) => {
  try {
    const driverId = String(req.authActorId || (req.body && req.body.driverId) || '').trim();
    if (!driverId) return fail(res, 400, 'Missing required field: driverId');

    const cfg = config();
    const { value, errors } = validateHeartbeat(req.body, cfg);
    if (errors) {
      // an imprecise fix is not a client bug: the app should keep sending and wait for a better one
      const retry = !!errors.accuracy && Object.keys(errors).length === 1;
      return res.status(retry ? 422 : 400).json({ success: false, message: retry ? errors.accuracy : 'Invalid location', errors, error: retry ? 'LOCATION_TOO_INACCURATE' : undefined, data: null });
    }

    const Driver = createModel('drivers');
    const driver = await Driver.findOne({ driverId }).lean();
    if (!driver) return fail(res, 404, 'Driver not found');

    // an app that names its business can only report for that business's drivers
    if (req.headers['x-app-id'] && req.appTenant && (await effectiveTenantId(driver)) !== req.appTenant.tenantId) {
      return fail(res, 403, 'This account belongs to another app.', { error: 'WRONG_APP' });
    }

    // a suspended or inactive driver is not tracked, and is taken offline (the same rule as the go-online check)
    if ((driver.accountStatus || 'ACTIVE') !== 'ACTIVE') {
      if (driver.isOnline) await Driver.updateOne({ driverId }, { $set: { isOnline: false } });
      return fail(res, 403, `Your account is ${String(driver.accountStatus).toLowerCase()}, so your location is not being shared.`, { error: 'DRIVER_ACCOUNT_NOT_ACTIVE', shouldGoOffline: true });
    }

    const tenant = await tenantForAccount(driver);
    const regions = tenant ? await regionsFor(tenant.tenantId) : [];
    const match = matchRegion(regions, { lat: value.lat, lng: value.lng });
    const now = new Date();
    await Driver.updateOne({ driverId }, { $set: locationUpdate(value, { regionId: match ? match.region.regionId : null, now }) });

    const gate = await checkDriverAvailable(driver);
    return res.status(200).json({
      success: true,
      message: 'Location received',
      data: {
        serverTime: now.toISOString(),
        nextHeartbeatSeconds: cfg.nextHeartbeatSeconds,
        freshSeconds: cfg.freshSeconds,
        isOnline: !!driver.isOnline,
        region: match ? { regionId: match.region.regionId, city: match.region.city, zoneName: match.region.zoneName } : null,
        // null when the business has not drawn any service area, so there is nothing to be outside of
        inServiceArea: hasGeofence(regions) ? !!match : null,
        available: { ok: !!gate.available, code: gate.available ? null : gate.code || null, message: gate.available ? null : gate.message || null }
      }
    });
  } catch (e) {
    console.error('[driver-location] heartbeat failed:', e.message);
    return fail(res, 500, 'Could not record the location. Please try again.');
  }
};
