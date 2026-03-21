const crypto = require('crypto');
const { createModel } = require('../models/dynamicModel');
const { sendFCMNotification } = require('../config/firestore');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required. Refusing to start with insecure fallback.');
}

// Allowed collections for dynamic CRUD routes
const ALLOWED_COLLECTIONS = ['drivers', 'users', 'admins', 'driver_faqs', 'driver_issues', 'drivers_notification'];

// Fields that cannot be set via generic update endpoints
const SENSITIVE_FIELDS = ['passwordHash', 'accessToken', 'role', 'isVerified', 'walletBalance'];

// Helper function to ensure all driver fields are present in response
const ensureAllDriverFields = (driver) => {
  // Define all expected fields with their default values
  const defaultFields = {
    // Basic Information
    driverId: null,
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    profilePhoto: 'https://cdn.example.com/drivers/default.jpg',
    
    // Vehicle Information
    vehicleType: null,
    vehicleNumber: null,
    vehicleModel: null,
    vehicleColor: null,
    vehicleManufacturingYear: null,
    engineNumber: null,
    chassisNumber: null,
    fuleType: "",
    seatingCapacity: "",
    
    // Vehicle Insurance Details
    vehicleInsurance: {
      policyNumber: null,
      insuranceCompany: null,
      insuranceExpiryDate: null,
      insuranceAmount: null,
      isInsuranceValid: false
    },
    
    // Document Images (stored as {url, publicId} objects)
    vehicleRegistrationImages: [],
    vehicleInsuranceImages: [],
    drivingLicenseImages: [],
    idProofImages: [],
    
    // License and Verification
    licenseNumber: null,
    licenseExpiry: null,
    license_type: null,
    expiry_date: null,
    drivingLicenseIssueDate: null,
    drivingLicenseIssuingAuthority: null,
    aadhaarNumber: null,
    id_proof_type: null,
    isVerified: false,
    isProfileComplete: false,
    isPhoneVerified: false,
    isVehicleAdded: false,
    isDocumentsUploaded: false,
    verification_status: 'INCOMPLETE',
    
    // Location and Status
    currentLocation: {
      type: 'Point',
      coordinates: [0, 0]
    },
    isOnline: false,
    isLoggedin: false,
    onlineAs: 0,
    lastActive: null,
    
    // Mobile App Integration
    fcmToken: null,
    deviceId: null,
    accessToken: null,
    
    // Financial Information
    walletBalance: 0,
    bankAccount: {
      accountHolderName: null,
      accountNumber: null,
      ifscCode: null
    },
    membership: {
      plan: 'Free',
      startDate: null,
      endDate: null,
      paymentStatus: 'Pending',
      transactionId: null,
      isCancelled: false,
      cancelledAt: null,
      cancelReason: null
    },
    
    // Performance Metrics
    rating: 0,
    totalRides: 0,
    cancelledRides: 0,
    
    // System Fields
    role: 'driver',
    createdAt: null,
    updatedAt: null
  };
  
  // Merge the driver data with default fields, ensuring all fields are present
  const completeDriver = { ...defaultFields, ...driver };
  
  // Ensure nested objects are properly merged
  if (driver.vehicleInsurance) {
    completeDriver.vehicleInsurance = { ...defaultFields.vehicleInsurance, ...driver.vehicleInsurance };
  }
  
  if (driver.currentLocation) {
    completeDriver.currentLocation = { ...defaultFields.currentLocation, ...driver.currentLocation };
  }
  
  if (driver.bankAccount) {
    completeDriver.bankAccount = { ...defaultFields.bankAccount, ...driver.bankAccount };
  }
  
  if (driver.membership) {
    completeDriver.membership = { ...defaultFields.membership, ...driver.membership };
  }
  
  // Ensure arrays are always present (even if empty)
    // Convert old string format to new {url, publicId} format if needed
    const convertImageArray = (images) => {
      if (!images || !Array.isArray(images)) return [];
      return images.map(img => {
        if (typeof img === 'string') {
          // Old format: just URL string, extract publicId from URL or use URL as publicId
          return {
            url: img,
            publicId: img.split('/').pop().split('.')[0] || img
          };
        }
        // New format: already {url, publicId}
        return img;
      });
    };
    
    completeDriver.vehicleRegistrationImages = convertImageArray(driver.vehicleRegistrationImages);
    completeDriver.vehicleInsuranceImages = convertImageArray(driver.vehicleInsuranceImages);
    completeDriver.drivingLicenseImages = convertImageArray(driver.drivingLicenseImages);
    completeDriver.idProofImages = convertImageArray(driver.idProofImages);
  
  // Add virtual field for full name
  completeDriver.fullName = `${completeDriver.firstName || ''} ${completeDriver.lastName || ''}`.trim();
  
  // Add id field for compatibility
  completeDriver.id = completeDriver._id;
  
  return completeDriver;
};

// Export ensureAllDriverFields for use in other controllers
exports.ensureAllDriverFields = ensureAllDriverFields;

// Validate collection name for dynamic routes
function validateCollectionName(collectionName, res) {
  if (!ALLOWED_COLLECTIONS.includes(collectionName.toLowerCase())) {
    res.status(403).json({
      success: false,
      message: `Collection '${collectionName}' is not allowed`,
      data: { allowedCollections: ALLOWED_COLLECTIONS }
    });
    return false;
  }
  return true;
}

// Strip sensitive fields from update data
function stripSensitiveFields(data) {
  const cleaned = { ...data };
  for (const field of SENSITIVE_FIELDS) {
    delete cleaned[field];
  }
  return cleaned;
}

// Dynamic controller that works with any collection
exports.createRecord = async (req, res) => {
  try {
    const { collectionName } = req.params;
    if (!validateCollectionName(collectionName, res)) return;
    const Model = createModel(collectionName);
    
    // Special handling for driver signup
    if (collectionName.toLowerCase() === 'drivers') {
      return await createDriver(req, res, Model);
    }
    
    const record = new Model(req.body);
    await record.save();
    
    res.status(201).json({
      success: true,
      message: `${collectionName} created successfully`,
      data: record
    });
  } catch (error) {
    if (error.code === 11000) {
      // Check which field caused the duplicate error
      if (error.keyPattern && error.keyPattern.email) {
        return res.status(400).json({ 
          success: false,
          message: 'Email address already exists',
          data: {
            field: 'email'
          }
        });
      } else if (error.keyPattern && error.keyPattern.phone) {
        return res.status(400).json({ 
          success: false,
          message: 'Phone number already exists',
          data: {
            field: 'phone'
          }
        });
      } else if (error.keyPattern && error.keyPattern.vehicleNumber) {
        return res.status(400).json({ 
          success: false,
          message: 'Vehicle number already exists',
          data: {
            field: 'vehicleNumber'
          }
        });
      } else if (error.keyPattern && error.keyPattern.licenseNumber) {
        return res.status(400).json({ 
          success: false,
          message: 'License number already exists',
          data: {
            field: 'licenseNumber'
          }
        });
      } else if (error.keyPattern && error.keyPattern.driverId) {
        return res.status(400).json({ 
          success: false,
          message: 'Driver ID already exists. Please try again.',
          data: {
            field: 'driverId'
          }
        });
      } else {
        return res.status(400).json({ 
          success: false,
          message: 'Duplicate field value. Please check your input.',
          data: {
            details: error.keyPattern
          }
        });
      }
    }
    res.status(500).json({ 
      success: false,
      message: 'Server error',
      data: {
        details: error.message
      }
    });
  }
};

// Function to generate unique driver ID
const generateUniqueDriverId = async (DriverModel) => {
  let driverId;
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 10;

  while (!isUnique && attempts < maxAttempts) {
    // Generate a 10-digit numerical driver ID
    // Use timestamp (last 6 digits) + random 4 digits to ensure uniqueness
    const timestamp = Date.now().toString().slice(-6); // Last 6 digits of timestamp
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0'); // 4 random digits
    driverId = timestamp + random; // 10 digits total
    
    // Check if this driver ID already exists
    const existingDriver = await DriverModel.findOne({ driverId });
    if (!existingDriver) {
      isUnique = true;
    }
    attempts++;
  }

  if (!isUnique) {
    throw new Error('Unable to generate unique driver ID after multiple attempts');
  }

  return driverId;
};

