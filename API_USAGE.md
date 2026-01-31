# Dynamic API Usage Guide

This API now supports dynamic collection creation and management. You can create records in different collections using the same endpoints by specifying the collection name in the URL.

## Base URLs

### HTTP API
```
http://172.16.8.65:3000/api
```

**Note**: This is a development API server running on HTTP.

## Driver-Specific Endpoints

### Driver Login
**POST** `/api/drivers/login`

Authenticates a driver and returns access token.

**Required Fields:**
- `emailOrPhone` (string)
- `password` (string)
- `deviceId` (string)
- `fcmToken` (string)

**Request Body:**
```json
{
  "emailOrPhone": "driver@example.com",
  "password": "password123",
  "deviceId": "device-123",
  "fcmToken": "fcm-token-456"
}
```

### Driver Logout
**POST** `/api/drivers/logout`

Logs out a driver and clears session data.

**Required Fields:**
- `driverId` (string)

**Request Body:**
```json
{
  "driverId": "1234567890"
}
```

### Driver Online Status Update
**PUT** `/api/drivers/online-status`

Updates driver's online status and booking type.

**Required Fields:**
- `driverId` (string)

**Optional Fields:**
- `isOnline` (boolean) - true for on duty, false for off duty
- `onlineAs` (number) - 0 for public, 1 for private booking

**Request Body:**
```json
{
  "driverId": "1234567890",
  "isOnline": true,
  "onlineAs": 1
}
```

### Driver Current Status
**GET** `/api/drivers/status/:driverId`

Gets the current status of a driver including online/offline status and booking type.

**URL Parameters:**
- `driverId` (string) - The driver's unique ID

**Example Request:**
```
GET /api/drivers/status/1234567890
```

**Response:**
```json
{
  "success": true,
  "message": "Driver status retrieved successfully",
  "data": {
    "driverId": "1234567890",
    "driverName": "John Doe",
    "status": {
      "isLoggedin": true,
      "isOnline": true,
      "onlineAs": 1,
      "statusText": "Online",
      "onlineAsText": "Private Booking"
    },
    "location": {
      "type": "Point",
      "coordinates": [77.209, 28.6139]
    },
    "lastActive": "2025-08-31T11:11:55.627Z",
    "retrievedAt": "2025-08-31T11:11:55.721Z"
  }
}
```

**Status Values:**
- `isLoggedin`: true/false (authentication status)
- `isOnline`: true/false (on duty/off duty)
- `onlineAs`: 0 (Public) or 1 (Private Booking)
- `statusText`: "Online", "Offline", or "Not Logged In"
- `onlineAsText`: "Public" or "Private Booking"

## Dynamic Endpoints

### Create a Record
**POST** `/api/:collectionName`

Creates a new record in the specified collection.

**Examples:**
- Create a driver: `POST /api/drivers`
- Create a user: `POST /api/users`
- Create an admin: `POST /api/admins`

### Driver Signup (Special Handling)
**POST** `/api/drivers`

Creates a new driver with all required fields and default values.

**Required Fields for Driver Signup:**
- `firstName` (string)
- `lastName` (string)
- `email` (string, unique across all drivers)
- `phone` (string)
- `password` (string)

**Optional Fields for Driver Signup:**
- `profilePhoto` (string, defaults to default image)

**Request Body for Driver:**
```json
{
  "firstName": "Rajesh",
  "lastName": "Kumar",
  "email": "rajesh.kumar@example.com",
  "phone": "+919876543210",
  "password": "securePassword123",
  "profilePhoto": "https://cdn.example.com/drivers/rajesh.jpg",
  "vehicleNumber": "DL01AB1234",
  "licenseNumber": "DL123456789"
}
```

**Validation Rules:**
- **Email**: Must be unique across all drivers
- **Phone**: Must be unique across all drivers  
- **Vehicle Number**: Must be unique if provided
- **License Number**: Must be unique if provided
- **Driver ID**: Auto-generated and guaranteed unique

