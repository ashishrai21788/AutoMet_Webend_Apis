const { createModel } = require('../models/dynamicModel');
const { Trip, TRIP_STATUSES } = require('../models/tripModel');
const { TripDetails } = require('../models/tripDetailsModel');
const { getNextTripId } = require('../models/tripCounterModel');
const { issueForTrip, toPublic: invoiceToPublic } = require('../lib/riderInvoice');
const TripEvent = require('../models/tripEventModel');
const { sendPushToDriver, sendPushToUser } = require('../lib/pushNotification');
const { clearForDriver: clearTripRateLimitForDriver } = require('../lib/tripRateLimit');
const { emitToDriver, emitToUser } = require('../config/socket');
const { estimateTrip } = require('../lib/fare');
const { findDriverConflict } = require('../lib/driverBusy');
const tripStartOtp = require('../lib/tripStartOtp');
const { distanceKm: haversineKm, etaMinutes } = require('../lib/dispatch');
const { positionOf, presenceOf } = require('../lib/driverLocation');
const { loadPricingConfig } = require('../lib/tripPricing');
const { tenantForAccount } = require('../lib/appTenant');
const { policyFor, riderCancelFee } = require('../lib/cancellationFee');

/** The business's cancellation policy for a trip's category, or null (a trip of the default business has none). */
async function cancellationPolicyOf(trip) {
  try {
    if (!trip || !trip.tenant_id) return null;
    const { forTenant } = require('../lib/tenantData');
    const { CancellationPolicy } = require('../models/businessModels');
    return policyFor(await forTenant(trip.tenant_id).find(CancellationPolicy).lean(), trip);
  } catch (_) {
    return null; // no policy readable: no fee, never a guessed one
  }
}

const DRIVER_RESPONSE_TIMEOUT_SECONDS = Number(process.env.RIDE_REQUEST_TIMEOUT_SECONDS) || 60;
const ACTIVE_STATUSES = ['REQUESTED', 'ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];
// Active statuses in trip_details (in-progress until completed)
const ACTIVE_STATUSES_TRIP_DETAILS = ['REQUESTED', 'ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];

function isValidLat(lat) {
  return typeof lat === 'number' && !Number.isNaN(lat) && lat >= -90 && lat <= 90;
}
function isValidLng(lng) {
  return typeof lng === 'number' && !Number.isNaN(lng) && lng >= -180 && lng <= 180;
}

/** Safe user profile for display (e.g. to driver). Excludes password, tokens. */
function toUserProfileForDisplay(doc) {
  if (!doc) return null;
  const d = doc.toObject ? doc.toObject() : doc;
  const { passwordHash, accessToken, fcmToken, deviceId, __v, ...rest } = d;
  const fullName = [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || null;
  return {
    user_id: d.userId,
    first_name: d.firstName,
    last_name: d.lastName,
    full_name: fullName,
    phone: d.phone,
    email: d.email || null,
    profile_photo: d.profilePhoto || null,
    is_phone_verified: d.isPhoneVerified
  };
}

/** Safe driver profile for display (e.g. to user). Excludes password, tokens. */
function toDriverProfileForDisplay(doc) {
  if (!doc) return null;
  const d = doc.toObject ? doc.toObject() : doc;
  const { passwordHash, accessToken, fcmToken, deviceId, __v, ...rest } = d;
  const fullName = [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || null;
  return {
    driver_id: d.driverId,
    first_name: d.firstName,
    last_name: d.lastName,
    full_name: fullName,
    phone: d.phone,
    email: d.email || null,
    profile_photo: d.profilePhoto || null,
    rating: d.rating != null ? Number(d.rating) : null,
    total_rides: d.totalRides != null ? d.totalRides : null,
    vehicle_type: d.vehicleType || null,
    vehicle_number: d.vehicleNumber || null,
    vehicle_model: d.vehicleModel || null,
    vehicle_color: d.vehicleColor || null,
    seats: d.seatingCapacity != null ? Number(d.seatingCapacity) : null,
    fuel_type: d.fuleType || null,
    // approved by the business, and the documents are on record
    verified: d.driverVerificationStatus === 'APPROVED',
    id_verified: d.driverVerificationStatus === 'APPROVED' && d.isDocumentsUploaded !== false
  };
}

async function logTripEvent(tripId, event, payload = {}) {
  try {
    await TripEvent.create({ trip_id: tripId, event, payload });
  } catch (e) {
    if (process.env.NODE_ENV === 'development') console.warn('[trip_event]', e.message);
  }
}

function assertAuthenticatedDriverOwnsTrip(req, tripDriverId) {
  const actorId = req.authActorId || req.driver?.driverId;
  if (actorId && tripDriverId && actorId !== tripDriverId) {
    return { ok: false, status: 403, message: 'Driver does not match this trip' };
  }
  return { ok: true };
}

async function notifyUserTripDetailsResponse(trip, status, message, rejectReason) {
  if (!trip?.user_id) return;
  const pickupAddress = (trip.pickup && trip.pickup.address) ? trip.pickup.address : (trip.pickup_address || '');
  const dropAddress = (trip.drop && trip.drop.address) ? trip.drop.address : (trip.drop_address || '');
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
  const pickupLat = trip.pickup?.lat ?? trip.pickup_latitude;
  const pickupLng = trip.pickup?.lng ?? trip.pickup_longitude;
  const dropLat = trip.drop?.lat ?? trip.drop_latitude;
  const dropLng = trip.drop?.lng ?? trip.drop_longitude;
  if (pickupLat != null) data.pickup_lat = String(pickupLat);
  if (pickupLng != null) data.pickup_lng = String(pickupLng);
  if (dropLat != null) data.drop_lat = String(dropLat);
  if (dropLng != null) data.drop_lng = String(dropLng);
  if (trip.ride_note) data.ride_note = trip.ride_note;
  try {
    emitToUser(trip.user_id, isAccepted ? 'ride_request_accepted' : 'ride_request_rejected', {
      trip_id: trip.trip_id,
      request_id: trip.request_id,
      status,
      message: data.message,
      reject_reason: rejectReason || undefined
    });
  } catch (e) {
    if (process.env.NODE_ENV === 'development') console.warn('[notifyUserTripDetailsResponse] Socket emit failed:', e.message);
  }
  const result = await sendPushToUser(trip.user_id, {
    title,
    body,
    channelId: 'user_notifications',
    data,
    dataOnly: true
  });
  if (!result.success && process.env.NODE_ENV === 'development') {
    console.warn('[notifyUserTripDetailsResponse] FCM failed:', result.error, { userId: trip.user_id });
  }
}

/**
 * POST /api/v1/rides/request
 * Create ride request intent. Validates user, driver, driver online, lat/lng, no duplicate active request.
 */
exports.createRideRequest = async (req, res) => {
  try {
    const body = req.body || {};
    const requestId = body.request_id != null ? String(body.request_id).trim() : '';
    const userId = body.user_id != null ? String(body.user_id).trim() : '';
    const driverId = body.driver_id != null ? String(body.driver_id).trim() : '';
    const pickupAddress = body.pickup_address != null ? String(body.pickup_address).trim() : '';
    const pickupLat = body.pickup_latitude;
    const pickupLng = body.pickup_longitude;
    const dropAddress = body.drop_address != null ? String(body.drop_address).trim() : '';
    const dropLat = body.drop_latitude;
    const dropLng = body.drop_longitude;
    const rideNote = body.ride_note != null ? String(body.ride_note).trim() : null;

    if (!userId || !driverId || !pickupAddress || !dropAddress) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: user_id, driver_id, pickup_address, drop_address',
        data: { missingFields: { user_id: !userId, driver_id: !driverId, pickup_address: !pickupAddress, drop_address: !dropAddress } }
      });
    }
    if (!isValidLat(pickupLat) || !isValidLng(pickupLng)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pickup coordinates. Use pickup_latitude (-90 to 90) and pickup_longitude (-180 to 180).'
      });
    }
    if (!isValidLat(dropLat) || !isValidLng(dropLng)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid drop coordinates. Use drop_latitude and drop_longitude.'
      });
    }
    const latDiff = Math.abs(pickupLat - dropLat);
    const lngDiff = Math.abs(pickupLng - dropLng);
    if (latDiff < 1e-6 && lngDiff < 1e-6) {
      return res.status(400).json({
        success: false,
        message: 'Pickup and drop locations must be different.'
      });
    }

    const UserModel = createModel('users');
    const DriverModel = createModel('drivers');
    const [user, driver] = await Promise.all([
      UserModel.findOne({ userId }).lean(),
      DriverModel.findOne({ driverId }).lean()
    ]);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: { user_id: userId }
      });
    }
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: { driver_id: driverId }
      });
    }
    if (!driver.isOnline) {
      return res.status(400).json({
        success: false,
        message: 'Driver is not online. Cannot send ride request.',
        data: { driver_id: driverId }
      });
    }
    // same rules as /api/v1/trips: one business at a time, and only drivers who are available
    {
      const { sameBusiness } = require('../lib/appTenant');
      const { checkDriverAvailable } = require('../lib/driverAvailability');
      if (!(await sameBusiness(user, driver))) {
        return res.status(403).json({ success: false, message: 'This driver is not available for your app.', data: { driver_id: driverId } });
      }
      const gate = await checkDriverAvailable(driver);
      if (!gate.available) {
        return res.status(409).json({ success: false, message: 'This driver is not available for rides right now.', error: gate.code, data: { driver_id: driverId, code: gate.code } });
      }
    }

    // one live ride per rider, whichever driver it is with
    const riderBusy = await TripDetails.findOne({ user_id: userId, status: { $in: ACTIVE_STATUSES_TRIP_DETAILS } }).lean();
    if (riderBusy) {
      return res.status(409).json({
        success: false,
        message: 'You already have a ride in progress.',
        data: { trip_id: riderBusy.trip_id, status: riderBusy.status }
      });
    }
    const duplicateDetails = await TripDetails.findOne({
      user_id: userId,
      driver_id: driverId,
      status: { $in: ACTIVE_STATUSES_TRIP_DETAILS }
    }).lean();
    const duplicate = await Trip.findOne({
      user_id: userId,
      driver_id: driverId,
      status: { $in: ACTIVE_STATUSES }
    });
    if (duplicate || duplicateDetails) {
      const existing = duplicateDetails || duplicate;
      return res.status(409).json({
        success: false,
        message: 'An active ride request already exists for this user and driver.',
        data: { trip_id: existing.trip_id, status: existing.status }
      });
    }

    const tripId = await getNextTripId();
    const now = new Date();
    const trip = await Trip.create({
      trip_id: tripId,
      request_id: requestId || tripId,
      user_id: userId,
      driver_id: driverId,
      pickup_address: pickupAddress,
      pickup_latitude: pickupLat,
      pickup_longitude: pickupLng,
      drop_address: dropAddress,
      drop_latitude: dropLat,
      drop_longitude: dropLng,
      ride_note: rideNote || undefined,
      status: 'REQUESTED',
      requested_at: now
    });

    await logTripEvent(tripId, 'REQUESTED', { user_id: userId, driver_id: driverId });

    const notifyResult = await sendPushToDriver(driverId, {
      title: 'New ride request',
      body: `${pickupAddress} → ${dropAddress}`,
      channelId: 'driver_notifications',
      data: {
        type: 'RIDE_REQUEST',
        trip_id: String(tripId),
        user_id: userId,
        pickup_address: pickupAddress,
        drop_address: dropAddress,
        pickup_lat: String(pickupLat),
        pickup_lng: String(pickupLng),
        drop_lat: String(dropLat),
        drop_lng: String(dropLng),
        ride_note: rideNote || ''
      },
      dataOnly: true
    });
    if (!notifyResult.success) {
      console.warn('[ride_request] FCM notify failed:', notifyResult.error, { driverId, tripId });
    }

    res.status(201).json({
      success: true,
      trip_id: tripId,
      request_id: requestId || tripId,
      status: 'REQUESTED',
      message: 'Ride request sent to driver'
    });
  } catch (error) {
    console.error('[createRideRequest]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create ride request'
    });
  }
};

