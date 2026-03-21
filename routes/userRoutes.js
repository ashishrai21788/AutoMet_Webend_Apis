const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

// User Registration - collection: users
router.post('/register', userController.registerUser);

// User Login - creates OTP in users_otp
router.post('/login', userController.loginUser);

// User OTP Verification - users_otp, updates users
router.post('/verify-otp', userController.verifyUserOtp);

// Update FCM token / device ID (call when token refreshes on mobile)
router.post('/update-token', userController.updateUserToken);

// User Profile Edit
router.put('/profile', userController.updateUserProfile);
router.post('/profile', userController.updateUserProfile);

// Resend OTP - users_otp
router.post('/resend-otp', userController.resendUserOtp);

// Get user detail by userId - users
router.get('/detail/:userId', userController.getUserByUserId);

// User Logout - users
router.post('/logout', userController.logoutUser);

// User Notifications - users_notification
router.get('/notifications', userController.getUserNotifications);
router.post('/notifications/send', userController.sendUserNotification);
router.put('/notifications/mark-read', userController.updateUserNotificationReadStatus);
router.get('/notifications/delete', userController.deleteUserNotification);

module.exports = router;
