/**
 * Ride Action Service – atomic status updates with race-condition handling.
 * Uses findOneAndUpdate with status in filter for single-document atomicity (no SELECT FOR UPDATE needed in MongoDB).
 */

const { getNextTripId } = require('../models/tripCounterModel');
const {
  Ride,
  RideStatus,
  RIDE_STATUSES,
  terminalStatuses,
  cancellableStatuses,
  acceptRejectStatus
} = require('../models/rideModel');

const ALLOW_USER_CANCEL_AFTER_ACCEPT = process.env.ALLOW_USER_CANCEL_AFTER_ACCEPT !== 'false';

/**
 * Create a ride request (REQUESTED). Used so action APIs have rides to act on.
 */
async function createRideRequest({ userId, driverId, pickup, drop, rideNote = null }) {
  const rideId = await getNextTripId();
  const now = new Date();
  const ride = await Ride.create({
    ride_id: rideId,
    user_id: userId,
    driver_id: driverId,
    pickup: { address: pickup.address, lat: pickup.lat, lng: pickup.lng },
    drop: { address: drop.address, lat: drop.lat, lng: drop.lng },
    ride_note: rideNote || undefined,
    status: RideStatus.REQUESTED,
    requested_at: now,
    created_at: now,
    updated_at: now
  });
  return ride.toObject();
}

/**
 * Driver Accept Ride (atomic).
 * Case: User cancels while driver accepts → Accept fails if ride already CANCELLED.
 * Case: Multiple drivers try to accept → Only first success (filter by status REQUESTED + ride's driver_id).
 */
async function acceptRide(rideId, driverId) {
  const now = new Date();
  const updated = await Ride.findOneAndUpdate(
    {
      ride_id: rideId,
      driver_id: driverId,
      status: acceptRejectStatus
    },
    {
      $set: {
        status: RideStatus.ACCEPTED,
        accepted_at: now,
        updated_at: now
      }
    },
    { new: true }
  ).lean();

  if (updated) {
    return { success: true, ride: updated, code: 'ACCEPTED' };
  }

  const current = await Ride.findOne({ ride_id: rideId }).select('status driver_id').lean();
  if (!current) {
    return { success: false, code: 'NOT_FOUND', message: 'Ride not found' };
  }
  if (terminalStatuses.includes(current.status)) {
    if (current.status === RideStatus.CANCELLED) {
      return { success: false, code: 'ALREADY_CANCELLED', message: 'Ride was already cancelled', currentStatus: current.status };
    }
    if (current.status === RideStatus.REJECTED) {
      return { success: false, code: 'ALREADY_REJECTED', message: 'Ride was already rejected', currentStatus: current.status };
    }
    if (current.status === RideStatus.COMPLETED) {
      return { success: false, code: 'ALREADY_COMPLETED', message: 'Ride already completed', currentStatus: current.status };
    }
  }
  if (current.status === RideStatus.ACCEPTED) {
    return { success: false, code: 'ALREADY_ACCEPTED', message: 'Ride was already accepted by driver', currentStatus: current.status };
  }
  if (current.status !== acceptRejectStatus) {
    return { success: false, code: 'INVALID_STATE', message: `Ride cannot be accepted from status: ${current.status}`, currentStatus: current.status };
  }
  if (current.driver_id && current.driver_id !== driverId) {
    return { success: false, code: 'DRIVER_MISMATCH', message: 'This ride is assigned to another driver', currentStatus: current.status };
  }

  return { success: false, code: 'EXPIRED_OR_CONFLICT', message: 'Request expired or another action was taken', currentStatus: current.status };
}

/**
 * Driver Reject Ride (atomic).
 */
