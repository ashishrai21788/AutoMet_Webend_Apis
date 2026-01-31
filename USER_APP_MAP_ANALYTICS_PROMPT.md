# Prompt: Implement Map Analytics on User App (No Overcounting)

**Copy the prompt below and give it to your AI or developer working on the user app.** It is self-contained so they can implement without reading the backend repo.

---

## PROMPT (copy from here)

Implement map analytics on the **user app** so that we do **not** overcount when the driver list refreshes every few seconds. The backend already supports the new events; the user app must send them correctly.

### Goals

1. **Map screen appearance** — Count **once per map screen session** when the user opens the map (e.g. landing/map screen). Do **not** fire on every driver list refresh, WebSocket push, or timer-based refresh.
2. **Currently visible drivers** — Send a snapshot **only when the set of visible driver IDs actually changes**. Do **not** send on every refresh if the same drivers are still visible.

### 1. New event: `map_screen_opened`

- **Fire when:** The user **opens** the map screen — once per “map session” (e.g. first time map is shown in this app session, or when user navigates to the map from another screen). Use **session ID** or screen lifecycle (e.g. `onStart` / `onResume` **only on first load** or when route becomes “map”).
- **Do NOT fire when:** Driver list refreshes, WebSocket update, timer tick, or same map screen already open.
- **Payload to send** (inside your existing analytics `events` array, same API `POST /api/user-app-analytics`):

```json
{
  "eventName": "map_screen_opened",
  "params": {
    "session_id": "<current-session-id>",
    "initial_visible_driver_count": 4,
    "initial_visible_driver_ids": ["driverId1", "driverId2", "driverId3", "driverId4"]
  },
  "clientTimestamp": "<ISO-8601>",
  "eventCategory": "map"
}
```

- **Required:** `initial_visible_driver_ids` must be the list of driver IDs currently visible on the map **at the moment the map screen opened** (so the backend can count “map appearances” per driver). You can use `driver_ids` instead; backend accepts both.
- **Session:** Use the same `sessionId` you already send at request level, or generate one per app session and pass it in `params.session_id` as well.

### 2. New event: `visible_driver_snapshot`

- **Fire when:** **Only when the set of visible driver IDs has changed** (e.g. user panned/zoomed, or list updated and different drivers are now visible). Compare `new_driver_ids` with the **last sent** set; if they are different, send the event.
- **Do NOT fire when:** Every N-second refresh if the visible driver IDs are the same (same 4 drivers, just position/ETA updated).

**Logic (implement this):**

- Keep in memory: `lastSentVisibleDriverIds` (set or sorted list of driver IDs last sent).
- Whenever the driver list is updated (refresh, WebSocket, etc.):
  - Get current visible driver IDs: `currentIds = [ ... ]`.
  - Normalize to a set or sorted list for comparison.
  - If `currentIds` is **different** from `lastSentVisibleDriverIds`:
    - Send `visible_driver_snapshot` with the new list.
    - Set `lastSentVisibleDriverIds = currentIds`.
  - If same, do nothing (do not send).

**Payload to send:**

```json
{
  "eventName": "visible_driver_snapshot",
  "params": {
    "session_id": "<current-session-id>",
    "visible_driver_count": 6,
    "driver_ids": ["id1", "id2", "id3", "id4", "id5", "id6"],
    "timestamp": "<ISO-8601>"
  },
  "clientTimestamp": "<ISO-8601>",
  "eventCategory": "map"
}
```

- Optional: `driver_ids_hash` (e.g. hash of sorted IDs) for debugging; backend does not require it.

### 3. When to fire each event (summary)

| Scenario | Action |
|----------|--------|
| User opens map (first time or navigated to map) | Fire **one** `map_screen_opened` with `initial_visible_driver_ids` = current visible drivers at that moment. |
| Driver list refresh, same drivers still visible | Do **not** fire `map_screen_opened`. Do **not** fire `visible_driver_snapshot`. |
| Driver list refresh, set of drivers changed (e.g. 4 → 6 or different IDs) | Fire `visible_driver_snapshot` with new `driver_ids` and `visible_driver_count`. |
| User leaves map and comes back later | Fire `map_screen_opened` again (new “map open” in that session). |

### 4. API

- Same endpoint as today: `POST /api/user-app-analytics`.
- Same body shape: `{ "events": [ ... ], "deviceId": "...", "sessionId": "...", "appId": "in.automet.user", "source": "user_app", ... }`.
- Add the new events (`map_screen_opened`, `visible_driver_snapshot`) to the `events` array when the rules above apply. You can batch them with other analytics events in the same request.

### 5. Backward compatibility

- You may **stop** sending `map_visible_drivers` / `map_viewport` on every refresh if you want to avoid overcounting; the backend now uses `map_screen_opened` for “map appearances” and `visible_driver_snapshot` for “currently viewing” and today metrics.
- If you keep sending `map_visible_drivers` or `map_viewport`, they still update “currently viewing” (TTL) but **do not** affect “map appearances” or “todayTotalViewed” anymore — so prefer sending only `visible_driver_snapshot` when the set changes.

### 6. Checklist

- [ ] Fire `map_screen_opened` **once** when the user opens the map screen (session or first load), with `initial_visible_driver_ids` (or `driver_ids`) set to current visible drivers.
- [ ] Compare current visible driver IDs with last sent set; fire `visible_driver_snapshot` **only when the set changes**.
- [ ] Do **not** fire `map_screen_opened` on timer/refresh/WebSocket; only on actual “map screen opened” (lifecycle or navigation).
- [ ] Do **not** fire `visible_driver_snapshot` on every refresh when the driver set is unchanged.

Implement the above in the user app (map screen / analytics module) so that backend map appearance and currently-visible metrics are accurate and not inflated by frequent refreshes.

---

## END PROMPT (copy until here)