/**
 * PATCH /api/v1/rides/:tripId/accept
 * Driver accepts the ride.
 */
exports.acceptRide = async (req, res) => {
  try {
    const tripId = (req.params.tripId || '').trim();
    const driverId = (req.body.driver_id || req.body.driverId || '').toString().trim();
    if (!tripId) {
      return res.status(400).json({ success: false, message: 'tripId is required' });
    }
    if (!driverId) {
      return res.status(400).json({ success: false, message: 'driver_id is required in request body' });
    }
    const now = new Date();

    const tripDetails = await TripDetails.findOne({ trip_id: tripId });
    if (tripDetails) {
      const ownerCheck = assertAuthenticatedDriverOwnsTrip(req, tripDetails.driver_id);
      if (!ownerCheck.ok) {
        return res.status(ownerCheck.status).json({ success: false, message: ownerCheck.message });
      }
      if (tripDetails.driver_id !== driverId) {
        return res.status(403).json({ success: false, message: 'Driver does not match this trip' });
      }
      if (tripDetails.status !== 'REQUESTED') {
        const alreadySuccess = tripDetails.status === 'ACCEPTED';
        return res.status(200).json({
          success: alreadySuccess,
          trip_id: tripId,
          request_id: tripDetails.request_id,
          status: tripDetails.status,
          message: alreadySuccess ? 'Ride accepted by driver' : `Trip cannot be accepted. Current status: ${tripDetails.status}`
        });
      }
      const busyWith = await findDriverConflict(TripDetails, driverId, { exceptTripId: tripId });
      if (busyWith) {
        return res.status(409).json({
          success: false,
          message: 'You are already on another ride. Finish it before accepting a new one.',
          error: 'DRIVER_BUSY',
          data: { code: 'DRIVER_BUSY', trip_id: tripId, active_trip_id: busyWith.trip_id }
        });
      }
      const acceptedTrip = await TripDetails.findOneAndUpdate(
        { trip_id: tripId, status: 'REQUESTED' },
        { $set: { status: 'ACCEPTED', driver_response: 'ACCEPTED', responded_at: now, updated_at: now } },
        { new: true }
      );
      if (!acceptedTrip) {
        // lost the race (cancelled, timed out or already answered): report the real state and notify nobody
        const nowTrip = await TripDetails.findOne({ trip_id: tripId });
        const nowStatus = nowTrip ? nowTrip.status : 'UNKNOWN';
        return res.status(200).json({
          success: nowStatus === 'ACCEPTED',
          trip_id: tripId,
          request_id: tripDetails.request_id,
          status: nowStatus,
          message: nowStatus === 'ACCEPTED' ? 'Ride accepted by driver' : `Trip cannot be accepted. Current status: ${nowStatus}`
        });
      }
      tripDetails.status = 'ACCEPTED';
      await notifyUserTripDetailsResponse(tripDetails, 'ACCEPTED', 'Driver accepted your request');
      return res.status(200).json({
        success: true,
        trip_id: tripId,
        request_id: tripDetails.request_id,
        status: 'ACCEPTED',
        message: 'Ride accepted by driver'
      });
    }

    const trip = await Trip.findOneAndUpdate(
      { trip_id: tripId, status: 'REQUESTED', driver_id: driverId },
      { $set: { status: 'ACCEPTED', accepted_at: now } },
      { new: true }
    );
    if (!trip) {
      const existing = await Trip.findOne({ trip_id: tripId }).lean();
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Trip not found', data: { trip_id: tripId } });
      }
      if (existing.driver_id !== driverId) {
        return res.status(403).json({ success: false, message: 'Driver does not match this trip' });
      }
      return res.status(400).json({
        success: false,
        message: `Trip cannot be accepted. Current status: ${existing.status}`,
        data: { trip_id: tripId, status: existing.status }
      });
    }
    await logTripEvent(tripId, 'ACCEPTED', { accepted_at: now.toISOString() });

    res.status(200).json({
      success: true,
      trip_id: tripId,
      status: 'ACCEPTED',
      message: 'Ride accepted by driver'
    });
  } catch (error) {
    console.error('[acceptRide]', error);
    res.status(500).json({ success: false, message: 'Failed to accept ride' });
  }
};