**Response for Driver:**
```json
{
  "success": true,
  "message": "Driver created successfully. OTP sent for verification.",
  "data": {
    "driver": {
      "driverId": "7297735142",
    "firstName": "Rajesh",
    "lastName": "Kumar",
    "email": "rajesh.kumar@example.com",
    "phone": "+919876543210",
    "profilePhoto": "https://cdn.example.com/drivers/rajesh.jpg",
    "vehicleType": null,
    "vehicleNumber": null,
    "vehicleModel": null,
    "vehicleColor": null,
    "licenseNumber": null,
    "licenseExpiry": null,
    "aadhaarNumber": null,
    "isVerified": false,
    "currentLocation": { "type": "Point", "coordinates": [0, 0] },
    "isOnline": false,
    "lastActive": "2025-07-28T14:10:00Z",
    "walletBalance": 0,
    "bankAccount": {
      "accountHolderName": null,
      "accountNumber": null,
      "ifscCode": null
    },
    "rating": 0,
    "totalRides": 0,
    "cancelledRides": 0,
    "role": "driver",
    "createdAt": "2025-07-28T14:10:00Z",
    "updatedAt": "2025-07-28T14:10:00Z"
    },
    "otp": {
      "otp": "123456",
      "expiresAt": "2025-07-29T13:05:14.014Z",
      "message": "Please verify your account using the OTP sent to your email and phone"
    }
  }
}

### OTP Verification Endpoints

**Base URL**: `http://localhost:3000/api/otp`

#### POST `/send` - Send OTP for driver verification (creates or updates existing OTP)
**Request Body:**
```json
{
  "driverId": "7297735142"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "data": {
    "driverId": "7297735142",
    "email": "rajesh.kumar@example.com",
    "phone": "+919876543210",
    "otp": "123456",
    "expiresAt": "2025-07-29T13:05:14.014Z",
    "message": "OTP sent to your registered email and phone number",
    "action": "created"
  }
}
```

#### POST `/generate` - Generate OTP for driver verification (legacy endpoint)
**Request Body:**
```json
{
  "driverId": "7297735142",
  "email": "rajesh.kumar@example.com",
  "phone": "+919876543210"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP generated successfully",
  "data": {
    "driverId": "7297735142",
    "email": "rajesh.kumar@example.com",
    "phone": "+919876543210",
    "otp": "123456",
    "expiresAt": "2025-07-29T13:05:14.014Z",
    "message": "OTP sent to your registered email and phone number"
  }
}
```

#### POST `/verify` - Verify OTP and update driver verification status
**Request Body:**
```json
{
  "driverId": "7297735142",
  "otp": "123456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP verified successfully. Driver is now verified.",
  "data": {
    "driverId": "7297735142",
    "firstName": "Rajesh",
    "lastName": "Kumar",
    "email": "rajesh.kumar@example.com",
    "phone": "+919876543210",
    "profilePhoto": "https://cdn.example.com/drivers/rajesh.jpg",
    "vehicleType": null,
    "vehicleNumber": null,
    "vehicleModel": null,
    "vehicleColor": null,
    "licenseNumber": null,
    "licenseExpiry": null,
    "aadhaarNumber": null,
    "isVerified": true,
    "isProfileComplete": false,
    "currentLocation": { "type": "Point", "coordinates": [0, 0] },
    "isOnline": false,
    "lastActive": "2025-07-29T13:31:35.768Z",
    "walletBalance": 0,
    "bankAccount": {
      "accountHolderName": null,
      "accountNumber": null,
      "ifscCode": null
    },
    "rating": 0,
    "totalRides": 0,
    "cancelledRides": 0,
    "role": "driver",
    "createdAt": "2025-07-29T13:31:35.770Z",
    "updatedAt": "2025-07-29T13:31:39.972Z"
  }
}
```

#### POST `/resend` - Resend OTP for unverified drivers
**Request Body:**
```json
{
  "driverId": "7297735142"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP resent successfully",
  "data": {
    "driverId": "7297735142",
    "email": "rajesh.kumar@example.com",
    "phone": "+919876543210",
    "otp": "654321",
    "expiresAt": "2025-07-29T13:10:14.014Z",
    "message": "New OTP sent to your registered email and phone number"
  }
}
```

