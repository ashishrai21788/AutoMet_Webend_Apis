# Complete API List

## Base URL
```
http://localhost:3000
```
or
```
http://YOUR_IP:3000
```

---

## Server Health & Test Endpoints

### 1. Health Check
- **Method:** `GET`
- **Endpoint:** `/health`
- **Description:** Check server health status
- **Request:** None
- **Response:** Server health information

### 2. Test Endpoint
- **Method:** `GET`
- **Endpoint:** `/test`
- **Description:** Test endpoint for debugging
- **Request:** None
- **Response:** Server status and headers

---

## Driver APIs

### 1. Create Driver (Signup)
- **Method:** `POST`
- **Endpoint:** `/api/drivers`
- **Description:** Create a new driver account
- **Request Body:**
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

### 2. Driver Login
- **Method:** `POST`
- **Endpoint:** `/api/drivers/login`
- **Description:** Login driver and get access token
- **Request Body:**
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

### 3. Driver Logout
- **Method:** `POST`
- **Endpoint:** `/api/drivers/logout`
- **Description:** Logout driver
- **Request Body:**
```json
{
  "driverId": "1234567890"
}
```

### 4. Update Online Status
- **Method:** `PUT`
- **Endpoint:** `/api/drivers/online-status`
- **Description:** Update driver online status (onlineAs: 0=Public, 1=Private)
- **Request Body:**
```json
{
  "driverId": "1234567890",
  "isOnline": true,
  "onlineAs": 0
}
```

### 5. Get Driver Status
- **Method:** `GET`
- **Endpoint:** `/api/drivers/status/:driverId`
- **Description:** Get driver status by driverId
- **URL Parameters:** `driverId` (e.g., `1234567890`)

### 6. Get Driver Profile (Protected)
- **Method:** `GET`
- **Endpoint:** `/api/drivers/profile`
- **Description:** Get driver profile (requires JWT token)
- **Headers:** `Authorization: Bearer <access_token>`

