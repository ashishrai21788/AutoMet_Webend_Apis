const crypto = require('crypto');
const DriverOTP = require('../models/otpModel');
const { createModel } = require('../models/dynamicModel');
const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required. Refusing to start with insecure fallback.');
}

// Send OTP for driver verification (creates or updates existing OTP)
exports.sendOTP = async (req, res) => {
  try {
    const { driverId } = req.body;

    // Validate required fields
    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: driverId',
        data: {
          missingFields: {
            driverId: !driverId
          }
        }
      });
    }

    // Check if driver exists
    const DriverModel = createModel('drivers');
    const driver = await DriverModel.findOne({ driverId });
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: {
          driverId: driverId
        }
      });
    }

    // Check if driver is already verified
    if (driver.isVerified) {
      return res.status(400).json({
        success: false,
        message: 'Driver is already verified',
        data: {
          driverId: driverId,
          isVerified: true
        }
      });
    }

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    
    // Set expiration time (5 minutes from now)
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // Find existing OTP record for this driver
    let otpRecord = await DriverOTP.findOne({ driverId });

    if (otpRecord) {
      // Update existing OTP record
      otpRecord.otp = otp;
      otpRecord.expiresAt = expiresAt;
      otpRecord.isUsed = false;
      otpRecord.updatedAt = new Date();
      await otpRecord.save();
    } else {
      // Create new OTP record
      otpRecord = new DriverOTP({
        driverId,
        email: driver.email,
        phone: driver.phone,
        otp,
        expiresAt
      });
      await otpRecord.save();
    }

    // In a real application, you would send this OTP via SMS/Email
    // For now, we'll return it in the response for testing
    res.status(200).json({
      success: true,
      message: 'OTP sent successfully',
      data: {
        driverId: driverId,
        email: driver.email,
        phone: driver.phone,
        expiresAt: expiresAt,
        message: 'OTP sent to your registered email and phone number',
        action: otpRecord.isNew ? 'created' : 'updated'
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      data: {
        details: error.message
      }
    });
  }
};

// Generate OTP for driver verification (legacy function - kept for backward compatibility)
exports.generateOTP = async (req, res) => {
  try {
    const { driverId, email, phone } = req.body;

    // Validate required fields
    if (!driverId || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: driverId, email, phone',
        data: {
          missingFields: {
            driverId: !driverId,
            email: !email,
            phone: !phone
          }
        }
      });
    }

    // Check if driver exists
    const DriverModel = createModel('drivers');
    const driver = await DriverModel.findOne({ driverId });
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: {
          driverId: driverId
        }
      });
    }

    // Check if driver is already verified
    if (driver.isVerified) {
      return res.status(400).json({
        success: false,
        message: 'Driver is already verified',
        data: {
          driverId: driverId,
          isVerified: true
        }
      });
    }

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    
    // Set expiration time (5 minutes from now)
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // Delete any existing OTP for this driver
    await DriverOTP.deleteMany({ driverId });

    // Create new OTP record
    const otpRecord = new DriverOTP({
      driverId,
      email: email.toLowerCase(),
      phone,
      otp,
      expiresAt
    });

    await otpRecord.save();

    // In a real application, you would send this OTP via SMS/Email
    // For now, we'll return it in the response for testing
    res.status(201).json({
      success: true,
      message: 'OTP generated successfully',
      data: {
        driverId: driverId,
        email: email,
        phone: phone,
        expiresAt: expiresAt,
        message: 'OTP sent to your registered email and phone number'
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      data: {
        details: error.message
      }
    });
  }
};

// Verify OTP and return complete driver record (accepts optional device_id, fcm_id)
exports.verifyOTP = async (req, res) => {
  try {
    const { driverId, otp, device_id, fcm_id } = req.body;

    // Validate required fields
    if (!driverId || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: driverId, otp',
        data: {
          missingFields: {
            driverId: !driverId,
            otp: !otp
          }
        }
      });
    }

    // Find the OTP record
    const otpRecord = await DriverOTP.findOne({ 
      driverId, 
      otp, 
      isUsed: false,
      expiresAt: { $gt: new Date() }
    });

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP',
        data: {
          driverId: driverId
        }
      });
    }

    // Get driver record
    const DriverModel = createModel('drivers');
    const driver = await DriverModel.findOne({ driverId });

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: {
          driverId: driverId
        }
      });
    }

    // Mark OTP as used
    otpRecord.isUsed = true;
    await otpRecord.save();

    // Generate JWT access token
    const jwtSecret = process.env.JWT_SECRET;
    const tokenPayload = {
      driverId: driver.driverId,
      email: driver.email,
      phone: driver.phone,
      role: 'driver',
      loginTime: new Date().toISOString()
    };
    
    const accessToken = jwt.sign(tokenPayload, jwtSecret, { 
      expiresIn: '7d' // Token expires in 7 days
    });

    const updateFields = {
      isLoggedin: true,
      lastActive: new Date(),
      accessToken: accessToken,
      updatedAt: new Date()
    };
    if (device_id != null && typeof device_id === 'string' && device_id.trim()) {
      updateFields.deviceId = device_id.trim();
    }
    if (fcm_id != null && typeof fcm_id === 'string' && fcm_id.trim()) {
      updateFields.fcmToken = fcm_id.trim();
    }
    const updatedDriver = await DriverModel.findByIdAndUpdate(
      driver._id,
      updateFields,
      { new: true }
    );

    // Get complete driver data with all fields
    const completeDriver = await DriverModel.findById(updatedDriver._id).lean();
    delete completeDriver.passwordHash;
    
    // Ensure all fields are present in response using ensureAllDriverFields
    // Import the helper function from dynamicController
    const dynamicController = require('./dynamicController');
    const driverWithAllFields = dynamicController.ensureAllDriverFields(completeDriver);

    // Set proper headers for mobile compatibility
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      data: {
        driver: driverWithAllFields, // Returns all driver fields
        accessToken: accessToken, // JWT token for authentication
        loginTime: new Date().toISOString(),
        sessionInfo: {
          isLoggedin: true,
          lastActive: updatedDriver.lastActive,
          tokenExpiresIn: '7d'
        }
      }
    });

  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      data: {
        details: error.message
      }
    });
  }
};

