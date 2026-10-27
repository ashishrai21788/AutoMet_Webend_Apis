const { createModel } = require('../models/dynamicModel');
const { TripDetails } = require('../models/tripDetailsModel');
const { getNextTripId } = require('../models/tripCounterModel');
const { isFcmReady } = require('../config/firestore');
const { emitToDriver, emitToUser } = require('../config/socket');
const { buildImmediateCreateResponse } = require('../lib/createRequestMode');
const { isDriverReachable, getDriverFcmInfo, sendRideRequestPushWithRetry } = require('../lib/fcmTripPush');
const { offerExtras } = require('../lib/rideOffer');
const { sendPushToDriver, sendPushToUser } = require('../lib/pushNotification');
const { priceTrip, priceTripWithCoupon, withSurge, loadPricingConfig } = require('../lib/tripPricing');
const coupons = require('../lib/coupons');
const { sameBusiness, tenantForAccount } = require('../lib/appTenant');
const { checkDriverAvailable, refusal } = require('../lib/driverAvailability');
const { findDriverConflict, COMMITTED_STATUSES } = require('../lib/driverBusy');
const { dispatchConfig, rankCandidates, canReoffer, etaMinutes } = require('../lib/dispatch');
const { matchRegion, hasGeofence } = require('../lib/regionMatch');

