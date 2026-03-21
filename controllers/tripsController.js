const { createModel } = require('../models/dynamicModel');
const { TripDetails } = require('../models/tripDetailsModel');
const { getNextTripId } = require('../models/tripCounterModel');
const { emitToDriver, emitToUser } = require('../config/socket');
const { registerWaiter, resolveWaiter } = require('../lib/tripWaitResolver');
const { isDriverReachable, getDriverFcmInfo, sendRideRequestPushWithRetry } = require('../lib/fcmTripPush');
const { sendPushToDriver, sendPushToUser } = require('../lib/pushNotification');

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
    }
  });
  if (process.env.NODE_ENV === 'development' && !result.success) console.warn('[notifyDriverRideTimeout] FCM failed:', result.error);
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
    data
  });
  if (process.env.NODE_ENV === 'development' && !result.success) console.warn('[notifyUserDriverResponse] FCM failed:', result.error);
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
exports.createRequest = async (req, res) => {
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

    if (!requestId || !userId || !driverId || !pickupAddress || !dropAddress) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: request_id, user_id, driver_id, pickup_address, drop_address'
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
    const [user, driver] = await Promise.all([
      UserModel.findOne({ userId }).lean(),
      DriverModel.findOne({ driverId }).lean()
    ]);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found', data: { user_id: userId } });
    }
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

    const { fcmToken: driverFcmToken } = getDriverFcmInfo(driver);
    const tripId = await getNextTripId();
    const timeoutAt = new Date(now.getTime() + DRIVER_RESPONSE_TIMEOUT_MS);

    // Create trip in DB BEFORE sending push so driver-response finds it
    const trip = await TripDetails.create({
      trip_id: tripId,
      request_id: requestId,
      user_id: userId,
      driver_id: driverId,
      pickup: { address: pickupAddress, lat: pickupLat, lng: pickupLng },
      drop: { address: dropAddress, lat: dropLat, lng: dropLng },
      ride_note: rideNote || undefined,
      status: 'REQUESTED',
      requested_at: now,
      timeout_at: timeoutAt,
      push_sent: false
    });

    const riderName = user
      ? [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.fullName || null
      : null;
    const pushPayload = {
      pickup_address: pickupAddress,
      drop_address: dropAddress,
      pickup_lat: pickupLat,
      pickup_lng: pickupLng,
      drop_lat: dropLat,
      drop_lng: dropLng,
      ride_note: rideNote || '',
      rider_name: riderName || ''
    };
    const pushResult = await sendRideRequestPushWithRetry(
      driverFcmToken,
      tripId,
      pushPayload,
      { DriverModel, driverId }
    );

    if (!pushResult.success) {
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

    const waitForDriver = new Promise((resolve) => {
      registerWaiter(tripId, resolve, resolve);
    });
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ _timeout: true }), DRIVER_RESPONSE_TIMEOUT_MS);
    });

    const outcome = await Promise.race([waitForDriver, timeoutPromise]);

    let finalStatus = outcome.status;
    let success = outcome.success;
    let message = outcome.message;

    if (outcome._timeout) {
      const updated = await TripDetails.findOneAndUpdate(
        { trip_id: tripId, status: 'REQUESTED' },
        { $set: { status: 'NO_RESPONSE', driver_response: 'NO_RESPONSE', updated_at: new Date() } },
        { new: true }
      );
      if (updated) {
        finalStatus = 'NO_RESPONSE';
        success = false;
        message = 'No response from driver';
        emitToUser(userId, 'ride_request_timeout', { trip_id: tripId, request_id: requestId, status: finalStatus, message });
        await notifyDriverRideTimeout(updated.driver_id, updated.trip_id, updated.request_id);
      } else {
        const current = await TripDetails.findOne({ trip_id: tripId }).lean();
        if (current) {
          finalStatus = current.status;
          success = current.status === 'ACCEPTED';
          message = current.status === 'ACCEPTED' ? 'Driver accepted your request' : current.status === 'REJECTED' || current.status === 'REJECTED_WITH_REASON' ? 'Driver rejected the request' : 'No response from driver';
        }
      }
    }

    if (success === undefined) {
      if (finalStatus === 'ACCEPTED') {
        success = true;
        message = 'Driver accepted your request';
      } else if (finalStatus === 'REJECTED' || finalStatus === 'REJECTED_WITH_REASON') {
        success = false;
        message = 'Driver rejected the request';
      } else {
        success = false;
        message = message || 'No response from driver';
      }
    }

    res.status(200).json({
      success: success !== false,
      trip_id: tripId,
      request_id: requestId,
      status: finalStatus,
      message: message || (success ? 'Driver accepted your request' : 'Driver rejected the request')
    });
  } catch (error) {
    console.error('[trips createRequest]', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create trip request'
    });
  }
};

/**
 * POST /api/v1/trips/cancel-request
 * Body: trip_id, cancelled_by (USER | DRIVER)
 * Cancels a trip that is still in REQUESTED status (before driver accepts).
 */
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

    // Resolve any pending waiter so create-request returns immediately
    resolveWaiter(tripId, { success: false, status: newStatus, message: `Ride cancelled by ${cancelledBy.toLowerCase()}` });

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
      resolveWaiter(tripId, result);
      emitToUser(trip.user_id, 'ride_request_timeout', { trip_id: tripId, request_id: requestId, status: 'NO_RESPONSE', message: 'No response from driver' });
      await notifyDriverRideTimeout(trip.driver_id, tripId, requestId);
      return res.status(200).json(result);
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
    await TripDetails.updateOne({ trip_id: tripId }, { $set: update });

    const success = newStatus === 'ACCEPTED';
    const message = success ? 'Driver accepted your request' : 'Driver rejected the request';
    const result = { success, trip_id: tripId, request_id: requestId, status: newStatus, message };

    resolveWaiter(tripId, result);

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
exports.checkTimeouts = async (req, res) => {
  try {
    const now = new Date();
    const toUpdate = await TripDetails.find({ status: 'REQUESTED', timeout_at: { $lt: now } }).select('trip_id request_id user_id driver_id').lean();
    const tripIds = toUpdate.map((t) => t.trip_id);
    if (tripIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'Timeout check completed',
        data: { marked_no_response: 0, timeout_seconds: DRIVER_RESPONSE_TIMEOUT_MS / 1000 }
      });
    }
    await TripDetails.updateMany(
      { trip_id: { $in: tripIds } },
      { $set: { status: 'NO_RESPONSE', driver_response: 'NO_RESPONSE', updated_at: now } }
    );
    for (const t of toUpdate) {
      resolveWaiter(t.trip_id, { success: false, status: 'NO_RESPONSE', message: 'No response from driver' });
      emitToUser(t.user_id, 'ride_request_timeout', { trip_id: t.trip_id, request_id: t.request_id, status: 'NO_RESPONSE', message: 'No response from driver' });
      await notifyDriverRideTimeout(t.driver_id, t.trip_id, t.request_id);
    }
    res.status(200).json({
      success: true,
      message: 'Timeout check completed',
      data: {
        marked_no_response: tripIds.length,
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
