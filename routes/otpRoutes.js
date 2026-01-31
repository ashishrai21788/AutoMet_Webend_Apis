const express = require('express');
const router = express.Router();
const otpController = require('../controllers/otpController');

// Send OTP for driver verification (creates or updates existing OTP)
router.post('/send', otpController.sendOTP);

// Generate OTP for driver verification (legacy endpoint)
router.post('/generate', otpController.generateOTP);

// Verify OTP and update driver verification status
router.post('/verify', otpController.verifyOTP);

// Update driver profile completion status
router.post('/profile-complete', otpController.updateProfileComplete);

// Resend OTP
router.post('/resend', otpController.resendOTP);

module.exports = router; 