const DRIVER_RESPONSE_TIMEOUT_MS = (Number(process.env.TRIP_DRIVER_RESPONSE_TIMEOUT_SECONDS) || 60) * 1000;
const ACTIVE_STATUSES = ['REQUESTED', 'ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];

async function notifyDriverRideTimeout(driverId, tripId, requestId) {
  if (!driverId) return;
  try {
    emitToDriver(driverId, 'ride_request_timeout', {
      trip_id: tripId,
      request_id: requestId || null,
      status: 'NO_RESPONSE',
      message: 'Ride timed out'
    });
  } catch (e) {
    if (process.env.NODE_ENV === 'development') console.warn('[notifyDriverRideTimeout] Socket emit failed:', e.message);
  }
  const result = await sendPushToDriver(driverId, {
    title: 'Ride timed out',
    body: 'The ride request has expired. You can hide the accept/reject view.',
    channelId: 'driver_notifications',
    data: {
      type: 'ride_request_timeout',
      trip_id: tripId,
      request_id: requestId || '',
      status: 'NO_RESPONSE'
    },
    dataOnly: true
  });
  if (!result.success) console.warn('[notifyDriverRideTimeout] FCM failed:', result.error, { driverId });
}

/**
 * Send FCM notification to the requesting user when driver accepts or rejects.
 * Includes ride details in the payload.
 */
async function notifyUserDriverResponse(userId, trip, status, message, rejectReason) {
  if (!userId) return;
  const pickupAddress = (trip.pickup && trip.pickup.address) ? trip.pickup.address : '';
  const dropAddress = (trip.drop && trip.drop.address) ? trip.drop.address : '';
  const isAccepted = status === 'ACCEPTED';
  const title = isAccepted ? 'Ride accepted' : 'Ride rejected';
  const body = isAccepted
    ? `Driver accepted your ride: ${pickupAddress} → ${dropAddress}`
    : (rejectReason ? `Driver declined: ${rejectReason}` : `Driver declined your ride: ${pickupAddress} → ${dropAddress}`);
  const data = {
    type: isAccepted ? 'ride_request_accepted' : 'ride_request_rejected',
    trip_id: trip.trip_id,
    request_id: trip.request_id || '',
    status,
    message: message || (isAccepted ? 'Driver accepted your request' : 'Driver rejected the request'),
    pickup_address: pickupAddress,
    drop_address: dropAddress,
    driver_id: trip.driver_id || '',
    reject_reason: rejectReason || ''
  };
  if (trip.pickup && (trip.pickup.lat != null || trip.pickup.lng != null)) {
    data.pickup_lat = String(trip.pickup.lat);
    data.pickup_lng = String(trip.pickup.lng);
  }
  if (trip.drop && (trip.drop.lat != null || trip.drop.lng != null)) {
    data.drop_lat = String(trip.drop.lat);
    data.drop_lng = String(trip.drop.lng);
  }
  if (trip.ride_note) data.ride_note = trip.ride_note;
  const result = await sendPushToUser(userId, {
    title,
    body,
    channelId: 'user_notifications',
    data,
    dataOnly: true
  });
  if (!result.success) console.warn('[notifyUserDriverResponse] FCM failed:', result.error, { userId });
}

async function notifyUserRideTimeout(userId, trip) {
  if (!userId || !trip) return;
  const pickupAddress = (trip.pickup && trip.pickup.address) ? trip.pickup.address : '';
  const dropAddress = (trip.drop && trip.drop.address) ? trip.drop.address : '';
  const result = await sendPushToUser(userId, {
    title: 'No response from driver',
    body: `No response for your ride request: ${pickupAddress} → ${dropAddress}`,
    channelId: 'user_notifications',
    data: {
      type: 'ride_request_timeout',
      trip_id: trip.trip_id,
      request_id: trip.request_id || '',
      status: 'NO_RESPONSE',
      message: 'No response from driver',
      pickup_address: pickupAddress,
      drop_address: dropAddress,
      driver_id: trip.driver_id || ''
    },
    dataOnly: true
  });
  if (!result.success) console.warn('[notifyUserRideTimeout] FCM failed:', result.error, { userId });
}

function isValidLat(lat) {
  return typeof lat === 'number' && !Number.isNaN(lat) && lat >= -90 && lat <= 90;
}
function isValidLng(lng) {
  return typeof lng === 'number' && !Number.isNaN(lng) && lng >= -180 && lng <= 180;
}

function normalizeDriverResponse(value) {
  if (typeof value === 'boolean') return value ? 'ACCEPTED' : 'REJECTED';
  const normalized = (value != null ? String(value) : '').trim().toUpperCase();
  if (!normalized) return '';
  if (['ACCEPT', 'ACCEPTED', 'YES', 'Y', 'TRUE'].includes(normalized)) return 'ACCEPTED';
  if (['REJECT', 'REJECTED', 'DECLINE', 'DECLINED', 'NO', 'N', 'FALSE'].includes(normalized)) return 'REJECTED';
  if (normalized === 'REJECTED_WITH_REASON') return 'REJECTED_WITH_REASON';
  return normalized;
}

function buildTripMessageByStatus(status) {
  if (status === 'ACCEPTED') return 'Driver accepted your request';
  if (status === 'DRIVER_ON_THE_WAY') return 'Driver is on the way';
  if (status === 'ARRIVED') return 'Driver has arrived';
  if (status === 'ON_GOING') return 'Trip started';
  if (status === 'COMPLETED') return 'Trip completed';
  if (status === 'REJECTED' || status === 'REJECTED_WITH_REASON') return 'Driver rejected the request';
  if (status === 'NO_RESPONSE') return 'No response from driver';
  if (status === 'CANCELLED_BY_USER' || status === 'CANCELLED_BY_USER_AFTER_ACCEPTANCE') return 'Ride was cancelled by user';
  return `Trip already processed with status ${status}`;
}

/**
 * POST /api/v1/trips/create-request
 * Create trip in trip_details, notify driver, wait up to 60s for response, return final status.
 */
/**
 * The nearest driver who can be offered this ride right now (automatic dispatch), or null.
 * Candidates are the rider's business's online drivers, nearest first (lib/dispatch.js); the first one that is reachable,
 * allowed to take rides and free of another ride wins. `exclude` holds drivers already offered this request.
 */
async function findAutoDriver(user, pickup, { exclude = [], vehicleType, categoryId } = {}) {
  const DriverModel = createModel('drivers');
  let categoryName;
  if (categoryId) {
    const config = await loadPricingConfig(await tenantForAccount(user));
    const category = config.categories.find((c) => c.categoryId === categoryId);
    categoryName = category ? category.name : undefined;
  }
  const online = await DriverModel.find({ isOnline: true }).limit(500).lean();
  const sameShop = [];
  for (const d of online) {
    if (await sameBusiness(user, d)) sameShop.push(d);
  }
  const ranked = rankCandidates(sameShop, pickup, { exclude, vehicleType, categoryId, categoryName });
  for (const { driver, distanceKm } of ranked) {
    if (!isDriverReachable(driver).reachable) continue;
    if (await findDriverConflict(TripDetails, driver.driverId, { includePending: true })) continue;
    if (!(await checkDriverAvailable(driver)).available) continue;
    return { driver, distanceKm };
  }
  return null;
}

/**
 * POST /api/v1/trips/nearby-drivers  { latitude, longitude }
 * The positions of this business's available drivers around a point, for the rider's map. It carries no driver
 * identity: only where a vehicle is, which kind it is and which way it faces. Drivers who are busy, offline or
 * whose position is stale are left out, so every marker is a vehicle that could actually be offered the ride.
 */
exports.nearbyDrivers = async (req, res) => {
  try {
    const body = req.body || {};
    const centre = { lat: Number(body.latitude), lng: Number(body.longitude) };
    if (!isValidLat(centre.lat) || !isValidLng(centre.lng)) {
      return res.status(400).json({ success: false, message: 'Valid latitude and longitude are required.' });
    }
    const user = req.user;
    const online = await createModel('drivers').find({ isOnline: true }).limit(500).lean();
    const sameShop = [];
    for (const d of online) {
      if (!user || (await sameBusiness(user, d))) sameShop.push(d);
    }
    const busyIds = new Set();
    if (sameShop.length) {
      const busy = await TripDetails.find({
        driver_id: { $in: sameShop.map((d) => d.driverId) },
        status: { $in: ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'] }
      }).select('driver_id').lean();
      busy.forEach((t) => busyIds.add(t.driver_id));
    }
    const cfg = dispatchConfig();
    const free = sameShop.filter((d) => !busyIds.has(d.driverId));
    // each category's map icon (a business-uploaded top view), so the app can draw the right vehicle
    const iconByCategory = {};
    try {
      const tenant = user ? await tenantForAccount(user) : req.appTenant || null;
      (await loadPricingConfig(tenant)).categories.forEach((c) => { if (c.mapIconUrl) iconByCategory[c.categoryId] = c.mapIconUrl; });
    } catch (_) { /* icons are optional */ }
    // the rider's map shows what is close by: 1 km unless the app asks for another radius (0.2 to 5 km)
    const asked = Number(body.radius_km);
    const radiusKm = Number.isFinite(asked) && asked > 0 ? Math.min(Math.max(asked, 0.2), 5) : Math.max(cfg.radiusKm, 5);
    const near = rankCandidates(free, centre, { radiusKm })
      .filter((c) => Number.isFinite(c.distanceKm))
      .slice(0, 30);
    const vehicles = near.map(({ driver, distanceKm }) => {
      const c = driver.lastLocation.coordinates;
      return {
        lat: Math.round(c[1] * 1e5) / 1e5,
        lng: Math.round(c[0] * 1e5) / 1e5,
        heading: Number.isFinite(Number(driver.locationHeading)) ? Number(driver.locationHeading) : null,
        category_id: driver.eligibleCategoryId || null,
        vehicle_type: driver.vehicleType || null,
        map_icon_url: iconByCategory[driver.eligibleCategoryId] || null,
        distance_km: Math.round(distanceKm * 10) / 10
      };
    });
    return res.status(200).json({ success: true, message: 'Nearby drivers', data: { count: vehicles.length, vehicles } });
  } catch (error) {
    console.error('[trips nearby-drivers]', error);
    return res.status(500).json({ success: false, message: 'Failed to load nearby drivers' });
  }
};

/** The push payload the driver app shows as "New Ride Request", built from a stored trip. */
function ridePushPayload(trip, riderName, extras = {}) {
  return {
    ...extras,
    request_id: trip.request_id,
    pickup_address: trip.pickup.address,
    drop_address: trip.drop.address,
    pickup_lat: trip.pickup.lat,
    pickup_lng: trip.pickup.lng,
    drop_lat: trip.drop.lat,
    drop_lng: trip.drop.lng,
    ride_note: trip.ride_note || '',
    rider_name: riderName || '',
    distance: String(trip.distance_km),
    estimated_duration: String(trip.estimated_duration_min),
    fare: String(trip.fare),
    currency: trip.currency,
    payment_mode: trip.payment_mode || 'CASH',
    // a coupon the business funds is paid to the driver on top of what the rider pays (major units), so the offer can show the true amount
    coupon_covered: String(require('../lib/driverEarnings').couponCoveredMajor(trip))
  };
}

/**
 * Moves an automatically dispatched request that its driver rejected or ignored on to the next nearest driver.
 * Returns true when another driver now holds the offer (the rider keeps waiting), false when it cannot be re-offered
 * (not automatic, attempts used up, or nobody else is available), in which case the caller ends the request as usual.
 * The move is a conditional write on the current driver, so a late answer, a cancellation or a second server instance
 * cannot be overwritten or applied twice.
 */
async function reofferTrip(trip, now = new Date()) {
  const cfg = dispatchConfig();
  let current = trip;
  while (canReoffer(current, cfg)) {
    const user = await createModel('users').findOne({ userId: current.user_id }).lean();
    if (!user) return false;
    const previous = await createModel('drivers').findOne({ driverId: current.driver_id }).select('vehicleType').lean();
    const attempted = Array.from(new Set([...(current.dispatch_attempted || []), current.driver_id]));
    const next = await findAutoDriver(user, { lat: current.pickup.lat, lng: current.pickup.lng }, {
      exclude: attempted,
      categoryId: current.category_id || undefined,
      vehicleType: current.category_id ? undefined : previous && previous.vehicleType
    });
    if (!next) return false;

    const nextId = next.driver.driverId;
    const claimed = await TripDetails.findOneAndUpdate(
      { trip_id: current.trip_id, status: 'REQUESTED', driver_id: current.driver_id },
      { $set: {
        driver_id: nextId,
        dispatch_attempted: [...attempted, nextId],
        dispatch_attempts: (current.dispatch_attempts || 0) + 1,
        timeout_at: new Date(now.getTime() + cfg.offerSeconds * 1000),
        driver_response: null,
        push_sent: false,
        updated_at: now
      } },
      { new: true }
    );
    if (!claimed) return true; // answered, cancelled or moved by someone else in the meantime: not ours to end
    if (current.driver_id !== nextId) notifyDriverRideTimeout(current.driver_id, claimed.trip_id, claimed.request_id).catch(() => {});

    const { fcmToken } = getDriverFcmInfo(next.driver);
    const riderName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.fullName || null;
    const extras = await offerExtras(claimed, next.driver);
    const push = await sendRideRequestPushWithRetry(fcmToken, claimed.trip_id, ridePushPayload(claimed, riderName, extras), {
      DriverModel: createModel('drivers'), driverId: nextId
    });
    if (push.success) {
      await TripDetails.updateOne({ trip_id: claimed.trip_id }, { $set: { push_sent: true, push_sent_at: now, push_status: 'DELIVERED' } });
      emitToDriver(nextId, 'ride_request_received', {
        trip_id: claimed.trip_id, request_id: claimed.request_id, user_id: claimed.user_id, driver_id: nextId,
        pickup: claimed.pickup, drop: claimed.drop, ride_note: claimed.ride_note,
        requested_at: claimed.requested_at, timeout_at: claimed.timeout_at
      });
      return true;
    }
    current = claimed; // the push failed: try the next driver straight away
  }
  return false;
}
exports.reofferTrip = reofferTrip;

exports.createRequest = async (req, res) => {
  try {
    const body = req.body || {};
    const requestId = body.request_id != null ? String(body.request_id).trim() : '';
    const userId = body.user_id != null ? String(body.user_id).trim() : '';
    let driverId = body.driver_id != null ? String(body.driver_id).trim() : '';
    // No driver_id means automatic dispatch: the server picks the nearest free driver (lib/dispatch.js).
    const autoDispatch = !driverId;
    const pickupAddress = body.pickup_address != null ? String(body.pickup_address).trim() : '';
    const pickupLat = body.pickup_latitude;
    const pickupLng = body.pickup_longitude;
    const dropAddress = body.drop_address != null ? String(body.drop_address).trim() : '';
    const dropLat = body.drop_latitude;
    const dropLng = body.drop_longitude;
    const rideNote = body.ride_note != null ? String(body.ride_note).trim() : null;
    // the ride type the rider chose (a vehicle category of their business); priced and dispatched by that category
    const requestedCategoryId = body.category_id != null ? String(body.category_id).trim() : '';

    if (!requestId || !userId || !pickupAddress || !dropAddress) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: request_id, user_id, pickup_address, drop_address'
      });
    }
    if (!isValidLat(pickupLat) || !isValidLng(pickupLng)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pickup coordinates (latitude -90 to 90, longitude -180 to 180).'
      });
    }
    if (!isValidLat(dropLat) || !isValidLng(dropLng)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid drop coordinates.'
      });
    }
    if (Math.abs(pickupLat - dropLat) < 1e-6 && Math.abs(pickupLng - dropLng) < 1e-6) {
      return res.status(400).json({
        success: false,
        message: 'Pickup and drop locations must be different.'
      });
    }

    const UserModel = createModel('users');
    const DriverModel = createModel('drivers');
    const user = await UserModel.findOne({ userId }).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found', data: { user_id: userId } });
    }
    if (autoDispatch) {
      // one search at a time per rider
      const mine = await TripDetails.findOne({ user_id: userId, status: { $in: ACTIVE_STATUSES } });
      if (mine) {
        return res.status(409).json({
          success: false,
          message: 'You already have a ride in progress.',
          data: { trip_id: mine.trip_id, request_id: mine.request_id, status: mine.status }
        });
      }
      const wantedType = body.vehicle_type != null ? String(body.vehicle_type).trim() : '';
      const found = await findAutoDriver(user, { lat: pickupLat, lng: pickupLng }, {
        vehicleType: wantedType || undefined,
        categoryId: requestedCategoryId || undefined
      });
      if (!found) {
        return res.status(404).json({
          success: false,
          message: 'No drivers are available near you right now. Please try again in a moment.',
          error: 'NO_DRIVERS_AVAILABLE',
          data: { code: 'NO_DRIVERS_AVAILABLE' }
        });
      }
      driverId = found.driver.driverId;
    }
    const driver = await DriverModel.findOne({ driverId }).lean();
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found', data: { driver_id: driverId } });
    }
    if (!driver.isOnline) {
      return res.status(400).json({
        success: false,
        message: 'Driver is not online. Cannot send ride request.',
        data: { driver_id: driverId }
      });
    }

    if (user && user.accountStatus === 'SUSPENDED') {
      return res.status(403).json({ success: false, message: 'Your account is suspended. Please contact support.', error: 'ACCOUNT_SUSPENDED', data: null });
    }
    // A rider can only request a driver of the same business, and the fare comes from that business's own rules.
    if (!(await sameBusiness(user, driver))) {
      return res.status(403).json({ success: false, message: 'This driver is not available for your app.', data: { driver_id: driverId } });
    }
    const gate = await checkDriverAvailable(driver);
    if (!gate.available) {
      return res.status(409).json({ success: false, message: 'This driver is not available for rides right now.', error: gate.code, data: { driver_id: driverId, code: gate.code } });
    }
    const tenant = await tenantForAccount(user);
    const couponCode = body.coupon_code != null ? String(body.coupon_code).trim() : '';
    const pricing = await priceTripWithCoupon(await loadPricingConfig(tenant), {
      pickup: { lat: pickupLat, lng: pickupLng },
      drop: { lat: dropLat, lng: dropLng },
      vehicleType: driver.vehicleType,
      categoryId: requestedCategoryId || undefined
    }, { tenant, userId, code: couponCode, surge: { mode: 'book', loadFreeDrivers: () => freeDriversOf(user) } });
    if (!pricing.ok) {
      return res.status(pricing.status).json({ success: false, message: pricing.message, error: pricing.code, data: { driver_id: driverId } });
    }
    // a coupon that does not apply stops the booking: the rider is never charged the full fare behind their back
    if (couponCode && !(pricing.coupon && pricing.coupon.applied)) {
      return res.status(422).json({ success: false, message: pricing.coupon ? pricing.coupon.message : 'That coupon is not valid.', error: 'COUPON_INVALID', data: { coupon_code: couponCode, code: pricing.coupon && pricing.coupon.code_error } });
    }
    const estimate = pricing.estimate;

    // one live ride per rider, whichever driver it is with (the auto-dispatch path above has the same rule)
    const riderBusy = await TripDetails.findOne({ user_id: userId, status: { $in: ACTIVE_STATUSES } });
    if (riderBusy) {
      return res.status(409).json({
        success: false,
        message: 'You already have a ride in progress.',
        data: { trip_id: riderBusy.trip_id, request_id: riderBusy.request_id, status: riderBusy.status }
      });
    }
    const duplicate = await TripDetails.findOne({
      user_id: userId,
      driver_id: driverId,
      status: { $in: ACTIVE_STATUSES }
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'An active trip request already exists for this user and driver.',
        data: { trip_id: duplicate.trip_id, request_id: duplicate.request_id, status: duplicate.status }
      });
    }

    // A driver is offered one ride at a time: refuse while they are on another trip or another rider's request is pending.
    const driverConflict = await findDriverConflict(TripDetails, driverId, { includePending: true });
    if (driverConflict) {
      return res.status(409).json({
        success: false,
        message: 'This driver is busy with another ride. Please choose another driver.',
        error: 'DRIVER_BUSY',
        data: { code: 'DRIVER_BUSY', driver_id: driverId }
      });
    }

    const existingRequestId = await TripDetails.findOne({ request_id: requestId }).lean();
    if (existingRequestId) {
      return res.status(409).json({
        success: false,
        message: 'A trip request with this request_id already exists.',
        data: { request_id: requestId, trip_id: existingRequestId.trip_id, status: existingRequestId.status }
      });
    }

    const now = new Date();

    const reachable = isDriverReachable(driver);
    if (!reachable.reachable) {
      return res.status(200).json({
        success: false,
        message: 'Driver is currently unreachable. Please try another driver.'
      });
    }

    if (!isFcmReady()) {
      console.error('[trips createRequest] FCM not configured — cannot send ride request notification. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_KEY.');
      return res.status(503).json({
        success: false,
        message: 'Ride notifications are unavailable (server push not configured). Contact support or try again later.',
        error: 'FCM_NOT_CONFIGURED'
      });
    }

    const { fcmToken: driverFcmToken } = getDriverFcmInfo(driver);
    const tripId = await getNextTripId();
    const timeoutAt = new Date(now.getTime() + (autoDispatch ? dispatchConfig().offerSeconds * 1000 : DRIVER_RESPONSE_TIMEOUT_MS));

    // Create trip in DB BEFORE sending push so driver-response finds it
    const trip = await TripDetails.create({
      trip_id: tripId,
      request_id: requestId,
      user_id: userId,
      driver_id: driverId,
      pickup: { address: pickupAddress, lat: pickupLat, lng: pickupLng },
      drop: { address: dropAddress, lat: dropLat, lng: dropLng },
      ride_note: rideNote || undefined,
      fare: estimate.fare,
      currency: estimate.currency,
      distance_km: estimate.distance_km,
      estimated_duration_min: estimate.duration_min,
      fare_basis: estimate.fare_basis,
      fare_source: estimate.fare_source,
      fare_breakdown: estimate.breakdown || null,
      pricing_version: estimate.pricing_version ?? null,
      pricing_rule: estimate.pricing_rule || null,
      coupon: pricing.coupon && pricing.coupon.applied ? { code: pricing.coupon.couponDoc.code, coupon_id: pricing.coupon.couponDoc.couponId, discount_minor: pricing.coupon.discountMinor, funded_by: pricing.coupon.couponDoc.fundedBy || 'BUSINESS' } : null,
      region_id: estimate.region_id || null,
      category_id: estimate.category_id || null,
      tenant_id: tenant ? tenant.tenantId : null,
      payment_mode: 'CASH',
      status: 'REQUESTED',
      dispatch_mode: autoDispatch ? 'AUTO' : 'MANUAL',
      dispatch_attempted: [driverId],
      dispatch_attempts: 1,
      requested_at: now,
      timeout_at: timeoutAt,
      push_sent: false
    });

    {
      // The one-search-per-rider check above and this insert are not atomic: two taps at the same instant can both pass it.
      // (every booking path, whether the rider picked a driver or the server does)
      // Keep the earliest request and withdraw this one before the driver is told about it.
      const live = await TripDetails.find({ user_id: userId, status: { $in: ACTIVE_STATUSES } }).lean();
      const earlier = (live || []).filter((t) => t.trip_id !== trip.trip_id)
        .sort((a, b) => new Date(a.requested_at) - new Date(b.requested_at) || String(a.trip_id).localeCompare(String(b.trip_id)))[0];
      const mineFirst = !earlier || new Date(earlier.requested_at) > new Date(trip.requested_at)
        || (new Date(earlier.requested_at).getTime() === new Date(trip.requested_at).getTime() && String(earlier.trip_id) > String(trip.trip_id));
      if (!mineFirst) {
        await TripDetails.updateOne({ trip_id: trip.trip_id, status: 'REQUESTED' }, { $set: { status: 'CANCELLED_BY_USER', cancelled_at: new Date(), cancellation_reason: 'Duplicate request', updated_at: new Date() } });
        return res.status(409).json({
          success: false,
          message: 'You already have a ride in progress.',
          data: { trip_id: earlier.trip_id, request_id: earlier.request_id, status: earlier.status }
        });
      }
    }

    {
      // The "driver is busy" check above and the insert are not atomic either: riders asking at the same instant can all pass it
      // and the driver would hold several offers. A ride the driver already committed to always wins, otherwise the earliest
      // pending request does; the others are withdrawn before the driver is told about them.
      const claims = await TripDetails.find({ driver_id: driverId, status: { $in: ['REQUESTED', ...COMMITTED_STATUSES] } }).lean();
      const stamp = (t) => new Date(t.requested_at).getTime();
      const wins = (a, b) => (a.status !== 'REQUESTED') !== (b.status !== 'REQUESTED')
        ? a.status !== 'REQUESTED'
        : (stamp(a) !== stamp(b) ? stamp(a) < stamp(b) : String(a.trip_id) < String(b.trip_id));
      const beaten = (claims || []).some((t) => t.trip_id !== trip.trip_id && !(t.status === 'REQUESTED' && new Date(t.timeout_at) <= now) && wins(t, trip));
      if (beaten) {
        await TripDetails.updateOne({ trip_id: trip.trip_id, status: 'REQUESTED' }, { $set: { status: 'CANCELLED_BY_USER', cancelled_at: new Date(), cancellation_reason: 'Driver took another request', updated_at: new Date() } });
        return res.status(409).json({
          success: false,
          message: 'This driver is busy with another ride. Please choose another driver.',
          error: 'DRIVER_BUSY',
          data: { code: 'DRIVER_BUSY', driver_id: driverId }
        });
      }
    }

    // Take the coupon's use now that the booking exists. The limits are conditional counter updates, so the last use goes to one
    // booking only; a booking that lost the race is withdrawn before the driver hears about it.
    if (pricing.coupon && pricing.coupon.applied) {
      const taken = await coupons.reserve({ tenantId: tenant.tenantId, coupon: pricing.coupon.couponDoc, userId, tripId: trip.trip_id, discountMinor: pricing.coupon.discountMinor, currency: estimate.currency });
      if (!taken.ok) {
        await TripDetails.updateOne({ trip_id: trip.trip_id, status: 'REQUESTED' }, { $set: { status: 'CANCELLED_BY_USER', cancelled_at: new Date(), cancellation_reason: 'Coupon no longer available', updated_at: new Date() } });
        return res.status(422).json({ success: false, message: taken.message, error: 'COUPON_INVALID', data: { coupon_code: couponCode, code: taken.code } });
      }
    }

    const riderName = user
      ? [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.fullName || null
      : null;
    const pushPayload = {
      request_id: requestId,
      pickup_address: pickupAddress,
      drop_address: dropAddress,
      pickup_lat: pickupLat,
      pickup_lng: pickupLng,
      drop_lat: dropLat,
      drop_lng: dropLng,
      ride_note: rideNote || '',
      rider_name: riderName || '',
      // Shown on the driver's "New Ride Request" sheet (distance in km, duration in minutes).
      distance: String(estimate.distance_km),
      estimated_duration: String(estimate.duration_min),
      fare: String(estimate.fare),
      currency: estimate.currency,
      payment_mode: 'CASH',
      ...(await offerExtras(trip, driver))
    };
    const pushResult = await sendRideRequestPushWithRetry(
      driverFcmToken,
      tripId,
      pushPayload,
      { DriverModel, driverId }
    );

    if (!pushResult.success) {
      console.warn('[trips createRequest] FCM ride request push failed:', pushResult.error, {
        driverId,
        invalidToken: pushResult.invalidToken
      });
      // Clean up the trip since we couldn't notify the driver
      await TripDetails.deleteOne({ trip_id: tripId });
      return res.status(200).json({
        success: false,
        message: 'Unable to send request to driver. Please try another driver.'
      });
    }

    // Update trip with push delivery info
    await TripDetails.updateOne(
      { trip_id: tripId },
      { $set: { push_sent: true, push_message_id: pushResult.messageId || undefined, push_sent_at: now, push_status: 'DELIVERED' } }
    );

    const tripPayload = {
      trip_id: tripId,
      request_id: requestId,
      user_id: userId,
      driver_id: driverId,
      pickup: trip.pickup,
      drop: trip.drop,
      ride_note: trip.ride_note,
      requested_at: trip.requested_at,
      timeout_at: trip.timeout_at
    };
    emitToDriver(driverId, 'ride_request_received', tripPayload);

    return res.status(201).json(buildImmediateCreateResponse({
      tripId,
      requestId,
      timeoutAt: timeoutAt.toISOString(),
      estimate
    }));
  } catch (error) {
    console.error('[trips createRequest]', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create trip request'
    });
  }
};