// Special function for driver creation with password hashing
const createDriver = async (req, res, DriverModel) => {
  try {
    // Accept: name, email, phoneNumber, plus optional lastName and password from driver app
    const {
      name,
      lastName: explicitLastName,
      email,
      phoneNumber,
      password: explicitPassword
    } = req.body;
    
    // Validate required fields for driver signup
    if (!name || !email || !phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, email, phoneNumber',
        data: {
          missingFields: {
            name: !name,
            email: !email,
            phoneNumber: !phoneNumber
          }
        }
      });
    }

    // Use explicit lastName if provided by driver app, otherwise split name
    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0] || name;
    const lastName = explicitLastName || nameParts.slice(1).join(' ') || name;
    const phone = phoneNumber;
    const emailLower = email.toLowerCase().trim();

    // Validate BOTH phoneNumber and email for uniqueness
    // Check for existing phone number first (priority)
    const existingPhone = await DriverModel.findOne({ phone });
    if (existingPhone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number already registered',
        data: {
          field: 'phone',
          value: phone,
          existingDriverId: existingPhone.driverId
        }
      });
    }
    
    // Check for existing email (if email is provided)
    if (email && email.trim()) {
      const existingEmail = await DriverModel.findOne({ email: emailLower });
      if (existingEmail) {
        return res.status(400).json({
          success: false,
          message: 'Email already registered',
          data: {
            field: 'email',
            value: email,
            existingDriverId: existingEmail.driverId
          }
        });
      }
    }
    
    // Generate unique driver ID
    const driverId = await generateUniqueDriverId(DriverModel);
    
    // Use explicit password if provided by driver app, otherwise generate random
    const saltRounds = 10;
    const passwordToHash = explicitPassword || (Math.random().toString(36).slice(-12) + Math.random().toString(36).slice(-12));
    const passwordHash = await bcrypt.hash(passwordToHash, saltRounds);
    
    // Create driver with ALL fields explicitly set to ensure complete data
    const driverData = {
      driverId,
      firstName,
      lastName,
      email: email.toLowerCase(),
      phone,
      passwordHash,
      profilePhoto: 'https://cdn.example.com/drivers/default.jpg',
      
      // Vehicle Information (all defaults)
      vehicleType: null,
      vehicleNumber: null,
      vehicleModel: null,
      vehicleColor: null,
      vehicleManufacturingYear: null,
      engineNumber: null,
      chassisNumber: null,
      fuleType: "",
      seatingCapacity: "",
      vehicleInsurance: {
        policyNumber: null,
        insuranceCompany: null,
        insuranceExpiryDate: null,
        insuranceAmount: null,
        isInsuranceValid: false
      },
      
      // License and Verification (with defaults)
      licenseNumber: null,
      licenseExpiry: null,
      license_type: null,
      expiry_date: null,
      drivingLicenseIssueDate: null,
      drivingLicenseIssuingAuthority: null,
      aadhaarNumber: null,
      isVerified: false,
      isProfileComplete: false,
      isPhoneVerified: false, // NEW: Set to false on signup
      isVehicleAdded: false,
      isDocumentsUploaded: false,
      verification_status: 'INCOMPLETE',

      // Document Images (empty arrays)
      vehicleRegistrationImages: [],
      vehicleInsuranceImages: [],
      drivingLicenseImages: [],
      idProofImages: [],
      
      // Location and Status (with defaults)
      currentLocation: {
        type: 'Point',
        coordinates: [0, 0]
      },
      isOnline: false,
      isLoggedin: false, // New drivers start as not logged in
      onlineAs: 0, // Default to public (0)
      lastActive: new Date(),
      
      // Financial Information (with defaults)
      walletBalance: 0.0,
      bankAccount: {
        accountHolderName: null,
        accountNumber: null,
        ifscCode: null
      },
      // Membership defaults (app-based monthly renewal)
      membership: {
        plan: 'Free',
        startDate: new Date(),
        endDate: (() => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d; })(),
        paymentStatus: 'Pending',
        transactionId: null,
        isCancelled: false,
        cancelledAt: null,
        cancelReason: null
      },
      
      // Performance Metrics (with defaults)
      rating: 0.0,
      totalRides: 0,
      cancelledRides: 0,
      
      // Role
      role: 'driver'
    };
    
    const driver = new DriverModel(driverData);
    await driver.save();
    
    // Generate OTP for phone verification
    const DriverOTP = require('../models/otpModel');
    const otp = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now
    const createdAt = new Date();

    // Create OTP record with driverId (the actual driverId string, not MongoDB _id)
    const otpRecord = new DriverOTP({
      driverId: driver.driverId, // Store the actual driverId string (e.g., "1234567890")
      phoneNumber: phone, // Store phoneNumber
      email: emailLower, // Store email
      otp,
      isUsed: false,
      expiresAt,
      createdAt
    });

    await otpRecord.save();
    
    // Get the complete driver data from database to ensure all fields are included
    const completeDriver = await DriverModel.findById(driver._id).lean();
    
    // Remove password hash from response
    delete completeDriver.passwordHash;
    
    // Ensure all fields are present in response
    const driverWithAllFields = ensureAllDriverFields(completeDriver);
    
    // Set proper headers for mobile compatibility
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    
    // Create response with all necessary fields for mobile compatibility
    const response = {
      success: true,
      message: 'Driver created successfully. OTP sent for verification.',
      data: {
        driver: driverWithAllFields,
        otp: {
          expiresAt: expiresAt,
          message: 'Please verify your account using the OTP sent to your email and phone'
        }
      }
    };
    
    // Ensure response is properly stringified and sent
    res.status(201).json(response);
  } catch (error) {
    if (error.code === 11000) {
      // Check which field caused the duplicate error
      if (error.keyPattern && error.keyPattern.email) {
        return res.status(400).json({ 
          error: 'Email address already exists.' 
        });
      } else if (error.keyPattern && error.keyPattern.driverId) {
        return res.status(400).json({ 
          error: 'Driver ID already exists. Please try again.' 
        });
      } else {
        return res.status(400).json({ 
          error: 'Duplicate field value. Please check your input.',
          details: error.keyPattern
        });
      }
    }
    res.status(500).json({ error: 'Server error', details: error.message });
  }
};

// Driver Login API - Now accepts only phone number and sends OTP
exports.loginDriver = async (req, res) => {
  try {
    const { phoneNumber, device_id, fcm_id } = req.body;

    // Validate required fields - only phoneNumber is required
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: phoneNumber',
        data: {
          missingFields: {
            phoneNumber: !phoneNumber
          }
        }
      });
    }

    // Find driver by phone number
    const DriverModel = createModel('drivers');
    const driver = await DriverModel.findOne({ phone: phoneNumber });

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found with this phone number',
        data: {
          phoneNumber: phoneNumber
        }
      });
    }

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now
    const createdAt = new Date();

    // Store OTP in drivers_otp collection
    const DriverOTP = require('../models/otpModel');
    
    // Delete any existing unused OTP for this driver (optional - can keep multiple for resend)
    // For login, we'll update existing or create new
    let otpRecord = await DriverOTP.findOne({ 
      driverId: driver.driverId, 
      phoneNumber: phoneNumber,
      isUsed: false 
    });

    if (otpRecord) {
      // Update existing OTP record
      otpRecord.otp = otp;
      otpRecord.expiresAt = expiresAt;
      otpRecord.isUsed = false;
      otpRecord.createdAt = createdAt;
      await otpRecord.save();
    } else {
      // Create new OTP record
      otpRecord = new DriverOTP({
        driverId: driver.driverId,
        phoneNumber: phoneNumber,
        email: driver.email || null,
        otp: otp,
        isUsed: false,
        expiresAt: expiresAt,
        createdAt: createdAt
      });
      await otpRecord.save();
    }

    // Update device_id and fcm_id if provided by the app
    const deviceUpdates = {};
    if (fcm_id) deviceUpdates.fcmToken = fcm_id;
    if (device_id) deviceUpdates.deviceId = device_id;
    if (Object.keys(deviceUpdates).length > 0) {
      await DriverModel.updateOne({ _id: driver._id }, { $set: deviceUpdates });
    }

    // Get complete driver data with all fields
    const completeDriver = await DriverModel.findById(driver._id).lean();
    delete completeDriver.passwordHash;
    
    // Ensure all fields are present in response
    const driverWithAllFields = ensureAllDriverFields(completeDriver);

    // Set proper headers for mobile compatibility
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    // In production, send OTP via SMS here
    // For now, return OTP in response for testing
    res.status(200).json({
      success: true,
      message: 'OTP sent to your registered phone number',
      data: {
        driver: driverWithAllFields, // All driver fields
        otp: {
          expiresAt: expiresAt,
          message: 'OTP sent to your registered phone number. Please verify to complete login.'
        }
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login',
      data: {
        details: error.message
      }
    });
  }
};

// Driver Logout API
exports.logoutDriver = async (req, res) => {
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

    // Find and update driver
    const DriverModel = createModel('drivers');
    const updatedDriver = await DriverModel.findOneAndUpdate(
      { driverId },
      {
        isLoggedin: false, // Set login status to false
        lastActive: new Date(),
        fcmToken: null, // Clear FCM token on logout
        deviceId: null, // Clear device ID on logout
        accessToken: null // Clear access token on logout
      },
      { new: true }
    );

    if (!updatedDriver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: {
          driverId: driverId
        }
      });
    }

    // Remove password hash from response
    const driverResponse = updatedDriver.toObject();
    delete driverResponse.passwordHash;

    // Set proper headers for mobile compatibility
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    res.status(200).json({
      success: true,
      message: 'Driver logged out successfully',
      data: {
        driver: driverResponse,
        logoutTime: new Date().toISOString(),
        sessionInfo: {
          isLoggedin: false,
          lastActive: updatedDriver.lastActive,
          fcmToken: null,
          deviceId: null
        }
      }
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during logout',
      data: {
        details: error.message
      }
    });
  }
};

// Driver Online Status Update API
exports.updateOnlineStatus = async (req, res) => {
  try {
    const { driverId, isOnline, onlineAs } = req.body;

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

    // Validate onlineAs if provided
    if (onlineAs !== undefined && ![0, 1].includes(onlineAs)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid onlineAs value. Must be 0 (public) or 1 (private booking)',
        data: {
          onlineAs: onlineAs
        }
      });
    }

    // Prepare update data
    const updateData = {
      lastActive: new Date()
    };

    // Add isOnline if provided
    if (isOnline !== undefined) {
      updateData.isOnline = isOnline;
    }

    // Add onlineAs if provided
    if (onlineAs !== undefined) {
      updateData.onlineAs = onlineAs;
    }

    // Find and update driver
    const DriverModel = createModel('drivers');
    const updatedDriver = await DriverModel.findOneAndUpdate(
      { driverId },
      updateData,
      { new: true }
    );

    if (!updatedDriver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: {
          driverId: driverId
        }
      });
    }

    // Remove password hash from response
    const driverResponse = updatedDriver.toObject();
    delete driverResponse.passwordHash;

    // Set proper headers for mobile compatibility
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    res.status(200).json({
      success: true,
      message: 'Driver online status updated successfully',
      data: {
        driver: driverResponse,
        updateTime: new Date().toISOString(),
        statusInfo: {
          isOnline: updatedDriver.isOnline,
          onlineAs: updatedDriver.onlineAs,
          onlineAsText: updatedDriver.onlineAs === 0 ? 'Public' : 'Private Booking',
          lastActive: updatedDriver.lastActive
        }
      }
    });

  } catch (error) {
    console.error('Online status update error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during online status update',
      data: {
        details: error.message
      }
    });
  }
};