### 7. Update Vehicle Details
- **Method:** `PUT`
- **Endpoint:** `/api/drivers/vehicle-details`
- **Description:** Update vehicle details with pre-uploaded image URLs
- **Request Body:**
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
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/vehicle-registration/abc123"}
  ],
  "drivingLicenseImages": [
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/driving-license/abc123"}
  ],
  "insurance": [
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/insurance/abc123"}
  ],
  "idProofImages": [
    {"url": "https://res.cloudinary.com/...", "publicId": "driver-documents/id-proof/abc123"}
  ]
}
```

### 8. Get Vehicle Details by DriverId
- **Method:** `GET`
- **Endpoint:** `/api/drivers/:driverId/vehicle-details`
- **Description:** Get vehicle details by driverId
- **URL Parameters:** `driverId` (e.g., `0656798311`)

### 9. Get Driver Analytics
- **Method:** `GET`
- **Endpoint:** `/api/drivers/:driverId/analytics`
- **Description:** Aggregated analytics for a driver. **Map appearances** = only `map_screen_opened` (once per session, no overcounting). **todayTotalViewed** = `map_screen_opened` + `visible_driver_snapshot`. **currentlyViewing** = active search live (TTL). See [MAP_ANALYTICS_DESIGN.md](./MAP_ANALYTICS_DESIGN.md).
- **URL Parameters:** `driverId` (e.g., `1017299105`)
- **Query Parameters:**
  - `period` (optional): `today`, `day`, `week`, `month`. Default: `week`.
  - `from`, `to` (optional): ISO 8601 dates for custom range; max 365 days.
- **Response:** `mapAppearances`, `markerTaps`, `calls`, `pickupRequests`, `infoCardViews`, `profileOpenedFromMap`, `messageTaps`, `directionsTapped`, `todayTotalViewed`, `currentlyViewing`, `totalVisibilityDurationMs`, `totalVisibilityDurationMinutes`, `totalVisibilityDurationHours` (for plotting "time visible on map"), plus `from`, `to`, `period`.

### 10. Send Driver Push Notification (FCM, Android)
- **Method:** `POST`
- **Endpoint:** `/api/drivers/notifications/send`
- **Description:** Send a push notification to a **driver app** Android device via FCM. Uses Android-standard payload (high priority, notification channel). Requires driver to have `fcmToken` set. Also saves to `driver_notification`.
- **Request Body:**
  - `driverId` or `driver_id` (required): Driver ID
  - `title` (required): Notification title
  - `body` (optional): Notification body text
  - `data` (optional): Object of string key-value pairs (e.g. `{ "type": "booking", "id": "123" }`)
  - `channelId` (optional): Android notification channel ID (default: `driver_notifications`). Create this channel in the driver app.
- **Response:** `success`, `data.messageId`, `data.driverId`, `data.title`. On failure: 400 (missing token), 404 (driver not found), 502 (FCM send failed).
- **Env:** Set `FIREBASE_SERVICE_ACCOUNT_KEY` or `FIREBASE_SERVICE_ACCOUNT_PATH` for FCM.

### 11. Get All Drivers
- **Method:** `GET`
- **Endpoint:** `/api/drivers`
- **Description:** Get all drivers or filter by driverId
- **Query Parameters:** `driverId` (optional, e.g., `?driverId=0656798311`)

### 12. Get Driver by ID
- **Method:** `GET`
- **Endpoint:** `/api/drivers/:id`
- **Description:** Get driver by MongoDB _id
- **URL Parameters:** `id` (MongoDB ObjectId)

### 13. Update Driver by ID
- **Method:** `PUT`
- **Endpoint:** `/api/drivers/:id`
- **Description:** Update driver by MongoDB _id
- **URL Parameters:** `id` (MongoDB ObjectId)
- **Request Body:**
```json
{
  "firstName": "John Updated",
  "vehicleNumber": "XY999ZZ"
}
```

### 14. Delete Driver by ID
- **Method:** `DELETE`
- **Endpoint:** `/api/drivers/:id`
- **Description:** Delete driver by MongoDB _id
- **URL Parameters:** `id` (MongoDB ObjectId)

---

## User Notifications (FCM, Android)

Notifications for the **user app** (Android). Same FCM/Android payload standard as driver notifications; separate endpoint and channel.

### 1. Send User Push Notification (FCM, Android)
- **Method:** `POST`
- **Endpoint:** `/api/users/notifications/send`
- **Description:** Send a push notification to a **user app** Android device via FCM. Uses Android-standard payload (high priority, notification channel). Requires user to have `fcmToken` set. Also saves to `users_notification`.
- **Request Body:**
  - `userId` or `user_id` (required): User ID
  - `title` (required): Notification title
  - `body` (optional): Notification body text
  - `data` (optional): Object of string key-value pairs (e.g. `{ "type": "ride", "id": "456" }`)
  - `channelId` (optional): Android notification channel ID (default: `user_notifications`). Create this channel in the user app.
- **Response:** `success`, `data.messageId`, `data.userId`, `data.title`. On failure: 400 (missing token), 404 (user not found), 502 (FCM send failed).
- **Env:** Set `FIREBASE_SERVICE_ACCOUNT_KEY` or `FIREBASE_SERVICE_ACCOUNT_PATH` for FCM.

---

## OTP APIs

### 1. Send OTP
- **Method:** `POST`
- **Endpoint:** `/api/otp/send`
- **Description:** Send OTP for driver verification
- **Request Body:**
```json
{
  "driverId": "1234567890"
}
```

### 2. Verify OTP
- **Method:** `POST`
- **Endpoint:** `/api/otp/verify`
- **Description:** Verify OTP and update driver verification status
- **Request Body:**
```json
{
  "driverId": "1234567890",
  "otp": "123456"
}
```

### 3. Resend OTP
- **Method:** `POST`
- **Endpoint:** `/api/otp/resend`
- **Description:** Resend OTP to driver
- **Request Body:**
```json
{
  "driverId": "1234567890"
}
```

### 4. Generate OTP (Legacy)
- **Method:** `POST`
- **Endpoint:** `/api/otp/generate`
- **Description:** Generate OTP (legacy endpoint)
- **Request Body:**
```json
{
  "driverId": "1234567890",
  "email": "john.doe@example.com",
  "phone": "1234567890"
}
```

### 5. Update Profile Complete
- **Method:** `POST`
- **Endpoint:** `/api/otp/profile-complete`
- **Description:** Update driver profile completion status
- **Request Body:**
```json
{
  "driverId": "1234567890",
  "isProfileComplete": true
}
```

---

## Image APIs

### 1. Upload Image to Cloudinary
- **Method:** `POST`
- **Endpoint:** `/api/images/upload`
- **Description:** Upload single image to Cloudinary. Returns URL and publicId.
- **Content-Type:** `multipart/form-data`
- **Request Body:**
  - `image` (file, required) - Image file to upload
  - `folder` (string, optional) - Cloudinary folder path (default: `driver-documents`)

### 2. Delete Image from Cloudinary
- **Method:** `DELETE`
- **Endpoint:** `/api/images/delete/:public_id`
- **Description:** Delete image from Cloudinary by public_id
- **URL Parameters:** `public_id` (e.g., `driver-documents/profile-photos/abc123xyz`)

---

## User App Analytics APIs

**Event reference:** See **USER_APP_ANALYTICS_EVENTS.md** for all event names, params, and categories (platform, auth, map, legal, etc.).

### 1. Save User App Analytics Events
- **Method:** `POST`
- **Endpoint:** `/api/user-app-analytics`
- **Description:** Save user app analytics events to MongoDB (collection: `user_app_analytics`).
- **Request Body:**
```json
{
  "events": [
    {
      "eventName": "login_success",
      "appId": "in.automet.user",
      "source": "user_app",
      "eventCategory": "user",
      "pageIdentifier": "login",
      "params": { "method": "phone" },
      "eventId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "actorId": "user_mongo_id_here",
      "actorType": "user",
      "appVersion": "1.0",
      "platform": "android",
      "sessionId": "sess-uuid-here",
      "deviceId": "device-hash-here",
      "clientTimestamp": "2025-01-31T10:00:00.000Z",
      "metadata": {}
    }
  ],
  "deviceId": "device-hash-here",
  "sessionId": "sess-uuid-here",
  "appId": "in.automet.user",
  "appVersion": "1.0",
  "platform": "android",
  "source": "user_app"
}
```
- **Response:** 201 Created with `id`, `eventsCount`, `deviceId`, `sessionId`, `appId`, `createdAt`.

---

## Driver App Analytics APIs

**Event reference:** See **ANALYTICS_DATA_MODEL.md**, **ANALYTICS_FOR_API.md**, **PROMPT_ANALYTICS_API.md** for duty_on, duty_off, online_session_summary, tracking_health and params (onlineAs, heading, lat, lng, onlineDurationSeconds, idleDurationSeconds, onlineStartedAt, etc.).

### 1. Save Driver App Analytics Events
- **Method:** `POST`
- **Endpoint:** `/api/driver-app-analytics`
- **Description:** Save driver app analytics events to MongoDB (collection: `driver_app_analytics`). Events: duty_on, duty_off, online_session_summary, tracking_health.
- **Request Body:**
```json
{
  "events": [
    {
      "eventName": "duty_on",
      "appId": "in.automet.driver",
      "source": "driver_app",
      "eventCategory": "driver",
      "params": {
        "onlineAs": 0,
        "heading": 45,
        "lat": 28.6139,
        "lng": 77.209
      },
      "eventId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "actorId": "driver_mongo_id_here",
      "actorType": "driver",
      "appVersion": "1.0",
      "platform": "android",
      "sessionId": "sess-uuid-here",
      "deviceId": "device-hash-here",
      "clientTimestamp": "2025-01-31T10:00:00.000Z",
      "metadata": {}
    }
  ],
  "deviceId": "device-hash-here",
  "sessionId": "sess-uuid-here",
  "appId": "in.automet.driver",
  "appVersion": "1.0",
  "platform": "android",
  "source": "driver_app"
}
```
- **Response:** 201 Created with `id`, `eventsCount`, `deviceId`, `sessionId`, `appId`, `createdAt`.

---

## Dynamic Collection APIs

These APIs work with any collection name. Replace `:collectionName` with your collection name (e.g., `drivers`, `users`, `vehicles`, etc.).

### 1. Create Record
- **Method:** `POST`
- **Endpoint:** `/api/:collectionName`
- **Description:** Create a record in any collection
- **Request Body:**
```json
{
  "field1": "value1",
  "field2": "value2"
}
```

### 2. Get All Records
- **Method:** `GET`
- **Endpoint:** `/api/:collectionName`
- **Description:** Get all records from a collection
- **Query Parameters:** Varies by collection (e.g., `driverId` for drivers)

### 3. Get Record by ID
- **Method:** `GET`
- **Endpoint:** `/api/:collectionName/:id`
- **Description:** Get a record by MongoDB _id
- **URL Parameters:** `id` (MongoDB ObjectId)

### 4. Update Record
- **Method:** `PUT`
- **Endpoint:** `/api/:collectionName/:id`
- **Description:** Update a record by MongoDB _id
- **URL Parameters:** `id` (MongoDB ObjectId)
- **Request Body:**
```json
{
  "field1": "updated_value1"
}
```

### 5. Delete Record
- **Method:** `DELETE`
- **Endpoint:** `/api/:collectionName/:id`
- **Description:** Delete a record by MongoDB _id
- **URL Parameters:** `id` (MongoDB ObjectId)

---

## Summary

**Total APIs: 30**

- **Server Health & Test:** 2 APIs
- **Driver APIs:** 12 APIs
- **OTP APIs:** 5 APIs
- **Image APIs:** 2 APIs
- **User App Analytics APIs:** 1 API
- **Driver App Analytics APIs:** 1 API
- **Dynamic Collection APIs:** 5 APIs

---

## Postman Collection

A complete Postman collection is available in `API_Collection.postman_collection.json`

**To import:**
1. Open Postman
2. Click "Import" button
3. Select `API_Collection.postman_collection.json`
4. Update the `base_url` variable to match your server URL

**Collection Variables:**
- `base_url`: `http://localhost:3000` (or your server IP)
- `access_token`: JWT token for protected routes (set after login)

---

**Last Updated:** December 27, 2024