/**
 * Update FCM token and/or device ID for driver (call when token refreshes on mobile).
 * POST /api/otp/update-token
 * Body: driverId (required), fcm_id (optional), device_id (optional). At least one of fcm_id or device_id.
 */
exports.updateDriverToken = async (req, res) => {
  try {
    const { driverId, fcm_id, device_id } = req.body;
    const driverIdValue = (driverId != null && typeof driverId === 'string') ? driverId.trim() : '';
    if (!driverIdValue) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: driverId',
        data: { missingFields: { driverId: true } }
      });
    }
    const hasFcm = fcm_id != null && typeof fcm_id === 'string' && fcm_id.trim() !== '';
    const hasDevice = device_id != null && typeof device_id === 'string' && device_id.trim() !== '';
    if (!hasFcm && !hasDevice) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one of: fcm_id, device_id',
        data: { missingFields: { fcm_id: !hasFcm, device_id: !hasDevice } }
      });
    }
    const DriverModel = createModel('drivers');
    const driver = await DriverModel.findOne({ driverId: driverIdValue });
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: { driverId: driverIdValue }
      });
    }
    const updateFields = { updatedAt: new Date() };
    if (hasFcm) updateFields.fcmToken = fcm_id.trim();
    if (hasDevice) updateFields.deviceId = device_id.trim();
    await DriverModel.findByIdAndUpdate(driver._id, { $set: updateFields });
    const updated = await DriverModel.findOne({ driverId: driverIdValue }).select('fcmToken deviceId').lean();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({
      success: true,
      message: 'Token updated successfully',
      data: {
        driverId: driverIdValue,
        fcmToken: updated.fcmToken != null,
        deviceId: updated.deviceId != null
      }
    });
  } catch (error) {
    console.error('updateDriverToken error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating token',
      data: { details: error.message }
    });
  }
};

// Update driver profile completion status
exports.updateProfileComplete = async (req, res) => {
  try {
    const { driverId, isProfileComplete } = req.body;

    // Validate required fields
    if (!driverId || typeof isProfileComplete !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: driverId, isProfileComplete (boolean)',
        data: {
          missingFields: {
            driverId: !driverId,
            isProfileComplete: typeof isProfileComplete !== 'boolean'
          }
        }
      });
    }

    // Check if driver exists
    const DriverModel = createModel('drivers');
    const driver = await DriverModel.findOne({ driverId });
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: {
          driverId: driverId
        }
      });
    }

    // Update profile completion status
    const updatedDriver = await DriverModel.findOneAndUpdate(
      { driverId },
      { 
        isProfileComplete: isProfileComplete,
        updatedAt: new Date()
      },
      { new: true }
    );

    // Remove password hash from response
    const driverResponse = updatedDriver.toObject();
    delete driverResponse.passwordHash;

    res.status(200).json({
      success: true,
      message: `Profile completion status updated to ${isProfileComplete}`,
      data: driverResponse
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      data: {
        details: error.message
      }
    });
  }
};

// Resend OTP
exports.resendOTP = async (req, res) => {
  try {
    const { driverId } = req.body;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: driverId',
        data: {
          missingFields: {
            driverId: !driverId
          }
        }
      });
    }

    // Check if driver exists
    const DriverModel = createModel('drivers');
    const driver = await DriverModel.findOne({ driverId });
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: {
          driverId: driverId
        }
      });
    }

    // Check if driver is already verified
    if (driver.isVerified) {
      return res.status(400).json({
        success: false,
        message: 'Driver is already verified',
        data: {
          driverId: driverId,
          isVerified: true
        }
      });
    }

    // Generate new 6-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    
    // Set expiration time (5 minutes from now)
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // Delete any existing OTP for this driver
    await DriverOTP.deleteMany({ driverId });

    // Create new OTP record
    const otpRecord = new DriverOTP({
      driverId,
      email: driver.email,
      phone: driver.phone,
      otp,
      expiresAt
    });

    await otpRecord.save();

    // In a real application, you would send this OTP via SMS/Email
    res.status(200).json({
      success: true,
      message: 'OTP resent successfully',
      data: {
        driverId: driverId,
        email: driver.email,
        phone: driver.phone,
        expiresAt: expiresAt,
        message: 'New OTP sent to your registered email and phone number'
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      data: {
        details: error.message
      }
    });
  }
}; 