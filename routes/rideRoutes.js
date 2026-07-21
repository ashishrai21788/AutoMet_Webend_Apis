const express = require('express');
const router = express.Router();
const rideController = require('../controllers/rideController');
const tripsController = require('../controllers/tripsController');
const { requireAuth, requireRideScopeQuery, requireSchedulerSecret } = require('../lib/authMiddleware');
const { deprecateLegacyRideApi } = require('../lib/deprecationHeaders');

// Create ride request (user → driver) — legacy; prefer /trips/create-request
router.post(
  '/request',
  deprecateLegacyRideApi('/api/v1/trips/create-request', 'POST /rides/request'),
  requireAuth({ roles: ['user'], enforceBodyUserId: true }),
  rideController.createRideRequest
);

router.post('/check-timeouts', requireSchedulerSecret, tripsController.checkTimeouts);

router.post(
  '/cancel',
  requireAuth({ roles: ['user'], enforceBodyUserId: true }),
  rideController.cancelRideByUser
);

router.get('/active', requireRideScopeQuery, rideController.getActiveRide);

router.get('/details', requireRideScopeQuery, rideController.getRideDetails);

router.get('/', rideController.listTrips);
router.get('/:tripId/timeline', rideController.getTripTimeline);
router.get('/:tripId', rideController.getTrip);

router.patch(
  '/:tripId/accept',
  requireAuth({ roles: ['driver'], enforceBodyDriverId: true }),
  rideController.acceptRide
);
router.patch(
  '/:tripId/reject',
  requireAuth({ roles: ['driver'], enforceBodyDriverId: true }),
  rideController.rejectRide
);
router.patch(
  '/:tripId/status',
  requireAuth({ roles: ['driver'] }),
  rideController.updateTripStatus
);

module.exports = router;
