const express = require('express');
const router = express.Router();
const tripsController = require('../controllers/tripsController');
const { requireAuth, requireSchedulerSecret } = require('../lib/authMiddleware');

router.post(
  '/create-request',
  requireAuth({ roles: ['user'], enforceBodyUserId: true }),
  tripsController.createRequest
);
router.post(
  '/auto-dispatch',
  requireAuth({ roles: ['user'], enforceBodyUserId: true }),
  (req, res, next) => {
    if (req.body) req.body.driver_id = null;
    return tripsController.createRequest(req, res, next);
  }
);
router.post(
  '/estimate',
  requireAuth({ roles: ['user'] }),
  tripsController.estimate
);
router.post(
  '/ride-options',
  requireAuth({ roles: ['user'] }),
  tripsController.rideOptions
);
router.get(
  '/coupons',
  requireAuth({ roles: ['user'] }),
  tripsController.listCoupons
);
router.post(
  '/nearby-drivers',
  requireAuth({ roles: ['user'] }),
  tripsController.nearbyDrivers
);
router.post(
  '/cancel-request',
  requireAuth({ roles: ['user', 'driver'] }),
  tripsController.cancelRequest
);
router.post(
  '/driver-response',
  requireAuth({ roles: ['driver'], enforceBodyDriverId: true }),
  tripsController.driverResponse
);
router.post(
  '/offer-response',
  requireAuth({ roles: ['driver'], enforceBodyDriverId: true }),
  tripsController.driverResponse
);
router.post(
  '/check-timeouts',
  requireSchedulerSecret,
  tripsController.checkTimeouts
);

module.exports = router;
