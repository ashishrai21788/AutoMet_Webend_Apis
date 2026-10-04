const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { requireAuth } = require('../lib/authMiddleware');
const supportController = require('../controllers/supportController');
const { createLimiter } = require('../lib/rateLimit');
const { otpSendLimiters, otpVerifyLimiters } = require('../lib/rateLimit');

const sendLimit = otpSendLimiters('user');
const verifyLimit = otpVerifyLimiters('user');

// User Registration - collection: users
router.post('/register', ...sendLimit, userController.registerUser);

// User Login - creates OTP in users_otp
router.post('/login', ...sendLimit, userController.loginUser);

// User OTP Verification - users_otp, updates users
router.post('/verify-otp', ...verifyLimit, userController.verifyUserOtp);

// Update FCM token / device ID (call when token refreshes on mobile)
router.post(
  '/update-token',
  requireAuth({ roles: ['user'], enforceBodyUserIdCamelCase: true }),
  userController.updateUserToken
);

// User Profile Edit
router.put('/profile', requireAuth({ roles: ['user'] }), userController.updateUserProfile);
router.post('/profile', requireAuth({ roles: ['user'] }), userController.updateUserProfile);

// Report a problem to support (optionally about one of the rider's trips), and read the answers
router.post(
  '/issues',
  requireAuth({ roles: ['user'], enforceBodyUserIdCamelCase: true }),
  createLimiter({ name: 'rider-issue', windowMs: 60 * 60 * 1000, max: 10, key: (r) => { const u = r.authActorId || (r.body && r.body.userId); return u ? `issue:${u}` : null; }, message: 'You have sent several reports recently. Please wait a while before sending another.' }),
  supportController.submitRiderIssue
);
router.get('/issues', requireAuth({ roles: ['user'] }), supportController.myRiderIssues);

// Resend OTP - users_otp
router.post('/resend-otp', ...sendLimit, userController.resendUserOtp);

// Get user detail by userId - users
router.get('/detail/:userId', userController.getUserByUserId);

// User Logout - users
router.post('/logout', requireAuth({ roles: ['user'] }), userController.logoutUser);

// User Notifications - users_notification
router.get(
  '/notifications',
  requireAuth({ roles: ['user'] }),
  userController.getUserNotifications
);
router.post('/notifications/send', requireAuth({ roles: ['user'] }), userController.sendUserNotification);
router.put(
  '/notifications/mark-read',
  requireAuth({ roles: ['user'] }),
  userController.updateUserNotificationReadStatus
);
router.get(
  '/notifications/delete',
  requireAuth({ roles: ['user'] }),
  userController.deleteUserNotification
);

module.exports = router;
