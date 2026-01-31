# User vs Driver API List

**Base URL:** `http://localhost:3000` or `http://YOUR_IP:3000`

---

## USER APIs

**Collections:** `users`, `users_otp`, `users_notification`  
**Base path:** `/api/users`

| # | Method | Endpoint | Description |
|---|--------|----------|-------------|
| 1 | POST | `/api/users/register` | User registration |
| 2 | POST | `/api/users/login` | User login (sends OTP to `users_otp`) |
| 3 | POST | `/api/users/verify-otp` | Verify OTP (reads `users_otp`, updates `users`) |
| 4 | PUT / POST | `/api/users/profile` | Edit user profile |
| 5 | POST | `/api/users/resend-otp` | Resend OTP (`users_otp`) |
| 6 | GET | `/api/users/detail/:userId` | Get user detail by userId |
| 7 | POST | `/api/users/logout` | User logout |
| 8 | GET | `/api/users/notifications` | Get user notifications (`users_notification`) |
| 9 | PUT | `/api/users/notifications/mark-read` | Mark notifications as read |

### 1. User Registration
- **Method:** `POST`
- **Endpoint:** `/api/users/register`
- **Collection:** `users`
- **Request Body:**
```json
{
  "name": "John Doe",
  "phone": "9876543210",
  "email": "john@example.com"
}
```
- **Response:** Full `user` (all fields, no passwordHash) + `otp` (for verification)

### 2. User Login
- **Method:** `POST`
- **Endpoint:** `/api/users/login`
- **Collections:** `users` (read), `users_otp` (create/update)
- **Request Body:**
```json
{
  "phoneNumber": "9876543210"
}
```
- **Response:** Full `user` (all fields, no passwordHash) + `otp` (sent to phone)

### 3. User OTP Verification
- **Method:** `POST`
- **Endpoint:** `/api/users/verify-otp`
- **Collections:** `users_otp` (read, mark used), `users` (update isLoggedin, isPhoneVerified, accessToken)
- **Request Body:**
```json
{
  "userId": "1234567890",
  "otp": "123456"
}
```
- **Response:** Full `user` (all fields, no passwordHash) + `accessToken` (JWT)

### 4. User Profile Edit
- **Method:** `PUT` or `POST`
- **Endpoint:** `/api/users/profile`
- **Collection:** `users`
- **Request Body:**
```json
{
  "userId": "1234567890",
  "firstName": "John",
  "lastName": "Doe",
  "profilePhoto": "https://..."
}
```
- **Response:** Full `user` (all fields, no passwordHash)

### 5. User Resend OTP
- **Method:** `POST`
- **Endpoint:** `/api/users/resend-otp`
- **Collections:** `users` (read), `users_otp` (create)
- **Request Body:**
```json
{
  "userId": "1234567890"
}
```
- **Response:** Full `user` (all fields, no passwordHash) + `otp` info

### 6. Get User Detail by userId
- **Method:** `GET`
- **Endpoint:** `/api/users/detail/:userId`
- **Collection:** `users`
- **URL Parameter:** `userId` (e.g. `1234567890`)
- **Response:** Full `user` (all fields, no passwordHash)

### 7. User Logout
- **Method:** `POST`
- **Endpoint:** `/api/users/logout`
- **Collection:** `users`
- **Request Body:**
```json
{
  "userId": "1234567890"
}
```
- **Response:** Full `user` (all fields, no passwordHash) + `logoutTime`, `sessionInfo`

### 8. Get User Notifications
- **Method:** `GET`
- **Endpoint:** `/api/users/notifications`
- **Collection:** `users_notification`
- **Query:** `userId` or `user_id` (optional)
- **Response:** `notifications`, `totalCount`, `unreadCount`

### 9. Mark User Notifications as Read
- **Method:** `PUT`
- **Endpoint:** `/api/users/notifications/mark-read`
- **Collection:** `users_notification`
- **Request Body:**
```json
{
  "user_id": "1234567890",
  "notificationIds": ["507f1f77bcf86cd799439011"]
}
```
- **Response:** `updatedCount`, `matchedCount`, `notifications`, `summary`

---

## DRIVER APIs

**Collections:** `drivers`, `drivers_otp`  
**Base path:** `/api/drivers` and `/api/otp` (for driver OTP)

| # | Method | Endpoint | Description |
|---|--------|----------|-------------|
| 1 | POST | `/api/drivers` | Create driver (signup) |
| 2 | POST | `/api/drivers/login` | Driver login |
| 3 | POST | `/api/drivers/logout` | Driver logout |
| 4 | PUT | `/api/drivers/online-status` | Update online status |
| 5 | GET | `/api/drivers/status/:driverId` | Get driver status |
| 6 | GET | `/api/drivers/profile` | Get driver profile (JWT) |
| 7 | PUT | `/api/drivers/profile` | Update driver profile |
| 8 | PUT / POST | `/api/drivers/update` | Update driver fields (e.g. isPhoneVerified) |
| 9 | PUT | `/api/drivers/vehicle-details` | Update vehicle details |
| 10 | GET | `/api/drivers/:driverId/vehicle-details` | Get vehicle details |
| 11 | GET | `/api/drivers/faqs` | Get driver FAQs |
| 12 | POST | `/api/drivers/issues` | Submit driver issue |
| 13 | GET | `/api/drivers/:driverId/issues` | Get driver issues |
| 14 | PUT | `/api/drivers/issues/:issueId` | Update issue status |
| 15 | GET | `/api/drivers/notifications` | Get driver notifications |
| 16 | PUT | `/api/drivers/notifications/mark-read` | Mark notifications read |
| 17 | GET | `/api/drivers` | Get all drivers |
| 18 | GET | `/api/drivers/:id` | Get driver by MongoDB _id |
| 19 | PUT | `/api/drivers/:id` | Update driver by _id |
| 20 | DELETE | `/api/drivers/:id` | Delete driver by _id |

### Driver OTP (collection: `drivers_otp`)

| # | Method | Endpoint | Description |
|---|--------|----------|-------------|
| 1 | POST | `/api/otp/send` | Send OTP |
| 2 | POST | `/api/otp/generate` | Generate OTP (legacy) |
| 3 | POST | `/api/otp/verify` | Verify OTP |
| 4 | POST | `/api/otp/profile-complete` | Update profile complete |
| 5 | POST | `/api/otp/resend` | Resend OTP |

---

## OTHER (Shared / Neutral)

| # | Method | Endpoint | Description |
|---|--------|----------|-------------|
| 1 | GET | `/health` | Health check |
| 2 | GET | `/test` | Test endpoint |
| 3 | POST | `/api/images/upload` | Upload image |
| 4 | DELETE | `/api/images/delete/:public_id` | Delete image |
| 5 | POST | `/api/:collectionName` | Dynamic create |
| 6 | GET | `/api/:collectionName` | Dynamic get all |
| 7 | GET | `/api/:collectionName/:id` | Dynamic get by id |
| 8 | PUT | `/api/:collectionName/:id` | Dynamic update |
| 9 | DELETE | `/api/:collectionName/:id` | Dynamic delete |

---

## Summary

| Group | Count | Collections |
|-------|-------|-------------|
| **User** | 9 | `users`, `users_otp`, `users_notification` |
| **Driver** | 20 | `drivers` |
| **Driver OTP** | 5 | `drivers_otp` |
| **Other** | 9 | — |

**User and Driver are fully separate:** different routes, controllers, models, and MongoDB collections.
