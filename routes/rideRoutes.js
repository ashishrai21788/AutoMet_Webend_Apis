const express = require('express');
const router = express.Router();
const rideController = require('../controllers/rideController');

// Create ride request (user → driver)
router.post('/request', rideController.createRideRequest);

// Cron: mark REQUESTED trips past timeout as NO_RESPONSE
router.post('/check-timeouts', rideController.checkTimeouts);
// User cancels ride (before or after driver acceptance, before trip start)
router.post('/cancel', rideController.cancelRideByUser);

// Active (incomplete) ride for driver or user - call on landing (before /:tripId)
router.get('/active', rideController.getActiveRide);
// Ride details by ride_id + user_id or driver_id (before /:tripId)
router.get('/details', rideController.getRideDetails);
// List trips (query: user_id, driver_id, status, limit, skip)
router.get('/', rideController.listTrips);

// Trip timeline / audit (must be before /:tripId)
router.get('/:tripId/timeline', rideController.getTripTimeline);
// Trip by id
router.get('/:tripId', rideController.getTrip);

// Driver accept
router.patch('/:tripId/accept', rideController.acceptRide);
// Driver or user reject
router.patch('/:tripId/reject', rideController.rejectRide);
// Status update (ON_GOING, COMPLETED)
router.patch('/:tripId/status', rideController.updateTripStatus);

module.exports = router;
