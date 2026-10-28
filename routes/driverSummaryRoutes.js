const express = require('express');
const router = express.Router();
const summary = require('../controllers/driverSummaryController');
const onboarding = require('../controllers/driverOnboardingController');
const { requireAuth } = require('../lib/authMiddleware');

// Mounted at /api/v1/driver/summary. The signed-in driver's own numbers for the app's Home and Profile.
router.get('/', requireAuth({ roles: ['driver'] }), onboarding.driverContext, summary.summary);

// where riders are asking right now around the driver, and the weather there (counts only; see lib/heatmap.js)
router.get('/demand-map', requireAuth({ roles: ['driver'] }), onboarding.driverContext, summary.demandMap);

router.get('/detail', requireAuth({ roles: ['driver'] }), onboarding.driverContext, summary.detail);
router.get('/profile', requireAuth({ roles: ['driver'] }), onboarding.driverContext, summary.profile);
router.get('/trips', requireAuth({ roles: ['driver'] }), onboarding.driverContext, summary.trips);
router.get('/trips/:tripId', requireAuth({ roles: ['driver'] }), onboarding.driverContext, summary.tripDetail);
router.get('/trips/:tripId/receipt.pdf', requireAuth({ roles: ['driver'] }), onboarding.driverContext, summary.tripReceipt);

module.exports = router;
