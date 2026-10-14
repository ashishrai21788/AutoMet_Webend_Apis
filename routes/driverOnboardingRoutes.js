const express = require('express');
const router = express.Router();
const ctl = require('../controllers/driverOnboardingController');
const { requireAuth } = require('../lib/authMiddleware');
const { createLimiter } = require('../lib/rateLimit');

// Mounted at /api/v1/driver/onboarding. Everything works on the signed-in driver's own record.
const asDriver = [requireAuth({ roles: ['driver'] }), ctl.driverContext];
const writeLimit = createLimiter({ name: 'driver-onboarding-write', windowMs: 60 * 1000, max: 30, key: (r) => (r.authActorId ? `onb:${r.authActorId}` : null) });

router.get('/', ...asDriver, ctl.getState);
router.put('/area', ...asDriver, writeLimit, ctl.setArea);
router.put('/vehicle', ...asDriver, writeLimit, ctl.saveVehicle);
router.post('/documents', ...asDriver, writeLimit, ctl.parseUpload, ctl.submitDocument);

module.exports = router;