// Driver Current Status API
exports.getDriverStatus = async (req, res) => {
  try {
    const { driverId } = req.params;

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

    // Find driver by driverId (full document)
    const DriverModel = createModel('drivers');
    const driverDoc = await DriverModel.findOne({ driverId });

    if (!driverDoc) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: {
          driverId: driverId
        }
      });
    }

    // Prepare response-safe driver object
    const driver = driverDoc.toObject();
    delete driver.passwordHash;
    
    // Ensure all fields are present in response
    const driverWithAllFields = ensureAllDriverFields(driver);

    // Set proper headers for mobile compatibility
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    // Determine status text based on fields
    const statusText = driver.isLoggedin 
      ? (driver.isOnline ? 'Online' : 'Offline')
      : 'Not Logged In';

    const onlineAsText = driver.onlineAs === 0 ? 'Public' : 'Private Booking';

    res.status(200).json({
      success: true,
      message: 'Driver status retrieved successfully',
      data: {
        driver: driverWithAllFields,
        driverId: driver.driverId,
        driverName: `${driver.firstName} ${driver.lastName}`,
        status: {
          isLoggedin: driver.isLoggedin,
          isOnline: driver.isOnline,
          onlineAs: driver.onlineAs,
          statusText: statusText,
          onlineAsText: onlineAsText
        },
        location: driver.currentLocation,
        lastActive: driver.lastActive,
        retrievedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Get driver status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while retrieving driver status',
      data: {
        details: error.message
      }
    });
  }
};

// Get all records from a collection (with optional filters)
exports.getRecords = async (req, res) => {
  try {
    const { collectionName } = req.params;
    if (!validateCollectionName(collectionName, res)) return;
    const Model = createModel(collectionName);
    
    // Build query filters
    const query = {};
    if (collectionName.toLowerCase() === 'drivers') {
      const { driverId } = req.query;
      if (driverId) {
        query.driverId = driverId;
      }
    }
    
    const records = await Model.find(query).lean();
    
    // Remove password hash from driver records and ensure all fields are present
    let data = records;
    if (collectionName.toLowerCase() === 'drivers') {
      data = records.map(record => {
        // Remove password hash
        delete record.passwordHash;
        
        // Ensure all fields are present in response
        const completeDriver = ensureAllDriverFields(record);
        
        // Ensure __v field is present (for Kotlin compatibility)
        if (completeDriver.__v === undefined) {
          completeDriver.__v = record.__v || 0;
        }
        
        // Ensure all required fields for Kotlin data class are present
        // Convert dates to strings for consistency
        if (completeDriver.createdAt && typeof completeDriver.createdAt === 'object') {
          completeDriver.createdAt = completeDriver.createdAt.toISOString();
        }
        if (completeDriver.updatedAt && typeof completeDriver.updatedAt === 'object') {
          completeDriver.updatedAt = completeDriver.updatedAt.toISOString();
        }
        if (completeDriver.lastActive && typeof completeDriver.lastActive === 'object') {
          completeDriver.lastActive = completeDriver.lastActive.toISOString();
        }
        if (completeDriver.licenseExpiry && typeof completeDriver.licenseExpiry === 'object') {
          completeDriver.licenseExpiry = completeDriver.licenseExpiry.toISOString();
        }
        if (completeDriver.drivingLicenseIssueDate && typeof completeDriver.drivingLicenseIssueDate === 'object') {
          completeDriver.drivingLicenseIssueDate = completeDriver.drivingLicenseIssueDate.toISOString();
        }
        if (completeDriver.expiry_date && typeof completeDriver.expiry_date === 'object') {
          completeDriver.expiry_date = completeDriver.expiry_date.toISOString();
        }
        if (completeDriver.vehicleInsurance && completeDriver.vehicleInsurance.insuranceExpiryDate && typeof completeDriver.vehicleInsurance.insuranceExpiryDate === 'object') {
          completeDriver.vehicleInsurance.insuranceExpiryDate = completeDriver.vehicleInsurance.insuranceExpiryDate.toISOString();
        }
        if (completeDriver.membership) {
          if (completeDriver.membership.startDate && typeof completeDriver.membership.startDate === 'object') {
            completeDriver.membership.startDate = completeDriver.membership.startDate.toISOString();
          }
          if (completeDriver.membership.endDate && typeof completeDriver.membership.endDate === 'object') {
            completeDriver.membership.endDate = completeDriver.membership.endDate.toISOString();
          }
          if (completeDriver.membership.cancelledAt && typeof completeDriver.membership.cancelledAt === 'object') {
            completeDriver.membership.cancelledAt = completeDriver.membership.cancelledAt.toISOString();
          }
        }
        
        return completeDriver;
      });
    }
    
    // Set proper headers for mobile compatibility
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    // When drivers list is filtered by driverId and exactly one driver is found, return data as object
    // so clients (e.g. SyncDutyStatus) that expect data to be a single driver object get BEGIN_OBJECT, not BEGIN_ARRAY
    const payloadData = (collectionName.toLowerCase() === 'drivers' && query.driverId && data.length === 1)
      ? data[0]
      : data;

    res.status(200).json({
      success: true,
      message: records.length === 0 ? 'No drivers found' : `${records.length} driver(s) found`,
      count: records.length.toString(), // Convert to string for Kotlin compatibility
      data: payloadData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: 'Server error', 
      details: error.message 
    });
  }
};

// Get a single record by ID
exports.getRecordById = async (req, res) => {
  try {
    const { collectionName, id } = req.params;
    if (!validateCollectionName(collectionName, res)) return;
    const Model = createModel(collectionName);
    
    const record = await Model.findById(id);
    if (!record) {
      return res.status(404).json({ 
        error: `${collectionName} not found` 
      });
    }
    
    // Remove password hash from driver record and ensure all fields are present
    let data = record;
    if (collectionName.toLowerCase() === 'drivers') {
      data = record.toObject();
      delete data.passwordHash;
      // Ensure all fields are present in response
      data = ensureAllDriverFields(data);
    }
    
    res.status(200).json({
      success: true,
      data: data
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error', details: error.message });
  }
};

// Update a record
exports.updateRecord = async (req, res) => {
  try {
    const { collectionName, id } = req.params;
    if (!validateCollectionName(collectionName, res)) return;
    const Model = createModel(collectionName);

    const record = await Model.findByIdAndUpdate(
      id,
      { $set: stripSensitiveFields(req.body) },
      { new: true, runValidators: true }
    );
    
    if (!record) {
      return res.status(404).json({ 
        error: `${collectionName} not found` 
      });
    }
    
    res.status(200).json({
      success: true,
      message: `${collectionName} updated successfully`,
      data: record
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ 
        error: 'Duplicate field value. Phone number or email already exists.' 
      });
    }
    res.status(500).json({ error: 'Server error', details: error.message });
  }
};

// Delete a record
exports.deleteRecord = async (req, res) => {
  try {
    const { collectionName, id } = req.params;
    if (!validateCollectionName(collectionName, res)) return;
    const Model = createModel(collectionName);
    
    const record = await Model.findByIdAndDelete(id);
    
    if (!record) {
      return res.status(404).json({ 
        error: `${collectionName} not found` 
      });
    }
    
    res.status(200).json({
      success: true,
      message: `${collectionName} deleted successfully`
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error', details: error.message });
  }
}; 

// JWT Token Verification Middleware
exports.verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access token required',
        data: {
          error: 'Authorization header missing or invalid format'
        }
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const jwtSecret = process.env.JWT_SECRET;

    // Verify JWT token
    const decoded = jwt.verify(token, jwtSecret);
    
    // Check if driver or user exists and token is still valid in database
    if (decoded.driverId) {
      const DriverModel = createModel('drivers');
      const driver = await DriverModel.findOne({
        driverId: decoded.driverId,
        accessToken: token
      });
      if (!driver) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired token',
          data: { error: 'Driver not found or token invalidated' }
        });
      }
      req.driver = driver;
      req.user = null;
    } else if (decoded.userId) {
      const UserModel = createModel('users');
      const user = await UserModel.findOne({
        userId: decoded.userId,
        accessToken: token
      });
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired token',
          data: { error: 'User not found or token invalidated' }
        });
      }
      req.user = user;
      req.driver = null;
    } else {
      return res.status(401).json({
        success: false,
        message: 'Invalid token payload',
        data: { error: 'Token does not contain driverId or userId' }
      });
    }

    req.token = token;
    req.decoded = decoded;
    next();

  } catch (error) {
    console.error('Token verification error:', error);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
        data: {
          error: 'Token signature is invalid'
        }
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired',
        data: {
          error: 'Access token has expired'
        }
      });
    }

    res.status(500).json({
      success: false,
      message: 'Token verification failed',
      data: {
        error: error.message
      }
    });
  }
};