/**
 * PATCH /api/v1/rides/:tripId/reject
 * Driver (or user) rejects. Body: { rejected_reason?, rejected_by: 'DRIVER'|'USER' }
 */
exports.rejectRide = async (req, res) => {
  try {
    const tripId = (req.params.tripId || '').trim();
    const body = req.body || {};
    const driverId = (body.driver_id || body.driverId || '').toString().trim();
    const rejectedReason = body.rejected_reason != null ? String(body.rejected_reason).trim()
      : (body.reject_reason != null ? String(body.reject_reason).trim() : null);
    const rejectedBy = (body.rejected_by && ['USER', 'DRIVER'].includes(String(body.rejected_by).toUpperCase()))
      ? String(body.rejected_by).toUpperCase()
      : 'DRIVER';

    if (!tripId) {
      return res.status(400).json({ success: false, message: 'tripId is required' });
    }
    if (!driverId) {
      return res.status(400).json({ success: false, message: 'driver_id is required in request body' });
    }

    const tripDetails = await TripDetails.findOne({ trip_id: tripId });
    if (tripDetails) {
      const ownerCheck = assertAuthenticatedDriverOwnsTrip(req, tripDetails.driver_id);
      if (!ownerCheck.ok) {
        return res.status(ownerCheck.status).json({ success: false, message: ownerCheck.message });
      }
      if (tripDetails.driver_id !== driverId) {
        return res.status(403).json({ success: false, message: 'Driver does not match this trip' });
      }
      if (tripDetails.status !== 'REQUESTED') {
        return res.status(400).json({
          success: false,
          message: `Trip cannot be rejected. Current status: ${tripDetails.status}`,
          data: { trip_id: tripId, status: tripDetails.status }
        });
      }
      const newStatus = rejectedReason ? 'REJECTED_WITH_REASON' : 'REJECTED';
      const now = new Date();
      await TripDetails.updateOne(
        { trip_id: tripId, status: 'REQUESTED' },
        {
          $set: {
            status: newStatus,
            driver_response: newStatus,
            reject_reason: rejectedReason || undefined,
            responded_at: now,
            updated_at: now
          }
        }
      );
      tripDetails.status = newStatus;
      await notifyUserTripDetailsResponse(tripDetails, newStatus, 'Driver rejected the request', rejectedReason);
      return res.status(200).json({
        success: true,
        trip_id: tripId,
        request_id: tripDetails.request_id,
        status: newStatus,
        rejected_by: rejectedBy,
        message: 'Ride rejected'
      });
    }

    const newStatus = rejectedReason ? 'REJECTED_WITH_REASON' : 'REJECTED';
    const trip = await Trip.findOneAndUpdate(
      { trip_id: tripId, status: 'REQUESTED', driver_id: driverId },
      { $set: { status: newStatus, rejected_reason: rejectedReason || undefined, rejected_by: rejectedBy } },
      { new: true }
    );
    if (!trip) {
      const existing = await Trip.findOne({ trip_id: tripId }).lean();
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Trip not found', data: { trip_id: tripId } });
      }
      if (existing.driver_id !== driverId) {
        return res.status(403).json({ success: false, message: 'Driver does not match this trip' });
      }
      return res.status(400).json({
        success: false,
        message: `Trip cannot be rejected. Current status: ${existing.status}`,
        data: { trip_id: tripId, status: existing.status }
      });
    }
    await logTripEvent(tripId, newStatus, { rejected_by: rejectedBy, rejected_reason: rejectedReason || undefined });

    res.status(200).json({
      success: true,
      trip_id: tripId,
      status: newStatus,
      rejected_by: rejectedBy,
      message: 'Ride rejected'
    });
  } catch (error) {
    console.error('[rejectRide]', error);
    res.status(500).json({ success: false, message: 'Failed to reject ride' });
  }
};

/**
 * POST /api/v1/rides/cancel
 * User cancels ride. Handles both: before driver accepts, and after acceptance but before trip start.
 * Body: { request_id? | ride_id, user_id, cancellation_reason?, cancel_stage: 'before_accept'|'after_accept' }
 */
