const express = require('express');
const router = express.Router();
const userAppAnalyticsController = require('../controllers/userAppAnalyticsController');

// Save user app analytics events (collection: user_app_analytics)
router.post('/', userAppAnalyticsController.saveAnalytics);

module.exports = router;
