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
  '/estimate',
  requireAuth({ roles: ['user'] }),
  tripsController.estimate
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
  '/check-timeouts',
  requireSchedulerSecret,
  tripsController.checkTimeouts
);

module.exports = router;
