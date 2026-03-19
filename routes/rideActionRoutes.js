/**
 * Ride Action APIs – Driver Accept / Reject, User Cancel.
 * Base path: /api/v1/ride-actions
 */

const express = require('express');
const router = express.Router();
const rideActionController = require('../controllers/rideActionController');

router.post('/request', rideActionController.createRideRequest);
router.post('/accept', rideActionController.driverAcceptRide);
router.post('/reject', rideActionController.driverRejectRide);
router.post('/cancel', rideActionController.userCancelRide);

module.exports = router;