#### POST `/profile-complete` - Update driver profile completion status
**Request Body:**
```json
{
  "driverId": "7297735142",
  "isProfileComplete": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Profile completion status updated to true",
  "data": {
    "driverId": "7297735142",
    "firstName": "Rajesh",
    "lastName": "Kumar",
    "email": "rajesh.kumar@example.com",
    "isVerified": true,
    "isProfileComplete": true,
    // ... complete driver record
  }
}
```

### User/Admin Creation
**Request Body for Users/Admins:**
```json
{
  "name": "John Doe",
  "phone": "+1234567890",
  "email": "john@example.com", // Optional
  "role": "user" // Optional: "user", "admin"
}
```

### Get All Records
**GET** `/api/:collectionName`

Retrieves all records from the specified collection.

**Examples:**
- Get all drivers: `GET /api/drivers`
- Get all users: `GET /api/users`

### Get Record by ID
**GET** `/api/:collectionName/:id`

Retrieves a specific record by its ID.

**Examples:**
- Get driver by ID: `GET /api/drivers/64f8a1b2c3d4e5f6a7b8c9d0`
- Get user by ID: `GET /api/users/64f8a1b2c3d4e5f6a7b8c9d0`

### Update Record
**PUT** `/api/:collectionName/:id`

Updates a specific record by its ID.

**Examples:**
- Update driver: `PUT /api/drivers/64f8a1b2c3d4e5f6a7b8c9d0`
- Update user: `PUT /api/users/64f8a1b2c3d4e5f6a7b8c9d0`

### Delete Record
**DELETE** `/api/:collectionName/:id`

Deletes a specific record by its ID.

**Examples:**
- Delete driver: `DELETE /api/drivers/64f8a1b2c3d4e5f6a7b8c9d0`
- Delete user: `DELETE /api/users/64f8a1b2c3d4e5f6a7b8c9d0`

## Usage Examples

### Creating a Driver
```bash
curl -X POST http://localhost:3000/api/drivers \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Rajesh",
    "lastName": "Kumar",
    "email": "rajesh.kumar@example.com",
    "phone": "+919876543210",
    "password": "securePassword123",
    "profilePhoto": "https://cdn.example.com/drivers/rajesh.jpg"
  }'

# Response will include a 10-digit numerical driver ID like: "7297735142"
```

### Creating a User
```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jane User",
    "phone": "+0987654321",
    "email": "jane@example.com",
    "role": "user"
  }'
```

### Getting All Drivers
```bash
curl -X GET http://localhost:3000/api/drivers
```

### Getting All Users
```bash
curl -X GET http://localhost:3000/api/users
```

## Schema Fields

### Driver Schema
Drivers have a comprehensive schema with the following fields:

**Required Fields (for signup):**
- **firstName** (required): String - Driver's first name
- **lastName** (required): String - Driver's last name
- **email** (required): String - Email address (unique across all drivers)
- **phone** (required): String - Phone number
- **password** (required): String - Password (will be hashed)

**Optional Fields (for signup):**
- **profilePhoto** (optional): String - Profile photo URL (defaults to default image)

**Auto-generated Fields:**
- **driverId** (auto-generated): String - Unique 10-digit numerical driver ID (format: 6 digits from timestamp + 4 random digits, guaranteed unique)
- **isVerified** (auto-generated): Boolean - Verification status (default: false, updated to true after OTP verification)
- **isProfileComplete** (auto-generated): Boolean - Profile completion status (default: false, updated when driver uploads all required details)
- **createdAt** (auto-generated): Date - Creation timestamp
- **updatedAt** (auto-generated): Date - Last update timestamp