exports.cancelRideByUser = async (req, res) => {
  try {
    const body = req.body || {};
    const rideId = (body.ride_id != null ? String(body.ride_id) : '').trim();
    const requestId = (body.request_id != null ? String(body.request_id) : '').trim();
    const rideOrRequestId = rideId || requestId;
    const userId = (body.user_id != null ? String(body.user_id) : '').trim();
    const cancellationReason = body.cancellation_reason != null ? String(body.cancellation_reason).trim() : null;
    const cancelStage = (body.cancel_stage && ['before_accept', 'after_accept'].includes(String(body.cancel_stage).toLowerCase()))
      ? String(body.cancel_stage).toLowerCase()
      : null;

    if (!rideOrRequestId || !userId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: (request_id or ride_id), user_id',
        data: { missingFields: { request_id: !requestId, ride_id: !rideId, user_id: !userId } }
      });
    }
    if (!cancelStage) {
      return res.status(400).json({
        success: false,
        message: 'cancel_stage is required and must be one of: before_accept, after_accept',
        data: { allowed: ['before_accept', 'after_accept'] }
      });
    }

    let source = 'trip_details';
    let trip = await TripDetails.findOne({
      $or: [
        { trip_id: rideOrRequestId },
        { request_id: rideOrRequestId }
      ]
    });
    if (!trip) {
      source = 'trips';
      trip = await Trip.findOne({
        $or: [
          { trip_id: rideOrRequestId },
          { request_id: rideOrRequestId }
        ]
      });
    }
    if (!trip) {
      return res.status(404).json({
        success: false,
        message: 'Ride not found',
        data: { request_id: requestId || undefined, ride_id: rideId || undefined }
      });
    }
    const resolvedRideId = trip.trip_id;
    const resolvedRequestId = trip.request_id || trip.trip_id;
    if (trip.user_id !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Only the user who created the ride can cancel it',
        data: { ride_id: resolvedRideId, request_id: resolvedRequestId }
      });
    }

    const cancelledStatuses = ['CANCELLED_BY_USER', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE'];
    if (cancelledStatuses.includes(trip.status)) {
      return res.status(409).json({
        success: false,
        message: 'Ride has already been cancelled',
        data: { ride_id: resolvedRideId, request_id: resolvedRequestId, status: trip.status }
      });
    }
    const nonCancellableStatuses = ['ON_GOING', 'COMPLETED'];
    if (nonCancellableStatuses.includes(trip.status)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel ride once trip has started or completed',
        data: { ride_id: resolvedRideId, request_id: resolvedRequestId, status: trip.status }
      });
    }
    if (cancelStage === 'before_accept' && trip.status !== 'REQUESTED') {
      return res.status(400).json({
        success: false,
        message: `cancel_stage 'before_accept' requires ride status REQUESTED. Current status: ${trip.status}`,
        data: { ride_id: resolvedRideId, request_id: resolvedRequestId, status: trip.status }
      });
    }
    const afterAcceptAllowed = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED'];
    if (cancelStage === 'after_accept' && !afterAcceptAllowed.includes(trip.status)) {
      return res.status(400).json({
        success: false,
        message: `cancel_stage 'after_accept' requires ride status ACCEPTED, DRIVER_ON_THE_WAY, or ARRIVED. Current status: ${trip.status}`,
        data: { ride_id: resolvedRideId, request_id: resolvedRequestId, status: trip.status }
      });
    }

    const newStatus = cancelStage === 'before_accept' ? 'CANCELLED_BY_USER' : 'CANCELLED_BY_USER_AFTER_ACCEPTANCE';
    const now = new Date();
    // after the driver accepted, the business's own policy decides whether this cancellation costs the rider anything
    const feeInfo = cancelStage === 'after_accept' && source === 'trip_details'
      ? riderCancelFee(await cancellationPolicyOf(trip), trip, now)
      : { fee: 0, reason: null };
    const driverId = trip.driver_id;
    if (cancelStage === 'before_accept' && driverId) {
      clearTripRateLimitForDriver(driverId);
    }
    if (source === 'trip_details') {
      const cancelled = await TripDetails.findOneAndUpdate(
        { _id: trip._id, status: trip.status },
        {
          $set: {
            status: newStatus,
            driver_response: newStatus,
            cancellation_reason: cancellationReason || null,
            cancelled_at: now,
            cancel_stage: cancelStage,
            cancelled_by: 'USER',
            cancellation_fee: feeInfo.fee,
            cancellation_fee_reason: feeInfo.reason,
            updated_at: now
          }
        },
        { new: true }
      );
      if (!cancelled) {
        // the driver answered or the trip moved on after this cancel was validated: report it, change nothing
        const latest = await TripDetails.findOne({ _id: trip._id });
        return res.status(409).json({
          success: false,
          message: `The ride has just changed (now ${latest ? latest.status : 'unknown'}). Please check its status.`,
          data: { ride_id: resolvedRideId, current_status: latest ? latest.status : null }
        });
      }
    } else {
      trip.status = newStatus;
      trip.cancellation_reason = cancellationReason || undefined;
      trip.cancelled_at = now;
      trip.cancel_stage = cancelStage;
      trip.cancelled_by = 'USER';
      await trip.save();
    }

    const eventPayload = {
      cancelled_by: 'USER',
      cancel_stage: cancelStage,
      cancellation_reason: cancellationReason || undefined,
      cancelled_at: now.toISOString()
    };
    await logTripEvent(resolvedRideId, newStatus, eventPayload);

    if (driverId) {
      try {
        emitToDriver(driverId, 'ride_cancelled_by_user', {
          trip_id: resolvedRideId,
          request_id: resolvedRequestId,
          user_id: userId,
          status: newStatus,
          cancellation_reason: cancellationReason || undefined,
          cancel_stage: cancelStage,
          cancelled_at: now.toISOString()
        });
      } catch (e) {
        if (process.env.NODE_ENV === 'development') console.warn('[cancelRideByUser] Socket emit failed:', e.message);
      }

      const notifyResult = await sendPushToDriver(driverId, {
        title: 'Ride cancelled',
        body: cancellationReason
          ? `User cancelled the ride. Reason: ${cancellationReason}`
          : 'User cancelled the ride.',
        channelId: 'driver_notifications',
        data: {
          type: 'ride_cancelled_by_user',
          trip_id: resolvedRideId,
          request_id: resolvedRequestId,
          user_id: userId,
          status: newStatus,
          cancellation_reason: cancellationReason || '',
          cancel_stage: cancelStage
        },
        dataOnly: true
      });
      if (!notifyResult.success) {
        console.warn('[cancelRideByUser] FCM notify failed:', notifyResult.error, { driverId });
      }
    }

    res.status(200).json({
      success: true,
      trip_id: resolvedRideId,
      request_id: resolvedRequestId,
      status: newStatus,
      cancellation_fee: feeInfo.fee,
      message: cancelStage === 'before_accept' ? 'Ride cancelled before driver acceptance' : 'Ride cancelled after driver acceptance'
    });
  } catch (error) {
    console.error('[cancelRideByUser]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to cancel ride' });
  }
};

/**
 * POST /api/v1/rides/rating
 * The rider rates the driver once, after the trip is COMPLETED.
 * Body: { ride_id | trip_id, user_id, stars (1-5), comment? (max 300 characters), tags? (quick feedback chips, see RATING_TAGS) }
 * 404 unknown trip · 403 not the rider's trip · 409 not completed yet / already rated · 400 bad input.
 */
const RATING_TAGS = ['Great driver', 'Clean vehicle', 'Safe ride', 'On time', 'Polite', 'Smooth ride'];

exports.rateDriver = async (req, res) => {
  try {
    const body = req.body || {};
    const tripId = String(body.ride_id ?? body.trip_id ?? '').trim();
    const userId = String(body.user_id ?? '').trim();
    const stars = Number(body.stars);
    const comment = body.comment == null ? null : String(body.comment).trim();
    // only the known chips are kept, once each; anything else is ignored rather than stored
    const tags = Array.isArray(body.tags) ? [...new Set(body.tags.map((t) => String(t).trim()).filter((t) => RATING_TAGS.includes(t)))] : [];

    if (!tripId || !userId) {
      return res.status(400).json({ success: false, message: 'Missing required fields: ride_id, user_id', data: { missingFields: { ride_id: !tripId, user_id: !userId } } });
    }
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ success: false, message: 'stars must be a whole number from 1 to 5', data: { stars: body.stars } });
    }
    if (comment && comment.length > 300) {
      return res.status(400).json({ success: false, message: 'comment must be 300 characters or fewer', data: { length: comment.length } });
    }

    const trip = await TripDetails.findOne({ trip_id: tripId }).lean();
    if (!trip) return res.status(404).json({ success: false, message: 'Ride not found', data: { ride_id: tripId } });
    if (trip.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'You can only rate your own ride', data: { ride_id: tripId } });
    }
    if (trip.status !== 'COMPLETED') {
      return res.status(409).json({ success: false, message: 'A ride can be rated once it is completed', data: { ride_id: tripId, status: trip.status } });
    }
    if (trip.rider_rating && trip.rider_rating.stars) {
      return res.status(409).json({ success: false, message: 'This ride has already been rated', data: { ride_id: tripId, stars: trip.rider_rating.stars } });
    }

    const now = new Date();
    // conditional write: two taps at once cannot both rate the ride
    const rated = await TripDetails.findOneAndUpdate(
      { trip_id: tripId, status: 'COMPLETED', 'rider_rating.stars': null },
      { $set: { 'rider_rating.stars': stars, 'rider_rating.comment': comment || null, 'rider_rating.tags': tags, 'rider_rating.rated_at': now, rider_receipt_ack_at: trip.rider_receipt_ack_at || now, updated_at: now } },
      { new: true }
    );
    if (!rated) {
      return res.status(409).json({ success: false, message: 'This ride has already been rated', data: { ride_id: tripId } });
    }
    await logTripEvent(tripId, 'RIDER_RATED_DRIVER', { stars, comment: comment || undefined, tags: tags.length ? tags : undefined, rated_at: now.toISOString() });

    res.status(200).json({ success: true, message: 'Thanks for rating your ride', data: { ride_id: tripId, stars, comment: comment || null, tags, rated_at: now.toISOString() } });
  } catch (error) {
    console.error('[rateDriver]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to save the rating' });
  }
};

/**
 * POST /api/v1/rides/rate-rider
 * The driver of a COMPLETED trip rates the rider once. Body: { trip_id, driver_id, stars (1-5), comment? (max 300 characters) }.
 * 404 unknown trip · 403 not this driver's trip · 409 not completed yet / already rated · 400 bad input.
 */