// Update vehicle details API - accepts pre-uploaded image URLs and publicIds
// Accepts any fields independently or grouped - NO MANDATORY CHECKS (except driverId)
exports.updateVehicleDetails = async (req, res) => {
  try {
    const {
      driverId, 
      vehicleData, 
      licenseData,
      vehicleRegistrationImages,
      vehicleInsuranceImages,
      drivingLicenseImages,
      idProofImages,
      id_proof_type,
      insurance, // Alias for vehicleInsuranceImages
      // Allow fields directly at root level too
      vehicleType,
      vehicleNumber,
      vehicleModel,
      vehicleColor,
      vehicleManufacturingYear,
      engineNumber,
      chassisNumber,
      vehicleInsurance,
      license_number,
      license_type,
      drivingLicenseIssueDate,
      expiry_date,
      drivingLicenseIssuingAuthority,
      fuleType,
      seatingCapacity,
      isVehicleAdded,
      isDocumentsUploaded,
      verification_status
    } = req.body;

    // Validate required fields - only driverId is required to identify the driver
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

    // Find driver by driverId
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

    // Prepare update data
    const updateData = {
      updatedAt: new Date()
    };

    // Process vehicleData object first (if provided)
    if (vehicleData && typeof vehicleData === 'object') {
      const {
        vehicleType: vType,
        vehicleNumber: vNumber,
        vehicleModel: vModel,
        vehicleColor: vColor,
        vehicleManufacturingYear: vYear,
        engineNumber: eNumber,
        chassisNumber: cNumber,
        vehicleInsurance: vInsurance
      } = vehicleData;

      // Handle vehicle manufacturing year from vehicleData (skip if invalid, don't error)
      if (vYear !== undefined && vYear !== null) {
        const year = typeof vYear === 'string' ? parseInt(vYear) : vYear;
        const currentYear = new Date().getFullYear();
        if (!isNaN(year) && year >= 1900 && year <= currentYear + 1) {
          updateData.vehicleManufacturingYear = year;
        }
      }

      // Handle vehicle type from vehicleData (accept any value)
      if (vType !== undefined && vType !== null) {
        // Accept any string value including empty string, but trim whitespace
        updateData.vehicleType = typeof vType === 'string' ? vType.trim() : vType;
      }

      // Add vehicle fields from vehicleData object
      if (vNumber !== undefined) updateData.vehicleNumber = vNumber;
      if (vModel !== undefined) updateData.vehicleModel = vModel;
      if (vColor !== undefined) updateData.vehicleColor = vColor;
      if (eNumber !== undefined) updateData.engineNumber = eNumber;
      if (cNumber !== undefined) updateData.chassisNumber = cNumber;

      // Handle vehicle insurance from vehicleData
      if (vInsurance !== undefined) {
        if (typeof vInsurance === 'object' && vInsurance !== null) {
          const currentInsurance = driver.vehicleInsurance || {};
          const mergedInsurance = {
            ...currentInsurance,
            ...vInsurance
          };
          // Convert insuranceExpiryDate string to Date if provided
          if (mergedInsurance.insuranceExpiryDate && typeof mergedInsurance.insuranceExpiryDate === 'string') {
            const expiryDate = new Date(mergedInsurance.insuranceExpiryDate);
            if (!isNaN(expiryDate.getTime())) {
              mergedInsurance.insuranceExpiryDate = expiryDate;
            }
          }
          updateData.vehicleInsurance = mergedInsurance;
        } else {
          updateData.vehicleInsurance = vInsurance;
        }
      }
    }

    // Handle direct root-level vehicle fields (these override vehicleData if both provided)
    // Root level fields take precedence over nested vehicleData
    if (vehicleType !== undefined && vehicleType !== null) {
      // Accept any string value including empty string, but trim whitespace
      updateData.vehicleType = typeof vehicleType === 'string' ? vehicleType.trim() : vehicleType;
    }
    if (vehicleNumber !== undefined) updateData.vehicleNumber = vehicleNumber;
    if (vehicleModel !== undefined) updateData.vehicleModel = vehicleModel;
    if (vehicleColor !== undefined) updateData.vehicleColor = vehicleColor;
    if (engineNumber !== undefined) updateData.engineNumber = engineNumber;
    if (chassisNumber !== undefined) updateData.chassisNumber = chassisNumber;
    if (fuleType !== undefined) updateData.fuleType = fuleType;
    if (seatingCapacity !== undefined) updateData.seatingCapacity = seatingCapacity;
    if (isVehicleAdded !== undefined) updateData.isVehicleAdded = isVehicleAdded;
    if (isDocumentsUploaded !== undefined) updateData.isDocumentsUploaded = isDocumentsUploaded;
    if (verification_status !== undefined) updateData.verification_status = verification_status;
    
    // Handle vehicleManufacturingYear at root level (skip if invalid, don't error)
    if (vehicleManufacturingYear !== undefined && vehicleManufacturingYear !== null) {
      const year = typeof vehicleManufacturingYear === 'string' ? parseInt(vehicleManufacturingYear) : vehicleManufacturingYear;
      const currentYear = new Date().getFullYear();
      if (!isNaN(year) && year >= 1900 && year <= currentYear + 1) {
        updateData.vehicleManufacturingYear = year;
      }
    }
    
    // Handle vehicleInsurance at root level (overrides vehicleData if both provided)
    if (vehicleInsurance !== undefined) {
      if (typeof vehicleInsurance === 'object' && vehicleInsurance !== null) {
        const currentInsurance = driver.vehicleInsurance || {};
        const mergedInsurance = {
          ...currentInsurance,
          ...vehicleInsurance
        };
        // Convert insuranceExpiryDate string to Date if provided
        if (mergedInsurance.insuranceExpiryDate && typeof mergedInsurance.insuranceExpiryDate === 'string') {
          const expiryDate = new Date(mergedInsurance.insuranceExpiryDate);
          if (!isNaN(expiryDate.getTime())) {
            mergedInsurance.insuranceExpiryDate = expiryDate;
          }
        }
        updateData.vehicleInsurance = mergedInsurance;
      } else {
        updateData.vehicleInsurance = vehicleInsurance;
      }
    }

    // Process licenseData object first (if provided)
    if (licenseData && typeof licenseData === 'object') {
      const {
        license_number: licenseNum,
        license_type: licenseType,
        drivingLicenseIssueDate: issueDate,
        expiry_date: expiryDate,
        drivingLicenseIssuingAuthority: authority
      } = licenseData;

      if (licenseNum !== undefined) updateData.licenseNumber = licenseNum;
      if (licenseType !== undefined) updateData.license_type = licenseType;
      if (issueDate !== undefined && issueDate !== null) {
        const parsedDate = new Date(issueDate);
        if (!isNaN(parsedDate.getTime())) {
          updateData.drivingLicenseIssueDate = parsedDate;
        }
      }
      if (expiryDate !== undefined && expiryDate !== null) {
        const parsedExpiry = new Date(expiryDate);
        if (!isNaN(parsedExpiry.getTime())) {
          updateData.expiry_date = parsedExpiry;
          updateData.licenseExpiry = parsedExpiry;
        }
      }
      if (authority !== undefined) {
        updateData.drivingLicenseIssuingAuthority = authority;
      }
    }

    // Handle direct root-level license fields (these override licenseData if both provided)
    if (license_number !== undefined) updateData.licenseNumber = license_number;
    if (license_type !== undefined) updateData.license_type = license_type;
    if (drivingLicenseIssueDate !== undefined && drivingLicenseIssueDate !== null) {
      const issueDate = new Date(drivingLicenseIssueDate);
      if (!isNaN(issueDate.getTime())) {
        updateData.drivingLicenseIssueDate = issueDate;
      }
    }
    if (expiry_date !== undefined && expiry_date !== null) {
      const expiryDate = new Date(expiry_date);
      if (!isNaN(expiryDate.getTime())) {
        updateData.expiry_date = expiryDate;
        // Also update licenseExpiry for backward compatibility
        updateData.licenseExpiry = expiryDate;
      }
    }
    if (drivingLicenseIssuingAuthority !== undefined) {
      updateData.drivingLicenseIssuingAuthority = drivingLicenseIssuingAuthority;
    }

    // Handle id_proof_type field
    if (id_proof_type !== undefined) {
      updateData.id_proof_type = id_proof_type;
    }

    // Handle image arrays - validate and format
    const validateImageArray = (images, fieldName) => {
      if (!images) return null;
      if (!Array.isArray(images)) {
        throw new Error(`${fieldName} must be an array`);
      }
      return images.map(img => {
        if (typeof img === 'string') {
          // Legacy format: just URL string
          return {
            url: img,
            publicId: img.split('/').pop().split('.')[0] || img
          };
        }
        if (typeof img === 'object' && img.url && img.publicId) {
          return {
            url: img.url,
            publicId: img.publicId
          };
        }
        throw new Error(`${fieldName} items must be objects with url and publicId, or URL strings`);
      });
    };

    // Normalize existing images to {url, publicId} format
    const normalizeExistingImages = (images) => {
      if (!images || !Array.isArray(images)) return [];
      return images.map(img => {
        if (typeof img === 'string') {
          // Old format: just URL string, extract publicId from URL
          const urlParts = img.split('/');
          const filename = urlParts[urlParts.length - 1];
          const publicId = filename.split('.')[0] || img;
          // Try to extract full path from URL
          const urlMatch = img.match(/\/upload\/v\d+\/(.+?)\.(jpg|jpeg|png|gif|webp)/i);
          const fullPublicId = urlMatch ? urlMatch[1] : publicId;
          return {
            url: img,
            publicId: fullPublicId
          };
        }
        // Already in new format: {url, publicId}
        if (typeof img === 'object' && img.url && img.publicId) {
          return {
            url: img.url,
            publicId: img.publicId
          };
        }
        // Invalid format, skip
        return null;
      }).filter(img => img !== null);
    };

    // Process image arrays - REPLACE existing images (not merge)
    // Clear existing images from MongoDB before saving new ones
    try {
      if (vehicleRegistrationImages !== undefined) {
        const validated = validateImageArray(vehicleRegistrationImages, 'vehicleRegistrationImages');
        // Replace completely - if null/empty array, clear the field
        updateData.vehicleRegistrationImages = validated !== null ? validated : [];
      }

      // Handle both vehicleInsuranceImages and insurance (alias)
      const insuranceImages = vehicleInsuranceImages || insurance;
      if (insuranceImages !== undefined) {
        const validated = validateImageArray(insuranceImages, 'vehicleInsuranceImages');
        // Replace completely - if null/empty array, clear the field
        updateData.vehicleInsuranceImages = validated !== null ? validated : [];
      }

      if (drivingLicenseImages !== undefined) {
        const validated = validateImageArray(drivingLicenseImages, 'drivingLicenseImages');
        // Replace completely - if null/empty array, clear the field
        updateData.drivingLicenseImages = validated !== null ? validated : [];
      }

      if (idProofImages !== undefined) {
        const validated = validateImageArray(idProofImages, 'idProofImages');
        // Replace completely - if null/empty array, clear the field
        updateData.idProofImages = validated !== null ? validated : [];
      }
    } catch (imageError) {
      return res.status(400).json({
        success: false,
        message: imageError.message,
        data: {
          error: 'Image validation failed'
        }
      });
    }

    // Check if there's anything to update (besides updatedAt)
    const fieldsToUpdate = Object.keys(updateData).filter(key => key !== 'updatedAt');
    if (fieldsToUpdate.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields provided to update',
        data: {
          receivedFields: Object.keys(req.body).filter(key => key !== 'driverId'),
          note: 'Provide at least one field to update'
        }
      });
    }

    // Update driver with better error handling
    let updatedDriver;
    try {
      updatedDriver = await DriverModel.findOneAndUpdate(
        { driverId },
        updateData,
        { new: true, runValidators: true }
      );
      
      if (!updatedDriver) {
        return res.status(404).json({
          success: false,
          message: 'Driver not found after update',
          data: {
            driverId: driverId
          }
        });
      }
    } catch (validationError) {
      console.error('Mongoose validation error:', validationError);
      console.error('Update data that caused error:', JSON.stringify(updateData, null, 2));
      
      // Handle Mongoose validation errors
      if (validationError.name === 'ValidationError') {
        const validationErrors = {};
        if (validationError.errors) {
          Object.keys(validationError.errors).forEach(key => {
            validationErrors[key] = validationError.errors[key].message;
          });
        }
        
        return res.status(400).json({
          success: false,
          message: 'Validation error while updating vehicle details',
          data: {
            error: validationError.message,
            errorType: 'ValidationError',
            validationErrors: validationErrors
          }
        });
      }
      
      // Re-throw if it's not a validation error
      throw validationError;
    }

    // Remove password hash from response
    const driverResponse = updatedDriver.toObject();
    delete driverResponse.passwordHash;
    
    // Ensure all fields are present in response
    const driverWithAllFields = ensureAllDriverFields(driverResponse);

    // Set proper headers for mobile compatibility
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    res.status(200).json({
      success: true,
      message: 'Vehicle details updated successfully',
      data: {
        driver: driverWithAllFields,
        updatedFields: Object.keys(updateData).filter(key => key !== 'updatedAt')
      }
    });

  } catch (error) {
    console.error('Update vehicle details error:', error);
    console.error('Error stack:', error.stack);
    try {
      console.error('Request body:', JSON.stringify(req.body, null, 2));
    } catch (jsonError) {
      console.error('Could not stringify request body:', jsonError.message);
      console.error('Request body keys:', Object.keys(req.body || {}));
    }
    
    const errorResponse = {
      success: false,
      message: 'Internal server error while updating vehicle details',
      data: {
        error: error.message,
        errorType: error.name || 'Unknown'
      }
    };
    
    // Add detailed error info in development mode
    if (process.env.NODE_ENV === 'development') {
      errorResponse.data.stack = error.stack;
      errorResponse.data.details = error.toString();
    }
    
    res.status(500).json(errorResponse);
  }
};

