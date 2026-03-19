# AutoMet Webend APIs – Postman Collection

This folder contains a Postman collection for all AutoMet backend APIs, with request bodies and response examples.

## Import

1. Open Postman.
2. Click **Import** and select `AutoMet_Webend_APIs.postman_collection.json`.
3. The collection **AutoMet Webend APIs** will appear with folders for each API group.

## Collection Variables

Set these in the collection (or environment) for easy reuse:

| Variable   | Description                    | Example        |
|-----------|---------------------------------|----------------|
| `baseUrl` | API base URL                    | `http://localhost:3000` |
| `userId`  | User ID (from register/login)   | `123456`       |
| `driverId`| Driver ID                       | `DRV001`       |
| `accessToken` | JWT for protected routes   | `eyJhbGci...`   |
| `tripId`  | Trip / ride ID                  | `TRIP001`      |

To set: Collection → Variables tab, or create a Postman Environment and set the same names there.

## Folders Overview

| Folder              | Base Path                    | Description |
|---------------------|------------------------------|-------------|
| **Health**          | `/health`, `/api/health`     | Server and API health checks |
| **Users**           | `/api/users/*`               | Register, login, OTP, profile, notifications |
| **OTP (Driver)**    | `/api/otp/*`                 | Driver OTP send/verify, token, profile-complete |
| **Drivers (API)**   | `/api/drivers/*`             | Driver login, logout, profile, vehicle, issues, notifications |
| **Rides (v1)**      | `/api/v1/rides/*`            | Ride request, accept/reject, cancel, status, list, timeline |
| **Ride Actions (v1)**| `/api/v1/ride-actions/*`     | Atomic request, accept, reject, cancel (idempotent) |
| **Trips (v1)**      | `/api/v1/trips/*`            | Create-request (wait for driver), driver-response, check-timeouts |
| **Images**          | `/api/images/*`              | Upload (Cloudinary), delete by public_id |
| **User App Analytics**  | `/api/user-app-analytics` | Save user app events (deviceId, events array) |
| **Driver App Analytics**| `/api/driver-app-analytics`| Save driver app events |
| **Dynamic (CRUD)**  | `/api/:collectionName`       | Generic CRUD for any collection (e.g. drivers) |

## Request and Response

- Each request has a **Body** (where applicable) and a short **Description** of required/optional fields.
- Each request includes at least one **Response example** (status and body) that you can view in the **Examples** tab or when saving responses.

## Notes

- **Images – Upload**: Use **form-data** and add a key `image` of type **File**, then choose a file. Optional key `folder` (e.g. `driver-documents`).
- **Get Driver Profile**: Requires `Authorization: Bearer {{accessToken}}` (driver JWT from OTP verify or login flow).
- **Dynamic CRUD**: Replace `:collectionName` with the actual collection name (e.g. `drivers`) and `:id` with MongoDB `_id` when using Get/Update/Delete by id.
- **Trips – Create Request**: This endpoint waits up to ~60 seconds for the driver to accept/reject; use **driver-response** from the driver app to complete the flow.
