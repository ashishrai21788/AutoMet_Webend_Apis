const express = require('express');
const router = express.Router();
const driverAppAnalyticsController = require('../controllers/driverAppAnalyticsController');

// Save driver app analytics events (collection: driver_app_analytics)
const { analyticsGuard } = require('../lib/analyticsGuard');

router.post('/', ...analyticsGuard('driver'), driverAppAnalyticsController.saveAnalytics);

module.exports = router;