// Get current driver profile (protected route example)
exports.getDriverProfile = async (req, res) => {
  try {
    // Driver info is already available from verifyToken middleware
    const driver = req.driver;
    
    // Remove password hash from response
    const driverResponse = driver.toObject();
    delete driverResponse.passwordHash;
    
    // Ensure all fields are present in response
    const driverWithAllFields = ensureAllDriverFields(driverResponse);

    res.status(200).json({
      success: true,
      message: 'Driver profile retrieved successfully',
      data: {
        driver: driverWithAllFields
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while retrieving profile',
      data: {
        details: error.message
      }
    });
  }
};

// Update Driver Fields by driverId (Generic update for any driver field)
exports.updateDriverFields = async (req, res) => {
  try {
    const { driverId } = req.body;
    const updateData = stripSensitiveFields({ ...req.body });
    delete updateData.driverId; // Remove driverId from update data

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

    // Check if there's anything to update (besides driverId)
    const fieldsToUpdate = Object.keys(updateData);
    if (fieldsToUpdate.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields provided to update',
        data: {
          receivedFields: Object.keys(req.body),
          note: 'Provide at least one field to update (excluding driverId)'
        }
      });
    }

    // Find driver by driverId
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

    // Add updatedAt timestamp
    updateData.updatedAt = new Date();

    // Update driver with better error handling
    let updatedDriver;
    try {
      updatedDriver = await DriverModel.findOneAndUpdate(
        { driverId },
        updateData,
        { new: true, runValidators: true }
      );
      
      if (!updatedDriver) {
        return res.status(404).json({
          success: false,
          message: 'Driver not found after update',
          data: {
            driverId: driverId
          }
        });
      }
    } catch (validationError) {
      console.error('Mongoose validation error:', validationError);
      
      // Handle Mongoose validation errors
      if (validationError.name === 'ValidationError') {
        const validationErrors = {};
        if (validationError.errors) {
          Object.keys(validationError.errors).forEach(key => {
            validationErrors[key] = validationError.errors[key].message;
          });
        }
        
        return res.status(400).json({
          success: false,
          message: 'Validation error while updating driver',
          data: {
            error: validationError.message,
            errorType: 'ValidationError',
            validationErrors: validationErrors
          }
        });
      }
      
      // Handle duplicate key errors
      if (validationError.code === 11000) {
        const duplicateField = Object.keys(validationError.keyPattern || {})[0];
        return res.status(400).json({
          success: false,
          message: `Duplicate ${duplicateField} value. This ${duplicateField} already exists.`,
          data: {
            error: 'Duplicate field value',
            duplicateField: duplicateField
          }
        });
      }
      
      throw validationError;
    }

    // Remove password hash from response
    const driverResponse = updatedDriver.toObject();
    delete driverResponse.passwordHash;
    
    // Ensure all fields are present in response
    const driverWithAllFields = ensureAllDriverFields(driverResponse);

    // Set proper headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    res.status(200).json({
      success: true,
      message: 'Driver updated successfully',
      data: {
        driver: driverWithAllFields,
        updatedFields: fieldsToUpdate
      }
    });

  } catch (error) {
    console.error('Update driver fields error:', error);
    console.error('Error stack:', error.stack);
    
    const errorResponse = {
      success: false,
      message: 'Internal server error while updating driver',
      data: {
        error: error.message,
        errorType: error.name || 'Unknown'
      }
    };
    
    // Add detailed error info in development mode
    if (process.env.NODE_ENV === 'development') {
      errorResponse.data.stack = error.stack;
      errorResponse.data.details = error.toString();
    }
    
    res.status(500).json(errorResponse);
  }
};

// Update driver profile (firstName, lastName, profilePhoto)
exports.updateDriverProfile = async (req, res) => {
  try {
    const { driverId, firstName, lastName, profilePhoto } = req.body;

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

    // Find driver by driverId
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

    // Prepare update data
    const updateData = {
      updatedAt: new Date()
    };

    // Add fields to update if provided
    if (firstName !== undefined) {
      if (!firstName || firstName.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: 'firstName cannot be empty',
          data: {
            field: 'firstName'
          }
        });
      }
      updateData.firstName = firstName.trim();
    }

    if (lastName !== undefined) {
      if (!lastName || lastName.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: 'lastName cannot be empty',
          data: {
            field: 'lastName'
          }
        });
      }
      updateData.lastName = lastName.trim();
    }

    if (profilePhoto !== undefined) {
      if (!profilePhoto || profilePhoto.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: 'profilePhoto cannot be empty',
          data: {
            field: 'profilePhoto'
          }
        });
      }
      updateData.profilePhoto = profilePhoto.trim();
    }

    // Check if there's anything to update
    if (Object.keys(updateData).length === 1) { // Only updatedAt
      return res.status(400).json({
        success: false,
        message: 'No fields provided to update. Provide at least one of: firstName, lastName, profilePhoto',
        data: {
          allowedFields: ['firstName', 'lastName', 'profilePhoto']
        }
      });
    }

    // Update driver
    let updatedDriver;
    try {
      updatedDriver = await DriverModel.findOneAndUpdate(
        { driverId },
        updateData,
        { new: true, runValidators: true }
      );
      
      if (!updatedDriver) {
        return res.status(404).json({
          success: false,
          message: 'Driver not found after update',
          data: {
            driverId: driverId
          }
        });
      }
    } catch (validationError) {
      console.error('Mongoose validation error:', validationError);
      
      if (validationError.name === 'ValidationError') {
        const validationErrors = {};
        if (validationError.errors) {
          Object.keys(validationError.errors).forEach(key => {
            validationErrors[key] = validationError.errors[key].message;
          });
        }
        
        return res.status(400).json({
          success: false,
          message: 'Validation error while updating profile',
          data: {
            error: validationError.message,
            errorType: 'ValidationError',
            validationErrors: validationErrors
          }
        });
      }
      
      throw validationError;
    }

    // Remove password hash from response
    const driverResponse = updatedDriver.toObject();
    delete driverResponse.passwordHash;
    
    // Ensure all fields are present in response
    const driverWithAllFields = ensureAllDriverFields(driverResponse);

    // Set proper headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    res.status(200).json({
      success: true,
      message: 'Driver profile updated successfully',
      data: {
        driver: driverWithAllFields,
        updatedFields: Object.keys(updateData).filter(key => key !== 'updatedAt')
      }
    });

  } catch (error) {
    console.error('Update driver profile error:', error);
    console.error('Error stack:', error.stack);
    
    const errorResponse = {
      success: false,
      message: 'Internal server error while updating driver profile',
      data: {
        error: error.message,
        errorType: error.name || 'Unknown'
      }
    };
    
    // Add detailed error info in development mode
    if (process.env.NODE_ENV === 'development') {
      errorResponse.data.stack = error.stack;
      errorResponse.data.details = error.toString();
    }
    
    res.status(500).json(errorResponse);
  }
};

