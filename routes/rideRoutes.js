const express = require('express');
const router = express.Router();
const rideController = require('../controllers/rideController');
const tripsController = require('../controllers/tripsController');
const { requireAuth, requireRideScopeQuery, requireSchedulerSecret } = require('../lib/authMiddleware');
const { deprecateLegacyRideApi } = require('../lib/deprecationHeaders');
const shareController = require('../controllers/shareController');

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

router.post(
  '/rating',
  requireAuth({ roles: ['user'], enforceBodyUserId: true }),
  rideController.rateDriver
);

// the rider tips the driver for a finished ride
router.post(
  '/tip',
  requireAuth({ roles: ['user'], enforceBodyUserId: true }),
  rideController.tipDriver
);

// the driver cancels an accepted ride before the trip starts
router.post(
  '/driver-cancel',
  requireAuth({ roles: ['driver'], enforceBodyDriverId: true }),
  rideController.cancelRideByDriver
);

// what cancelling would cost the driver right now (the warning before they confirm)
router.post(
  '/driver-cancel-preview',
  requireAuth({ roles: ['driver'], enforceBodyDriverId: true }),
  rideController.driverCancelPreview
);

// the driver rates the rider after a finished ride
router.post(
  '/rate-rider',
  requireAuth({ roles: ['driver'], enforceBodyDriverId: true }),
  rideController.rateRider
);

// the rider's app showed the finished-trip receipt: it is not offered again on the next start
router.post(
  '/receipt-ack',
  requireAuth({ roles: ['user'], enforceBodyUserId: true }),
  rideController.ackReceipt
);

// the rider's link that lets anyone follow this ride (public page /t/:token)
router.post('/share', requireAuth({ roles: ['user'] }), shareController.createShare);

router.get('/active', requireRideScopeQuery, rideController.getActiveRide);

router.get('/details', requireRideScopeQuery, rideController.getRideDetails);

// A rider's or driver's own trips only: the list is scoped to the signed-in actor, and a single trip (or its
// timeline) is refused to anyone who is not its rider or driver.
router.get('/', requireRideScopeQuery, rideController.listTrips);
// GET /api/v1/rides itself is answered by the generic /api/:collection/:id route (collection "v1"), so apps read the list here.
router.get('/history', requireRideScopeQuery, rideController.listTrips);
router.get('/:tripId/invoice', requireAuth({ roles: ['user'] }), rideController.getTripInvoice);
router.get('/:tripId/invoice.pdf', requireAuth({ roles: ['user'] }), rideController.getTripInvoicePdf);
router.get('/:tripId/timeline', requireAuth({ roles: ['user', 'driver'] }), rideController.getTripTimeline);
router.get('/:tripId', requireAuth({ roles: ['user', 'driver'] }), rideController.getTrip);

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
