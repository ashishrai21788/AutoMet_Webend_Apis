# Trip Creation + Driver Notification + Response API

Ride request flow: create trip, notify driver via FCM, **wait up to 60 seconds** for driver response, then return final status to the user app.

**Base path:** `/api/v1/trips`

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/create-request` | Create trip, send FCM to driver, wait up to 60s, return ACCEPTED / REJECTED / NO_RESPONSE |
| POST | `/driver-response` | Driver accepts or rejects (must be within 60s of request) |
| POST | `/check-timeouts` | Cron: mark timed-out REQUESTED trips as NO_RESPONSE |

---

## 1. Create trip request (user app)

**POST** `/api/v1/trips/create-request`

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

**Validations:** `request_id`, user and driver must exist; driver must be **online**; valid lat/lng; pickup ≠ drop; no other active request for same user+driver; `request_id` must be unique; driver must have a valid FCM token and (optional) be active within the allowed window; rate limit per driver.

**Behaviour:**  
1. Validates driver (exists, online, no active trip, rate limit).  
2. Checks driver reachability: FCM token must exist and not be empty; if `lastActive` is used, driver must have been active within `DRIVER_INACTIVE_MAX_MINUTES`.  
3. If unreachable → returns `"Driver is currently unreachable. Please try another driver."` (no trip created).  
4. Sends FCM push **before** creating the trip (retry up to 2 times with 2s delay on transient errors).  
5. If push fails (invalid token, unregistered device, or delivery failure) → returns `"Unable to send request to driver. Please try another driver."` (no trip created). Invalid/unregistered tokens are cleared on the driver document.  
6. Only if push succeeds: creates trip in `trip_details` with push metadata (`push_sent`, `push_message_id`, `push_sent_at`, `push_status: DELIVERED`), then **blocks up to 60 seconds** for driver response. Response is sent when driver accepts/rejects or when the 60s timeout is reached.

**Responses:**

- **Accepted:** `{ "success": true, "trip_id": "amt_id_000245", "request_id": "REQ_10001", "status": "ACCEPTED", "message": "Driver accepted your request" }`
- **Rejected:** `{ "success": false, "trip_id": "amt_id_000245", "request_id": "REQ_10001", "status": "REJECTED", "message": "Driver rejected the request" }`
- **No response:** `{ "success": false, "trip_id": "amt_id_000245", "request_id": "REQ_10001", "status": "NO_RESPONSE", "message": "No response from driver" }`
- **Driver unreachable (no/invalid token or inactive):** `{ "success": false, "message": "Driver is currently unreachable. Please try another driver." }` — no trip created.
- **Push delivery failed:** `{ "success": false, "message": "Unable to send request to driver. Please try another driver." }` — no trip created; technical reason not exposed.
- **Rate limit:** `429` — `{ "success": false, "message": "Please wait before sending another request to this driver." }`

---

## 2. Driver response

**POST** `/api/v1/trips/driver-response`

**Body:**

```json
{
  "request_id": "REQ_10001",
  "driver_id": "DRV_5566",
  "response": "accept",
  "reject_reason": null
}
```

Identifier: send any one of `request_id` or `trip_id` or `ride_id`.  
Response value supports `ACCEPTED`, `REJECTED`, `REJECTED_WITH_REASON` and also `accept` / `reject` variants.

For reject with reason: `"response": "REJECTED_WITH_REASON"`, `"reject_reason": "Too far"`.

**Rules:** Trip must exist, `driver_id` must match trip, status must be `REQUESTED`, and current time must be before `timeout_at` (requested_at + 60s).

---

## 3. Check timeouts (cron)

**POST** `/api/v1/trips/check-timeouts`

No body. Finds all `REQUESTED` trips with `timeout_at < now`, sets status to `NO_RESPONSE`, and resolves any waiting create-request. Call every 10–15 seconds if you rely on cron; the create-request endpoint also handles its own 60s wait.

---

## MongoDB collection: `trip_details`

- `trip_id`, `request_id`, `user_id`, `driver_id`
- `pickup`: `{ address, lat, lng }`
- `drop`: `{ address, lat, lng }`
- `ride_note`, `status`, `driver_response`, `reject_reason`
- `requested_at`, `responded_at`, `timeout_at`
- `push_sent`, `push_message_id`, `push_sent_at`, `push_status` (`DELIVERED` | `FAILED`) — set only when trip is created after successful FCM send
- `created_at`, `updated_at`

**Status lifecycle:** `REQUESTED` → `ACCEPTED` | `REJECTED` | `REJECTED_WITH_REASON` | `NO_RESPONSE`

---

## Socket.IO events

- **To driver** (room `driver:{driver_id}`): `ride_request_received` (full trip payload).
- **To user** (room `user:{user_id}`): `ride_request_accepted`, `ride_request_rejected`, `ride_request_timeout`.

**Joining rooms:** After connecting, emit `join_driver` with `driverId` or `join_user` with `userId` so the server can add the socket to the correct room.

---

## Environment

- `TRIP_DRIVER_RESPONSE_TIMEOUT_SECONDS` — driver response window in seconds (default: **60**).
- `DRIVER_INACTIVE_MAX_MINUTES` — if driver has `lastActive`, reject if older than this many minutes (default: **30**). Set to `0` to disable.
- `TRIP_RATE_LIMIT_SECONDS` — minimum seconds between trip requests to the same driver (default: **60**).