// Get vehicle details by driverId
exports.getVehicleDetails = async (req, res) => {
  try {
    const { driverId } = req.params;

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

    // Find driver by driverId
    const DriverModel = createModel('drivers');
    const driver = await DriverModel.findOne({ driverId }).lean();

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: {
          driverId: driverId
        }
      });
    }

    // Remove password hash from response
    delete driver.passwordHash;
    delete driver.__v; // Remove version key

    // Ensure all fields are present using the helper function
    const driverWithAllFields = ensureAllDriverFields(driver);

    // Extract ALL vehicle-related fields from the complete driver record
    const vehicleDetails = {
      // Driver Basic Info
      driverId: driverWithAllFields.driverId,
      driverName: driverWithAllFields.fullName || `${driverWithAllFields.firstName || ''} ${driverWithAllFields.lastName || ''}`.trim(),
      firstName: driverWithAllFields.firstName,
      lastName: driverWithAllFields.lastName,
      email: driverWithAllFields.email,
      phone: driverWithAllFields.phone,
      profilePhoto: driverWithAllFields.profilePhoto,
      
      // Vehicle Information - ALL fields
      vehicleType: driverWithAllFields.vehicleType,
      vehicleNumber: driverWithAllFields.vehicleNumber,
      vehicleModel: driverWithAllFields.vehicleModel,
      vehicleColor: driverWithAllFields.vehicleColor,
      vehicleManufacturingYear: driverWithAllFields.vehicleManufacturingYear,
      engineNumber: driverWithAllFields.engineNumber,
      chassisNumber: driverWithAllFields.chassisNumber,
      
      // Vehicle Insurance Details - Complete object
      vehicleInsurance: driverWithAllFields.vehicleInsurance || {
        policyNumber: null,
        insuranceCompany: null,
        insuranceExpiryDate: null,
        insuranceAmount: null,
        isInsuranceValid: false
      },
      
      // Document Images - ALL image arrays
      vehicleRegistrationImages: driverWithAllFields.vehicleRegistrationImages || [],
      vehicleInsuranceImages: driverWithAllFields.vehicleInsuranceImages || [],
      drivingLicenseImages: driverWithAllFields.drivingLicenseImages || [],
      idProofImages: driverWithAllFields.idProofImages || [],
      
      // License Information
      licenseNumber: driverWithAllFields.licenseNumber,
      licenseExpiry: driverWithAllFields.licenseExpiry,
      license_type: driverWithAllFields.license_type,
      expiry_date: driverWithAllFields.expiry_date,
      drivingLicenseIssueDate: driverWithAllFields.drivingLicenseIssueDate,
      drivingLicenseIssuingAuthority: driverWithAllFields.drivingLicenseIssuingAuthority,
      aadhaarNumber: driverWithAllFields.aadhaarNumber,
      id_proof_type: driverWithAllFields.id_proof_type,
      
      // Verification Status
      isVerified: driverWithAllFields.isVerified,
      isProfileComplete: driverWithAllFields.isProfileComplete,
      
      // Location (if relevant to vehicle)
      currentLocation: driverWithAllFields.currentLocation,
      
      // Status Information
      isOnline: driverWithAllFields.isOnline,
      isLoggedin: driverWithAllFields.isLoggedin,
      onlineAs: driverWithAllFields.onlineAs,
      lastActive: driverWithAllFields.lastActive,
      
      // System Fields
      role: driverWithAllFields.role,
      createdAt: driverWithAllFields.createdAt,
      updatedAt: driverWithAllFields.updatedAt,
      _id: driverWithAllFields._id,
      id: driverWithAllFields.id
    };

    // Set proper headers for mobile compatibility
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    res.status(200).json({
      success: true,
      message: 'Vehicle details retrieved successfully',
      data: {
        vehicleDetails: vehicleDetails,
        retrievedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Get vehicle details error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while retrieving vehicle details',
      data: {
        details: error.message
      }
    });
  }
};

// Update vehicle details API with image upload support
exports.updateVehicleDetailsOld = async (req, res) => {
  let uploadedFiles = null;
  
  try {
    const { driverId } = req.body;
    const {
      vehicleType,
      vehicleNumber,
      vehicleModel,
      vehicleColor,
      vehicleManufacturingYear,
      engineNumber,
      chassisNumber,
      vehicleInsurance
    } = req.body;

    // Get uploaded files from multer
    uploadedFiles = req.files;

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

    // Validate vehicle manufacturing year if provided
    if (vehicleManufacturingYear !== undefined) {
      const currentYear = new Date().getFullYear();
      if (vehicleManufacturingYear < 1900 || vehicleManufacturingYear > currentYear + 1) {
        return res.status(400).json({
          success: false,
          message: 'Invalid vehicle manufacturing year. Must be between 1900 and current year + 1',
          data: {
            vehicleManufacturingYear: vehicleManufacturingYear,
            validRange: {
              min: 1900,
              max: currentYear + 1
            }
          }
        });
      }
    }

    // Validate vehicle type if provided
    if (vehicleType && !['Auto', 'Car', 'Bike', 'Van'].includes(vehicleType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid vehicle type. Must be one of: Auto, Car, Bike, Van',
        data: {
          vehicleType: vehicleType,
          validTypes: ['Auto', 'Car', 'Bike', 'Van']
        }
      });
    }

    // Validate image arrays if provided
    const validateImageArray = (images, fieldName) => {
      if (images !== undefined && images !== null) {
        if (!Array.isArray(images)) {
          return {
            valid: false,
            message: `${fieldName} must be an array of image URLs`
          };
        }
        if (!images.every(url => typeof url === 'string' && url.trim().length > 0)) {
          return {
            valid: false,
            message: `${fieldName} must contain valid image URLs`
          };
        }
      }
      return { valid: true };
    };

    // Validate all image fields
    const vehicleRegValidation = validateImageArray(vehicleRegistrationImages, 'Vehicle registration images');
    if (!vehicleRegValidation.valid) {
      return res.status(400).json({
        success: false,
        message: vehicleRegValidation.message
      });
    }

    const vehicleInsValidation = validateImageArray(vehicleInsuranceImages, 'Vehicle insurance images');
    if (!vehicleInsValidation.valid) {
      return res.status(400).json({
        success: false,
        message: vehicleInsValidation.message
      });
    }

    const drivingLicenseValidation = validateImageArray(drivingLicenseImages, 'Driving license images');
    if (!drivingLicenseValidation.valid) {
      return res.status(400).json({
        success: false,
        message: drivingLicenseValidation.message
      });
    }

    const idProofValidation = validateImageArray(idProofImages, 'ID proof images');
    if (!idProofValidation.valid) {
      return res.status(400).json({
        success: false,
        message: idProofValidation.message
      });
    }

    // Find driver
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

    // Prepare update data
    const updateData = {
      updatedAt: new Date()
    };

    // Add vehicle fields if provided
    if (vehicleType !== undefined) updateData.vehicleType = vehicleType;
    if (vehicleNumber !== undefined) updateData.vehicleNumber = vehicleNumber;
    if (vehicleModel !== undefined) updateData.vehicleModel = vehicleModel;
    if (vehicleColor !== undefined) updateData.vehicleColor = vehicleColor;
    if (vehicleManufacturingYear !== undefined) updateData.vehicleManufacturingYear = vehicleManufacturingYear;
    if (engineNumber !== undefined) updateData.engineNumber = engineNumber;
    if (chassisNumber !== undefined) updateData.chassisNumber = chassisNumber;

    // Add document image fields if provided
    if (vehicleRegistrationImages !== undefined) updateData.vehicleRegistrationImages = vehicleRegistrationImages;
    if (vehicleInsuranceImages !== undefined) updateData.vehicleInsuranceImages = vehicleInsuranceImages;
    if (drivingLicenseImages !== undefined) updateData.drivingLicenseImages = drivingLicenseImages;
    if (idProofImages !== undefined) updateData.idProofImages = idProofImages;

    // Handle vehicle insurance details
    if (vehicleInsurance !== undefined) {
      const currentInsurance = driver.vehicleInsurance || {};
      updateData.vehicleInsurance = {
        policyNumber: vehicleInsurance.policyNumber !== undefined ? vehicleInsurance.policyNumber : currentInsurance.policyNumber,
        insuranceCompany: vehicleInsurance.insuranceCompany !== undefined ? vehicleInsurance.insuranceCompany : currentInsurance.insuranceCompany,
        insuranceExpiryDate: vehicleInsurance.insuranceExpiryDate !== undefined ? vehicleInsurance.insuranceExpiryDate : currentInsurance.insuranceExpiryDate,
        insuranceAmount: vehicleInsurance.insuranceAmount !== undefined ? vehicleInsurance.insuranceAmount : currentInsurance.insuranceAmount,
        isInsuranceValid: vehicleInsurance.isInsuranceValid !== undefined ? vehicleInsurance.isInsuranceValid : currentInsurance.isInsuranceValid
      };
    }

    // Update driver
    const updatedDriver = await DriverModel.findOneAndUpdate(
      { driverId },
      updateData,
      { new: true, runValidators: true }
    );

    // Remove password hash from response
    const driverResponse = updatedDriver.toObject();
    delete driverResponse.passwordHash;
    
    // Ensure all fields are present in response
    const driverWithAllFields = ensureAllDriverFields(driverResponse);

    res.status(200).json({
      success: true,
      message: 'Vehicle details updated successfully',
      data: {
        driver: driverWithAllFields,
        updatedFields: Object.keys(updateData).filter(key => key !== 'updatedAt'),
        vehicleDetails: {
          vehicleType: updatedDriver.vehicleType,
          vehicleNumber: updatedDriver.vehicleNumber,
          vehicleModel: updatedDriver.vehicleModel,
          vehicleColor: updatedDriver.vehicleColor,
          vehicleManufacturingYear: updatedDriver.vehicleManufacturingYear,
          engineNumber: updatedDriver.engineNumber,
          chassisNumber: updatedDriver.chassisNumber,
          vehicleInsurance: updatedDriver.vehicleInsurance
        },
        documentImages: {
          vehicleRegistrationImages: updatedDriver.vehicleRegistrationImages,
          vehicleInsuranceImages: updatedDriver.vehicleInsuranceImages,
          drivingLicenseImages: updatedDriver.drivingLicenseImages,
          idProofImages: updatedDriver.idProofImages
        }
      }
    });

  } catch (error) {
    console.error('Update vehicle details error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating vehicle details',
      data: {
        details: error.message
      }
    });
  }
};

