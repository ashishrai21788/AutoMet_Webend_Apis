const express = require('express');
const router = express.Router();
const dynamicController = require('../controllers/dynamicController');

// Driver Login Route - MUST come before dynamic routes
router.post('/drivers/login', dynamicController.loginDriver);

// Driver Logout Route - MUST come before dynamic routes
router.post('/drivers/logout', dynamicController.logoutDriver);

// Driver Online Status Update Route - MUST come before dynamic routes
router.put('/drivers/online-status', dynamicController.updateOnlineStatus);

// Driver Current Status Route - MUST come before dynamic routes
router.get('/drivers/status/:driverId', dynamicController.getDriverStatus);

// Protected Driver Routes (require JWT token) - MUST come before dynamic routes
router.get('/drivers/profile', dynamicController.verifyToken, dynamicController.getDriverProfile);

// Update Driver Profile Route - MUST come before dynamic routes
router.put('/drivers/profile', dynamicController.updateDriverProfile);

// Update Driver Fields Route (Generic update by driverId) - MUST come before dynamic routes
router.put('/drivers/update', dynamicController.updateDriverFields);
router.post('/drivers/update', dynamicController.updateDriverFields); // Also support POST for client compatibility

// Vehicle Details Update Route - MUST come before dynamic routes
router.put('/drivers/vehicle-details', dynamicController.updateVehicleDetails);

// Get Vehicle Details by DriverId Route - MUST come before dynamic routes
router.get('/drivers/:driverId/vehicle-details', dynamicController.getVehicleDetails);

// Get Driver FAQs Route - MUST come before dynamic routes
router.get('/drivers/faqs', dynamicController.getDriverFAQs);

// Driver Issue Reports Routes - MUST come before dynamic routes
router.post('/drivers/issues', dynamicController.submitDriverIssue);
router.get('/drivers/:driverId/issues', dynamicController.getDriverIssues);
router.put('/drivers/issues/:issueId', dynamicController.updateIssueStatus);

// Driver Notifications Routes - MUST come before dynamic routes
router.get('/drivers/notifications', dynamicController.getDriverNotifications);
router.put('/drivers/notifications/mark-read', dynamicController.updateNotificationReadStatus);

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

// Dynamic routes for any collection - These must come AFTER specific routes
router.post('/:collectionName', dynamicController.createRecord);
router.get('/:collectionName', dynamicController.getRecords);
router.get('/:collectionName/:id', dynamicController.getRecordById);
router.put('/:collectionName/:id', dynamicController.updateRecord);
router.delete('/:collectionName/:id', dynamicController.deleteRecord);

module.exports = router; 