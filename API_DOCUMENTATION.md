# Complete API Documentation

## Base URL
```
http://localhost:3000/api
```
or
```
http://YOUR_IP:3000/api
```

---

## Table of Contents
1. [Server Health & Test Endpoints](#server-health--test-endpoints)
2. [Driver APIs](#driver-apis)
3. [OTP APIs](#otp-apis)
4. [Dynamic Collection APIs](#dynamic-collection-apis)

---

## Server Health & Test Endpoints

### 1. Health Check
**GET** `/health`

**Response:**
```json
{
  "success": true,
  "message": "Server is healthy",
  "timestamp": "2024-12-24T10:30:00.000Z",
  "health": {
    "isHealthy": true,
    "uptime": 3600,
    "memoryUsage": "150MB",
    "dbConnected": true,
    "totalRequests": 100,
    "errorCount": 0,
    "startTime": "2024-12-24T09:30:00.000Z",
    "lastHealthCheck": "2024-12-24T10:30:00.000Z"
  }
}
```

### 2. Test Endpoint
**GET** `/test`

**Response:**
```json
{
  "success": true,
  "message": "Server is working",
  "timestamp": "2024-12-24T10:30:00.000Z",
  "headers": { ... }
}
```

---

## Driver APIs

### 1. Create Driver (Signup)
**POST** `/api/drivers`

**Request Body:**
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john.doe@example.com",
  "phone": "1234567890",
  "password": "password123",
  "profilePhoto": "https://example.com/photo.jpg",
  "vehicleNumber": "AB123CD",
  "licenseNumber": "DL1234567890",
  "vehicleType": "Car",
  "vehicleModel": "Honda City",
  "vehicleColor": "White",
  "vehicleManufacturingYear": 2020,
  "engineNumber": "ENG123456",
  "chassisNumber": "CHS123456",
  "vehicleInsurance": {
    "policyNumber": "POL123456",
    "insuranceCompany": "ABC Insurance",
    "insuranceExpiryDate": "2025-12-31",
    "insuranceAmount": 50000,
    "isInsuranceValid": true
  },
  "vehicleRegistrationImages": [],
  "vehicleInsuranceImages": [],
  "drivingLicenseImages": [],
  "idProofImages": []
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "message": "Driver created successfully. OTP sent for verification.",
  "data": {
    "driver": {
      "driverId": "1234567890",
      "firstName": "John",
      "lastName": "Doe",
      "email": "john.doe@example.com",
      "phone": "1234567890",
      "profilePhoto": "https://cdn.example.com/drivers/default.jpg",
      "vehicleType": "Car",
      "vehicleNumber": "AB123CD",
      "vehicleModel": "Honda City",
      "vehicleColor": "White",
      "vehicleManufacturingYear": 2020,
      "engineNumber": "ENG123456",
      "chassisNumber": "CHS123456",
      "vehicleInsurance": {
        "policyNumber": "POL123456",
        "insuranceCompany": "ABC Insurance",
        "insuranceExpiryDate": "2025-12-31",
        "insuranceAmount": 50000,
        "isInsuranceValid": true
      },
      "vehicleRegistrationImages": [],
      "vehicleInsuranceImages": [],
      "drivingLicenseImages": [],
      "idProofImages": [],
      "licenseNumber": "DL1234567890",
      "licenseExpiry": null,
      "aadhaarNumber": null,
      "isVerified": false,
      "isProfileComplete": false,
      "currentLocation": {
        "type": "Point",
        "coordinates": [0, 0]
      },
      "isOnline": false,
      "isLoggedin": false,
      "onlineAs": 0,
      "lastActive": "2024-12-24T10:30:00.000Z",
      "fcmToken": null,
      "deviceId": null,
      "accessToken": null,
      "walletBalance": 0,
      "bankAccount": {
        "accountHolderName": null,
        "accountNumber": null,
        "ifscCode": null
      },
      "membership": {
        "plan": "Free",
        "startDate": "2024-12-24T10:30:00.000Z",
        "endDate": "2025-01-24T10:30:00.000Z",
        "paymentStatus": "Pending",
        "transactionId": null,
        "isCancelled": false,
        "cancelledAt": null,
        "cancelReason": null
      },
      "rating": 0,
      "totalRides": 0,
      "cancelledRides": 0,
      "role": "driver",
      "createdAt": "2024-12-24T10:30:00.000Z",
      "updatedAt": "2024-12-24T10:30:00.000Z",
      "fullName": "John Doe",
      "id": "507f1f77bcf86cd799439011"
    },
    "otp": {
      "otp": "123456",
      "expiresAt": "2024-12-24T10:35:00.000Z",
      "message": "Please verify your account using the OTP sent to your email and phone"
    }
  }
}
```

**Error Responses:**
- `400` - Missing required fields or validation error
- `400` - Email/Phone/Vehicle number already exists
- `500` - Server error

---

### 2. Driver Login
**POST** `/api/drivers/login`

**Request Body:**
```json
{
  "emailOrPhone": "john.doe@example.com",
  "password": "password123",
  "fcmToken": "fcm_token_here",
  "deviceId": "device_id_here",
  "currentLocation": {
    "coordinates": [77.2090, 28.6139]
  }
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Driver logged in successfully",
  "data": {
    "driver": {
      "driverId": "1234567890",
      "firstName": "John",
      "lastName": "Doe",
      "email": "john.doe@example.com",
      "phone": "1234567890",
      "isVerified": true,
      "isLoggedin": true,
      "isOnline": false,
      "currentLocation": {
        "type": "Point",
        "coordinates": [77.2090, 28.6139]
      },
      "fcmToken": "fcm_token_here",
      "deviceId": "device_id_here",
      "accessToken": "jwt_token_here",
      "lastActive": "2024-12-24T10:30:00.000Z",
      "...": "all other driver fields"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "loginTime": "2024-12-24T10:30:00.000Z",
    "sessionInfo": {
      "isLoggedin": true,
      "lastActive": "2024-12-24T10:30:00.000Z",
      "fcmToken": "fcm_token_here",
      "deviceId": "device_id_here",
      "currentLocation": {
        "coordinates": [77.2090, 28.6139]
      },
      "tokenExpiresIn": "7d"
    }
  }
}
```

**Error Responses:**
- `400` - Missing required fields
- `401` - Invalid credentials
- `403` - Driver account not verified
- `500` - Server error

---

### 3. Driver Logout
**POST** `/api/drivers/logout`

**Request Body:**
```json
{
  "driverId": "1234567890"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Driver logged out successfully",
  "data": {
    "driver": {
      "driverId": "1234567890",
      "isLoggedin": false,
      "fcmToken": null,
      "deviceId": null,
      "accessToken": null,
      "lastActive": "2024-12-24T10:30:00.000Z",
      "...": "all other driver fields"
    },
    "logoutTime": "2024-12-24T10:30:00.000Z",
    "sessionInfo": {
      "isLoggedin": false,
      "lastActive": "2024-12-24T10:30:00.000Z",
      "fcmToken": null,
      "deviceId": null
    }
  }
}
```

**Error Responses:**
- `400` - Missing driverId
- `404` - Driver not found
- `500` - Server error

---

### 4. Update Online Status
**PUT** `/api/drivers/online-status`

**Request Body:**
```json
{
  "driverId": "1234567890",
  "isOnline": true,
  "onlineAs": 0
}
```

**Note:** `onlineAs` values: `0` = Public, `1` = Private Booking

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Driver online status updated successfully",
  "data": {
    "driver": {
      "driverId": "1234567890",
      "isOnline": true,
      "onlineAs": 0,
      "lastActive": "2024-12-24T10:30:00.000Z",
      "...": "all other driver fields"
    },
    "updateTime": "2024-12-24T10:30:00.000Z",
    "statusInfo": {
      "isOnline": true,
      "onlineAs": 0,
      "onlineAsText": "Public",
      "lastActive": "2024-12-24T10:30:00.000Z"
    }
  }
}
```

**Error Responses:**
- `400` - Missing driverId or invalid onlineAs value
- `404` - Driver not found
- `500` - Server error

---

### 5. Get Driver Status
**GET** `/api/drivers/status/:driverId`

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Driver status retrieved successfully",
  "data": {
    "driver": {
      "driverId": "1234567890",
      "firstName": "John",
      "lastName": "Doe",
      "isLoggedin": true,
      "isOnline": true,
      "onlineAs": 0,
      "currentLocation": {
        "type": "Point",
        "coordinates": [77.2090, 28.6139]
      },
      "lastActive": "2024-12-24T10:30:00.000Z",
      "...": "all other driver fields"
    },
    "driverId": "1234567890",
    "driverName": "John Doe",
    "status": {
      "isLoggedin": true,
      "isOnline": true,
      "onlineAs": 0,
      "statusText": "Online",
      "onlineAsText": "Public"
    },
    "location": {
      "type": "Point",
      "coordinates": [77.2090, 28.6139]
    },
    "lastActive": "2024-12-24T10:30:00.000Z",
    "retrievedAt": "2024-12-24T10:30:00.000Z"
  }
}
```

**Error Responses:**
- `404` - Driver not found
- `500` - Server error

---

### 6. Get Driver Profile (Protected)
**GET** `/api/drivers/profile`

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Driver profile retrieved successfully",
  "data": {
    "driver": {
      "driverId": "1234567890",
      "firstName": "John",
      "lastName": "Doe",
      "email": "john.doe@example.com",
      "phone": "1234567890",
      "...": "all driver fields"
    }
  }
}
```

**Error Responses:**
- `401` - Access token required or invalid/expired token
- `500` - Server error

---

### 7. Update Vehicle Details
**PUT** `/api/drivers/vehicle-details`

**Description:** This API accepts pre-uploaded image URLs and publicIds. Images should be uploaded separately using the `/api/images/upload` endpoint before calling this API.

**Request Body (application/json):**
```json
{
  "driverId": "0656798311",
  "vehicleData": {
    "vehicleType": "Car",
    "vehicleNumber": "DL01AB1234",
    "vehicleModel": "Bajaj RE",
    "vehicleManufacturingYear": "2025",
    "vehicleColor": "White",
    "engineNumber": "weerwer234234234",
    "chassisNumber": "erwerr23423424",
    "vehicleInsurance": {
      "policyNumber": "werewr",
      "insuranceExpiryDate": "2025-09-17"
    }
  },
  "licenseData": {
    "license_number": "NEW123456789",
    "license_type": "LMV",
    "drivingLicenseIssueDate": "2020-01-15",
    "expiry_date": "2027-12-31",
    "drivingLicenseIssuingAuthority": "RTO Delhi"
  },
  "vehicleRegistrationImages": [
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/vehicle-registration/abc123"},
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/vehicle-registration/xyz789"}
  ],
  "drivingLicenseImages": [
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/driving-license/abc123"},
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/driving-license/xyz789"}
  ],
  "insurance": [
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/insurance/abc123"},
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/insurance/xyz789"}
  ],
  "idProofImages": [
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/id-proof/abc123"},
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/id-proof/xyz789"}
  ]
}
```

**Note:** 
- All fields are optional except `driverId`
- `vehicleInsuranceImages` can also be provided as `insurance` (alias)
- Image arrays are additive - new images are added to existing ones
- Images must be uploaded to Cloudinary first using `/api/images/upload`

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Vehicle details updated successfully",
  "data": {
    "driver": {
      "...": "complete driver object with all fields"
    },
    "updatedFields": ["vehicleType", "vehicleNumber", "vehicleRegistrationImages"]
  }
}
```

**Error Responses:**
- `400` - Missing driverId or validation error
- `404` - Driver not found
- `500` - Server error

---

### 8. Get Vehicle Details by DriverId
**GET** `/api/drivers/:driverId/vehicle-details`

**URL Parameters:**
- `driverId` - The driver ID (e.g., `0656798311`)

**Example:** `GET /api/drivers/0656798311/vehicle-details`

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Vehicle details retrieved successfully",
  "data": {
    "vehicleDetails": {
      "driverId": "0656798311",
      "driverName": "Ashish Rai",
      "firstName": "Ashish",
      "lastName": "Rai",
      "email": "rai@yopmail.com",
      "phone": "98765432111",
      "profilePhoto": "https://cdn.example.com/drivers/default.jpg",
      "vehicleType": "Car",
      "vehicleNumber": "DL01AB1234",
      "vehicleModel": "Bajaj RE",
      "vehicleColor": "White",
      "vehicleManufacturingYear": 2025,
      "engineNumber": "weerwer234234234",
      "chassisNumber": "erwerr23423424",
      "vehicleInsurance": {
        "policyNumber": "werewr",
        "insuranceCompany": "ICICI Lombard",
        "insuranceExpiryDate": "2025-09-17T00:00:00.000Z",
        "insuranceAmount": 20000,
        "isInsuranceValid": true
      },
      "vehicleRegistrationImages": [
        {"url": "https://res.cloudinary.com/drjv1dcre/image/upload/v1761289512/driver-documents/vehicle-registration/e0ucacfkczwvfflyk7fh.jpg", "publicId": "driver-documents/vehicle-registration/e0ucacfkczwvfflyk7fh"}
      ],
      "vehicleInsuranceImages": [],
      "drivingLicenseImages": [],
      "idProofImages": [],
      "licenseNumber": "NEW123456789",
      "licenseExpiry": "2027-12-31T00:00:00.000Z",
      "license_type": "LMV",
      "expiry_date": "2027-12-31T00:00:00.000Z",
      "drivingLicenseIssueDate": "2020-01-15T00:00:00.000Z",
      "drivingLicenseIssuingAuthority": "RTO Delhi",
      "aadhaarNumber": "987654321098",
      "isVerified": true,
      "isProfileComplete": false,
      "currentLocation": {
        "type": "Point",
        "coordinates": [0, 0]
      },
      "isOnline": true,
      "isLoggedin": true,
      "onlineAs": 0,
      "lastActive": "2025-12-26T09:42:15.973Z",
      "role": "driver",
      "createdAt": "2025-08-08T12:27:45.807Z",
      "updatedAt": "2025-12-26T09:44:16.425Z",
      "_id": "6895ed4143acb3decdb8f2ed",
      "id": "6895ed4143acb3decdb8f2ed"
    },
    "retrievedAt": "2025-12-26T09:50:00.000Z"
  }
}
```

**Response includes ALL fields:**
- Driver basic information (driverId, firstName, lastName, email, phone, profilePhoto)
- Vehicle information (vehicleType, vehicleNumber, vehicleModel, vehicleColor, vehicleManufacturingYear, engineNumber, chassisNumber)
- Vehicle insurance details (complete object with all fields)
- Document images (all 4 image arrays: vehicleRegistrationImages, vehicleInsuranceImages, drivingLicenseImages, idProofImages) - each image is an object with `{url, publicId}`
- License information (licenseNumber, licenseExpiry, license_type, expiry_date, drivingLicenseIssueDate, drivingLicenseIssuingAuthority, aadhaarNumber)
- Verification status (isVerified, isProfileComplete)
- Location and status (currentLocation, isOnline, isLoggedin, onlineAs, lastActive)
- System fields (role, createdAt, updatedAt, _id, id)

**Error Responses:**
- `400` - Missing driverId parameter
- `404` - Driver not found
- `500` - Server error

---

## OTP APIs

### 1. Send OTP
**POST** `/api/otp/send`

**Request Body:**
```json
{
  "driverId": "1234567890"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "data": {
    "driverId": "1234567890",
    "email": "john.doe@example.com",
    "phone": "1234567890",
    "otp": "123456",
    "expiresAt": "2024-12-24T10:35:00.000Z",
    "message": "OTP sent to your registered email and phone number",
    "action": "created"
  }
}
```

**Error Responses:**
- `400` - Missing driverId or driver already verified
- `404` - Driver not found
- `500` - Server error

---

### 2. Verify OTP
**POST** `/api/otp/verify`

**Request Body:**
```json
{
  "driverId": "1234567890",
  "otp": "123456"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "OTP verified successfully. Driver is now verified.",
  "data": {
    "driverId": "1234567890",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john.doe@example.com",
    "phone": "1234567890",
    "isVerified": true,
    "...": "all other driver fields"
  }
}
```

**Error Responses:**
- `400` - Missing driverId/otp or invalid/expired OTP
- `404` - Driver not found
- `500` - Server error

---

### 3. Resend OTP
**POST** `/api/otp/resend`

**Request Body:**
```json
{
  "driverId": "1234567890"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "OTP resent successfully",
  "data": {
    "driverId": "1234567890",
    "email": "john.doe@example.com",
    "phone": "1234567890",
    "otp": "654321",
    "expiresAt": "2024-12-24T10:35:00.000Z",
    "message": "New OTP sent to your registered email and phone number"
  }
}
```

**Error Responses:**
- `400` - Missing driverId or driver already verified
- `404` - Driver not found
- `500` - Server error

---

### 4. Generate OTP (Legacy)
**POST** `/api/otp/generate`

**Request Body:**
```json
{
  "driverId": "1234567890",
  "email": "john.doe@example.com",
  "phone": "1234567890"
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "message": "OTP generated successfully",
  "data": {
    "driverId": "1234567890",
    "email": "john.doe@example.com",
    "phone": "1234567890",
    "otp": "123456",
    "expiresAt": "2024-12-24T10:35:00.000Z",
    "message": "OTP sent to your registered email and phone number"
  }
}
```

---

### 5. Update Profile Complete
**POST** `/api/otp/profile-complete`

**Request Body:**
```json
{
  "driverId": "1234567890",
  "isProfileComplete": true
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Profile completion status updated to true",
  "data": {
    "driverId": "1234567890",
    "firstName": "John",
    "lastName": "Doe",
    "isProfileComplete": true,
    "...": "all other driver fields"
  }
}
```

**Error Responses:**
- `400` - Missing driverId or invalid isProfileComplete value
- `404` - Driver not found
- `500` - Server error

---

## Dynamic Collection APIs

These APIs work with any collection name. Replace `:collectionName` with your collection name (e.g., `drivers`, `users`, `vehicles`, etc.).

### 1. Create Record
**POST** `/api/:collectionName`

**Example:** `POST /api/drivers`

**Request Body:**
```json
{
  "field1": "value1",
  "field2": "value2",
  "...": "..."
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "message": "drivers created successfully",
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "field1": "value1",
    "field2": "value2",
    "createdAt": "2024-12-24T10:30:00.000Z",
    "updatedAt": "2024-12-24T10:30:00.000Z"
  }
}
```

**Error Responses:**
- `400` - Duplicate field value (email/phone/vehicleNumber/licenseNumber already exists)
- `500` - Server error

---

### 2. Get All Records
**GET** `/api/:collectionName`

**Example:** `GET /api/drivers` or `GET /api/drivers?driverId=0656798311`

**Query Parameters (optional):**
- `driverId` - Filter by driverId (for drivers collection)

**Response (200 OK):**
```json
{
  "success": true,
  "message": "1 driver(s) found",
  "count": "1",
  "data": [
    {
      "_id": "6895ed4143acb3decdb8f2ed",
      "id": "6895ed4143acb3decdb8f2ed",
      "driverId": "0656798311",
      "firstName": "Ashish",
      "lastName": "Rai",
      "email": "rai@yopmail.com",
      "phone": "98765432111",
      "profilePhoto": "https://cdn.example.com/drivers/default.jpg",
      "vehicleType": "Car",
      "vehicleNumber": "DL01AB1234",
      "vehicleModel": "Bajaj RE",
      "vehicleColor": "White",
      "vehicleManufacturingYear": 2025,
      "engineNumber": "weerwer234234234",
      "chassisNumber": "erwerr23423424",
      "vehicleInsurance": {
        "policyNumber": "werewr",
        "insuranceCompany": "ICICI Lombard",
        "insuranceExpiryDate": "2025-09-17T00:00:00.000Z",
        "insuranceAmount": 20000,
        "isInsuranceValid": true
      },
      "vehicleRegistrationImages": [
        {"url": "https://res.cloudinary.com/drjv1dcre/image/upload/v1761289512/driver-documents/vehicle-registration/e0ucacfkczwvfflyk7fh.jpg", "publicId": "driver-documents/vehicle-registration/e0ucacfkczwvfflyk7fh"}
      ],
      "vehicleInsuranceImages": [],
      "drivingLicenseImages": [],
      "idProofImages": [],
      "licenseNumber": "NEW123456789",
      "licenseExpiry": "2027-12-31T00:00:00.000Z",
      "license_type": "LMV",
      "expiry_date": "2027-12-31T00:00:00.000Z",
      "drivingLicenseIssueDate": "2020-01-15T00:00:00.000Z",
      "drivingLicenseIssuingAuthority": "RTO Delhi",
      "aadhaarNumber": "987654321098",
      "isVerified": true,
      "isProfileComplete": false,
      "currentLocation": {
        "type": "Point",
        "coordinates": [0, 0]
      },
      "isOnline": true,
      "isLoggedin": true,
      "onlineAs": 0,
      "lastActive": "2025-12-26T10:13:20.747Z",
      "fcmToken": "12345678",
      "deviceId": "3ef41756a3b618f9",
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "walletBalance": 0,
      "bankAccount": {
        "accountHolderName": null,
        "accountNumber": null,
        "ifscCode": null
      },
      "membership": {
        "plan": "Free",
        "startDate": "2025-12-26T10:18:15.156Z",
        "endDate": "2026-01-26T10:18:15.156Z",
        "paymentStatus": "Pending",
        "transactionId": null,
        "isCancelled": false,
        "cancelledAt": null,
        "cancelReason": null
      },
      "rating": 0,
      "totalRides": 0,
      "cancelledRides": 0,
      "role": "driver",
      "createdAt": "2025-08-08T12:27:45.807Z",
      "updatedAt": "2025-12-26T10:13:20.748Z",
      "__v": 0,
      "fullName": "Ashish Rai"
    }
  ]
}
```

**Response includes ALL driver fields:**
- Basic Information: driverId, firstName, lastName, email, phone, profilePhoto, fullName
- Vehicle Information: vehicleType, vehicleNumber, vehicleModel, vehicleColor, vehicleManufacturingYear, engineNumber, chassisNumber
- Vehicle Insurance: Complete vehicleInsurance object
- Document Images: vehicleRegistrationImages, vehicleInsuranceImages, drivingLicenseImages, idProofImages
- License Information: licenseNumber, licenseExpiry, aadhaarNumber
- Verification Status: isVerified, isProfileComplete
- Location & Status: currentLocation, isOnline, isLoggedin, onlineAs, lastActive
- Mobile Integration: fcmToken, deviceId, accessToken
- Financial: walletBalance, bankAccount, membership
- Performance: rating, totalRides, cancelledRides
- System Fields: role, createdAt, updatedAt, _id, id, __v

**Note:** 
- `count` is returned as a string for Kotlin compatibility
- All date fields are returned as ISO 8601 strings
- All fields are always present (null/empty values for missing data)

**Error Responses:**
- `500` - Server error

---

### 3. Get Record by ID
**GET** `/api/:collectionName/:id`

**Example:** `GET /api/drivers/507f1f77bcf86cd799439011`

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "driverId": "1234567890",
    "firstName": "John",
    "lastName": "Doe",
    "...": "all fields"
  }
}
```

**Error Responses:**
- `404` - Record not found
- `500` - Server error

---

### 4. Update Record
**PUT** `/api/:collectionName/:id`

**Example:** `PUT /api/drivers/507f1f77bcf86cd799439011`

**Request Body:**
```json
{
  "firstName": "John Updated",
  "vehicleNumber": "XY999ZZ"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "drivers updated successfully",
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "driverId": "1234567890",
    "firstName": "John Updated",
    "vehicleNumber": "XY999ZZ",
    "updatedAt": "2024-12-24T10:30:00.000Z"
  }
}
```

**Error Responses:**
- `400` - Duplicate field value
- `404` - Record not found
- `500` - Server error

---

### 5. Delete Record
**DELETE** `/api/:collectionName/:id`

**Example:** `DELETE /api/drivers/507f1f77bcf86cd799439011`

**Response (200 OK):**
```json
{
  "success": true,
  "message": "drivers deleted successfully"
}
```

**Error Responses:**
- `404` - Record not found
- `500` - Server error

---

## Common Error Responses

### 400 Bad Request
```json
{
  "success": false,
  "message": "Missing required fields: firstName, lastName, email",
  "data": {
    "missingFields": {
      "firstName": true,
      "lastName": true,
      "email": true
    }
  }
}
```

### 401 Unauthorized
```json
{
  "success": false,
  "message": "Access token required",
  "data": {
    "error": "Authorization header missing or invalid format"
  }
}
```

### 403 Forbidden
```json
{
  "success": false,
  "message": "Driver account not verified. Please verify your account first.",
  "data": {
    "driverId": "1234567890",
    "isVerified": false
  }
}
```

### 404 Not Found
```json
{
  "success": false,
  "message": "Driver not found",
  "data": {
    "driverId": "1234567890"
  }
}
```

### 500 Server Error
```json
{
  "success": false,
  "message": "Server error",
  "data": {
    "details": "Error message here"
  }
}
```

### 503 Service Unavailable
```json
{
  "success": false,
  "message": "Database connection not available. Please try again later.",
  "error": "DATABASE_CONNECTION_ERROR",
  "timestamp": "2024-12-24T10:30:00.000Z",
  "retryAfter": 30
}
```

---

## Authentication

### JWT Token Usage
For protected routes, include the JWT token in the Authorization header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Token Details
- **Expiration**: 7 days
- **Payload**: Contains driverId, email, phone, role, loginTime
- **Storage**: Stored in database for validation

---

## Notes

1. **Password**: Never returned in responses (passwordHash is excluded)
2. **OTP**: Currently returned in response for testing (remove in production)
3. **Image Uploads**: Supports multiple images per document type via multipart/form-data
4. **Vehicle Types**: Valid values are `Auto`, `Car`, `Bike`, `Van`
5. **Online Status**: `onlineAs` values: `0` = Public, `1` = Private Booking
6. **Coordinates**: Location format is `[longitude, latitude]` (GeoJSON Point)
7. **All Driver Fields**: Responses include all driver fields with default values for missing fields

---

## Testing Examples

### cURL Examples

**Create Driver:**
```bash
curl -X POST http://localhost:3000/api/drivers \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "1234567890",
    "password": "password123"
  }'