// Get Driver FAQs API
exports.getDriverFAQs = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    
    // Access the driver_faq collection directly
    const db = mongoose.connection.db;
    const faqCollection = db.collection('driver_faq');
    
    // Fetch the FAQ document (there should be one document with a 'faqs' array)
    const faqDoc = await faqCollection.findOne({});
    
    if (!faqDoc || !faqDoc.faqs || !Array.isArray(faqDoc.faqs)) {
      return res.status(200).json({
        success: true,
        message: 'FAQs retrieved successfully',
        faqs: []
      });
    }
    
    // Extract and format the FAQs array
    const formattedFAQs = faqDoc.faqs.map(faq => ({
      question: faq.question || '',
      answer: faq.answer || '',
      category: faq.category || ''
    }));
    
    res.status(200).json({
      success: true,
      message: 'FAQs retrieved successfully',
      faqs: formattedFAQs
    });
    
  } catch (error) {
    console.error('Get driver FAQs error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while retrieving FAQs',
      error: error.message,
      data: {
        details: error.message
      }
    });
  }
};

// Submit Driver Issue Report API
exports.submitDriverIssue = async (req, res) => {
  try {
    const { driverId, issueText, imageUrls } = req.body;

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

    if (!issueText || issueText.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing or empty required field: issueText',
        data: {
          missingFields: {
            issueText: !issueText || issueText.trim().length === 0
          }
        }
      });
    }

    // Validate driver exists
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

    // Validate imageUrls if provided
    let validImageUrls = [];
    if (imageUrls !== undefined && imageUrls !== null) {
      if (!Array.isArray(imageUrls)) {
        return res.status(400).json({
          success: false,
          message: 'imageUrls must be an array',
          data: {
            field: 'imageUrls'
          }
        });
      }
      
      // Filter out empty or invalid URLs
      validImageUrls = imageUrls.filter(url => 
        typeof url === 'string' && url.trim().length > 0
      );
    }

    // Access the driver_issues_reports collection
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const issuesCollection = db.collection('driver_issues_reports');

    // Create issue report document
    const issueReport = {
      driverId: driverId,
      issueText: issueText.trim(),
      imageUrls: validImageUrls,
      status: 'issue submitted', // Default status
      createdAt: new Date(),
      updatedAt: new Date(),
      // Additional useful fields
      driverName: `${driver.firstName} ${driver.lastName}`,
      driverPhone: driver.phone,
      driverEmail: driver.email
    };

    // Insert the issue report
    const result = await issuesCollection.insertOne(issueReport);

    // Fetch the inserted document
    const insertedIssue = await issuesCollection.findOne({ _id: result.insertedId });

    res.status(201).json({
      success: true,
      message: 'Issue report submitted successfully',
      data: {
        issueId: insertedIssue._id.toString(),
        driverId: insertedIssue.driverId,
        issueText: insertedIssue.issueText,
        imageUrls: insertedIssue.imageUrls,
        status: insertedIssue.status,
        createdAt: insertedIssue.createdAt,
        updatedAt: insertedIssue.updatedAt
      }
    });

  } catch (error) {
    console.error('Submit driver issue error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while submitting issue report',
      error: error.message,
      data: {
        details: error.message
      }
    });
  }
};

// Get Driver Issues API
exports.getDriverIssues = async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: driverId',
        data: {
          missingFields: {
            driverId: !driverId
          }
        }
      });
    }

    // Access the driver_issues_reports collection
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const issuesCollection = db.collection('driver_issues_reports');

    // Fetch all issues for the driver, sorted by most recent first
    const issues = await issuesCollection
      .find({ driverId: driverId })
      .sort({ createdAt: -1 })
      .toArray();

    // Format the response
    const formattedIssues = issues.map(issue => ({
      issueId: issue._id.toString(),
      driverId: issue.driverId,
      issueText: issue.issueText,
      imageUrls: issue.imageUrls || [],
      status: issue.status || 'issue submitted',
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      adminNotes: issue.adminNotes || null,
      resolvedAt: issue.resolvedAt || null
    }));

    res.status(200).json({
      success: true,
      message: 'Driver issues retrieved successfully',
      data: {
        driverId: driverId,
        totalIssues: formattedIssues.length,
        issues: formattedIssues
      }
    });

  } catch (error) {
    console.error('Get driver issues error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while retrieving driver issues',
      error: error.message,
      data: {
        details: error.message
      }
    });
  }
};

// Update Issue Status API (for admin use)
exports.updateIssueStatus = async (req, res) => {
  try {
    const { issueId } = req.params;
    const { status, adminNotes } = req.body;

    if (!issueId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: issueId',
        data: {
          missingFields: {
            issueId: !issueId
          }
        }
      });
    }

    // Validate status
    const validStatuses = ['issue submitted', 'under process', 'complete'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        data: {
          status: status,
          validStatuses: validStatuses
        }
      });
    }

    // Access the driver_issues_reports collection
    const mongoose = require('mongoose');
    const ObjectId = mongoose.Types.ObjectId;
    const db = mongoose.connection.db;
    const issuesCollection = db.collection('driver_issues_reports');

    // Validate ObjectId format
    if (!ObjectId.isValid(issueId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid issueId format',
        data: {
          issueId: issueId
        }
      });
    }

    // Find the issue
    const issue = await issuesCollection.findOne({ _id: new ObjectId(issueId) });
    
    if (!issue) {
      return res.status(404).json({
        success: false,
        message: 'Issue not found',
        data: {
          issueId: issueId
        }
      });
    }

    // Prepare update data
    const updateData = {
      status: status,
      updatedAt: new Date()
    };

    // Add admin notes if provided
    if (adminNotes !== undefined && adminNotes !== null) {
      updateData.adminNotes = adminNotes.trim();
    }

    // Add resolvedAt timestamp if status is 'complete'
    if (status === 'complete') {
      updateData.resolvedAt = new Date();
    } else if (issue.status === 'complete' && status !== 'complete') {
      // If changing from complete to another status, remove resolvedAt
      updateData.resolvedAt = null;
    }

    // Update the issue
    await issuesCollection.updateOne(
      { _id: new ObjectId(issueId) },
      { $set: updateData }
    );

    // Fetch the updated issue
    const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(issueId) });

    res.status(200).json({
      success: true,
      message: 'Issue status updated successfully',
      data: {
        issueId: updatedIssue._id.toString(),
        driverId: updatedIssue.driverId,
        issueText: updatedIssue.issueText,
        imageUrls: updatedIssue.imageUrls || [],
        status: updatedIssue.status,
        adminNotes: updatedIssue.adminNotes || null,
        resolvedAt: updatedIssue.resolvedAt || null,
        createdAt: updatedIssue.createdAt,
        updatedAt: updatedIssue.updatedAt
      }
    });

  } catch (error) {
    console.error('Update issue status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating issue status',
      error: error.message,
      data: {
        details: error.message
      }
    });
  }
};

// Get Driver Notifications API
exports.getDriverNotifications = async (req, res) => {
  try {
    const { driverId } = req.query; // Optional driverId filter from query params

    // Access the driver_notification collection
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const notificationsCollection = db.collection('driver_notification');

    // Build query - filter by driverId if provided
    const query = {};
    if (driverId) {
      query.driverId = driverId;
    }

    // Fetch all notifications, sorted by date (most recent first)
    const notifications = await notificationsCollection
      .find(query)
      .sort({ date: -1 })
      .toArray();

    // Format the response to match the data model
    const formattedNotifications = notifications.map(notification => ({
      id: notification._id.toString(),
      notification_id: notification.notification_id || notification._id.toString(),
      title: notification.title || '',
      description: notification.description || '',
      date: notification.date || '',
      isUnread: notification.isUnread !== undefined ? notification.isUnread : true,
      type: notification.type || 'Informational',
      driverId: notification.driverId || null,
      createdAt: notification.createdAt || null,
      updatedAt: notification.updatedAt || null
    }));

    // Set proper headers for mobile compatibility
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    res.status(200).json({
      success: true,
      message: 'Notifications retrieved successfully',
      data: {
        notifications: formattedNotifications,
        totalCount: formattedNotifications.length,
        unreadCount: formattedNotifications.filter(n => n.isUnread === true).length
      }
    });

  } catch (error) {
    console.error('Get driver notifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while retrieving notifications',
      error: error.message,
      data: {
        details: error.message
      }
    });
  }
};

