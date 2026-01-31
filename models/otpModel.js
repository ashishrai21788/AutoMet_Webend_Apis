const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  driverId: {
    type: String,
    required: true
  },
  phoneNumber: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: false,
    lowercase: true,
    default: null
  },
  otp: {
    type: String,
    required: true,
    length: 6
  },
  isUsed: {
    type: Boolean,
    default: false
  },
  expiresAt: {
    type: Date,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { 
  timestamps: true,
  collection: 'drivers_otp'
});

// Create TTL index for automatic deletion after expiration
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('DriverOTP', otpSchema); 