```

**Login:**
```bash
curl -X POST http://localhost:3000/api/drivers/login \
  -H "Content-Type: application/json" \
  -d '{
    "emailOrPhone": "john@example.com",
    "password": "password123",
    "fcmToken": "fcm_token",
    "deviceId": "device_id"
  }'
```

**Get Profile (Protected):**
```bash
curl -X GET http://localhost:3000/api/drivers/profile \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

---

## Image Upload & Delete APIs

### 1. Upload Image to Cloudinary
**POST** `/api/images/upload`

**Content-Type:** `multipart/form-data`

**Request Body:**
- `image` (file, required) - Image file to upload
- `folder` (string, optional) - Cloudinary folder path (default: `driver-documents`)

**Example Request (cURL):**
```bash
curl -X POST http://localhost:3000/api/images/upload \
  -F "image=@/path/to/image.jpg" \
  -F "folder=driver-documents/profile-photos"
```

**Example Request (JavaScript/Fetch):**
```javascript
const formData = new FormData();
formData.append('image', fileInput.files[0]);
formData.append('folder', 'driver-documents/profile-photos');

const response = await fetch('http://localhost:3000/api/images/upload', {
  method: 'POST',
  body: formData
});

const result = await response.json();
console.log(result);
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Image uploaded successfully to Cloudinary",
  "data": {
    "url": "https://res.cloudinary.com/drjv1dcre/image/upload/v1761289512/driver-documents/profile-photos/abc123xyz.jpg",
    "public_id": "driver-documents/profile-photos/abc123xyz",
    "width": 1920,
    "height": 1080,
    "format": "jpg",
    "bytes": 245678,
    "folder": "driver-documents/profile-photos",
    "uploadedAt": "2024-12-27T10:30:00.000Z"
  }
}
```

