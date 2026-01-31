# User App Analytics – Event Reference

Reference for event names, params, and categories used when sending analytics to **POST /api/user-app-analytics** (MongoDB collection: `user_app_analytics`).

---

## 1. Platform

| Event name       | Description                         | Typical params              |
|------------------|-------------------------------------|-----------------------------|
| `app_open`       | App opened (cold/background)        | `entry` (e.g. cold)        |
| `screen_view`    | Screen or tab viewed                | `screen_name`, `previous_screen`, `source` |
| `app_background` | App sent to background              | (optional)                  |

---

## 2. Auth / Login / Signup

| Event name              | Description                | Typical params              |
|-------------------------|----------------------------|-----------------------------|
| `login_screen_view`      | Login screen shown         | —                           |
| `login_method_selected`  | User chose login method    | `method` (e.g. phone)       |
| `login_otp_requested`    | User requested OTP         | `method`                    |
| `login_otp_sent`         | OTP sent by backend        | `method`                    |
| `login_otp_failed`       | OTP send failed            | `reason`                    |
| `login_otp_verified`     | OTP verified successfully  | `method`                    |
| `login_success`          | Login completed            | `method`                    |
| `login_failed`           | Login failed               | `reason`                    |
| `signup_screen_view`     | Signup screen shown        | —                           |
| `signup_started`         | User started signup        | `method`                    |
| `signup_otp_verified`    | Signup OTP verified        | `method`                    |
| `signup_completed`       | Signup completed           | `method`                    |
| `signup_abandoned`       | User left signup flow      | `step`                      |
| `signup_failed`          | Signup failed              | `reason`                    |
| `login_signup_screen_view` | Login/signup choice (onboarding) screen | — |

---

## 3. Landing / Onboarding / Permissions

| Event name             | Description                  | Typical params                    |
|------------------------|------------------------------|-----------------------------------|
| `landing_screen_view`  | Post-login landing shown     | `source` (e.g. post_login)        |
| `permission_requested` | App requested a permission   | `permission`, `context`           |
| `permission_granted`   | User granted permission      | `permission`, `context`           |
| `permission_denied`    | User denied permission       | `permission`, `context`           |
| `onboarding_completed` | Onboarding finished          | —                                 |

---

## 4. Main App (Home / Profile / Notifications)

| Event name                | Description                      | Typical params                    |
|---------------------------|----------------------------------|-----------------------------------|
| `home_screen_view`        | Home tab/screen shown           | `source` (e.g. bottom_nav)        |
| `profile_screen_view`     | Profile tab/screen shown        | `source`                          |
| `notifications_screen_view` | Notifications tab/screen shown | `source`                          |
| `user_details_screen_view` | User/details screen shown      | `source`                          |
| `profile_edit_started`    | User started editing profile    | `field` (optional)                |
| `profile_updated`         | Profile/vehicle details saved    | `field` (e.g. vehicle_details)    |
| `logout_tapped`           | User tapped logout              | —                                 |
| `logout_success`          | Logout completed                | —                                 |

---

## 5. Map / Driver Visibility and Interaction

**Preferred events (no overcounting):** See [MAP_ANALYTICS_DESIGN.md](./MAP_ANALYTICS_DESIGN.md).

| Event name                     | Description                          | Typical params                                              |
|--------------------------------|--------------------------------------|-------------------------------------------------------------|
| `map_screen_opened`           | **Map opened once per session** (do not fire on refresh) | `session_id`, `initial_visible_driver_count`, `initial_visible_driver_ids` (or `driver_ids`) |
| `visible_driver_snapshot`      | **Visible drivers changed** (fire only when set changes) | `session_id`, `visible_driver_count`, `driver_ids`, optional `driver_ids_hash` |
| `map_screen_view`              | Map shown                            | `source`                                                    |
| `map_visible_drivers_count`    | Count of drivers visible on map      | `count`, `zoom_level`, `bounds` (optional)                  |
| `map_drivers_loaded`           | Drivers loaded for current area       | `count`, `lat`, `lng`, `radius_km`, `zoom_level`            |
| `map_drivers_empty`            | No drivers in area                    | `lat`, `lng`, `radius_km`                                   |
| `map_refreshed`                | User refreshed map                    | `drivers_count_after`, etc.                                |
| `map_drivers_load_failed`      | Failed to load drivers                | `reason`, `lat`, `lng`                                      |
| `map_user_location_updated`   | User location updated for map         | `accuracy`, `source`                                        |
| `map_user_location_failed`    | Failed to get user location           | `reason`                                                    |
| `driver_marker_tapped`         | User tapped a driver marker           | `driver_id`, `vehicle_id`, `driver_distance_km`, `driver_rating` (optional) |
| `driver_marker_selected`      | A driver marker selected              | `driver_id`, `source`                                       |
| `driver_marker_deselected`    | Selection cleared                     | `driver_id`                                                 |
| `driver_info_card_viewed`     | Driver info card opened               | `driver_id`, `source`, `card_type`                          |
| `driver_info_card_dismissed`  | Driver info card closed               | `driver_id`, `action_taken` (optional)                      |
| `driver_list_item_tapped`     | User tapped driver in list            | `driver_id`, `list_position`, `driver_distance_km`          |
| `driver_profile_opened_from_map` | Full driver profile opened from map | `driver_id`, `source`                                       |
| `driver_call_tapped`          | User tapped call driver               | `driver_id`, `source`                                       |
| `driver_message_tapped`       | User tapped message driver            | `driver_id`, `source`                                       |
| `driver_book_tapped_from_map` | User tapped book from map/card        | `driver_id`, `vehicle_id`, `source`                         |
| `driver_directions_tapped`    | User asked for directions             | `driver_id`, `destination`                                  |

