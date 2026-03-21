/**
 * Ride Action APIs – Driver Accept / Reject, User Cancel.
 * Idempotent; returns proper codes for Already Accepted / Already Cancelled / Expired.
 */

const rideActionService = require('../services/rideActionService');

function toRideDto(ride) {
  if (!ride) return null;
  const { _id, __v, ...rest } = ride;
  return rest;
}

/**
 * POST /api/v1/ride-actions/accept
 * Request: { ride_id, driver_id }
 */
async function driverAcceptRide(req, res) {
  try {
    const rideId = (req.body.ride_id ?? req.body.rideId ?? '').toString().trim();
    const driverId = (req.body.driver_id ?? req.body.driverId ?? '').toString().trim();

    if (!rideId || !driverId) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'ride_id and driver_id are required',
        data: null
      });
    }

    const result = await rideActionService.acceptRide(rideId, driverId);

    if (result.success) {
      return res.status(200).json({
        success: true,
        code: result.code,
        message: 'Ride accepted',
        data: { ride: toRideDto(result.ride) }
      });
    }

    switch (result.code) {
      case 'NOT_FOUND':
        return res.status(404).json({
          success: false,
          code: result.code,
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
      case 'ALREADY_ACCEPTED':
        return res.status(200).json({
          success: true,
          code: result.code,
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
      case 'ALREADY_CANCELLED':
      case 'ALREADY_REJECTED':
      case 'ALREADY_COMPLETED':
        return res.status(409).json({
          success: false,
          code: result.code,
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
      case 'DRIVER_MISMATCH':
      case 'FORBIDDEN':
        return res.status(403).json({
          success: false,
          code: result.code,
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
      case 'EXPIRED_OR_CONFLICT':
      case 'INVALID_STATE':
      default:
        return res.status(409).json({
          success: false,
          code: result.code || 'CONFLICT',
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
    }
  } catch (err) {
    console.error('[rideActionController.driverAcceptRide]', err);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: err.message || 'Failed to accept ride',
      data: null
    });
  }
}

/**
 * POST /api/v1/ride-actions/reject
 * Request: { ride_id, driver_id, reject_reason? }
 */
async function driverRejectRide(req, res) {
  try {
    const rideId = (req.body.ride_id ?? req.body.rideId ?? '').toString().trim();
    const driverId = (req.body.driver_id ?? req.body.driverId ?? '').toString().trim();
    const rejectReason = req.body.reject_reason != null ? String(req.body.reject_reason).trim() : null;

    if (!rideId || !driverId) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'ride_id and driver_id are required',
        data: null
      });
    }

    const result = await rideActionService.rejectRide(rideId, driverId, rejectReason);

    if (result.success) {
      return res.status(200).json({
        success: true,
        code: result.code,
        message: 'Ride rejected',
        data: { ride: toRideDto(result.ride) }
      });
    }

    switch (result.code) {
      case 'NOT_FOUND':
        return res.status(404).json({
          success: false,
          code: result.code,
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
      case 'ALREADY_REJECTED':
      case 'ALREADY_CANCELLED':
        return res.status(409).json({
          success: false,
          code: result.code,
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
      case 'DRIVER_MISMATCH':
      case 'FORBIDDEN':
        return res.status(403).json({
          success: false,
          code: result.code,
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
      default:
        return res.status(409).json({
          success: false,
          code: result.code || 'CONFLICT',
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
    }
  } catch (err) {
    console.error('[rideActionController.driverRejectRide]', err);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: err.message || 'Failed to reject ride',
      data: null
    });
  }
}

/**
 * POST /api/v1/ride-actions/cancel
 * Request: { ride_id, user_id, cancellation_reason? }
 */
async function userCancelRide(req, res) {
  try {
    const rideId = (req.body.ride_id ?? req.body.rideId ?? '').toString().trim();
    const userId = (req.body.user_id ?? req.body.userId ?? '').toString().trim();
    const cancellationReason = req.body.cancellation_reason != null ? String(req.body.cancellation_reason).trim() : null;

    if (!rideId || !userId) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'ride_id and user_id are required',
        data: null
      });
    }

    const result = await rideActionService.cancelRide(rideId, userId, cancellationReason);

    if (result.success) {
      return res.status(200).json({
        success: true,
        code: result.code,
        message: 'Ride cancelled',
        data: { ride: toRideDto(result.ride) }
      });
    }

    switch (result.code) {
      case 'NOT_FOUND':
        return res.status(404).json({
          success: false,
          code: result.code,
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
      case 'ALREADY_CANCELLED':
        return res.status(409).json({
          success: false,
          code: result.code,
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
      case 'FORBIDDEN':
        return res.status(403).json({
          success: false,
          code: result.code,
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
      case 'CANCEL_AFTER_ACCEPT_NOT_ALLOWED':
      case 'INVALID_STATE':
        return res.status(409).json({
          success: false,
          code: result.code,
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
      default:
        return res.status(409).json({
          success: false,
          code: result.code || 'CONFLICT',
          message: result.message,
          data: { currentStatus: result.currentStatus }
        });
    }
  } catch (err) {
    console.error('[rideActionController.userCancelRide]', err);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: err.message || 'Failed to cancel ride',
      data: null
    });
  }
}

/**
 * POST /api/v1/ride-actions/request
 * Request: { user_id, driver_id, pickup: { address, lat, lng }, drop: { address, lat, lng }, ride_note? }
 */
async function createRideRequest(req, res) {
  try {
    const userId = (req.body.user_id ?? req.body.userId ?? '').toString().trim();
    const driverId = (req.body.driver_id ?? req.body.driverId ?? '').toString().trim();
    const pickup = req.body.pickup || {};
    const drop = req.body.drop || {};
    const rideNote = req.body.ride_note != null ? String(req.body.ride_note).trim() : null;

    const pickupAddress = (pickup.address ?? '').toString().trim();
    const pickupLat = pickup.lat != null ? Number(pickup.lat) : null;
    const pickupLng = pickup.lng != null ? Number(pickup.lng) : null;
    const dropAddress = (drop.address ?? '').toString().trim();
    const dropLat = drop.lat != null ? Number(drop.lat) : null;
    const dropLng = drop.lng != null ? Number(drop.lng) : null;

    if (!userId || !driverId || !pickupAddress || !dropAddress) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'user_id, driver_id, pickup.address, and drop.address are required',
        data: null
      });
    }
    if (typeof pickupLat !== 'number' || Number.isNaN(pickupLat) || typeof pickupLng !== 'number' || Number.isNaN(pickupLng) ||
        typeof dropLat !== 'number' || Number.isNaN(dropLat) || typeof dropLng !== 'number' || Number.isNaN(dropLng)) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'pickup and drop must have valid lat/lng numbers',
        data: null
      });
    }

    const ride = await rideActionService.createRideRequest({
      userId,
      driverId,
      pickup: { address: pickupAddress, lat: pickupLat, lng: pickupLng },
      drop: { address: dropAddress, lat: dropLat, lng: dropLng },
      rideNote: rideNote || undefined
    });

    return res.status(201).json({
      success: true,
      code: 'REQUESTED',
      message: 'Ride request created',
      data: { ride: toRideDto(ride) }
    });
  } catch (err) {
    console.error('[rideActionController.createRideRequest]', err);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: err.message || 'Failed to create ride request',
      data: null
    });
  }
}

module.exports = {
  createRideRequest,
  driverAcceptRide,
  driverRejectRide,
  userCancelRide
};
