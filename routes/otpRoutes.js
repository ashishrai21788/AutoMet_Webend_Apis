const express = require('express');
const router = express.Router();
const otpController = require('../controllers/otpController');
const { requireAuth } = require('../lib/authMiddleware');
const { otpSendLimiters, otpVerifyLimiters } = require('../lib/rateLimit');

const sendLimit = otpSendLimiters('driver');
const verifyLimit = otpVerifyLimiters('driver');

// Send OTP for driver verification (creates or updates existing OTP)
router.post('/send', ...sendLimit, otpController.sendOTP);

// Generate OTP for driver verification (legacy endpoint)
router.post('/generate', ...sendLimit, otpController.generateOTP);

// Verify OTP and update driver verification status
router.post('/verify', ...verifyLimit, otpController.verifyOTP);

// Update FCM token / device ID (call when token refreshes on mobile)
router.post(
  '/update-token',
  requireAuth({ roles: ['driver'], enforceBodyDriverIdCamelCase: true }),
  otpController.updateDriverToken
);

// Update driver profile completion status
router.post(
  '/profile-complete',
  requireAuth({ roles: ['driver'], enforceBodyDriverIdCamelCase: true }),
  otpController.updateProfileComplete
);

// Resend OTP
router.post('/resend', ...sendLimit, otpController.resendOTP);

module.exports = router;
