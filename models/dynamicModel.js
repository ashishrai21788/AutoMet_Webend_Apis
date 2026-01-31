const mongoose = require('mongoose');

// Driver-specific schema with all required fields and defaults
const driverSchema = new mongoose.Schema({
  // Basic Information (Mandatory for signup)
  driverId: {
    type: String,
    unique: true,
    required: true
  },
  firstName: {
    type: String,
    required: true,
    trim: true,
  },
  lastName: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  phone: {
    type: String,
    required: true,
    trim: true,
  },
  passwordHash: {
    type: String,
    required: true,
  },
  profilePhoto: {
    type: String,
    required: true,
    default: 'https://cdn.example.com/drivers/default.jpg'
  },

  // Vehicle Information (Optional - can be updated later)
  vehicleType: {
    type: String,
    default: null,
    trim: true
  },
  vehicleNumber: {
    type: String,
    default: null,
    trim: true,
    unique: false, // Explicitly set to false to override any existing unique index
  },
  vehicleModel: {
    type: String,
    default: null,
    trim: true,
  },
  vehicleColor: {
    type: String,
    default: null,
    trim: true,
  },
  // Vehicle Manufacturing Year (Mandatory field)
  vehicleManufacturingYear: {
    type: Number,
    default: null,
    min: 1900,
    max: new Date().getFullYear() + 1, // Current year + 1 for new vehicles
    validate: {
      validator: function(v) {
        return v === null || (v >= 1900 && v <= new Date().getFullYear() + 1);
      },
      message: 'Vehicle manufacturing year must be between 1900 and current year + 1'
    }
  },
  // Engine Number (Optional)
  engineNumber: {
    type: String,
    default: null,
    trim: true,
  },
  // Chassis Number (Optional)
  chassisNumber: {
    type: String,
    default: null,
    trim: true,
  },
  // Fuel Type (Optional)
  fuleType: {
    type: String,
    default: "",
    trim: true,
  },
  // Seating Capacity (Optional)
  seatingCapacity: {
    type: String,
    default: "",
    trim: true,
  },
  // Vehicle Insurance Details (Optional)
  vehicleInsurance: {
    policyNumber: {
      type: String,
      default: null,
      trim: true,
    },
    insuranceCompany: {
      type: String,
      default: null,
      trim: true,
    },
    insuranceExpiryDate: {
      type: Date,
      default: null,
    },
    insuranceAmount: {
      type: Number,
      default: null,
      min: 0
    },
    isInsuranceValid: {
      type: Boolean,
      default: false
    }
  },

  // License and Verification (Optional - can be updated later)
  licenseNumber: {
    type: String,
    default: null,
    trim: true,
    unique: false, // Explicitly set to false to override any existing unique index
  },
  licenseExpiry: {
    type: Date,
    default: null,
  },
  license_type: {
    type: String,
    default: null,
    trim: true,
  },
  expiry_date: {
    type: Date,
    default: null,
  },
  drivingLicenseIssueDate: {
    type: Date,
    default: null,
  },
  drivingLicenseIssuingAuthority: {
    type: String,
    default: null,
    trim: true,
  },
  aadhaarNumber: {
    type: String,
    default: null,
    trim: true,
    unique: false, // Explicitly set to false to override any existing unique index
  },
  id_proof_type: {
    type: String,
    default: null,
    trim: true,
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  isProfileComplete: {
    type: Boolean,
    default: false,
  },
  isPhoneVerified: {
    type: Boolean,
    default: false,
  },
  isVehicleAdded: {
    type: Boolean,
    default: false,
  },
  isDocumentsUploaded: {
    type: Boolean,
    default: false,
  },
  verification_status: {
    type: String,
    enum: ['INCOMPLETE', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'],
    default: 'INCOMPLETE',
    trim: true
  },

  // Document Images (Optional - can be updated later)
  // Images stored as objects with {url, publicId}
  vehicleRegistrationImages: {
    type: [{
      url: {
        type: String,
        required: true,
        trim: true
      },
      publicId: {
        type: String,
        required: true,
        trim: true
      }
    }],
    default: [],
    validate: {
      validator: function(v) {
        return Array.isArray(v) && v.every(img => 
          img && typeof img === 'object' && 
          typeof img.url === 'string' && img.url.trim().length > 0 &&
          typeof img.publicId === 'string' && img.publicId.trim().length > 0
        );
      },
      message: 'Vehicle registration images must be an array of objects with url and publicId'
    }
  },
  vehicleInsuranceImages: {
    type: [{
      url: {
        type: String,
        required: true,
        trim: true
      },
      publicId: {
        type: String,
        required: true,
        trim: true
      }
    }],
    default: [],
    validate: {
      validator: function(v) {
        return Array.isArray(v) && v.every(img => 
          img && typeof img === 'object' && 
          typeof img.url === 'string' && img.url.trim().length > 0 &&
          typeof img.publicId === 'string' && img.publicId.trim().length > 0
        );
      },
      message: 'Vehicle insurance images must be an array of objects with url and publicId'
    }
  },
  drivingLicenseImages: {
    type: [{
      url: {
        type: String,
        required: true,
        trim: true
      },
      publicId: {
        type: String,
        required: true,
        trim: true
      }
    }],
    default: [],
    validate: {
      validator: function(v) {
        return Array.isArray(v) && v.every(img => 
          img && typeof img === 'object' && 
          typeof img.url === 'string' && img.url.trim().length > 0 &&
          typeof img.publicId === 'string' && img.publicId.trim().length > 0
        );
      },
      message: 'Driving license images must be an array of objects with url and publicId'
    }
  },
  idProofImages: {
    type: [{
      url: {
        type: String,
        required: true,
        trim: true
      },
      publicId: {
        type: String,
        required: true,
        trim: true
      }
    }],
    default: [],
    validate: {
      validator: function(v) {
        return Array.isArray(v) && v.every(img => 
          img && typeof img === 'object' && 
          typeof img.url === 'string' && img.url.trim().length > 0 &&
          typeof img.publicId === 'string' && img.publicId.trim().length > 0
        );
      },
      message: 'ID proof images must be an array of objects with url and publicId'
    }
  },

  // Location and Status (Optional - can be updated later)
  currentLocation: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: [0, 0]
    }
  },
  isOnline: {
    type: Boolean,
    default: false,
  },
  isLoggedin: {
    type: Boolean,
    default: false,
  },
  onlineAs: {
    type: Number,
    default: 0,
    enum: [0, 1], // 0 = public, 1 = private booking
  },
  lastActive: {
    type: Date,
    default: Date.now,
  },

  // Mobile App Integration (Optional - updated during login)
  fcmToken: {
    type: String,
    default: null,
    trim: true,
  },
  deviceId: {
    type: String,
    default: null,
    trim: true,
  },
  accessToken: {
    type: String,
    default: null,
    trim: true,
  },

  // Financial Information (Optional - can be updated later)
  walletBalance: {
    type: Number,
    default: 0.0,
    min: 0
  },
  // Membership (App-based monthly renewal)
  membership: {
    plan: {
      type: String,
      enum: ['Free', 'Silver', 'Gold', 'Platinum'],
      default: 'Free'
    },
    startDate: {
      type: Date,
      default: function() { return new Date(); }
    },
    endDate: {
      type: Date,
      default: function() {
        const start = new Date();
        // add 1 month (handles month-end by letting Date overflow adjust)
        const end = new Date(start);
        end.setMonth(end.getMonth() + 1);
        return end;
      }
    },
    paymentStatus: {
      type: String,
      enum: ['Pending', 'Paid', 'Failed'],
      default: 'Pending'
    },
    transactionId: {
      type: String,
      default: null,
      trim: true
    },
    // Cancellation tracking
    isCancelled: {
      type: Boolean,
      default: false
    },
    cancelledAt: {
      type: Date,
      default: null
    },
    cancelReason: {
      type: String,
      default: null,
      trim: true
    }
  },
  bankAccount: {
    accountHolderName: {
      type: String,
      default: null,
      trim: true,
    },
    accountNumber: {
      type: String,
      default: null,
      trim: true,
    },
    ifscCode: {
      type: String,
      default: null,
      trim: true,
    }
  },

  // Performance Metrics (Optional - can be updated later)
  rating: {
    type: Number,
    default: 0.0,
    min: 0,
    max: 5
  },
  totalRides: {
    type: Number,
    default: 0,
    min: 0
  },
  cancelledRides: {
    type: Number,
    default: 0,
    min: 0
  },

  // Role for identification
  role: {
    type: String,
    default: 'driver',
    enum: ['driver', 'user', 'admin']
  }
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for full name
driverSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`;
});

// User-specific schema for "users" collection (login, signup, profile)
const userSchema = new mongoose.Schema({
  userId: {
    type: String,
    unique: true,
    required: true
  },
  firstName: {
    type: String,
    required: true,
    trim: true,
    default: ''
  },
  lastName: {
    type: String,
    required: true,
    trim: true,
    default: ''
  },
  phone: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  email: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
    default: null
  },
  passwordHash: {
    type: String,
    required: false,
    default: null
  },
  profilePhoto: {
    type: String,
    default: null,
    trim: true
  },
  isPhoneVerified: {
    type: Boolean,
    default: false
  },
  isLoggedin: {
    type: Boolean,
    default: false
  },
  accessToken: {
    type: String,
    default: null
  },
  fcmToken: {
    type: String,
    default: null
  },
  deviceId: {
    type: String,
    default: null
  },
  lastActive: {
    type: Date,
    default: null
  },
  role: {
    type: String,
    default: 'user',
    enum: ['user', 'driver', 'admin']
  }
}, {
  timestamps: true,
  collection: 'users'
});

userSchema.virtual('fullName').get(function() {
  return `${this.firstName || ''} ${this.lastName || ''}`.trim();
});

// Generic schema for other collections (users, admins, etc.)
const genericSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  phone: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  email: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
  },
  role: {
    type: String,
    enum: ['driver', 'user', 'admin'],
    default: 'user',
  }
}, { timestamps: true });

// Factory function to create models for different collections
const createModel = (collectionName) => {
  const modelName = collectionName.charAt(0).toUpperCase() + collectionName.slice(1);
  
  // Use driver schema for drivers collection
  if (collectionName.toLowerCase() === 'drivers') {
    return mongoose.model(modelName, driverSchema, collectionName);
  }

  // Use user schema for users collection
  if (collectionName.toLowerCase() === 'users') {
    return mongoose.model(modelName, userSchema, 'users');
  }
  
  // Use generic schema for other collections
  return mongoose.model(modelName, genericSchema, collectionName);
};

module.exports = { createModel, driverSchema, userSchema, genericSchema }; 