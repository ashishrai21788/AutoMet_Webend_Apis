/**
 * Ride Action APIs – Driver Accept / Reject, User Cancel.
 * Base path: /api/v1/ride-actions
 * @deprecated Prefer /api/v1/trips/* and /api/v1/rides/*
 */

const express = require('express');
const router = express.Router();
const rideActionController = require('../controllers/rideActionController');
const { requireAuth } = require('../lib/authMiddleware');
const { deprecateLegacyRideApi } = require('../lib/deprecationHeaders');

router.use(deprecateLegacyRideApi('/api/v1/trips/create-request', 'ride-actions'));

router.post(
  '/request',
  requireAuth({ roles: ['user'], enforceBodyUserId: true }),
  rideActionController.createRideRequest
);
router.post(
  '/accept',
  requireAuth({ roles: ['driver'], enforceBodyDriverId: true }),
  rideActionController.driverAcceptRide
);
router.post(
  '/reject',
  requireAuth({ roles: ['driver'], enforceBodyDriverId: true }),
  rideActionController.driverRejectRide
);
router.post(
  '/cancel',
  requireAuth({ roles: ['user'], enforceBodyUserId: true }),
  rideActionController.userCancelRide
);

module.exports = router;
