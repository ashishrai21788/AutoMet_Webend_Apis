# Ride Action APIs – Vehicle Booking / Live Tracking

Atomic Driver Accept / Reject and User Cancel with proper status validation and race-condition handling.

**Base path:** `/api/v1/ride-actions`

**Collection:** `rides`

---

## RideStatus enum

| Status              | Description                    |
|---------------------|--------------------------------|
| REQUESTED           | User requested; waiting driver |
| ACCEPTED            | Driver accepted                |
| DRIVER_ON_THE_WAY   | Driver is on the way to pickup |
| ARRIVED             | Driver has arrived at pickup   |
| STARTED             | Trip started                   |
| COMPLETED           | Trip completed                 |
| CANCELLED           | Cancelled (user/driver/system) |
| REJECTED            | Driver rejected                |

**Flow:**  
`REQUESTED → ACCEPTED → DRIVER_ON_THE_WAY → ARRIVED → STARTED → COMPLETED`  
`REQUESTED → CANCELLED` \| `REQUESTED → REJECTED`  
`ACCEPTED → CANCELLED` (configurable via `ALLOW_USER_CANCEL_AFTER_ACCEPT`)

---

## Endpoints

| Method | Path       | Description           |
|--------|------------|-----------------------|
| POST   | `/request` | Create ride request   |
| POST   | `/accept`  | Driver accept ride    |
| POST   | `/reject`  | Driver reject ride    |
| POST   | `/cancel`  | User cancel ride      |

---

## 1. Create ride request

**POST** `/api/v1/ride-actions/request`

**Request body:**

```json
{
  "user_id": "USR_001",
  "driver_id": "DRV_001",
  "pickup": { "address": "Sector 62, Noida", "lat": 28.6139, "lng": 77.391 },
  "drop": { "address": "CP, Delhi", "lat": 28.6315, "lng": 77.2167 },
  "ride_note": "Gate 2"
}
```

| Field   | Type   | Required | Description        |
|---------|--------|----------|--------------------|
| user_id | string | Yes      | Requesting user    |
| driver_id | string | Yes    | Assigned driver    |
| pickup  | object | Yes      | address, lat, lng  |
| drop    | object | Yes      | address, lat, lng  |
| ride_note | string | No     | Optional note      |

**Response (201):**

```json
{
  "success": true,
  "code": "REQUESTED",
  "message": "Ride request created",
  "data": { "ride": { "ride_id": "amt_id_000001", "status": "REQUESTED", ... } }
}
```

---

## 2. Driver accept ride

**POST** `/api/v1/ride-actions/accept`

**Request body:**

```json
{
  "ride_id": "amt_id_000001",
  "driver_id": "DRV_001"
}
```

| Field     | Type   | Required |
|-----------|--------|----------|
| ride_id   | string | Yes      |
| driver_id | string | Yes      |

**Response – Success (200):**

```json
{
  "success": true,
  "code": "ACCEPTED",
  "message": "Ride accepted",
  "data": { "ride": { "ride_id": "amt_id_000001", "status": "ACCEPTED", "accepted_at": "...", ... } }
}
```

**Response – Already accepted (200, idempotent):**

```json
{
  "success": true,
  "code": "ALREADY_ACCEPTED",
  "message": "Ride was already accepted by driver",
  "data": { "currentStatus": "ACCEPTED" }
}
```

**Response – Already cancelled (409):**

```json
{
  "success": false,
  "code": "ALREADY_CANCELLED",
  "message": "Ride was already cancelled",
  "data": { "currentStatus": "CANCELLED" }
}
```

**Response – Expired / conflict (409):**

```json
{
  "success": false,
  "code": "EXPIRED_OR_CONFLICT",
  "message": "Request expired or another action was taken",
  "data": { "currentStatus": "..." }
}
```

**Response – Not found (404):** `code: "NOT_FOUND"`

---

## 3. Driver reject ride

**POST** `/api/v1/ride-actions/reject`

**Request body:**

```json
{
  "ride_id": "amt_id_000001",
  "driver_id": "DRV_001",
  "reject_reason": "Too far"
}
```

| Field          | Type   | Required |
|----------------|--------|----------|
| ride_id        | string | Yes      |
| driver_id      | string | Yes      |
| reject_reason  | string | No       |

**Response – Success (200):**

```json
{
  "success": true,
  "code": "REJECTED",
  "message": "Ride rejected",
  "data": { "ride": { "ride_id": "amt_id_000001", "status": "REJECTED", "rejected_at": "...", ... } }
}
```

**Response – Already rejected (409):** `code: "ALREADY_REJECTED"`  
**Response – Already cancelled (409):** `code: "ALREADY_CANCELLED"`

---

## 4. User cancel ride

**POST** `/api/v1/ride-actions/cancel`

**Request body:**

```json
{
  "ride_id": "amt_id_000001",
  "user_id": "USR_001",
  "cancellation_reason": "Change of plans"
}
```

| Field               | Type   | Required |
|---------------------|--------|----------|
| ride_id             | string | Yes      |
| user_id             | string | Yes      |
| cancellation_reason | string | No       |

**Response – Success (200):**

```json
{
  "success": true,
  "code": "CANCELLED",
  "message": "Ride cancelled",
  "data": { "ride": { "ride_id": "amt_id_000001", "status": "CANCELLED", "cancelled_by": "USER", ... } }
}
```

**Response – Already cancelled (409):** `code: "ALREADY_CANCELLED"`  
**Response – Cancel after accept not allowed (409):** `code: "CANCEL_AFTER_ACCEPT_NOT_ALLOWED"` when `ALLOW_USER_CANCEL_AFTER_ACCEPT=false`

---

## Concurrency handling

- **Atomic updates:** All state changes use `findOneAndUpdate` with `status` in the filter so only one transition succeeds.
- **Case 1 – User cancels while driver accepts:** Accept is applied only if current status is `REQUESTED`. If cancel wins, status becomes `CANCELLED` and accept returns `ALREADY_CANCELLED`.
- **Case 2 – Driver accepts first, then user cancels:** Cancel is allowed when status is `ACCEPTED` only if `ALLOW_USER_CANCEL_AFTER_ACCEPT` is not `false` (default: allowed).
- **Case 3 – Multiple drivers:** Accept filter includes `driver_id`; only the assigned driver can accept. If you support pool of drivers, use a single “assign + accept” flow.

**Environment:**

- `ALLOW_USER_CANCEL_AFTER_ACCEPT` – set to `false` to disallow user cancel after driver has accepted (default: allow).

---

## Error codes summary

| Code                         | HTTP | Description                          |
|-----------------------------|------|--------------------------------------|
| VALIDATION_ERROR            | 400  | Missing/invalid body fields          |
| NOT_FOUND                   | 404  | Ride not found                       |
| FORBIDDEN / DRIVER_MISMATCH  | 403  | Not allowed for this ride            |
| ALREADY_ACCEPTED            | 200  | Idempotent success                   |
| ALREADY_CANCELLED           | 409  | Ride already cancelled               |
| ALREADY_REJECTED            | 409  | Ride already rejected                |
| INVALID_STATE               | 409  | Invalid transition                   |
| EXPIRED_OR_CONFLICT         | 409  | Race / expired                       |
| INTERNAL_ERROR              | 500  | Server error                         |