/**
 * POST /api/v1/trips/estimate
 * Body: pickup_latitude, pickup_longitude, drop_latitude, drop_longitude, and optionally driver_id (the fare then uses
 * that driver's vehicle type) or vehicle_type. Returns the same fare the trip will be created with.
 * Nothing is stored; it only calculates.
 */
exports.estimate = async (req, res) => {
  try {
    const body = req.body || {};
    const pickupLat = Number(body.pickup_latitude);
    const pickupLng = Number(body.pickup_longitude);
    const dropLat = Number(body.drop_latitude);
    const dropLng = Number(body.drop_longitude);
    if (!isValidLat(pickupLat) || !isValidLng(pickupLng) || !isValidLat(dropLat) || !isValidLng(dropLng)) {
      return res.status(400).json({
        success: false,
        message: 'Valid pickup_latitude, pickup_longitude, drop_latitude and drop_longitude are required.'
      });
    }

    let vehicleType = body.vehicle_type != null ? String(body.vehicle_type) : '';
    const driverId = body.driver_id != null ? String(body.driver_id).trim() : '';
    if (driverId) {
      const driver = await createModel('drivers').findOne({ driverId }).select('vehicleType').lean();
      if (driver && driver.vehicleType) vehicleType = driver.vehicleType;
    }

    // Automatic dispatch has no chosen driver yet: price the trip for the vehicle type of the driver who would get it.
    if (!driverId && !vehicleType && req.user) {
      const nearest = await findAutoDriver(req.user, { lat: pickupLat, lng: pickupLng });
      if (nearest && nearest.driver.vehicleType) vehicleType = nearest.driver.vehicleType;
    }

    // the business is the signed-in rider's, else the one named by the app (X-App-Id), else the default business
    const tenant = req.user ? await tenantForAccount(req.user) : req.appTenant || null;
    const categoryId = body.category_id != null ? String(body.category_id).trim() : '';
    const pricing = await priceTripWithCoupon(await loadPricingConfig(tenant), {
      pickup: { lat: pickupLat, lng: pickupLng },
      drop: { lat: dropLat, lng: dropLng },
      vehicleType,
      categoryId: categoryId || undefined
    }, { tenant, userId: req.user ? (req.user.userId || req.authActorId) : null, code: body.coupon_code != null ? String(body.coupon_code).trim() : '', surge: { mode: 'estimate', loadFreeDrivers: () => freeDriversOf(req.user) } });
    if (!pricing.ok) {
      return res.status(pricing.status).json({ success: false, message: pricing.message, error: pricing.code });
    }
    const estimate = pricing.estimate;
    return res.status(200).json({
      success: true,
      message: 'Fare estimate',
      data: {
        fare: estimate.fare,
        currency: estimate.currency,
        distance_km: estimate.distance_km,
        estimated_duration_min: estimate.duration_min,
        fare_basis: estimate.fare_basis,
        fare_source: estimate.fare_source,
        vehicle_type: estimate.vehicle_type,
        region_id: estimate.region_id || null,
        category_id: estimate.category_id || null,
        breakdown: estimate.fare_source === 'BUSINESS_RULES' ? estimate.breakdown : undefined,
        surge_multiplier: estimate.surge_multiplier > 1 ? estimate.surge_multiplier : undefined,
        coupon: pricing.coupon ? { code: pricing.coupon.code, applied: !!pricing.coupon.applied, discount: pricing.coupon.discount || 0, message: pricing.coupon.message } : undefined,
        payment_mode: 'CASH'
      }
    });
  } catch (error) {
    console.error('[trips estimate]', error);
    return res.status(500).json({ success: false, message: 'Failed to estimate fare' });
  }
};