async function rejectRide(rideId, driverId, rejectReason = null) {
  const now = new Date();
  const updated = await Ride.findOneAndUpdate(
    {
      ride_id: rideId,
      driver_id: driverId,
      status: acceptRejectStatus
    },
    {
      $set: {
        status: RideStatus.REJECTED,
        rejected_at: now,
        reject_reason: rejectReason || undefined,
        updated_at: now
      }
    },
    { new: true }
  ).lean();

  if (updated) {
    return { success: true, ride: updated, code: 'REJECTED' };
  }

  const current = await Ride.findOne({ ride_id: rideId }).select('status driver_id').lean();
  if (!current) {
    return { success: false, code: 'NOT_FOUND', message: 'Ride not found' };
  }
  if (current.status === RideStatus.REJECTED) {
    return { success: false, code: 'ALREADY_REJECTED', message: 'Ride was already rejected', currentStatus: current.status };
  }
  if (current.status === RideStatus.ACCEPTED || current.status === RideStatus.STARTED || current.status === RideStatus.COMPLETED) {
    return { success: false, code: 'INVALID_STATE', message: `Ride cannot be rejected from status: ${current.status}`, currentStatus: current.status };
  }
  if (current.status === RideStatus.CANCELLED) {
    return { success: false, code: 'ALREADY_CANCELLED', message: 'Ride was already cancelled', currentStatus: current.status };
  }
  if (current.driver_id && current.driver_id !== driverId) {
    return { success: false, code: 'DRIVER_MISMATCH', message: 'This ride is assigned to another driver', currentStatus: current.status };
  }

  return { success: false, code: 'EXPIRED_OR_CONFLICT', message: 'Request expired or another action was taken', currentStatus: current.status };
}

/**
 * User Cancel Ride (atomic).
 * Allowed when status is REQUESTED; when ACCEPTED only if ALLOW_USER_CANCEL_AFTER_ACCEPT is true.
 */
async function cancelRide(rideId, userId, cancellationReason = null) {
  const allowedStatuses = ALLOW_USER_CANCEL_AFTER_ACCEPT ? cancellableStatuses : [RideStatus.REQUESTED];
  const now = new Date();

  const updated = await Ride.findOneAndUpdate(
    {
      ride_id: rideId,
      user_id: userId,
      status: { $in: allowedStatuses }
    },
    {
      $set: {
        status: RideStatus.CANCELLED,
        cancelled_at: now,
        cancellation_reason: cancellationReason || undefined,
        cancelled_by: 'USER',
        updated_at: now
      }
    },
    { new: true }
  ).lean();

  if (updated) {
    return { success: true, ride: updated, code: 'CANCELLED' };
  }

  const current = await Ride.findOne({ ride_id: rideId }).select('status user_id').lean();
  if (!current) {
    return { success: false, code: 'NOT_FOUND', message: 'Ride not found' };
  }
  if (current.user_id !== userId) {
    return { success: false, code: 'FORBIDDEN', message: 'You can only cancel your own ride', currentStatus: current.status };
  }
  if (current.status === RideStatus.CANCELLED) {
    return { success: false, code: 'ALREADY_CANCELLED', message: 'Ride was already cancelled', currentStatus: current.status };
  }
  if (current.status === RideStatus.STARTED || current.status === RideStatus.COMPLETED) {
    return { success: false, code: 'INVALID_STATE', message: 'Ride cannot be cancelled once started or completed', currentStatus: current.status };
  }
  if (current.status === RideStatus.ACCEPTED && !ALLOW_USER_CANCEL_AFTER_ACCEPT) {
    return { success: false, code: 'CANCEL_AFTER_ACCEPT_NOT_ALLOWED', message: 'Cancellation after driver acceptance is not allowed', currentStatus: current.status };
  }

  return { success: false, code: 'EXPIRED_OR_CONFLICT', message: 'Ride state changed; cancellation not applied', currentStatus: current.status };
}

/**
 * Get ride by id (for responses).
 */
async function getRideById(rideId) {
  return Ride.findOne({ ride_id: rideId }).lean();
}

module.exports = {
  createRideRequest,
  acceptRide,
  rejectRide,
  cancelRide,
  getRideById,
  RideStatus,
  RIDE_STATUSES
};
