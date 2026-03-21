const { createModel } = require('../models/dynamicModel');
const { Trip, TRIP_STATUSES } = require('../models/tripModel');
const { TripDetails } = require('../models/tripDetailsModel');
const { getNextTripId } = require('../models/tripCounterModel');
const TripEvent = require('../models/tripEventModel');
const { sendPushToDriver, sendPushToUser } = require('../lib/pushNotification');
const { clearForDriver: clearTripRateLimitForDriver } = require('../lib/tripRateLimit');
const { emitToDriver, emitToUser } = require('../config/socket');

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
    vehicle_color: d.vehicleColor || null
  };
}

async function logTripEvent(tripId, event, payload = {}) {
  try {
    await TripEvent.create({ trip_id: tripId, event, payload });
  } catch (e) {
    if (process.env.NODE_ENV === 'development') console.warn('[trip_event]', e.message);
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

    const duplicate = await Trip.findOne({
      user_id: userId,
      driver_id: driverId,
      status: { $in: ACTIVE_STATUSES }
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'An active ride request already exists for this user and driver.',
        data: { trip_id: duplicate.trip_id, status: duplicate.status }
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
        type: 'ride_request',
        trip_id: tripId,
        user_id: userId,
        pickup_address: pickupAddress,
        drop_address: dropAddress
      }
    });
    if (process.env.NODE_ENV === 'development' && !notifyResult.success) {
      console.warn('[ride_request] FCM notify failed:', notifyResult.error);
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
    const rejectedReason = body.rejected_reason != null ? String(body.rejected_reason).trim() : null;
    const rejectedBy = (body.rejected_by && ['USER', 'DRIVER'].includes(String(body.rejected_by).toUpperCase()))
      ? String(body.rejected_by).toUpperCase()
      : 'DRIVER';

    if (!tripId) {
      return res.status(400).json({ success: false, message: 'tripId is required' });
    }
    if (!driverId) {
      return res.status(400).json({ success: false, message: 'driver_id is required in request body' });
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

    let source = 'trips';
    let trip = await Trip.findOne({
      $or: [
        { trip_id: rideOrRequestId },
        { request_id: rideOrRequestId }
      ]
    });
    if (!trip) {
      source = 'trip_details';
      trip = await TripDetails.findOne({
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
    const driverId = trip.driver_id;
    if (cancelStage === 'before_accept' && driverId) {
      clearTripRateLimitForDriver(driverId);
    }
    if (source === 'trip_details') {
      await TripDetails.updateOne(
        { _id: trip._id },
        {
          $set: {
            status: newStatus,
            driver_response: newStatus,
            cancellation_reason: cancellationReason || null,
            cancelled_at: now,
            cancel_stage: cancelStage,
            cancelled_by: 'USER',
            updated_at: now
          }
        }
      );
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
        }
      });
      if (process.env.NODE_ENV === 'development' && !notifyResult.success) {
        console.warn('[cancelRideByUser] FCM notify failed:', notifyResult.error);
      }
    }

    res.status(200).json({
      success: true,
      trip_id: resolvedRideId,
      request_id: resolvedRequestId,
      status: newStatus,
      message: cancelStage === 'before_accept' ? 'Ride cancelled before driver acceptance' : 'Ride cancelled after driver acceptance'
    });
  } catch (error) {
    console.error('[cancelRideByUser]', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to cancel ride' });
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
 * Notify the rider (user who requested the ride) when driver updates trip status.
 * Socket for in-app; FCM when user has a token (same payload as trip_details flow).
 */
async function notifyRiderRideStatusUpdated(userId, tripId, status) {
  if (!userId || typeof userId !== 'string' || !String(userId).trim()) return;
  const uid = String(userId).trim();
  emitToUser(uid, 'ride_status_updated', { trip_id: tripId, status });
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
      data: { type: 'ride_status_updated', trip_id: String(tripId), status }
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
      const allowedFrom = STATUS_TRANSITIONS[status];
      if (!allowedFrom.includes(tripDetails.status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot set status to ${status} from ${tripDetails.status}. Allowed previous: ${allowedFrom.join(', ')}`,
          data: { trip_id: tripId, current_status: tripDetails.status }
        });
      }
      await TripDetails.updateOne({ trip_id: tripId }, { $set: updatePayload });
      await notifyRiderRideStatusUpdated(tripDetails.user_id, tripId, status);
      return res.status(200).json({ success: true, trip_id: tripId, status, message: STATUS_MESSAGES[status] || status });
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

    const trip = await TripDetails.findOne(query).sort({ requested_at: -1 }).lean();
    if (!trip) {
      return res.status(200).json({
        success: true,
        message: 'No active ride found',
        data: { active_ride: null }
      });
    }

    const { _id, __v, ...rideRecord } = trip;
    res.status(200).json({
      success: true,
      message: 'Active ride found',
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
    }

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
exports.getTrip = async (req, res) => {
  try {
    const tripId = (req.params.tripId || '').trim();
    if (!tripId) {
      return res.status(400).json({ success: false, message: 'tripId is required' });
    }
    const trip = await Trip.findOne({ trip_id: tripId }).lean();
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found', data: { trip_id: tripId } });
    }
    const { _id, __v, ...rest } = trip;
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
    const trips = await Trip.find(query).sort({ requested_at: -1 }).skip(skip).limit(limit).lean();
    const list = trips.map(({ _id, __v, ...t }) => t);
    res.status(200).json({
      success: true,
      data: list,
      count: list.length
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
    const exists = await Trip.findOne({ trip_id: tripId }).select('trip_id').lean();
    if (!exists) {
      return res.status(404).json({ success: false, message: 'Trip not found', data: { trip_id: tripId } });
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
          data: { type: 'ride_request_timeout', trip_id: t.trip_id, status: 'NO_RESPONSE' }
        });
        if (process.env.NODE_ENV === 'development' && !notifyResult.success) console.warn('[checkTimeouts] FCM failed:', notifyResult.error);
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
