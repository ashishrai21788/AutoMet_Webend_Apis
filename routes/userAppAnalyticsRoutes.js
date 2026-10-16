const express = require('express');
const router = express.Router();
const userAppAnalyticsController = require('../controllers/userAppAnalyticsController');

// Save user app analytics events (collection: user_app_analytics)
const { analyticsGuard } = require('../lib/analyticsGuard');

router.post('/', ...analyticsGuard('user'), userAppAnalyticsController.saveAnalytics);

module.exports = router;