### Map appearances and active search live (driver analytics)

See **[MAP_ANALYTICS_DESIGN.md](./MAP_ANALYTICS_DESIGN.md)** for the full design (no overcounting).

- **Map appearances:** Counted **only** from `map_screen_opened` — once per map screen session. Do **not** fire on every driver list refresh; fire when the user opens the map (e.g. first load or navigate to map). Backend counts one appearance per driver in `initial_visible_driver_ids` (or `driver_ids`) so refreshes do not inflate the metric.
- **Currently viewing (active search live):** TTL collection is updated when the app sends `visible_driver_snapshot` (or legacy `map_visible_drivers`/`map_viewport`). Send `visible_driver_snapshot` **only when the visible driver set changes** (set difference) so "currently viewing" is not inflated by refresh frequency.

---

## 6. Legal / Settings / Notifications

| Event name             | Description                      | Typical params                                              |
|------------------------|----------------------------------|-------------------------------------------------------------|
| `legal_opened`         | Legal document opened            | `document_type` (e.g. privacy_policy, terms_and_conditions) |
| `document_viewer_opened` | Document/image viewer opened   | `document_type` (e.g. document title)                      |
| `notification_opened` | User opened a notification       | `notification_id`, `notification_type`                     |
| `notification_received` | App received a notification    | `notification_type`, etc. (optional)                        |

---

## 7. Param Keys (`params`)

Use these keys inside the `params` object of each event where applicable:

| Key                 | Description                                                         |
|---------------------|---------------------------------------------------------------------|
| `entry`             | How app was opened (e.g. cold)                                      |
| `method`            | Auth method (e.g. phone)                                            |
| `reason`             | Failure or denial reason                                            |
| `step`              | Funnel step (e.g. signup step)                                      |
| `source`            | Where action came from (e.g. bottom_nav, info_card, marker_tap)      |
| `screen_name`       | Current screen name                                                 |
| `previous_screen`   | Previous screen (for navigation)                                     |
| `success`           | Success flag (optional)                                             |
| `count`             | Numeric count (e.g. drivers)                                        |
| `driver_id`         | Driver identifier                                                   |
| `vehicle_id`        | Vehicle identifier                                                  |
| `driver_distance_km`| Distance to driver (km)                                             |
| `driver_rating`     | Driver rating                                                       |
| `lat`, `lng`        | Latitude, longitude                                                 |
| `radius_km`         | Search/radius (km)                                                  |
| `zoom_level`        | Map zoom level                                                      |
| `document_type`     | Type of document (e.g. privacy_policy, terms_and_conditions)        |
| `permission`        | Permission type (e.g. location, background_location)                 |
| `context`           | Context (e.g. login, background_location)                           |
| `field`             | Profile/detail field (e.g. vehicle_details)                          |
| `card_type`         | Info card type (e.g. compact, full)                                 |
| `action_taken`      | Action taken (e.g. book, call)                                      |

---

## 8. Event Categories (`eventCategory`)

Use for server-side filtering. Send one of these in each event’s `eventCategory`:

| Value       | Use for                                                                 |
|------------|--------------------------------------------------------------------------|
| `platform` | App lifecycle, screen views (e.g. app_open, screen_view, app_background) |
| `user`     | Auth, profile, permissions, main tabs, legal, notifications              |
| `map`      | Map and driver visibility / interaction                                  |

---

## 9. Events Currently Sent by the User App

These are the events the app sends today. The sections above define the full set you can use; this list is for implementation reference.

**Sent today:**  
`app_open`, `screen_view`, `login_screen_view`, `login_otp_sent`, `login_failed`, `permission_granted`, `permission_denied`, `login_signup_screen_view`, `login_otp_verified`, `login_success`, `signup_otp_verified`, `signup_completed`, `signup_failed`, `signup_screen_view`, `signup_started`, `landing_screen_view`, `onboarding_completed`, `home_screen_view`, `map_screen_view`, `driver_marker_tapped`, `profile_screen_view`, `logout_tapped`, `logout_success`, `notifications_screen_view`, `notification_opened`, `user_details_screen_view`, `profile_updated`, `document_viewer_opened`, `legal_opened`, `permission_requested`.

---

## API Usage

- **Endpoint:** `POST /api/user-app-analytics`
- **Collection:** `user_app_analytics`
- **Request body:** See main API docs; include `events` array and top-level `deviceId`, `sessionId`, `appId`, `source` (and optional `appVersion`, `platform`).
- **Event shape:** Each item in `events` should have `eventName`, `eventCategory`, and `params` as above; other fields (e.g. `pageIdentifier`, `actorId`, `clientTimestamp`) follow the existing schema.

Use this document as the single reference for event names, params, and categories when implementing or querying user app analytics.