// Send push notification to a driver (FCM) and optionally save to driver_notification
exports.sendDriverNotification = async (req, res) => {
  try {
    const { driver_id, driverId, title, body, data } = req.body;
    const driverIdValue = (driver_id || driverId || '').toString().trim();
    if (!driverIdValue) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: driverId (or driver_id)',
        data: { missingFields: { driverId: true } }
      });
    }
    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: title',
        data: { missingFields: { title: true } }
      });
    }
    const DriverModel = createModel('drivers');
    const driver = await DriverModel.findOne({ driverId: driverIdValue }).lean();
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found',
        data: { driverId: driverIdValue }
      });
    }
    const fcmToken = driver.fcmToken;
    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Driver has no FCM token. Ask the driver app to register the device token.',
        data: { driverId: driverIdValue }
      });
    }
    const payload = {
      title: title.trim(),
      body: (body && typeof body === 'string') ? body.trim() : '',
      channelId: (req.body.channelId && typeof req.body.channelId === 'string') ? req.body.channelId.trim() : 'driver_notifications'
    };
    if (data && typeof data === 'object') payload.data = data;
    const result = await sendFCMNotification(fcmToken, payload);
    if (!result.success) {
      return res.status(502).json({
        success: false,
        message: 'Failed to send push notification',
        data: { error: result.error }
      });
    }
    const mongoose = require('mongoose');
    const notificationsCollection = mongoose.connection.db.collection('driver_notification');
    const now = new Date();
    const doc = {
      driverId: driverIdValue,
      title: payload.title,
      description: payload.body || '',
      date: now.toISOString(),
      isUnread: true,
      type: (data && data.type) || 'Informational',
      createdAt: now,
      updatedAt: now
    };
    try {
      await notificationsCollection.insertOne(doc);
    } catch (insertErr) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[sendDriverNotification] Could not save to driver_notification:', insertErr.message);
      }
    }
    res.status(200).json({
      success: true,
      message: 'Push notification sent successfully',
      data: {
        messageId: result.messageId,
        driverId: driverIdValue,
        title: payload.title
      }
    });
  } catch (error) {
    console.error('Send driver notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while sending notification',
      data: { details: error.message }
    });
  }
};

// Update Notification Read Status API
exports.updateNotificationReadStatus = async (req, res) => {
  try {
    const { driver_id, driverId, notificationIds } = req.body; // driver_id and array of notification IDs
    const driverIdValue = driver_id || driverId; // Support both driver_id and driverId

    // Validate required fields
    if (!driverIdValue) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: driver_id',
        data: {
          missingFields: {
            driver_id: !driverIdValue
          }
        }
      });
    }

    if (!notificationIds) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: notificationIds',
        data: {
          missingFields: {
            notificationIds: !notificationIds
          }
        }
      });
    }

    // Validate that notificationIds is an array
    if (!Array.isArray(notificationIds)) {
      return res.status(400).json({
        success: false,
        message: 'notificationIds must be an array',
        data: {
          receivedType: typeof notificationIds,
          expectedType: 'array'
        }
      });
    }

    // Validate that array is not empty
    if (notificationIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'notificationIds array cannot be empty',
        data: {
          notificationIds: notificationIds
        }
      });
    }

    // Access the driver_notification collection
    const mongoose = require('mongoose');
    const ObjectId = mongoose.Types.ObjectId;
    const db = mongoose.connection.db;
    const notificationsCollection = db.collection('driver_notification');

    // Convert notification IDs to ObjectId format and validate
    const validObjectIds = [];
    const invalidIds = [];

    for (const id of notificationIds) {
      if (ObjectId.isValid(id)) {
        validObjectIds.push(new ObjectId(id));
      } else {
        invalidIds.push(id);
      }
    }

    // If there are invalid IDs, return error
    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification ID format(s)',
        data: {
          invalidIds: invalidIds,
          validIds: validObjectIds.map(id => id.toString())
        }
      });
    }

    // Update notifications to mark as read - filter by both driver_id and notification IDs
    const updateQuery = {
      _id: { $in: validObjectIds },
      driverId: driverIdValue // Ensure driver can only update their own notifications
    };

    const updateResult = await notificationsCollection.updateMany(
      updateQuery,
      {
        $set: {
          isUnread: false,
          updatedAt: new Date()
        }
      }
    );

    // Fetch the updated notifications
    const updatedNotifications = await notificationsCollection
      .find({
        _id: { $in: validObjectIds },
        driverId: driverIdValue
      })
      .toArray();

    // Format the response
    const formattedNotifications = updatedNotifications.map(notification => ({
      id: notification._id.toString(),
      notification_id: notification.notification_id || notification._id.toString(),
      title: notification.title || '',
      description: notification.description || '',
      date: notification.date || '',
      isUnread: notification.isUnread !== undefined ? notification.isUnread : false,
      type: notification.type || 'Informational',
      driverId: notification.driverId || null,
      createdAt: notification.createdAt || null,
      updatedAt: notification.updatedAt || null
    }));

    // Set proper headers for mobile compatibility
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    res.status(200).json({
      success: true,
      message: 'Notification read status updated successfully',
      data: {
        updatedCount: updateResult.modifiedCount,
        matchedCount: updateResult.matchedCount,
        notifications: formattedNotifications,
        summary: {
          totalRequested: notificationIds.length,
          successfullyUpdated: updateResult.modifiedCount,
          alreadyRead: updateResult.matchedCount - updateResult.modifiedCount
        }
      }
    });

  } catch (error) {
    console.error('Update notification read status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating notification read status',
      error: error.message,
      data: {
        details: error.message
      }
    });
  }
};

// Mark All Driver Notifications as Read
exports.markAllDriverNotificationsRead = async (req, res) => {
  try {
    const { driverId, driver_id } = req.query;
    const driverIdValue = driverId || driver_id;

    if (!driverIdValue) {
      return res.status(400).json({
        success: false,
        message: 'Missing required query parameter: driverId',
        data: { missingFields: { driverId: true } }
      });
    }

    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const notificationsCollection = db.collection('driver_notification');

    const updateResult = await notificationsCollection.updateMany(
      { driverId: driverIdValue, isUnread: true },
      { $set: { isUnread: false, updatedAt: new Date() } }
    );

    const notifications = await notificationsCollection
      .find({ driverId: driverIdValue })
      .sort({ date: -1 })
      .toArray();

    const formatted = notifications.map(n => ({
      id: n._id.toString(),
      notification_id: n.notification_id || n._id.toString(),
      title: n.title || '',
      description: n.description || '',
      date: n.date || '',
      isUnread: n.isUnread !== undefined ? n.isUnread : false,
      type: n.type || 'Informational',
      driverId: n.driverId || null,
      createdAt: n.createdAt || null,
      updatedAt: n.updatedAt || null
    }));

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json({
      success: true,
      message: 'All notifications marked as read',
      data: {
        notifications: formatted,
        totalCount: formatted.length,
        unreadCount: 0,
        markedCount: updateResult.modifiedCount
      }
    });
  } catch (error) {
    console.error('markAllDriverNotificationsRead error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while marking all notifications as read',
      data: { details: error.message }
    });
  }
};

// Delete a Driver Notification
exports.deleteDriverNotification = async (req, res) => {
  try {
    const { driverId, driver_id, notificationId, notification_id } = req.query;
    const driverIdValue = driverId || driver_id;
    const notificationIdValue = notificationId || notification_id;

    if (!driverIdValue || !notificationIdValue) {
      return res.status(400).json({
        success: false,
        message: 'Missing required query parameters: driverId, notificationId',
        data: { missingFields: { driverId: !driverIdValue, notificationId: !notificationIdValue } }
      });
    }

    const mongoose = require('mongoose');
    const ObjectId = mongoose.Types.ObjectId;
    const db = mongoose.connection.db;
    const notificationsCollection = db.collection('driver_notification');

    if (!ObjectId.isValid(notificationIdValue)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification ID format',
        data: { notificationId: notificationIdValue }
      });
    }

    const deleteResult = await notificationsCollection.deleteOne({
      _id: new ObjectId(notificationIdValue),
      driverId: driverIdValue
    });

    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found or does not belong to this driver',
        data: { driverId: driverIdValue, notificationId: notificationIdValue }
      });
    }

    // Return remaining notifications
    const notifications = await notificationsCollection
      .find({ driverId: driverIdValue })
      .sort({ date: -1 })
      .toArray();

    const formatted = notifications.map(n => ({
      id: n._id.toString(),
      notification_id: n.notification_id || n._id.toString(),
      title: n.title || '',
      description: n.description || '',
      date: n.date || '',
      isUnread: n.isUnread !== undefined ? n.isUnread : true,
      type: n.type || 'Informational',
      driverId: n.driverId || null,
      createdAt: n.createdAt || null,
      updatedAt: n.updatedAt || null
    }));

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json({
      success: true,
      message: 'Notification deleted successfully',
      data: {
        notifications: formatted,
        totalCount: formatted.length,
        unreadCount: formatted.filter(n => n.isUnread === true).length
      }
    });
  } catch (error) {
    console.error('deleteDriverNotification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting notification',
      data: { details: error.message }
    });
  }
};