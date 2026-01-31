# Driver App Analytics – API Reference

Session & engagement events for **POST /api/driver-app-analytics** (collection: `driver_app_analytics`).

---

## Session & engagement (driver app)

| Event / row              | Properties / payload |
|--------------------------|----------------------|
| **Duty ON**             | onlineAs (required). Optional: heading, lat, lng. |
| **Duty OFF**            | onlineDurationSeconds, idleDurationSeconds, onlineAs, onlineStartedAt. Optional: heading, lat, lng. |
| **Online session summary** | onlineDurationSeconds, idleDurationSeconds, optional busyDurationSeconds; onlineAs, onlineStartedAt; optional heading, lat, lng. |
| **Tracking health**    | Optional: heading, lat, lng, speed. |

---

## Summary table (admin / reporting)

| Metric           | Description                    | Properties / events |
|------------------|--------------------------------|----------------------|
| Online duration  | Total time driver was online   | onlineDurationSeconds (duty_off, online_session_summary) |
| Idle duration    | Time online with no ride       | idleDurationSeconds (duty_off, online_session_summary)   |
| Direction        | Heading 0–360°                 | heading (duty_on, duty_off, online_session_summary, tracking_health) |
| Position         | Latitude, longitude            | lat, lng (same events) |
| Online start     | When session started           | onlineStartedAt (duty_off, online_session_summary)       |
| Online mode      | Public (0) or private (1)       | onlineAs (duty_on, duty_off, online_session_summary)     |

---

## Request shape

- **Endpoint:** POST `/api/driver-app-analytics`
- **Body:** `events` array + top-level `deviceId`, `sessionId`, `appId`, `source` (and optional `appVersion`, `platform`).
- **Event shape:** Each item has `eventName`, `eventCategory`, and `params` (object). Driver-specific fields (onlineAs, heading, lat, lng, onlineDurationSeconds, idleDurationSeconds, onlineStartedAt, busyDurationSeconds, speed) go inside `params`.

---

**See also:** ANALYTICS_DATA_MODEL.md (field details), PROMPT_ANALYTICS_API.md (validation & quick reference).