exports.rateRider = async (req, res) => {
  try {
    const body = req.body || {};
    const tripId = String(body.ride_id ?? body.trip_id ?? '').trim();
    const driverId = String(body.driver_id ?? '').trim();
    const stars = Number(body.stars);
    const comment = body.comment == null ? null : String(body.comment).trim();
    if (!tripId || !driverId) {
      return res.status(400).json({ success: false, message: 'Missing required fields: trip_id, driver_id', data: { missingFields: { trip_id: !tripId, driver_id: !driverId } } });
    }
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ success: false, message: 'stars must be a whole number from 1 to 5', data: { stars: body.stars } });
    }
    if (comment && comment.length > 300) {
      return res.status(400).json({ success: false, message: 'comment must be 300 characters or fewer', data: { length: comment.length } });
    }
    const trip = await TripDetails.findOne({ trip_id: tripId }).lean();
    if (!trip) return res.status(404).json({ success: false, message: 'Ride not found', data: { ride_id: tripId } });
    if (trip.driver_id !== driverId) {
      return res.status(403).json({ success: false, message: 'You can only rate riders of your own rides', data: { ride_id: tripId } });
    }
    if (trip.status !== 'COMPLETED') {
      return res.status(409).json({ success: false, message: 'A rider can be rated once the ride is completed', data: { ride_id: tripId, status: trip.status } });
    }
    if (trip.driver_rating && trip.driver_rating.stars) {
      return res.status(409).json({ success: false, message: 'This rider has already been rated for this ride', data: { ride_id: tripId, stars: trip.driver_rating.stars } });
    }
    const now = new Date();
    // conditional write: two taps at once cannot both rate the rider
    const rated = await TripDetails.findOneAndUpdate(
      { trip_id: tripId, status: 'COMPLETED', 'driver_rating.stars': null },
      { $set: { 'driver_rating.stars': stars, 'driver_rating.comment': comment || null, 'driver_rating.rated_at': now, updated_at: now } },
      { new: true }
    );
    if (!rated) {
      return res.status(409).json({ success: false, message: 'This rider has already been rated for this ride', data: { ride_id: tripId } });
    }
    await logTripEvent(tripId, 'DRIVER_RATED_RIDER', { stars, comment: comment || undefined, rated_at: now.toISOString() });
    res.status(200).json({ success: true, message: 'Thanks for rating the rider', data: { ride_id: tripId, stars, comment: comment || null, rated_at: now.toISOString() } });
  } catch (error) {
    console.error('[rateRider]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to save the rating' });
  }
};

/**
 * POST /api/v1/rides/receipt-ack
 * The rider's app has shown the finished-trip receipt and it was dismissed. Body: { ride_id | trip_id, user_id }.
 * Only the rider of a COMPLETED trip; repeating it is fine (the first time is kept).
 */
exports.ackReceipt = async (req, res) => {
  try {
    const body = req.body || {};
    const tripId = String(body.ride_id ?? body.trip_id ?? '').trim();
    const userId = String(body.user_id ?? '').trim();
    if (!tripId || !userId) {
      return res.status(400).json({ success: false, message: 'Missing required fields: ride_id, user_id' });
    }
    const trip = await TripDetails.findOne({ trip_id: tripId }).lean();
    if (!trip) return res.status(404).json({ success: false, message: 'Ride not found', data: { ride_id: tripId } });
    if (trip.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'You can only update your own ride', data: { ride_id: tripId } });
    }
    if (trip.status !== 'COMPLETED') {
      return res.status(409).json({ success: false, message: 'Only a finished ride has a receipt', data: { ride_id: tripId, status: trip.status } });
    }
    if (!trip.rider_receipt_ack_at) {
      const now = new Date();
      await TripDetails.findOneAndUpdate({ trip_id: tripId, rider_receipt_ack_at: null }, { $set: { rider_receipt_ack_at: now, updated_at: now } }, { new: true });
    }
    res.status(200).json({ success: true, message: 'Receipt acknowledged', data: { ride_id: tripId } });
  } catch (error) {
    console.error('[ackReceipt]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to acknowledge the receipt' });
  }
};

const STATUS_TRANSITIONS = {
  DRIVER_ON_THE_WAY: ['ACCEPTED'],
  ARRIVED: ['DRIVER_ON_THE_WAY'],
  ON_GOING: ['ARRIVED'],
  COMPLETED: ['ON_GOING']
};

const STATUS_MESSAGES = {
  DRIVER_ON_THE_WAY: 'Driver is on the way',
  ARRIVED: 'Driver has arrived',
  ON_GOING: 'Trip started',
  COMPLETED: 'Trip completed'
};

/**
 * Fare for a finished trip. Returns the fare stored on the trip; if the trip predates fares, computes it from the
 * saved pickup/drop and the driver's vehicle type, stores it, and returns it. Returns null if it cannot be computed.
 */
async function ensureTripFare(tripDetails) {
  try {
    if (tripDetails.fare != null) {
      return {
        fare: tripDetails.fare,
        currency: tripDetails.currency || 'INR',
        distance_km: tripDetails.distance_km,
        estimated_duration_min: tripDetails.estimated_duration_min,
        fare_basis: tripDetails.fare_basis || 'ESTIMATE',
        payment_mode: tripDetails.payment_mode || 'CASH'
      };
    }
    const driver = await createModel('drivers').findOne({ driverId: tripDetails.driver_id }).select('vehicleType').lean();
    const estimate = estimateTrip({
      pickup: { lat: tripDetails.pickup.lat, lng: tripDetails.pickup.lng },
      drop: { lat: tripDetails.drop.lat, lng: tripDetails.drop.lng },
      vehicleType: driver && driver.vehicleType
    });
    const fields = {
      fare: estimate.fare,
      currency: estimate.currency,
      distance_km: estimate.distance_km,
      estimated_duration_min: estimate.duration_min,
      fare_basis: estimate.fare_basis,
      payment_mode: 'CASH'
    };
    await TripDetails.updateOne({ trip_id: tripDetails.trip_id }, { $set: fields });
    return fields;
  } catch (e) {
    console.warn('[ensureTripFare] could not compute fare for', tripDetails && tripDetails.trip_id, e.message);
    return null;
  }
}

/**
 * Notify the rider (user who requested the ride) when driver updates trip status.
 * Socket for in-app; FCM when user has a token (same payload as trip_details flow).
 */
async function notifyRiderRideStatusUpdated(userId, tripId, status, fareInfo) {
  if (!userId || typeof userId !== 'string' || !String(userId).trim()) return;
  const uid = String(userId).trim();
  // Fare/distance travel with the COMPLETED update so the rider's receipt shows the real numbers.
  const fareData = fareInfo
    ? {
        fare: String(fareInfo.fare),
        currency: String(fareInfo.currency || ''),
        distance_km: String(fareInfo.distance_km ?? ''),
        payment_mode: String(fareInfo.payment_mode || 'CASH')
      }
    : {};
  emitToUser(uid, 'ride_status_updated', { trip_id: tripId, status, ...(fareInfo || {}) });
  try {
    const bodyMsg =
      status === 'ARRIVED'
        ? 'Driver has arrived'
        : status === 'ON_GOING'
          ? 'Trip started'
          : status === 'COMPLETED'
            ? 'Trip completed'
            : 'Driver is on the way';
    await sendPushToUser(uid, {
      title: 'Ride update',
      body: bodyMsg,
      channelId: 'user_notifications',
      data: { type: 'ride_status_updated', trip_id: String(tripId), status, ...fareData },
      dataOnly: true
    });
  } catch (pushErr) {
    if (process.env.NODE_ENV === 'development') console.warn('[updateTripStatus] Push to user failed:', pushErr.message);
  }
}

