# Ride Request Intent API (No Fare / No Payment)

REST API for ride visibility and connection: user requests a ride to a specific driver. No fare, pricing, or payment.

**Base path:** `/api/v1/rides`

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/request` | Create ride request (user → driver) |
| POST | `/check-timeouts` | Cron: mark timed-out REQUESTED as NO_RESPONSE |
| POST | `/cancel` | User cancels ride (before or after acceptance, before trip start) |
| GET | `/active` | Get current incomplete ride for driver or user (query: `user_id` or `driver_id`) |
| GET | `/details` | Get ride details by `ride_id` + `user_id` or `driver_id` |
| GET | `/` | List trips (query: `user_id`, `driver_id`, `status`, `limit`, `skip`) |
| GET | `/:tripId` | Get trip by `trip_id` |
| GET | `/:tripId/timeline` | Trip audit / movement timestamps |
| PATCH | `/:tripId/accept` | Driver accepts |
| PATCH | `/:tripId/reject` | Driver or user rejects (body: `rejected_reason?`, `rejected_by`: USER \| DRIVER) |
| PATCH | `/:tripId/status` | Set status: `DRIVER_ON_THE_WAY` \| `ARRIVED` \| `ON_GOING` \| `COMPLETED` (body: `{ "status" }`) |

---

## Get active (incomplete) ride

**GET** `/api/v1/rides/active`

**Data source:** `trip_details` collection.

Call when driver or user lands on the app. Returns the current ride that is not completed (status is `REQUESTED`, `ACCEPTED`, `DRIVER_ON_THE_WAY`, `ARRIVED`, or `ON_GOING`). Full ride record from `trip_details` is included.

**Query (one required):**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| user_id | string | Yes* | User ID (*required if driver_id not sent) |
| driver_id | string | Yes* | Driver ID (*required if user_id not sent) |

**Examples:**

- User landing: `GET /api/v1/rides/active?user_id=USR_1023`
- Driver landing: `GET /api/v1/rides/active?driver_id=DRV_5566`

**Success (200) – active ride found:**

```json
{
  "success": true,
  "message": "Active ride found",
  "data": {
    "active_ride": {
      "trip_id": "amt_id_000123",
      "request_id": "REQ_10001",
      "user_id": "USR_1023",
      "driver_id": "DRV_5566",
      "pickup_address": "Sector 62, Noida",
      "pickup_latitude": 28.6139,
      "pickup_longitude": 77.391,
      "drop_address": "Connaught Place, Delhi",
      "drop_latitude": 28.6315,
      "drop_longitude": 77.2167,
      "ride_note": "Gate 2",
      "status": "ACCEPTED",
      "requested_at": "2025-02-18T10:00:00.000Z",
      "accepted_at": "2025-02-18T10:00:30.000Z",
      "started_at": null,
      "completed_at": null,
      "createdAt": "...",
      "updatedAt": "..."
    }
  }
}
```

**Success (200) – no active ride:**

```json
{
  "success": true,
  "message": "No active ride found",
  "data": { "active_ride": null }
}
```

---

## Get ride details by ride ID

**GET** `/api/v1/rides/details`

**Data source:** `trip_details` collection.

Fetch full ride details by ride ID. Works for both user and driver; caller must pass `user_id` or `driver_id` so the API can verify they are part of the ride.

**Query:**

| Param     | Type   | Required | Description                          |
|----------|--------|----------|--------------------------------------|
| ride_id  | string | Yes      | Trip/ride ID (e.g. `amt_id_000123`)   |
| user_id  | string | Yes*     | User ID (*use when caller is the user) |
| driver_id| string | Yes*     | Driver ID (*use when caller is the driver) |

**Examples:**

- User: `GET /api/v1/rides/details?ride_id=amt_id_000123&user_id=USR_1023`
- Driver: `GET /api/v1/rides/details?ride_id=amt_id_000123&driver_id=DRV_5566`

**Success (200):**

```json
{
  "success": true,
  "data": {
    "trip_id": "amt_id_000123",
    "request_id": "REQ_10001",
    "user_id": "USR_1023",
    "driver_id": "DRV_5566",
    "pickup_address": "Sector 62, Noida",
    "pickup_latitude": 28.6139,
    "pickup_longitude": 77.391,
    "drop_address": "Connaught Place, Delhi",
    "drop_latitude": 28.6315,
    "drop_longitude": 77.2167,
    "ride_note": "Gate 2",
    "status": "ACCEPTED",
    "requested_at": "...",
    "accepted_at": "...",
    "started_at": null,
    "completed_at": null,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**403** – Ride exists but the given `user_id`/`driver_id` is not the ride’s user or driver.

---

## Create ride request

**POST** `/api/v1/rides/request`

**Body:**

```json
{
  "request_id": "REQ_10001",
  "user_id": "USR_1023",
  "driver_id": "DRV_5566",
  "pickup_address": "Sector 62, Noida",
  "pickup_latitude": 28.6139,
  "pickup_longitude": 77.3910,
  "drop_address": "Connaught Place, Delhi",
  "drop_latitude": 28.6315,
  "drop_longitude": 77.2167,
  "ride_note": "Waiting near Gate 2"
}
```

**Validations:** `user_id` and `driver_id` must exist in `users` (by `userId`) and `drivers` (by `driverId`); driver must be **online**; valid lat/lng; pickup ≠ drop; no duplicate active request (same user + driver with status REQUESTED/ACCEPTED/ON_GOING).

**Success (201):**

```json
{
  "success": true,
  "trip_id": "amt_id_000123",
  "request_id": "REQ_10001",
  "status": "REQUESTED",
  "message": "Ride request sent to driver"
}
```

On success, the driver receives an FCM push (if `fcmToken` is set). Call **POST** `/api/v1/rides/check-timeouts` periodically (e.g. every minute) to auto-set `NO_RESPONSE` for requests older than `RIDE_REQUEST_TIMEOUT_SECONDS` (default 60).

---

---

## User cancels ride

**POST** `/api/v1/rides/cancel`

Handles both scenarios:
1. **Before acceptance** — User cancels within the 60-second waiting window (ride status `REQUESTED`).
2. **After acceptance, before trip start** — Driver accepted; trip not yet started (ride status `ACCEPTED`).

User **cannot cancel** once the ride has started (`ON_GOING`) or completed (`COMPLETED`). Cancel is allowed when status is REQUESTED, ACCEPTED, DRIVER_ON_THE_WAY, or ARRIVED (with appropriate `cancel_stage`).

**Body:**

```json
{
  "request_id": "REQ_10001",
  "user_id": "USR_1023",
  "cancellation_reason": "Change of plans",
  "cancel_stage": "before_accept"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| request_id | string | Conditionally required | Request ID from create-request/create ride request |
| ride_id | string | Conditionally required | Trip/ride ID |
| user_id | string | Yes | User who created the ride (must match ride owner) |
| cancellation_reason | string | No | Optional reason for cancellation |
| cancel_stage | string | Yes | `before_accept` or `after_accept` |

Either `request_id` or `ride_id` must be provided.

**Validations:** Ride must exist; `user_id` must match ride owner; status must be `REQUESTED` (for `before_accept`) or `ACCEPTED` (for `after_accept`); no duplicate cancellation.

**Success (200):**

```json
{
  "success": true,
  "trip_id": "amt_id_000123",
  "request_id": "REQ_10001",
  "status": "CANCELLED_BY_USER",
  "message": "Ride cancelled before driver acceptance"
}
```

On success: ride status updated; driver notified via FCM push and Socket.IO (`ride_cancelled_by_user`); audit log entry in `trip_events`.

---

## Trip status lifecycle

| Status | Meaning |
|--------|---------|
| REQUESTED | User sent request |
| ACCEPTED | Driver accepted |
| DRIVER_ON_THE_WAY | Driver is on the way to pickup |
| ARRIVED | Driver has arrived at pickup |
| ON_GOING | Trip started |
| COMPLETED | Trip ended |
| REJECTED | Driver/user rejected (no reason) |
| NO_RESPONSE | Timeout (driver did not respond) |
| REJECTED_WITH_REASON | Rejected with `rejected_reason` and `rejected_by` (USER / DRIVER) |
| CANCELLED_BY_USER | User cancelled before driver accepted |
| CANCELLED_BY_USER_AFTER_ACCEPTANCE | User cancelled after driver accepted (before or after driver on the way/arrived) |

---

## Database

- **trips:** `trip_id`, `request_id`, `user_id`, `driver_id`, pickup/drop (address, lat, lng), `ride_note`, `status`, `rejected_reason`, `rejected_by`, `cancellation_reason`, `cancelled_at`, `cancel_stage`, `cancelled_by`, `requested_at`, `accepted_at`, `driver_on_the_way_at`, `arrived_at`, `started_at`, `completed_at`, `createdAt`, `updatedAt`.
- **trip_events:** Audit log (trip_id, event, payload, created_at).
- **trip_counters:** Counter for `amt_id_XXXXXX` (6-digit zero-padded).

---

## Environment

- `RIDE_REQUEST_TIMEOUT_SECONDS` — seconds after which REQUESTED is auto-marked NO_RESPONSE (default: 60).