**Optional Fields (can be updated later):**
- **vehicleType**: String - Type of vehicle (Auto, Car, Bike, Van)
- **vehicleNumber**: String - Vehicle registration number
- **vehicleModel**: String - Vehicle model
- **vehicleColor**: String - Vehicle color
- **licenseNumber**: String - Driver's license number
- **licenseExpiry**: Date - License expiry date
- **aadhaarNumber**: String - Aadhaar number
- **isVerified**: Boolean - Verification status (default: false)
- **currentLocation**: Object - GPS coordinates {type: "Point", coordinates: [longitude, latitude]}
- **isOnline**: Boolean - Online status (default: false)
- **lastActive**: Date - Last active timestamp
- **walletBalance**: Number - Wallet balance (default: 0)
- **bankAccount**: Object - Bank account details
- **rating**: Number - Driver rating (0-5, default: 0)
- **totalRides**: Number - Total rides completed (default: 0)
- **cancelledRides**: Number - Cancelled rides count (default: 0)
- **role**: String - Role type (default: "driver")

### User/Admin Schema
Users and admins use a simpler schema:

- **name** (required): String - The person's name
- **phone** (required): String - Phone number (unique)
- **email** (optional): String - Email address
- **role** (optional): String - Role type ("user", "admin", default: "user")
- **timestamps**: Automatically added (createdAt, updatedAt)

## Response Format

All responses follow this format:

**Success Response:**
```json
{
  "success": true,
  "message": "Collection name created successfully",
  "data": {
    // Record data
  }
}
```

**Error Response:**
```json
{
  "success": false,
  "message": "Error message",
  "data": {
    "field": "fieldName",
    "value": "duplicateValue",
    "existingDriverId": "DRV12345"
  }
}
```

**Validation Error Examples:**

**Missing Required Fields:**
```json
{
  "success": false,
  "message": "Missing required fields: firstName, lastName, email, phone, password",
  "data": {
    "missingFields": {
      "firstName": false,
      "lastName": false,
      "email": false,
      "phone": true,
      "password": true
    }
  }
}
```

**Email Already Exists:**
```json
{
  "success": false,
  "message": "Email address already exists",
  "data": {
    "field": "email",
    "value": "john.doe@example.com",
    "existingDriverId": "DRV12345"
  }
}
```

**Phone Number Already Exists:**
```json
{
  "success": false,
  "message": "Phone number already exists",
  "data": {
    "field": "phone", 
    "value": "+1234567890",
    "existingDriverId": "DRV12345"
  }
}
```

**Vehicle Number Already Exists:**
```json
{
  "success": false,
  "message": "Vehicle number already exists",
  "data": {
    "field": "vehicleNumber",
    "value": "DL01AB1234",
    "existingDriverId": "DRV12345"
  }
}
```

**License Number Already Exists:**
```json
{
  "success": false,
  "message": "License number already exists",
  "data": {
    "field": "licenseNumber",
    "value": "DL123456789",
    "existingDriverId": "DRV12345"
  }
}
```

## Notes

- All collections are stored in the same database
- The collection name in the URL determines which collection the record is stored in
- For drivers: Email addresses must be unique across all drivers
- For users/admins: Phone numbers must be unique across all users/admins
- The same API endpoints work for any collection name you specify
- Driver IDs are automatically generated and guaranteed to be unique (format: 10-digit numerical combination)
- The system will retry up to 10 times to generate a unique driver ID if duplicates are found
- **OTP System**: 
  - 6-digit OTP is automatically generated when a driver is created
  - OTP expires after 5 minutes
  - OTP is stored in `drivers_otp` collection
  - Each driver has only one OTP record (updated when new OTP is sent)
  - Driver verification status is updated to `true` after successful OTP verification
  - Used OTPs are marked as used and cannot be reused
  - Send OTP API creates new OTP or updates existing one
  - OTP verification returns complete driver record
- **Profile Completion**: 
  - `isProfileComplete` field tracks when driver uploads all required details
  - Default value is `false` when driver is created
  - Can be updated via `/api/otp/profile-complete` endpoint
  - Returns complete driver record after update
- **Validation**: The system checks for existing values before creating new drivers and provides clear error messages
- **Case Insensitive**: Email addresses are stored in lowercase for consistency
- **Standardized Response**: All responses follow the same structure with `success`, `message`, and `data` fields
- **Enhanced Error Details**: Error responses include field name, duplicate value, and existing driver ID for better debugging 