/**
 * PATCH /api/v1/rides/:tripId/status
 * Update status: DRIVER_ON_THE_WAY | ARRIVED | ON_GOING | COMPLETED. Body: { status }
 * Flow: ACCEPTED → DRIVER_ON_THE_WAY → ARRIVED → ON_GOING → COMPLETED
 * Supports both trips (rides flow) and trip_details (trips/create-request flow).
 */
exports.updateTripStatus = async (req, res) => {
  try {
    const tripId = (req.params.tripId || '').trim();
    const status = (req.body && req.body.status) ? String(req.body.status).trim().toUpperCase().replace(/-/g, '_') : '';
    if (!tripId) {
      return res.status(400).json({ success: false, message: 'tripId is required' });
    }
    const allowedStatuses = Object.keys(STATUS_TRANSITIONS);
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${allowedStatuses.join(', ')}`,
        data: { allowed: allowedStatuses }
      });
    }

    const now = new Date();
    const updatePayload = {
      status,
      ...(status === 'DRIVER_ON_THE_WAY' && { driver_on_the_way_at: now }),
      ...(status === 'ARRIVED' && { arrived_at: now }),
      ...(status === 'ON_GOING' && { started_at: now }),
      ...(status === 'COMPLETED' && { completed_at: now }),
      updated_at: now
    };

    // Try trip_details first (trips/create-request flow - User app)
    let tripDetails = await TripDetails.findOne({ trip_id: tripId });
    if (tripDetails) {
      const ownerCheck = assertAuthenticatedDriverOwnsTrip(req, tripDetails.driver_id);
      if (!ownerCheck.ok) {
        return res.status(ownerCheck.status).json({ success: false, message: ownerCheck.message });
      }
      const allowedFrom = STATUS_TRANSITIONS[status];
      if (!allowedFrom.includes(tripDetails.status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot set status to ${status} from ${tripDetails.status}. Allowed previous: ${allowedFrom.join(', ')}`,
          data: { trip_id: tripId, current_status: tripDetails.status }
        });
      }
      if (status === 'ON_GOING') {
        // Starting the trip needs the rider's 4-digit code (TRIP_START_OTP=on). A repeated tap on a trip that has already
        // started (status already ON_GOING) never reaches here because the transition check above refuses it first.
        const supplied = req.body && (req.body.otp ?? req.body.start_otp ?? req.body.code);
        const verdict = tripStartOtp.check(tripDetails, supplied);
        if (!verdict.ok) {
          if (verdict.code === 'OTP_INVALID') {
            await TripDetails.updateOne({ trip_id: tripId }, { $inc: { start_otp_attempts: 1 } });
          }
          return res.status(verdict.status).json({
            success: false,
            message: verdict.message,
            error: verdict.code,
            data: { code: verdict.code, trip_id: tripId }
          });
        }
        // proof, kept on the trip, that this start went through the code check
        if (tripStartOtp.enabled()) updatePayload.start_otp_verified_at = now;
      }
      const moved = await TripDetails.findOneAndUpdate(
        { trip_id: tripId, status: tripDetails.status },
        { $set: updatePayload },
        { new: true }
      );
      if (!moved) {
        // the trip changed (cancelled, or the same step was already applied) after it was read: do not overwrite it
        const latest = await TripDetails.findOne({ trip_id: tripId });
        const latestStatus = latest ? latest.status : 'UNKNOWN';
        const alreadyThere = latestStatus === status; // a repeated tap on the same step is a success, not an error
        return res.status(alreadyThere ? 200 : 409).json({
          success: alreadyThere,
          trip_id: tripId,
          status: latestStatus,
          message: alreadyThere ? (STATUS_MESSAGES[status] || status) : `Cannot set status to ${status}: the trip is now ${latestStatus}`,
          data: { trip_id: tripId, current_status: latestStatus }
        });
      }
      // On completion make sure the trip has a fare (trips created before fares existed get one computed now).
      const fareInfo = status === 'COMPLETED' ? await ensureTripFare(tripDetails) : null;
      // the rider's invoice is issued as the trip completes; a failure here never fails the completion (it is issued on first read instead)
      if (status === 'COMPLETED') {
        try { await issueForTrip(await TripDetails.findOne({ trip_id: tripId }).lean()); } catch (e) { console.warn('[invoice] not issued at completion for', tripId, e.message); }
      }
      await notifyRiderRideStatusUpdated(tripDetails.user_id, tripId, status, fareInfo);
      return res.status(200).json({
        success: true,
        trip_id: tripId,
        status,
        message: STATUS_MESSAGES[status] || status,
        ...(fareInfo || {})
      });
    }

    // Fallback: trips collection (rides flow)
    const trip = await Trip.findOne({ trip_id: tripId });
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found', data: { trip_id: tripId } });
    }
    const allowedFrom = STATUS_TRANSITIONS[status];
    if (!allowedFrom.includes(trip.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot set status to ${status} from ${trip.status}. Allowed previous: ${allowedFrom.join(', ')}`,
        data: { trip_id: tripId, current_status: trip.status }
      });
    }
    if (status === 'DRIVER_ON_THE_WAY') trip.driver_on_the_way_at = now;
    else if (status === 'ARRIVED') trip.arrived_at = now;
    else if (status === 'ON_GOING') trip.started_at = now;
    else if (status === 'COMPLETED') trip.completed_at = now;
    trip.status = status;
    await trip.save();

    const timestampField = status === 'DRIVER_ON_THE_WAY' ? 'driver_on_the_way_at' : status === 'ARRIVED' ? 'arrived_at' : status === 'ON_GOING' ? 'started_at' : 'completed_at';
    await logTripEvent(tripId, status, { [timestampField]: now.toISOString() });

    await notifyRiderRideStatusUpdated(trip.user_id, tripId, status);

    res.status(200).json({ success: true, trip_id: tripId, status, message: STATUS_MESSAGES[status] || status });
  } catch (error) {
    console.error('[updateTripStatus]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to update status' });
  }
};

/**
 * GET /api/v1/rides/active
 * For driver or user landing on page: returns current incomplete ride (if any).
 * Reads from trip_details collection. Query: user_id OR driver_id (one required).
 */
/** A finished trip is offered again on the next app start for this long if its receipt was never dismissed. */
const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000;

exports.getActiveRide = async (req, res) => {
  try {
    const userId = (req.query.user_id != null && req.query.user_id !== '') ? String(req.query.user_id).trim() : null;
    const driverId = (req.query.driver_id != null && req.query.driver_id !== '') ? String(req.query.driver_id).trim() : null;

    if (!userId && !driverId) {
      return res.status(400).json({
        success: false,
        message: 'Provide either user_id or driver_id in query',
        data: { active_ride: null }
      });
    }

    const query = { status: { $in: ACTIVE_STATUSES_TRIP_DETAILS } };
    if (userId) query.user_id = userId;
    if (driverId) query.driver_id = driverId;

    let trip = await TripDetails.findOne(query).sort({ requested_at: -1 }).lean();
    let needsReceipt = false;
    if (!trip && userId && !driverId) {
      // nothing is live: offer a recently finished trip the rider has not seen the receipt of yet (the app was closed
      // when it ended). Once the receipt is dismissed or the trip is rated it is never offered again.
      const since = new Date(Date.now() - RECEIPT_WINDOW_MS);
      const done = await TripDetails.find({ user_id: userId, status: 'COMPLETED' }).sort({ completed_at: -1 }).limit(5).lean();
      const pending = (done || []).find((t) => !t.rider_receipt_ack_at && !(t.rider_rating && t.rider_rating.stars)
        && t.completed_at && new Date(t.completed_at) >= since);
      if (pending) { trip = pending; needsReceipt = true; }
    }
    if (!trip) {
      return res.status(200).json({
        success: true,
        message: 'No active ride found',
        data: { active_ride: null }
      });
    }

    const { _id, __v, start_otp_attempts, ...rideRecord } = trip; // internal counter, never part of a payload
    if (needsReceipt) rideRecord.needs_receipt = true;
    // a driver looking at an offer sees what the push carried: who is asking, how far the pickup is, how many rides they have done
    if (driverId && trip.status === 'REQUESTED') {
      try {
        const [rider, drv] = await Promise.all([
          createModel('users').findOne({ userId: trip.user_id }).lean(),
          createModel('drivers').findOne({ driverId }).lean()
        ]);
        const extras = await require('../lib/rideOffer').offerExtras(trip, drv);
        rideRecord.rider_name = rider ? ([rider.firstName, rider.lastName].filter(Boolean).join(' ').trim() || rider.fullName || null) : null;
        rideRecord.pickup_distance_km = extras.pickup_distance === '' ? null : Number(extras.pickup_distance);
        rideRecord.pickup_eta_min = extras.pickup_eta_min === '' ? null : Number(extras.pickup_eta_min);
        rideRecord.rider_trips = extras.rider_trips === '' ? null : Number(extras.rider_trips);
        rideRecord.rider_rating = extras.rider_rating === '' ? null : Number(extras.rider_rating);
      } catch (e) { console.error('[getActiveRide offer]', e && e.message); }
    }
    res.status(200).json({
      success: true,
      message: needsReceipt ? 'Finished ride waiting for its receipt to be seen' : 'Active ride found',
      data: { active_ride: rideRecord }
    });
  } catch (error) {
    console.error('[getActiveRide]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to get active ride', data: { active_ride: null } });
  }
};

/**
 * GET /api/v1/rides/details
 * Fetch full ride details by trip_id/ride_id from trip_details collection.
 * Includes the other party's profile: when driver calls, returns user profile; when user calls, returns driver profile.
 */
exports.getRideDetails = async (req, res) => {
  try {
    const rideId = (req.query.ride_id ?? req.query.trip_id ?? '').toString().trim() || null;
    const userId = (req.query.user_id != null && req.query.user_id !== '') ? String(req.query.user_id).trim() : null;
    const driverId = (req.query.driver_id != null && req.query.driver_id !== '') ? String(req.query.driver_id).trim() : null;

    if (!rideId) {
      return res.status(400).json({
        success: false,
        message: 'trip_id or ride_id is required in query'
      });
    }
    if (!userId && !driverId) {
      return res.status(400).json({
        success: false,
        message: 'Provide user_id or driver_id in query to fetch ride details'
      });
    }

    const trip = await TripDetails.findOne({ trip_id: rideId }).lean();
    if (!trip) {
      return res.status(404).json({
        success: false,
        message: 'Ride not found',
        data: { ride_id: rideId }
      });
    }

    const isUser = userId && trip.user_id === userId;
    const isDriver = driverId && trip.driver_id === driverId;
    if (!isUser && !isDriver) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this ride',
        data: { ride_id: rideId }
      });
    }

    const { _id, __v, ...rideDetails } = trip;
    const data = { ...rideDetails };

    const UserModel = createModel('users');
    const DriverModel = createModel('drivers');

    if (isDriver) {
      const userDoc = await UserModel.findOne({ userId: trip.user_id });
      data.user = toUserProfileForDisplay(userDoc);
    }
    if (isUser) {
      const driverDoc = await DriverModel.findOne({ driverId: trip.driver_id });
      data.driver = toDriverProfileForDisplay(driverDoc);
      // where the driver is now and how far from the next stop (pickup until the ride starts, then the drop)
      const pos = driverDoc ? positionOf(driverDoc) : null;
      const live = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'].includes(trip.status);
      if (pos && live) {
        const p = presenceOf(driverDoc);
        data.driver_location = {
          lat: pos.lat,
          lng: pos.lng,
          heading: Number.isFinite(Number(driverDoc.locationHeading)) ? Number(driverDoc.locationHeading) : null,
          updated_at: driverDoc.locationUpdatedAt || null,
          state: p.state
        };
        // the business-uploaded top-view icon for this ride's category, so the map draws the right vehicle
        try {
          const riderDoc = await UserModel.findOne({ userId: trip.user_id });
          const cfg = await loadPricingConfig(riderDoc ? await tenantForAccount(riderDoc) : req.appTenant || null);
          const cat = (cfg.categories || []).find((c) => c.categoryId === trip.category_id);
          if (cat && cat.mapIconUrl) data.driver_location.map_icon_url = cat.mapIconUrl;
        } catch (_) { /* the app falls back to its built-in icon */ }
        const target = trip.status === 'ON_GOING' ? trip.drop : trip.pickup;
        if (target && Number.isFinite(target.lat) && Number.isFinite(target.lng) && trip.status !== 'ARRIVED') {
          const km = haversineKm(pos, { lat: target.lat, lng: target.lng });
          data.eta = { minutes: etaMinutes(km), km: Math.round(km * 10) / 10, to: trip.status === 'ON_GOING' ? 'DROP' : 'PICKUP' };
        }
      }
      await addRideTypeNames([data]); // the ride type's name (VIP, Auto ...) for the screen
      // what cancelling right now would cost, so the rider is told before confirming (never a figure the app invents)
      if (['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED'].includes(trip.status)) {
        const preview = riderCancelFee(await cancellationPolicyOf(trip), trip, new Date());
        data.cancel_fee_now = preview.fee;
        data.cancel_fee_currency = preview.currency || trip.currency || null;
      }
      // The rider's start code (null unless TRIP_START_OTP=on and the driver is coming / has arrived). Never sent to the driver.
      const startCode = tripStartOtp.codeForRider(trip);
      if (startCode) data.start_otp = startCode; // absent unless the feature is on and a code is due
    }
    delete data.start_otp_attempts;

    res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[getRideDetails]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to get ride details' });
  }
};

/**
 * GET /api/v1/rides/:tripId
 */
/** True unless an authenticated actor is neither the rider nor the driver of [trip]. */
function mayReadTrip(req, trip) {
  const actor = req.authActorId;
  if (!actor) return true; // enforcement is off (local development)
  return trip.user_id === actor || trip.driver_id === actor;
}

exports.getTrip = async (req, res) => {
  try {
    const tripId = (req.params.tripId || '').trim();
    if (!tripId) {
      return res.status(400).json({ success: false, message: 'tripId is required' });
    }
    const trip = (await TripDetails.findOne({ trip_id: tripId }).lean()) || (await Trip.findOne({ trip_id: tripId }).lean());
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found', data: { trip_id: tripId } });
    }
    if (!mayReadTrip(req, trip)) {
      return res.status(403).json({ success: false, message: 'You can only view your own trips', data: null });
    }
    const { _id, __v, start_otp_attempts, ...rest } = trip;
    res.status(200).json({ success: true, data: rest });
  } catch (error) {
    console.error('[getTrip]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to get trip' });
  }
};

/**
 * GET /api/v1/rides
 * Query: user_id, driver_id, status (optional filters)
 */
/** Adds the ride type's name (VIP, Auto ...) to each trip, from its category, so a list can draw the right vehicle. */
async function addRideTypeNames(list) {
  try {
    const { forTenant } = require('../lib/tenantData');
    const { VehicleCategory } = require('../models/businessModels');
    const tenants = [...new Set(list.map((t) => t.tenant_id).filter(Boolean))];
    const names = {};
    for (const id of tenants) {
      (await forTenant(id).find(VehicleCategory).lean()).forEach((c) => { names[`${id}|${c.categoryId}`] = c.name; });
    }
    list.forEach((t) => { t.vehicle_type = names[`${t.tenant_id}|${t.category_id}`] || null; });
  } catch (_) { /* the list works without it */ }
}

/**
 * GET /api/v1/rides/:tripId/invoice[.pdf]: the rider's invoice for a completed trip (or for the charge after a cancellation).
 * Only the rider of the trip may read it; it is issued on first request if it was not already, and never changes afterwards.
 */
async function loadInvoice(req, res) {
  const tripId = String(req.params.tripId || '').trim();
  const trip = await TripDetails.findOne({ trip_id: tripId }).lean();
  if (!trip) { res.status(404).json({ success: false, message: 'Trip not found', data: null }); return null; }
  if (!req.authActorId || trip.user_id !== req.authActorId || req.authRole !== 'user') {
    res.status(403).json({ success: false, message: 'You can only view your own invoices', data: null });
    return null;
  }
  const invoice = await issueForTrip(trip);
  if (!invoice) { res.status(404).json({ success: false, message: 'There is no invoice for this trip. Invoices are issued for completed trips and for cancellation charges.', data: null }); return null; }
  return invoice;
}

exports.getTripInvoice = async (req, res) => {
  try {
    const invoice = await loadInvoice(req, res);
    if (!invoice) return;
    res.status(200).json({ success: true, data: invoiceToPublic(invoice) });
  } catch (error) {
    console.error('[getTripInvoice]', error);
    res.status(500).json({ success: false, message: 'Could not load the invoice', data: null });
  }
};

exports.getTripInvoicePdf = async (req, res) => {
  try {
    const invoice = await loadInvoice(req, res);
    if (!invoice) return;
    const pub = invoiceToPublic(invoice);
    const pdf = await require('../lib/riderInvoicePdf').renderRiderInvoice(pub);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="' + pub.invoiceNumber + '.pdf"', 'Cache-Control': 'private, no-store' });
    res.status(200).send(pdf);
  } catch (error) {
    console.error('[getTripInvoicePdf]', error);
    res.status(500).json({ success: false, message: 'Could not create the invoice PDF', data: null });
  }
};

/**
 * What a rider's trip list may show: rides a driver actually took (accepted, in progress, completed, or cancelled after
 * accepting). Requests that were never accepted (still searching, no driver found, declined, cancelled while searching)
 * are for the business's analytics, not the rider.
 */
const RIDER_LIST_STATUSES = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING', 'COMPLETED', 'CANCELLED_BY_USER', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE', 'CANCELLED_BY_DRIVER'];
const CANCELLED_NEEDS_ACCEPT = ['CANCELLED_BY_USER', 'CANCELLED_BY_DRIVER'];
function riderMayListTrip(t) {
  if (!RIDER_LIST_STATUSES.includes(t.status)) return false;
  if (CANCELLED_NEEDS_ACCEPT.includes(t.status)) return !!t.responded_at;
  return true;
}

exports.listTrips = async (req, res) => {
  try {
    const query = {};
    if (req.query.user_id) query.user_id = String(req.query.user_id).trim();
    if (req.query.driver_id) query.driver_id = String(req.query.driver_id).trim();
    if (req.query.status) {
      const s = String(req.query.status).trim().toUpperCase();
      if (TRIP_STATUSES.includes(s)) query.status = s;
    }
    if (!query.user_id && !query.driver_id) {
      return res.status(400).json({
        success: false,
        message: 'At least one of user_id or driver_id is required'
      });
    }
    const limit = Math.min(Math.max(0, parseInt(req.query.limit, 10) || 20), 100);
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    // trips are kept in trip_details (the booking record the apps and dispatch use)
    const riderOnly = !!query.user_id && !query.driver_id;
    if (riderOnly && !query.status) query.status = { $in: RIDER_LIST_STATUSES };
    let trips = await TripDetails.find(query).sort({ requested_at: -1, trip_id: -1 }).skip(skip).limit(limit).lean();
    // paging is counted on what was read, before the rider-visibility filter below drops any rows
    const read = trips.length;
    if (riderOnly) trips = trips.filter(riderMayListTrip);
    const list = trips.map(({ _id, __v, start_otp_attempts, ...t }) => t);
    await addRideTypeNames(list);
    res.status(200).json({
      success: true,
      data: list,
      count: list.length,
      has_more: read === limit,
      next_skip: skip + read
    });
  } catch (error) {
    console.error('[listTrips]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to list trips' });
  }
};

/**
 * GET /api/v1/rides/:tripId/timeline
 * Audit / trip movement timestamps.
 */
exports.getTripTimeline = async (req, res) => {
  try {
    const tripId = (req.params.tripId || '').trim();
    if (!tripId) {
      return res.status(400).json({ success: false, message: 'tripId is required' });
    }
    const exists = await Trip.findOne({ trip_id: tripId }).select('trip_id user_id driver_id').lean();
    if (!exists) {
      return res.status(404).json({ success: false, message: 'Trip not found', data: { trip_id: tripId } });
    }
    if (!mayReadTrip(req, exists)) {
      return res.status(403).json({ success: false, message: 'You can only view your own trips', data: null });
    }
    const events = await TripEvent.find({ trip_id: tripId }).sort({ created_at: 1 }).lean();
    const timeline = events.map(({ _id, __v, ...e }) => ({ ...e, created_at: e.created_at }));
    res.status(200).json({ success: true, data: { trip_id: tripId, timeline } });
  } catch (error) {
    console.error('[getTripTimeline]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to get timeline' });
  }
};

/**
 * POST /api/v1/rides/check-timeouts
 * Mark REQUESTED trips older than DRIVER_RESPONSE_TIMEOUT_SECONDS as NO_RESPONSE.
 * Notifies driver (FCM + Socket) so driver app can hide accept/reject view.
 * Call from a cron job (e.g. every minute).
 */
exports.checkTimeouts = async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - DRIVER_RESPONSE_TIMEOUT_SECONDS * 1000);
    const toUpdate = await Trip.find({ status: 'REQUESTED', requested_at: { $lt: cutoff } }).select('trip_id driver_id').lean();
    const tripIds = toUpdate.map((t) => t.trip_id);
    if (tripIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'Timeout check completed',
        data: { marked_no_response: 0, timeout_seconds: DRIVER_RESPONSE_TIMEOUT_SECONDS }
      });
    }
    const updated = await Trip.updateMany(
      { trip_id: { $in: tripIds } },
      { $set: { status: 'NO_RESPONSE', updatedAt: new Date() } }
    );
    for (const t of toUpdate) {
      await logTripEvent(t.trip_id, 'NO_RESPONSE', { reason: 'driver_response_timeout', timeout_seconds: DRIVER_RESPONSE_TIMEOUT_SECONDS });
      if (t.driver_id) {
        try {
          emitToDriver(t.driver_id, 'ride_request_timeout', {
            trip_id: t.trip_id,
            status: 'NO_RESPONSE',
            message: 'Ride timed out'
          });
        } catch (e) {
          if (process.env.NODE_ENV === 'development') console.warn('[checkTimeouts] Socket emit failed:', e.message);
        }
        const notifyResult = await sendPushToDriver(t.driver_id, {
          title: 'Ride timed out',
          body: 'The ride request has expired. You can hide the accept/reject view.',
          channelId: 'driver_notifications',
          data: { type: 'ride_request_timeout', trip_id: t.trip_id, status: 'NO_RESPONSE' },
          dataOnly: true
        });
        if (!notifyResult.success) console.warn('[checkTimeouts] FCM failed:', notifyResult.error, { driverId: t.driver_id });
      }
    }
    res.status(200).json({
      success: true,
      message: 'Timeout check completed',
      data: {
        marked_no_response: updated.modifiedCount,
        timeout_seconds: DRIVER_RESPONSE_TIMEOUT_SECONDS
      }
    });
  } catch (error) {
    console.error('[checkTimeouts]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to check timeouts' });
  }
};