/**
 * POST /api/v1/trips/cancel-request
 * Body: trip_id, cancelled_by (USER | DRIVER)
 * Cancels a trip that is still in REQUESTED status (before driver accepts).
 */
/**
 * POST /api/v1/trips/ride-options
 * Body: pickup_latitude, pickup_longitude, drop_latitude, drop_longitude.
 * The ride types (the business's vehicle categories) this rider can book for this trip, each with its fare, how many
 * drivers of that type are near the pickup and how soon the nearest one could arrive. Everything comes from what the
 * business configured in the admin dashboard: service regions (centre point and radius), the categories offered in
 * the pickup's region, and the fare rules. Nothing is stored.
 */
/** The business's online drivers that are not on a ride: the supply side of surge. Called only when a fare rule has surge on. */
async function freeDriversOf(user) {
  const online = await createModel('drivers').find({ isOnline: true }).limit(500).lean();
  const sameShop = [];
  for (const d of online) {
    if (user ? await sameBusiness(user, d) : true) sameShop.push(d);
  }
  if (!sameShop.length) return [];
  const busy = await TripDetails.find({ driver_id: { $in: sameShop.map((d) => d.driverId) }, status: { $in: ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'] } }).select('driver_id').lean();
  const busyIds = new Set(busy.map((t) => t.driver_id));
  return sameShop.filter((d) => !busyIds.has(d.driverId));
}

exports.rideOptions = async (req, res) => {
  try {
    const body = req.body || {};
    const pickup = { lat: Number(body.pickup_latitude), lng: Number(body.pickup_longitude) };
    const drop = { lat: Number(body.drop_latitude), lng: Number(body.drop_longitude) };
    if (!isValidLat(pickup.lat) || !isValidLng(pickup.lng) || !isValidLat(drop.lat) || !isValidLng(drop.lng)) {
      return res.status(400).json({
        success: false,
        message: 'Valid pickup_latitude, pickup_longitude, drop_latitude and drop_longitude are required.'
      });
    }

    const user = req.user;
    const tenant = user ? await tenantForAccount(user) : req.appTenant || null;
    const config = await loadPricingConfig(tenant);
    const answer = (extra) => res.status(200).json({
      success: true,
      message: 'Ride options',
      data: { currency: (config.market && config.market.currency) || null, options: [], ...extra }
    });

    // service area: with regions that have a centre and radius the pickup must be inside one of them
    let region = null;
    if (hasGeofence(config.regions)) {
      const match = matchRegion(config.regions, pickup);
      if (!match) return answer({ service_available: false, reason: 'OUTSIDE_SERVICE_AREA', region: null });
      region = match.region;
    }
    const regionInfo = region ? { region_id: region.regionId, city: region.city, zone_name: region.zoneName } : null;

    const offered = config.categories.filter((c) => c.active && (!region || (c.regionIds || []).includes(region.regionId)));
    if (!offered.length) return answer({ service_available: false, reason: 'NO_RIDE_TYPES', region: regionInfo });

    // drivers of this business that are online, and which of them are already busy
    const online = await createModel('drivers').find({ isOnline: true }).limit(500).lean();
    const sameShop = [];
    for (const d of online) {
      if (user ? await sameBusiness(user, d) : true) sameShop.push(d);
    }
    const busyIds = new Set();
    if (sameShop.length) {
      const busy = await TripDetails.find({
        driver_id: { $in: sameShop.map((d) => d.driverId) },
        status: { $in: ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'] }
      }).select('driver_id').lean();
      busy.forEach((t) => busyIds.add(t.driver_id));
    }
    const free = sameShop.filter((d) => !busyIds.has(d.driverId));

    const options = [];
    for (const category of offered) {
      const priced = priceTrip(config, await withSurge(config, { pickup, drop, categoryId: category.categoryId }, { tenant, userId: user ? (user.userId || req.authActorId) : null, surge: { mode: 'estimate', loadFreeDrivers: async () => free } }));
      if (!priced.ok) continue; // not priced yet (or not offered here): the rider is not shown a ride they cannot book
      // a driver whose app has not reported a position yet still counts: dispatch can offer them the ride
      const near = rankCandidates(free, pickup, { categoryId: category.categoryId, categoryName: category.name });
      const located = near.filter((c) => Number.isFinite(c.distanceKm));
      const nearest = located.length ? located[0].distanceKm : null;
      const est = priced.estimate;
      options.push({
        category_id: category.categoryId,
        name: category.name,
        description: category.description || '',
        ride_type: category.rideType,
        icon: category.icon || 'car',
        image_url: category.imageUrl || '',
        map_icon_url: category.mapIconUrl || '',
        passenger_capacity: category.passengerCapacity,
        luggage_capacity: category.luggageCapacity == null ? null : category.luggageCapacity,
        fare: est.fare,
        fare_min: est.fare_min != null ? est.fare_min : est.fare,
        fare_max: est.fare_max != null ? est.fare_max : est.fare,
        currency: est.currency,
        distance_km: est.distance_km,
        estimated_duration_min: est.duration_min,
        duration_min_low: est.duration_min_low != null ? est.duration_min_low : est.duration_min,
        duration_min_high: est.duration_min_high != null ? est.duration_min_high : est.duration_min,
        surge_multiplier: est.surge_multiplier > 1 ? est.surge_multiplier : undefined,
        drivers_nearby: near.length,
        eta_min: nearest == null ? null : etaMinutes(nearest),
        available: near.length > 0
      });
    }
    return answer({ service_available: options.length > 0, reason: options.length ? null : 'NO_PRICED_RIDE_TYPES', region: regionInfo, options });
  } catch (error) {
    console.error('[trips ride-options]', error);
    return res.status(500).json({ success: false, message: 'Failed to load ride options' });
  }
};

exports.cancelRequest = async (req, res) => {
  try {
    const body = req.body || {};
    const tripId = (body.trip_id != null ? String(body.trip_id) : '').trim();
    const cancelledBy = (body.cancelled_by != null ? String(body.cancelled_by) : 'USER').trim().toUpperCase();

    if (!tripId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: trip_id'
      });
    }

    const trip = await TripDetails.findOne({ trip_id: tripId });
    if (!trip) {
      return res.status(404).json({
        success: false,
        message: 'Trip not found',
        data: { trip_id: tripId }
      });
    }

    const actorId = req.authActorId;
    const actorRole = req.authRole;
    if (actorRole === 'user') {
      if (trip.user_id !== actorId) {
        return res.status(403).json({ success: false, message: 'Only the trip user can cancel this request' });
      }
      if (cancelledBy === 'DRIVER') {
        return res.status(403).json({ success: false, message: 'Users cannot cancel as DRIVER' });
      }
    } else if (actorRole === 'driver') {
      if (trip.driver_id !== actorId) {
        return res.status(403).json({ success: false, message: 'Only the assigned driver can cancel this request' });
      }
      if (cancelledBy === 'USER') {
        return res.status(403).json({ success: false, message: 'Drivers cannot cancel as USER' });
      }
    }

    // Only allow cancellation of REQUESTED trips (before acceptance)
    if (trip.status !== 'REQUESTED') {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel trip with status: ${trip.status}. Only REQUESTED trips can be cancelled via this endpoint.`,
        data: { trip_id: tripId, current_status: trip.status }
      });
    }

    const now = new Date();
    const newStatus = cancelledBy === 'DRIVER' ? 'CANCELLED_BY_DRIVER' : 'CANCELLED_BY_USER';

    await TripDetails.updateOne(
      { trip_id: tripId, status: 'REQUESTED' },
      { $set: { status: newStatus, cancelled_by: cancelledBy, cancelled_at: now, updated_at: now } }
    );

    // Notify the other party via socket
    if (cancelledBy === 'USER' && trip.driver_id) {
      emitToDriver(trip.driver_id, 'ride_cancelled_by_user', {
        trip_id: tripId,
        request_id: trip.request_id,
        status: newStatus,
        message: 'Ride was cancelled by user'
      });
    } else if (cancelledBy === 'DRIVER' && trip.user_id) {
      emitToUser(trip.user_id, 'ride_request_rejected', {
        trip_id: tripId,
        request_id: trip.request_id,
        status: newStatus,
        message: 'Ride was cancelled by driver'
      });
    }

    res.status(200).json({
      success: true,
      message: `Trip cancelled by ${cancelledBy.toLowerCase()}`,
      data: { trip_id: tripId, status: newStatus }
    });
  } catch (error) {
    console.error('[trips cancelRequest]', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to cancel trip request'
    });
  }
};

/**
 * POST /api/v1/trips/driver-response
 * Body: trip_id, driver_id, response (ACCEPTED | REJECTED | REJECTED_WITH_REASON), reject_reason (optional)
 */
exports.driverResponse = async (req, res) => {
  try {
    const body = req.body || {};
    const tripIdInput = (body.trip_id != null ? String(body.trip_id) : '').trim();
    const rideIdInput = (body.ride_id != null ? String(body.ride_id) : '').trim();
    const requestIdInput = (body.request_id != null ? String(body.request_id) : '').trim();
    const driverId = (body.driver_id ?? body.driverId ?? '').toString().trim();
    const response = normalizeDriverResponse(body.response ?? body.status ?? body.action);
    const rejectReason = body.reject_reason != null ? String(body.reject_reason).trim() : null;
    const tripLookupId = tripIdInput || rideIdInput;

    if ((!tripLookupId && !requestIdInput) || !driverId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: (trip_id or ride_id or request_id), driver_id'
      });
    }
    const allowed = ['ACCEPTED', 'REJECTED', 'REJECTED_WITH_REASON'];
    if (!allowed.includes(response)) {
      return res.status(400).json({
        success: false,
        message: 'response must be one of: ACCEPTED, REJECTED, REJECTED_WITH_REASON (accept/reject variants are supported)'
      });
    }

    const query = tripLookupId && requestIdInput
      ? { $or: [{ trip_id: tripLookupId }, { request_id: requestIdInput }] }
      : tripLookupId
        ? { trip_id: tripLookupId }
        : { request_id: requestIdInput };
    const trip = await TripDetails.findOne(query);
    if (!trip) {
      return res.status(404).json({
        success: false,
        message: 'Trip not found',
        data: { trip_id: tripLookupId || undefined, request_id: requestIdInput || undefined }
      });
    }
    const tripId = trip.trip_id;
    const requestId = trip.request_id;
    if (trip.driver_id !== driverId) {
      return res.status(403).json({
        success: false,
        message: 'Driver does not match this trip',
        data: { trip_id: tripId, request_id: requestId }
      });
    }
    const now = new Date();
    if (trip.status !== 'REQUESTED') {
      const alreadySuccess = trip.status === 'ACCEPTED';
      return res.status(200).json({
        success: alreadySuccess,
        trip_id: tripId,
        request_id: requestId,
        status: trip.status,
        message: buildTripMessageByStatus(trip.status)
      });
    }
    if (now > trip.timeout_at) {
      await TripDetails.updateOne(
        { trip_id: tripId, status: 'REQUESTED' },
        { $set: { status: 'NO_RESPONSE', driver_response: 'NO_RESPONSE', updated_at: now } }
      );
      const result = { success: false, trip_id: tripId, request_id: requestId, status: 'NO_RESPONSE', message: 'No response from driver' };
      emitToUser(trip.user_id, 'ride_request_timeout', { trip_id: tripId, request_id: requestId, status: 'NO_RESPONSE', message: 'No response from driver' });
      await notifyDriverRideTimeout(trip.driver_id, tripId, requestId);
      return res.status(200).json(result);
    }

    if (response === 'ACCEPTED') {
      // never accept a second trip while another one is in progress (the client is not trusted to enforce this)
      const conflict = await findDriverConflict(TripDetails, driverId, { exceptTripId: trip.trip_id });
      if (conflict) {
        return res.status(409).json({
          success: false,
          message: 'You are already on another ride. Finish it before accepting a new one.',
          error: 'DRIVER_BUSY',
          data: { code: 'DRIVER_BUSY', trip_id: tripId, active_trip_id: conflict.trip_id }
        });
      }
    }

    if (response !== 'ACCEPTED' && trip.dispatch_mode === 'AUTO') {
      // The rider asked for any driver, not this one: pass the request on and keep the rider waiting.
      if (await reofferTrip(trip, now)) {
        return res.status(200).json({ success: true, trip_id: tripId, request_id: requestId, status: response, message: 'Ride rejected' });
      }
    }

    const newStatus = response;
    const update = {
      status: newStatus,
      driver_response: newStatus,
      responded_at: now,
      updated_at: now
    };
    if (rejectReason && (newStatus === 'REJECTED' || newStatus === 'REJECTED_WITH_REASON')) {
      update.reject_reason = rejectReason;
    }
    // Conditional claim: the write only happens while the trip is still REQUESTED. Without it a rider's cancellation (or a
    // double tap, or the timeout sweeper) landing between the read above and this write was silently overwritten, and the
    // rider was told "accepted" for a ride they had cancelled.
    const claimedTrip = await TripDetails.findOneAndUpdate(
      { trip_id: tripId, status: 'REQUESTED' },
      { $set: update },
      { new: true }
    );
    if (!claimedTrip) {
      const current = await TripDetails.findOne({ trip_id: tripId });
      const currentStatus = current ? current.status : 'UNKNOWN';
      return res.status(200).json({
        success: currentStatus === 'ACCEPTED',
        trip_id: tripId,
        request_id: requestId,
        status: currentStatus,
        message: buildTripMessageByStatus(currentStatus)
      });
    }

    const success = newStatus === 'ACCEPTED';
    const message = success ? 'Driver accepted your request' : 'Driver rejected the request';
    const result = { success, trip_id: tripId, request_id: requestId, status: newStatus, message };

    if (success) {
      emitToUser(trip.user_id, 'ride_request_accepted', { trip_id: tripId, request_id: requestId, status: newStatus, message });
      await notifyUserDriverResponse(trip.user_id, trip, newStatus, message, null);
    } else {
      emitToUser(trip.user_id, 'ride_request_rejected', { trip_id: tripId, request_id: requestId, status: newStatus, message, reject_reason: rejectReason || undefined });
      await notifyUserDriverResponse(trip.user_id, trip, newStatus, message, rejectReason || undefined);
    }

    res.status(200).json({
      success: true,
      trip_id: tripId,
      request_id: requestId,
      status: newStatus,
      message: response === 'ACCEPTED' ? 'Ride accepted' : 'Ride rejected'
    });
  } catch (error) {
    console.error('[trips driverResponse]', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to process driver response'
    });
  }
};

/**
 * POST /api/v1/trips/check-timeouts
 * Mark REQUESTED trips with timeout_at < now as NO_RESPONSE. Call from cron.
 */
/**
 * Marks every REQUESTED trip whose driver-response window has passed as NO_RESPONSE and tells both apps.
 * Used by the check-timeouts endpoint and by the in-process sweeper (services/tripTimeoutSweeper.js).
 * Each trip is claimed with a conditional update, so two runs (or two server instances) never expire or notify the same
 * trip twice. Returns how many trips this run expired.
 */
async function expireTimedOutRequests(now = new Date(), { limit = 200 } = {}) {
  const due = await TripDetails.find({ status: 'REQUESTED', timeout_at: { $lt: now } })
    .select('trip_id request_id user_id driver_id dispatch_mode dispatch_attempted dispatch_attempts pickup')
    .limit(limit)
    .lean();
  let marked = 0;
  for (const t of due) {
    if (t.dispatch_mode === 'AUTO') {
      try {
        if (await reofferTrip(t, now)) continue; // another driver now holds the offer
      } catch (e) {
        console.warn('[trips dispatch] re-offer failed:', e.message, { trip_id: t.trip_id });
      }
    }
    const claimed = await TripDetails.findOneAndUpdate(
      { trip_id: t.trip_id, status: 'REQUESTED' },
      { $set: { status: 'NO_RESPONSE', driver_response: 'NO_RESPONSE', updated_at: now } },
      { new: true }
    );
    if (!claimed) continue; // answered, cancelled or expired by someone else in the meantime
    marked += 1;
    try {
      emitToUser(t.user_id, 'ride_request_timeout', { trip_id: t.trip_id, request_id: t.request_id, status: 'NO_RESPONSE', message: 'No response from driver' });
      await notifyUserRideTimeout(t.user_id, t);
      await notifyDriverRideTimeout(t.driver_id, t.trip_id, t.request_id);
    } catch (e) {
      console.warn('[trips expire] notify failed:', e.message, { trip_id: t.trip_id }); // the trip is already marked; a failed push must not undo that
    }
  }
  return marked;
}
exports.expireTimedOutRequests = expireTimedOutRequests;

exports.checkTimeouts = async (req, res) => {
  try {
    const marked = await expireTimedOutRequests(new Date());
    res.status(200).json({
      success: true,
      message: 'Timeout check completed',
      data: {
        marked_no_response: marked,
        timeout_seconds: DRIVER_RESPONSE_TIMEOUT_MS / 1000
      }
    });
  } catch (error) {
    console.error('[trips checkTimeouts]', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to check timeouts'
    });
  }
};
