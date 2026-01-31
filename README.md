# Node.js Express MongoDB REST API Boilerplate

A scalable REST API boilerplate using Node.js, Express, and MongoDB (with Mongoose) following MVC architecture.

## Features
- MVC folder structure
- MongoDB connection via environment variables
- Driver schema: name, phone, vehicleNumber, isOnline
- Routes for creating and retrieving drivers
- Async/await and proper error handling
- Ready for production
- **Easy database and collection name configuration**

## Folder Structure
```
APICreation/
├── config/
│   └── db.js
├── controllers/
│   └── driverController.js
├── models/
│   └── driver.js
├── routes/
│   └── driverRoutes.js
├── .env.example
├── index.js
├── package.json
└── README.md
```

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and configure your settings:
   ```bash
   cp .env.example .env
   ```
3. Start the server:
   ```bash
   npm run dev
   # or
   npm start
   ```

## Environment Variables

### Easy Database & Collection Configuration
Simply update these variables in your `.env` file:

```bash
# MongoDB Connection
MONGODB_USERNAME=your_username
MONGODB_PASSWORD=your_password
MONGODB_CLUSTER=your_cluster.mongodb.net
DB_NAME=your_database_name          # ← Change this for new database
COLLECTION_NAME=your_collection_name # ← Change this for new collection

# Server Configuration
PORT=3000
```

### How to Change Database/Collection Names

**To change database name:**
```bash
# In .env file, change:
DB_NAME=my_new_database
```

**To change collection name:**
```bash
# In .env file, change:
COLLECTION_NAME=my_new_collection
```

**Example - Change to "users" collection in "myapp" database:**
```bash
DB_NAME=myapp
COLLECTION_NAME=users
```

## API Endpoints

### Create Driver
- **POST** `/api/drivers`
- **Body:**
  ```json
  {
    "name": "John Doe",
    "phone": "1234567890",
    "vehicleNumber": "AB123CD",
    "isOnline": true
  }
  ```
- **Response:** 201 Created, driver object

### Driver Login
- **POST** `/api/drivers/login`
- **Body:**
  ```json
  {
    "emailOrPhone": "driver@example.com",
    "password": "password123",
    "fcmToken": "fcm_token_here",
    "deviceId": "device_id_here",
    "currentLocation": {
      "coordinates": [longitude, latitude]
    }
  }
  ```
- **Response:** 200 OK, driver object with access token
- **Features:**
  - ✅ JWT access token generation (7 days expiry)
  - ✅ Online status update to true
  - ✅ FCM token and device ID storage
  - ✅ Current location update
  - ✅ Last active timestamp update

### Driver Logout
- **POST** `/api/drivers/logout`
- **Body:**
  ```json
  {
    "driverId": "1234567890"
  }
  ```
- **Response:** 200 OK, driver object with logout info
- **Features:**
  - ✅ Online status update to false
  - ✅ Access token invalidation
  - ✅ FCM token and device ID clearing
  - ✅ Last active timestamp update

### Get Driver Profile (Protected Route)
- **GET** `/api/drivers/profile`
- **Headers:**
  ```
  Authorization: Bearer <access_token>
  ```
- **Response:** 200 OK, driver profile object
- **Features:**
  - ✅ JWT token verification required
  - ✅ Returns complete driver profile
  - ✅ Secure access to driver data

### Get All Drivers
- **GET** `/api/drivers`
- **Response:** 200 OK, array of drivers

Available Endpoints:
POST /api/:collectionName - Create record
GET /api/:collectionName - Get all records
GET /api/:collectionName/:id - Get specific record
PUT /api/:collectionName/:id - Update record
DELETE /api/:collectionName/:id - Delete record

## OTP APIs

### Send OTP
- **POST** `/api/otp/send`
- **Body:**
  ```json
  {
    "driverId": "1234567890"
  }
  ```
- **Response:** 200 OK, OTP sent successfully

### Verify OTP
- **POST** `/api/otp/verify`
- **Body:**
  ```json
  {
    "driverId": "1234567890",
    "otp": "123456"
  }
  ```
- **Response:** 200 OK, Driver verified successfully

### Resend OTP
- **POST** `/api/otp/resend`
- **Body:**
  ```json
  {
    "driverId": "1234567890"
  }
  ```
- **Response:** 200 OK, New OTP sent successfully

### Generate OTP (Legacy)
- **POST** `/api/otp/generate`
- **Body:**
  ```json
  {
    "driverId": "1234567890",
    "email": "driver@example.com",
    "phone": "1234567890"
  }
  ```
- **Response:** 201 Created, OTP generated successfully

### Update Profile Complete
- **POST** `/api/otp/profile-complete`
- **Body:**
  ```json
  {
    "driverId": "1234567890",
    "isProfileComplete": true
  }
  ```
- **Response:** 200 OK, Profile completion status updated

## Database Information

### MongoDB Database
- **Database Name:** `api_database` (configured in .env as `DB_NAME`)
- **Collections:**
  - `drivers` - Driver information
  - `drivers_otp` - OTP records for driver verification

### OTP Collection Schema
```javascript
{
  driverId: String,      // Reference to driver
  email: String,         // Driver's email
  phone: String,         // Driver's phone
  otp: String,           // 6-digit OTP
  isUsed: Boolean,       // Whether OTP has been used
  expiresAt: Date,       // OTP expiration time
  createdAt: Date,       // Record creation time
  updatedAt: Date        // Record update time
}
```

### OTP Features
- ✅ **6-digit OTP**: Randomly generated
- ✅ **5-minute expiration**: Automatic cleanup via TTL index
- ✅ **One-time use**: OTP marked as used after verification
- ✅ **Resend capability**: Can generate new OTP for same driver
- ✅ **Email/Phone tracking**: Stores contact information for sending

## JWT Authentication

### Access Token Features
- ✅ **JWT Token Generation**: Secure tokens with 7-day expiry
- ✅ **Token Storage**: Tokens stored in database for validation
- ✅ **Token Invalidation**: Tokens cleared on logout
- ✅ **Protected Routes**: Middleware for secure API access
- ✅ **Token Verification**: Validates token signature and expiry

### Token Payload
```javascript
{
  driverId: "1234567890",
  email: "driver@example.com",
  phone: "1234567890",
  role: "driver",
  loginTime: "2025-08-08T12:46:04.338Z",
  iat: 1754657164,    // Issued at
  exp: 1755261964     // Expires at (7 days)
}
```

### Using Protected Routes
```bash
# Include token in Authorization header
curl -X GET \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..." \
  http://172.16.8.65:3000/api/drivers/profile
```

### Environment Variables
```bash
JWT_SECRET=your_super_secret_jwt_key_for_driver_authentication_2024
```

## License
MIT 