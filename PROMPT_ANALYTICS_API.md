# Driver App Analytics – API Prompt & Validation

Allowed events and validation rules for **POST /api/driver-app-analytics** (collection: `driver_app_analytics`).

---

## 1. Allowed event list

- `duty_on`
- `duty_off`
- `online_session_summary`
- `tracking_health`

---

## 2. Driver online / idle / direction (requirement block)

### duty_on

- **Required in params:** `onlineAs` (0 = public, 1 = private).
- **Optional in params:** `heading` (0–360°), `lat`, `lng` (direction and position when going online).

### duty_off

- **Required in params:** `onlineDurationSeconds`, `idleDurationSeconds`, `onlineAs`, `onlineStartedAt` (ISO 8601).
- **Optional in params:** `heading`, `lat`, `lng` (last direction and position when going offline).

### online_session_summary

- **Required in params:** `onlineDurationSeconds`, `idleDurationSeconds`, `onlineAs`, `onlineStartedAt` (ISO 8601).
- **Optional in params:** `busyDurationSeconds`, `heading`, `lat`, `lng`.

### tracking_health

- **Optional in params:** `heading`, `lat`, `lng`, `speed`.

---

## 3. Validation

- Request must include non-empty `events` array and top-level `deviceId`, `sessionId`, `appId`, `source`.
- Each event must have `eventName`, `eventId`, and standard fields (e.g. `appId`, `source`, `eventCategory`).
- Driver-specific properties (`onlineAs`, `heading`, `lat`, `lng`, `onlineDurationSeconds`, `idleDurationSeconds`, `onlineStartedAt`, `busyDurationSeconds`, `speed`) are validated when present; `onlineStartedAt` is stored as ISO 8601 / Date.

---

## 4. Quick reference

| What            | Event(s)                    | Properties |
|-----------------|-----------------------------|------------|
| Online duration | duty_off, online_session_summary | onlineDurationSeconds |
| Idle duration   | duty_off, online_session_summary | idleDurationSeconds |
| Busy duration   | online_session_summary      | busyDurationSeconds (optional) |
| Direction       | duty_on, duty_off, online_session_summary, tracking_health | heading (0–360°) |
| Position        | Same events                 | lat, lng |
| Online start    | duty_off, online_session_summary | onlineStartedAt (ISO 8601) |
| Online mode     | duty_on, duty_off, online_session_summary | onlineAs (0 public, 1 private) |

---

**API:** POST `/api/driver-app-analytics`  
**Collection:** `driver_app_analytics`
