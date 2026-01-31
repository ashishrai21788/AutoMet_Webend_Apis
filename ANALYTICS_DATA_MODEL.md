# Driver App Analytics – Data Model

Reference for driver app analytics events saved via **POST /api/driver-app-analytics** (MongoDB collection: `driver_app_analytics`).

---

## 1. duty_on

Driver goes online.

| Property   | Type   | Description                                      |
|-----------|--------|--------------------------------------------------|
| onlineAs  | Number | 0 = public, 1 = private                          |
| heading   | Number | 0–360° (direction when going online)             |
| lat       | Number | Latitude (position when going online)            |
| lng       | Number | Longitude (position when going online)           |

---

## 2. duty_off

Driver goes offline.

| Property              | Type   | Description                                      |
|-----------------------|--------|--------------------------------------------------|
| onlineDurationSeconds | Number | Total time online (seconds)                      |
| idleDurationSeconds   | Number | Time online with no ride / waiting (seconds)     |
| onlineAs              | Number | 0 = public, 1 = private                          |
| onlineStartedAt       | String | ISO 8601 (when online session started)          |
| heading               | Number | 0–360° (last direction when going offline)     |
| lat                   | Number | Last latitude when going offline                |
| lng                   | Number | Last longitude when going offline               |

---

## 3. online_session_summary

Sent periodically while driver is online (e.g. every 5–15 min) or when going off.

| Property              | Type   | Description                                      |
|-----------------------|--------|--------------------------------------------------|
| onlineDurationSeconds | Number | Total time online (seconds)                      |
| idleDurationSeconds   | Number | Time online with no ride (seconds)               |
| busyDurationSeconds   | Number | Optional. Time on ride (seconds)                 |
| onlineAs              | Number | 0 = public, 1 = private                          |
| onlineStartedAt       | String | ISO 8601 (when online session started)          |
| heading               | Number | Optional. 0–360°                                 |
| lat                   | Number | Optional. Latitude                              |
| lng                   | Number | Optional. Longitude                              |

---

## 4. tracking_health

Current direction and location (optional).

| Property | Type   | Description        |
|----------|--------|--------------------|
| heading  | Number | Optional. 0–360°   |
| lat      | Number | Optional. Latitude |
| lng      | Number | Optional. Longitude|
| speed    | Number | Optional. Speed    |

---

## 5. Summary table (for admin)

| Metric           | Source events              | Properties / notes                    |
|------------------|----------------------------|--------------------------------------|
| Online duration  | duty_off, online_session_summary | onlineDurationSeconds           |
| Idle duration    | duty_off, online_session_summary | idleDurationSeconds             |
| Direction        | duty_on, duty_off, online_session_summary, tracking_health | heading (0–360°)        |
| Position         | Same events                | lat, lng                             |
| Online start     | duty_off, online_session_summary | onlineStartedAt (ISO 8601)       |
| Online mode      | duty_on, duty_off, online_session_summary | onlineAs (0 public, 1 private) |

---

## 6. Examples

### duty_on

```json
{
  "eventName": "duty_on",
  "params": {
    "onlineAs": 0,
    "heading": 45,
    "lat": 28.6139,
    "lng": 77.209
  }
}
```

### duty_off (with duration, idle, direction, position)

```json
{
  "eventName": "duty_off",
  "params": {
    "onlineDurationSeconds": 3600,
    "idleDurationSeconds": 1800,
    "onlineAs": 0,
    "onlineStartedAt": "2025-01-31T10:00:00.000Z",
    "heading": 90,
    "lat": 28.614,
    "lng": 77.210
  }
}
```

### online_session_summary

```json
{
  "eventName": "online_session_summary",
  "params": {
    "onlineDurationSeconds": 900,
    "idleDurationSeconds": 600,
    "busyDurationSeconds": 300,
    "onlineAs": 0,
    "onlineStartedAt": "2025-01-31T10:00:00.000Z",
    "heading": 180,
    "lat": 28.6145,
    "lng": 77.2105
  }
}
```

### tracking_health

```json
{
  "eventName": "tracking_health",
  "params": {
    "heading": 270,
    "lat": 28.615,
    "lng": 77.211,
    "speed": 25
  }
}
```

---

**API:** POST `/api/driver-app-analytics`  
**Collection:** `driver_app_analytics`