**Error Responses:**
- `400` - No image file provided
- `400` - File too large (max 10MB)
- `400` - Only image files are allowed
- `500` - Failed to upload to Cloudinary or server error

---

### 2. Delete Image from Cloudinary
**DELETE** `/api/images/delete/:public_id`

**URL Parameters:**
- `public_id` (required) - Cloudinary public_id of the image to delete

**Example Request (cURL):**
```bash
curl -X DELETE http://localhost:3000/api/images/delete/driver-documents/profile-photos/abc123xyz
```

**Example Request (JavaScript/Fetch):**
```javascript
const publicId = 'driver-documents/profile-photos/abc123xyz';

const response = await fetch(`http://localhost:3000/api/images/delete/${encodeURIComponent(publicId)}`, {
  method: 'DELETE'
});

const result = await response.json();
console.log(result);
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Image deleted successfully from Cloudinary",
  "data": {
    "public_id": "driver-documents/profile-photos/abc123xyz",
    "result": "ok",
    "deletedAt": "2024-12-27T10:35:00.000Z"
  }
}
```

**Error Responses:**
- `400` - Missing public_id parameter
- `500` - Failed to delete from Cloudinary or server error

**Note:** The `public_id` should be URL-encoded if it contains special characters.

---

**Last Updated:** December 27, 2024

