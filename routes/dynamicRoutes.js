const express = require('express');
const router = express.Router();
const dynamicController = require('../controllers/dynamicController');
const driverAnalyticsController = require('../controllers/driverAnalyticsController');
const { requireAuth, blockSensitiveDynamicCrud } = require('../lib/authMiddleware');
const { otpSendLimiters, createLimiter, clientIp } = require('../lib/rateLimit');
const driverLocationController = require('../controllers/driverLocationController');

// Driver Login Route - MUST come before dynamic routes
router.post('/drivers/login', ...otpSendLimiters('driver-login'), dynamicController.loginDriver);

// Driver Logout Route - MUST come before dynamic routes
router.post(
  '/drivers/logout',
  requireAuth({ roles: ['driver'], enforceBodyDriverIdCamelCase: true }),
  dynamicController.logoutDriver
);

// Driver Online Status Update Route - MUST come before dynamic routes
router.put(
  '/drivers/online-status',
  requireAuth({ roles: ['driver'], enforceBodyDriverIdCamelCase: true }),
  dynamicController.updateOnlineStatus
);

// Driver location heartbeat (every few seconds while online) - MUST come before dynamic routes
router.post(
  '/drivers/location',
  requireAuth({ roles: ['driver'], enforceBodyDriverIdCamelCase: true }),
  createLimiter({ name: 'driver-location-ip', windowMs: 60 * 1000, max: 1200, key: (r) => `loc:ip:${clientIp(r)}` }),
  createLimiter({ name: 'driver-location-driver', windowMs: 60 * 1000, max: 60, key: (r) => { const d = r.authActorId || (r.body && r.body.driverId); return d ? `loc:drv:${d}` : null; } }),
  driverLocationController.heartbeat
);

// Driver Current Status Route - MUST come before dynamic routes
router.get('/drivers/status/:driverId', dynamicController.getDriverStatus);

// Protected Driver Routes (require JWT token) - MUST come before dynamic routes
router.get('/drivers/profile', dynamicController.verifyToken, dynamicController.getDriverProfile);

// Update Driver Profile Route - MUST come before dynamic routes
router.put(
  '/drivers/profile',
  requireAuth({ roles: ['driver'], enforceBodyDriverIdCamelCase: true }),
  dynamicController.updateDriverProfile
);

// Update Driver Fields Route (Generic update by driverId) - MUST come before dynamic routes
router.put(
  '/drivers/update',
  requireAuth({ roles: ['driver'], enforceBodyDriverIdCamelCase: true }),
  dynamicController.updateDriverFields
);
router.post(
  '/drivers/update',
  requireAuth({ roles: ['driver'], enforceBodyDriverIdCamelCase: true }),
  dynamicController.updateDriverFields
);

// Vehicle Details Update Route - MUST come before dynamic routes
router.put(
  '/drivers/vehicle-details',
  requireAuth({ roles: ['driver'], enforceBodyDriverIdCamelCase: true }),
  dynamicController.updateVehicleDetails
);

// Get Vehicle Details by DriverId Route - MUST come before dynamic routes
router.get('/drivers/:driverId/vehicle-details', dynamicController.getVehicleDetails);

// Driver analytics (aggregate from user_app_analytics + currentlyViewing + todayTotalViewed)
router.get('/drivers/:driverId/analytics', driverAnalyticsController.getDriverAnalytics);

// Get Driver FAQs Route - MUST come before dynamic routes
router.get('/drivers/faqs', dynamicController.getDriverFAQs);

// Driver Issue Reports Routes - MUST come before dynamic routes
router.post(
  '/drivers/issues',
  requireAuth({ roles: ['driver'], enforceBodyDriverIdCamelCase: true }),
  dynamicController.submitDriverIssue
);
// A driver reads only their own reports. (This route used to need no sign-in at all.)
router.get(
  '/drivers/:driverId/issues',
  requireAuth({ roles: ['driver'] }),
  (req, res, next) => {
    if (req.authActorId && req.authActorId !== String(req.params.driverId)) {
      return res.status(403).json({ success: false, message: 'You can only read your own reports', data: null });
    }
    next();
  },
  dynamicController.getDriverIssues
);
// Changing a report's status or notes is the business's job and lives in the admin dashboard (Support). This route used to
// let any signed-in driver change any report, so it now refuses.
router.put('/drivers/issues/:issueId', (req, res) => res.status(403).json({ success: false, message: 'Issue status is managed by support, not from the app', data: null }));

// Driver Notifications Routes - MUST come before dynamic routes
router.get(
  '/drivers/notifications',
  requireAuth({ roles: ['driver'] }),
  dynamicController.getDriverNotifications
);
router.post('/drivers/notifications/send', requireAuth({ roles: ['driver'] }), dynamicController.sendDriverNotification);
router.put(
  '/drivers/notifications/mark-read',
  requireAuth({ roles: ['driver'] }),
  dynamicController.updateNotificationReadStatus
);
router.get(
  '/drivers/notifications/mark-all-read',
  requireAuth({ roles: ['driver'] }),
  dynamicController.markAllDriverNotificationsRead
);
router.get(
  '/drivers/notifications/delete',
  requireAuth({ roles: ['driver'] }),
  dynamicController.deleteDriverNotification
);

// Prevent /drivers/login from being caught by dynamic route
router.get('/drivers/login', (req, res) => {
  res.status(405).json({
    success: false,
    message: 'Method not allowed. Use POST for login.',
    data: {
      allowedMethods: ['POST']
    }
  });
});

// Dynamic routes for any collection - blocked for drivers/users/admins (use named routes)
router.post('/:collectionName', blockSensitiveDynamicCrud, dynamicController.createRecord);
router.get('/:collectionName', blockSensitiveDynamicCrud, dynamicController.getRecords);
router.get('/:collectionName/:id', blockSensitiveDynamicCrud, dynamicController.getRecordById);
router.put('/:collectionName/:id', blockSensitiveDynamicCrud, dynamicController.updateRecord);
router.delete('/:collectionName/:id', blockSensitiveDynamicCrud, dynamicController.deleteRecord);

module.exports = router;
