# Map Analytics Design — No Overcounting

This document defines how to track **map screen appearance** and **currently visible drivers** so that frequent data refreshes do not inflate counts.

---

## Goals

1. **Map screen appearance** — Count **once per screen session** when the user opens the map (landing/map screen). Do **not** increment on every driver list refresh, WebSocket push, or timer-based refresh.
2. **Currently visible drivers** — Represent real-time visible drivers; update only when the driver list **actually changes** (set difference). Do **not** duplicate counts when the same drivers remain visible.

---

## Applied Logic (Two Parts)

### 1️⃣ Driver Map Appearance (Historical / Today Count)

- **Event used:** `map_screen_opened`
- **Logic rule:** Driver appearance count increases **only when**:
  - The user opens the map screen, **and**
  - The driver is in the initial visible driver list.
- **Example:** User opens map → visible drivers = D1, D2, D3 → increase D1 +1, D2 +1, D3 +1. If data refreshes → **do not** increase. If user closes map and opens again → count again.
- **Principle:** Appearance = **screen-entry based**, not based on refresh or polling updates.
- **Backend:** Map appearances and today metrics are calculated only from `map_screen_opened` (and optionally `visible_driver_snapshot`). Refreshes do not create these events, so no duplicate appearance counting.

### 2️⃣ Driver Live Appearance (Real-Time Viewers)

- **Source used:** `user_driver_map_views` (collection updated when visibility events are received).
- **Important rule:** A user may send multiple visibility events, but must be counted as **one live viewer per driver**.
- **Stale records:** When counting currently viewing, **do not consider** records where `lastSeen` is older than **30 seconds**. Only sessions that have updated their visibility in the last 30 seconds are counted as "live" viewers.
- **Backend:** Collection has a **unique index on `(driverId, sessionId)`**. Each visibility event upserts one document per (driver, session) and sets `lastSeen`. Multiple events from the same session for the same driver update the same document. Live viewer count = `countDocuments({ driverId, lastSeen: { $gte: now - 30s } })` = number of **distinct sessions** that reported this driver visible in the last 30 seconds → one user = one live viewer per driver; stale records (>30s) are excluded.

**Avoid:**

- Duplicate appearance counting (solved by using only `map_screen_opened` for appearance).
- Multiple live viewer counts from the same user (solved by unique `(driverId, sessionId)` and upsert).

---

## Implementation Rules

### Map Screen Appearance

- **Track using:** Session ID **or** screen lifecycle (e.g. `onResume` / `onStart` **first load only**).
- **Do not track using:** Driver API refresh, WebSocket push, timer-based refresh.

### Visible Driver Updates

- **Update only when:** `new_driver_ids != previous_driver_ids` (set comparison).
- **Use:** Driver ID comparison / set difference check on the client before sending.

---

## Recommended Events

### 1. `map_screen_opened`

Fired **once per map screen session** (when user opens the map, not on every refresh).

| Property | Type | Description |
|----------|------|-------------|
| `session_id` | string | Session ID (or use top-level `sessionId` in request) |
| `timestamp` | ISO 8601 | When the map screen was opened |
| `initial_visible_driver_count` | number | Count of drivers visible when map opened |
| `initial_visible_driver_ids` | string[] | Driver IDs visible at open (used for per-driver “map appearances”) |

**When to fire:** Once when the user opens the map screen (e.g. first `onStart`/`onResume` of map in that session, or when navigating to map from another screen). Do **not** fire on every driver list refresh.

**Backend:** Map appearances for a driver = count of `map_screen_opened` events (in the period) where that driver is in `initial_visible_driver_ids` (or `driver_ids`). One event per session → no overcounting.

---

### 2. `visible_driver_snapshot`

Fired **only when the set of visible drivers changes** (e.g. after set-difference check on the client).

| Property | Type | Description |
|----------|------|-------------|
| `session_id` | string | Session ID |
| `visible_driver_count` | number | Current number of visible drivers |
| `driver_ids` | string[] | Current visible driver IDs |
| `driver_ids_hash` | string | Optional: hash of sorted driver IDs for dedup/validation |
| `timestamp` | ISO 8601 | When the snapshot was taken |

**When to fire:** Only when `new_driver_ids` is different from the previous set (additions, removals, or order change if you care). Do **not** fire on every refresh if the set is unchanged.

**Backend:** Used for:
- **Currently viewing (active search live):** TTL collection is updated when `visible_driver_snapshot` is received (so “currently viewing” only changes when the client sends a new snapshot = set changed).
- **todayTotalViewed:** Count of `visible_driver_snapshot` (and `map_screen_opened`) events where this driver was in the visible set — no duplicate counts per refresh.

---

## Expected Behavior (Summary)

| Case | Action |
|------|--------|
| **User opens map** | Fire `map_screen_opened` once (e.g. `initial_visible_driver_count: 4`, `initial_visible_driver_ids: [id1, id2, id3, id4]`). |
| **Data refresh, same drivers** | Do **not** fire `map_screen_opened` again. Optionally send `visible_driver_snapshot` only if you still want a heartbeat; backend treats snapshot as “set changed” only when you actually send it (client should send only when set changes). |
| **Drivers change (e.g. 4 → 6)** | Fire `visible_driver_snapshot` with `visible_driver_count: 6`, `driver_ids: [ ... ]`. |
| **User leaves and reopens map** | Fire `map_screen_opened` again (new session or new screen open). |

---

## Backend Behavior (This API)

- **Map appearances:** Count of `map_screen_opened` events where the driver is in `initial_visible_driver_ids` or `driver_ids`. One per session → no overcount from refreshes.
- **Currently viewing:** TTL collection updated when we receive `visible_driver_snapshot` (or legacy `map_visible_drivers` / `map_viewport`). Prefer sending `visible_driver_snapshot` only when the visible set changes so “currently viewing” is not inflated by refresh frequency.
- **todayTotalViewed:** Count of `map_screen_opened` + `visible_driver_snapshot` events (in the period) where this driver was in the visible set. Excludes legacy high-frequency events from this metric so it does not overcount.

Legacy events `map_visible_drivers` and `map_viewport` are still accepted and still update the TTL “currently viewing” collection for backward compatibility; for accurate map appearances and non-inflated today metrics, clients should adopt `map_screen_opened` and `visible_driver_snapshot` as above.
