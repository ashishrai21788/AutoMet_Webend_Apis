const express = require('express');
const router = express.Router();
const summary = require('../controllers/driverSummaryController');
const onboarding = require('../controllers/driverOnboardingController');
const { requireAuth } = require('../lib/authMiddleware');

// Mounted at /api/v1/driver/summary. The signed-in driver's own numbers for the app's Home and Profile.
router.get('/', requireAuth({ roles: ['driver'] }), onboarding.driverContext, summary.summary);

module.exports = router;
