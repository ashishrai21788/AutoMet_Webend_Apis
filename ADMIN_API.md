# Admin API (`/api/admin`)

Backend for the AutoMet Admin dashboard (`../AutoMet_Admin`). Separate from the rider and driver APIs: its own accounts, its own tokens.

## Concepts
- **Tenant (client):** one white-label app. Collection `tenants`.
- **Admin user:** collection `admin_users`. Roles: `super_admin` (platform, `tenantId: null`), `client_admin`, `operations`, `support`, `finance` (all bound to one tenant). Permissions per role are in `lib/adminPermissions.js` (mirrored in the dashboard).
- **Isolation:** `lib/tenantScope.js` `resolveTenantScope` is the one rule. The client always comes from the verified account. A client user who asks for another `tenantId` gets 403; the super admin may pass any `tenantId` or none (all clients).
- **Tokens:** signed with a key derived from `JWT_SECRET` (HMAC with a fixed label), payload `typ: "admin"`. A rider or driver token is rejected here and an admin token is rejected by the rider/driver APIs. Default lifetime 12 h (`ADMIN_TOKEN_TTL`). Each token carries the user's `tokenVersion`; deactivating a user, suspending a client, or changing a password bumps it and ends existing sessions immediately.
- **Passwords:** bcrypt (cost 12), min 10 characters. 5 failed sign-ins lock the account for 15 minutes. Unknown email and wrong password return the same message and take similar time.
- **Temporary passwords** (new client admin, new team member) are returned once in the creation response and flagged `mustChangePassword`.

## Endpoints
Responses: `{ success, message, data }`.

| Method and path | Permission | Notes |
|---|---|---|
| `POST /auth/login` | none | `{email, password}` → `{token, user}` |
| `GET /auth/me` | signed in | |
| `POST /auth/change-password` | signed in | `{currentPassword, newPassword}` → new `{token, user}`; ends other sessions |
| `GET /tenants` | signed in | super admin: all; others: own |
| `POST /tenants` | `clients.manage` | `{name, appName, packageName, city, plan, adminName, adminEmail}` → tenant + `initialAdmin {email, temporaryPassword}` (201) |
| `PATCH /tenants/:id/status` | `clients.manage` | `{status: active|trial|suspended}`; suspending ends the client's sessions; the default client cannot be suspended |
| `GET /users?tenantId=` | `team.manage` | scoped |
| `POST /users` | `team.manage` | `{name, email, role, tenantId?}` → user + `temporaryPassword` (201); `tenantId` honoured only for the super admin; `super_admin` cannot be created here |
| `PATCH /users/:id/active` | `team.manage` | `{active: boolean}`; not yourself; other clients' users 403 |
| `GET /dashboard?tenantId=` | `dashboard.view` | `ridesToday`, `activeDrivers`, `ongoingTrips`, `revenueToday` (completed trips today, IST), `acceptanceRate`, `cancellationRate` (last 7 days) |
| `GET /audit?tenantId=&limit=` | `audit.view` | newest first, max 200 |

## Business configuration (onboarding)
Every route below acts on **one business**, named by the `X-App-Id` header (the business's appId). `resolveTenantScope` checks it against the signed-in account: a business user can only use their own appId (another one is 403, no header means their own); the super admin must send one. Data access goes through `lib/tenantData.js` `forTenant(appId)`, which adds `tenantId` to every query and create, so a client-supplied `tenantId` in a body or filter is overwritten, and every unique index includes `tenantId`.

Reads need `dashboard.view`; regions, categories, settings and setup need `settings.manage`; fare rules and cancellation policies need `pricing.manage`. Validation failures return 400 with `errors` keyed by field.

| Method and path | Notes |
|---|---|
| `GET /business`, `GET /business/overview` | business, setup status (steps, next step, warnings) and counts, computed from the real data |
| `PUT /business/settings` | name, appName, brandColor, supportEmail, supportPhone. The appId and package name cannot be changed |
| `PUT /business/market` | `{country, currency, timezone}`. Country locked once regions or pricing exist; currency locked once pricing exists |
| `POST /business/setup/complete` | only when steps 1-3 are done |
| `GET/POST /business/regions`, `PATCH /business/regions/:id` | POST `{state, cities[], zoneName?, radiusKm?}` adds several at once and skips duplicates (a city may be `{name, lat, lng}` to give its centre); PATCH edits the zone, `active`, or the area (`center` + `radiusKm`, or `center: null` to clear); no delete |
| `POST /business/regions/locate` | `{lat, lng}` -> which region serves that point |
| `GET/POST /business/categories`, `PATCH /business/categories/:id` | duplicate names (case-insensitive) are 409; at least one region; deactivate with `active:false` |
| `GET/PUT /business/fare-rules`, `DELETE /business/fare-rules/:id` | PUT upserts one rule per category and region (`regionId: null` = default for the category) |
| `POST /business/fare-preview` | `{rule, trip}` returns the fare breakdown; same formula as documented in `lib/fareRules.js` |
| `GET/PUT /business/cancellation-policies`, `DELETE ...` | rider fees and driver penalty kept separate from the booking fee |

New collections: `service_regions`, `vehicle_categories`, `fare_rules`, `cancellation_policies`, `business_setup_progress`. The business's appId is `tenants.tenantId` (generated as `app_` + 10 characters, immutable in the schema).

**Not connected yet:** the live rider fare (`lib/fare.js`, `FARE_CONFIG`) does not read these rules, and trips/drivers are not yet tagged per business by the apps.

## Rider and driver apps: businesses, regions and pricing

**Which business a request belongs to.** Each business's app sends its App ID in the `X-App-Id` header. A request without the header belongs to the default business, so the apps that exist today keep working unchanged (`lib/appTenant.js`, mounted on `/api` after the admin routes). An unknown App ID is 400; a suspended business is 403 (its apps stop, other businesses are unaffected). If the default business cannot be looked up (database trouble), the request carries on with no business rather than being blocked.

**Tagging.** Riders (`users.tenantId`), drivers (`drivers.tenantId`) and trips (`trip_details.tenant_id`) are tagged with the business at creation. Untagged records are the default business. A trip can only be requested between a rider and a driver of the same business (403 otherwise).

**Service areas.** A region may have a centre point and radius (`center {lat,lng}`, `radiusKm`, 0.5 to 200 km). The Regions screen fills the centre from the city list and defaults the radius to 15 km; edit either on the region. `POST /business/regions/locate {lat,lng}` shows which region serves a point. A point belongs to the active regions whose circle contains it; where circles overlap the smallest radius wins (an airport zone inside a city), then the nearest centre (`lib/regionMatch.js`).

**Pricing a trip** (`lib/tripPricing.js`, used by `POST /api/v1/trips/estimate` and trip creation):
1. A business with no active fare rule keeps the legacy tariff (`lib/fare.js`, `FARE_CONFIG`): nothing changes for it. The default business is in this state until it configures pricing.
2. Otherwise, if any active region has an area, the pickup must be inside one (422 `OUTSIDE_SERVICE_AREA`). The driver's vehicle type (or the request's `category_id`) must match an active category by name, ignoring case and punctuation (422 `CATEGORY_NOT_OFFERED`), offered in that region (422 `CATEGORY_UNAVAILABLE_IN_REGION`), and a fare rule must exist for it: the region's own, else the category default (422 `PRICING_NOT_CONFIGURED`).
3. The fare is the rule's calculation (`lib/fareRules.js`) over the estimated distance and time (straight line x road factor, as before), in the business currency. Surge is not applied.

The response keeps its existing fields and adds `fare_source` (`BUSINESS_RULES` or `LEGACY_TARIFF`), `region_id`, `category_id` and, for business rules, `breakdown`. Trips store `fare_source`, `fare_breakdown`, `region_id`, `category_id`.

**Limits.**
- The Android apps do not send `X-App-Id` yet, so every rider and driver is the default business until the white-label flavors add it.
- A driver is matched to a category by comparing its `vehicleType` text with category names. A proper driver-to-category link comes with driver and vehicle management.
- Phone numbers and emails are unique across all businesses today (existing behaviour), so the same person cannot register in two businesses.
- Sign-in does not check that an account's business matches the app's `X-App-Id`; ride requests do.
- Distance and time are still an estimate (no road routing).

## Drivers, vehicles, documents and verification

All routes are under `/api/admin/business` and use the business named by `X-App-Id` (checked against the signed-in account). Nothing is ever deleted: deactivating keeps every record and its history.

**Data.** Drivers stay in the existing `drivers` collection (new fields: `accountStatus`, `driverVerificationStatus`, `verificationExpiresAt`, `operatingRegionId`, `eligibleCategoryId`, `dateOfBirth`, `address`, `createdByAdmin`; all protected from the driver app's profile-update endpoint). New collections: `vehicles`, `driver_documents`, `vehicle_documents`, `driver_vehicle_assignments`, `entity_history` (timelines; audit entries also go to `admin_audit_logs`). Every record carries `tenantId` and every unique index includes it. Drivers that predate business tagging belong to the default business (`forTenantWithUntagged`).

**Three separate things.** Account status (`ACTIVE`/`INACTIVE`/`SUSPENDED`), verification status (`INCOMPLETE`/`PENDING_REVIEW`/`APPROVED`/`REJECTED`/`EXPIRED`) and operational eligibility (never stored: `lib/eligibility.js`, pure, for the future dispatch service to reuse). A driver is eligible only with an active account, approved and unexpired verification, an active operating region, and an active assignment to a vehicle that is ACTIVE, approved, of the driver's category and in the driver's region. Creating an account or assigning a vehicle never makes a driver eligible on its own.

**Verification** (`lib/verification.js`) is computed from the mandatory documents: any rejected -> REJECTED; any approved one past its expiry -> EXPIRED; any missing -> INCOMPLETE; any awaiting review -> PENDING_REVIEW; else APPROVED. Required documents per business default to driving licence + identity (driver) and registration certificate + insurance (vehicle); `PUT /requirements` can make optional ones mandatory, but the licence and the registration certificate are always mandatory. Approved means a reviewer accepted the document, not that it is authentic. Stored status is used by lists; detail screens recompute live; an APPROVED record past its earliest expiry reads as EXPIRED everywhere.

| Method and path | Permission | Notes |
|---|---|---|
| `GET /drivers` | `drivers.view` | server-side `page`, `pageSize` (max 100), `search` (every word must match name, phone, id or email), `regionId`, `categoryId`, `verification`, `account`, `sort=oldest` |
| `POST /drivers` | `drivers.manage` | `{fullName, phone (+E.164), email?, dateOfBirth?, address?, operatingRegionId, eligibleCategoryId}`; region and category must be this business's, active and offered together; duplicate phone/email are 409 without revealing whose |
| `GET/PATCH /drivers/:id` | `drivers.view` / `drivers.manage` | detail includes eligibility and reasons; `accountStatus` cannot be set here |
| `POST /drivers/:id/status` | `drivers.manage` | `{status, reason}`; a suspension needs a reason (>= 5 characters) |
| `GET /drivers/:id/history` | `drivers.view` | timeline with actor and reason |
| `GET /drivers/:id/documents` | `drivers.view` | requirements with the submitted document; roles without `documents.view` get the number masked and no file details |
| `POST /drivers/:id/documents` | `drivers.manage` | multipart: `type`, `number?`, `expiryDate?`, `file`. A resubmission replaces the file and returns to review; the old file is kept in `previousFiles` |
| `GET /driver-documents/:docId/url` | `documents.view` | a signed link valid for 5 minutes; every view is audited (the link itself is not logged) |
| `POST /driver-documents/:docId/review` | `verification.review` | `{decision: APPROVE|REJECT, reason}`; a rejection needs a reason; an approved document can be revoked; a rejected one must be resubmitted |
| `POST /drivers/:id/assign-vehicle`, `/unassign-vehicle` | `drivers.manage` + `vehicles.manage` | `{vehicleId, reassign?}`; refused for suspended drivers/vehicles, category or region mismatch, or an existing assignment unless `reassign` |
| `GET/POST /vehicles`, `GET/PATCH /vehicles/:id`, `POST /vehicles/:id/status`, `GET /vehicles/:id/history` | `vehicles.view` / `vehicles.manage` | list filters: `search` (plate, make, model), `categoryId`, `regionId`, `status`, `verification`, `assignment=assigned|unassigned`. Registration is normalised (spaces and dashes ignored) and unique per business. A vehicle with an expired mandatory document cannot be set ACTIVE. Category/region edits that would break the assigned driver are 409 |
| `GET/POST /vehicles/:id/documents`, `GET /vehicle-documents/:docId/url`, `POST /vehicle-documents/:docId/review` | as for drivers | same rules |
| `POST /vehicles/:id/assign-driver`, `/unassign-driver` | `vehicles.manage` + `drivers.manage` | same checks as above |
| `GET/PUT /requirements` | `dashboard.view` / `settings.manage` | `{driver: {TYPE: bool}, vehicle: {...}}` |

**Roles.** `documents.view` and `verification.review`: super admin, business admin, operations. Support can see drivers and vehicles (numbers masked) but not open documents, review, or change anything. Finance has no access to the fleet.

**Files.** `lib/privateStorage.js`: files are never public. In production they go to Cloudinary as `authenticated` assets (needs the `CLOUDINARY_*` variables) and are opened only through a 5-minute signed URL; without storage, uploads are refused with 503. The file's own bytes decide its type (JPEG, PNG, WebP, PDF only, 5 MB at most; the name and declared type are ignored). Only a private storage key is stored with a document, never a link.

**Limits.**
- Driver and vehicle details entered in the driver app before this (the vehicle fields on the driver record, the image arrays and the app's own `verification_status`) are untouched and shown for information only; they do not feed the dashboard's verification or eligibility.
- A driver created without an email gets a unique placeholder address (the driver record requires one); it is never shown.
- Changing a business's document requirements updates lists the next time a record's documents change; detail screens always use the current requirements.
- Expiry is evaluated when records are read; there is no background job or notification yet for documents about to expire.
- No Cloudinary upload or signed-link call has been exercised from this code against the real service yet (tests use an in-memory storage with the same signed-link behaviour).
- Eligibility is computed and shown but not yet used by ride requests (that is the dispatch phase).

## Driver availability and ride settings

Who may go online and receive rides (`lib/driverAvailability.js`):
1. **Always:** the account must be `ACTIVE`. A suspended or inactive driver is refused when going online (`403`, error `DRIVER_ACCOUNT_NOT_ACTIVE`) and when a rider requests them (`409`), and suspending or deactivating a driver sets `isOnline: false` in the same update.
2. **Per business, off by default:** `rideSettings.requireEligibleDrivers`. When on, a driver must also be fully eligible (verified and unexpired, active region, an approved active vehicle of the right category and region). A refusal is `403` with error `DRIVER_NOT_ELIGIBLE`, a plain-language `message` ("You cannot go online yet: ...") and `data.reasons`. It is off by default so existing drivers, who were never verified, keep working until a business has onboarded its fleet.

Enforced in `PUT /api/drivers/online-status` (going online only; going offline is always allowed), `POST /api/v1/trips/create-request`, and the legacy `POST /api/v1/rides/request` (which also now has the same-business check). An app that sends `X-App-Id` can only take that business's drivers online (`403`, `WRONG_APP`).

| Method and path | Permission | Notes |
|---|---|---|
| `GET /business/ride-settings` | `dashboard.view` | `{requireEligibleDrivers}` |
| `PUT /business/ride-settings` | `settings.manage` | `{requireEligibleDrivers: boolean}`; audited |
| `GET /business/availability` | `drivers.view` | counts of drivers, eligible, online (as reported by the driver app), online and eligible, and why active drivers would be blocked; reads up to 10,000 drivers and says if partial |

## Local development without MongoDB
`npm run dev:fake` runs these routes on an in-memory stand-in for the database (`scripts/devServer.js`, port 3000, nothing saved, refuses to run in production). It seeds one demo super admin; the credentials are printed when it starts.

## Setup
1. Deploy. On the first start after the database connects, the server creates the **default client** (owns all existing records, which have no tenant tag) and, if set, the first super admin.
2. Set `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` (10+ characters) in the environment once. If no super admin exists, one is created with `mustChangePassword`. The password is never logged. Remove both variables after the first sign-in.
3. Optional: `DEFAULT_TENANT_NAME`, `DEFAULT_TENANT_SLUG`, `ADMIN_TOKEN_TTL`.
4. CORS is currently open (`*`) for the whole API; the admin API uses bearer tokens, not cookies, so this is not a cookie-CSRF risk, but restrict it to known origins before launch.

## Multi-client data
`trip_details.tenant_id` and `drivers.tenantId` were added (default `null` = default client). Dashboard counts filter by them. The rider/driver apps do not set them yet; that arrives with white-label (each client's app identifies its tenant). Until then everything belongs to the default client and other clients' dashboards show zeros.

## Tests
`npm test` runs the fare tests plus `test/admin.test.js` (permissions, scope, middleware, rates), `test/business.test.js` (fare formula, validation, setup status, `forTenant`), and `test/admin.api.test.js` / `test/business.api.test.js` (the real routes and controllers over HTTP, including cross-business attacks, with in-memory stand-ins for the database models from `test/helpers/fakeDb.js`). **No test has run against a real MongoDB yet**; the fake does not reproduce Mongoose defaults or validation.

## Security baseline

- **Rate limits** (per server instance, in memory; `lib/rateLimit.js`). Over the limit: `429`, `error: "RATE_LIMITED"`, and a `Retry-After` header in seconds.
  - Asking for a code (`/api/users/register`, `/login`, `/resend-otp`; `/api/otp/send`, `/generate`, `/resend`; `/api/drivers/login`): 5 per person and 30 per address per 10 minutes.
  - Checking a code (`/api/users/verify-otp`, `/api/otp/verify`): 8 per person and 60 per address per 10 minutes. "Person" is the `driverId`, `userId`, phone or email in the body, normalised.
  - Admin sign-in (`/api/admin/auth/login`): 10 per email and 30 per address per 15 minutes, on top of the account lockout.
  - With more than one server instance the counters need a shared store.
- **CORS**: browsers are limited to `https://auto-met-admin.vercel.app` and local development (`http://localhost:5173`). Add more with `CORS_ALLOWED_ORIGINS` (comma separated). The mobile apps send no `Origin` header and are unaffected.
- **`ssl/key.pem` and `cert.pem`** are no longer tracked and `ssl/` and `*.pem` are ignored. They stay in git history: treat them as exposed.

## Operations endpoints (read only)

All use the business named by `X-App-Id` and the signed-in account, like the other `/api/admin/business/*` routes. Lists are paged with `page` and `pageSize` (default 20, at most 100) and return `{ items, total, page, pageSize }`.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /api/admin/business/audit` | `audit.view` | Filters: `q` (who, action or target), `action` (prefix, such as `driver.`), `targetType`, `actor` (email), `from`, `to`. Newest first. `details` never contains passwords, tokens, links or document numbers. Also returns `facets` for the filter lists. |
| `GET /api/admin/business/alerts` | `dashboard.view` | Worked out from live records: no active region, regions without a centre and radius, categories without a price or without an active region, expired and expiring (30 days) driver and vehicle documents, documents awaiting review (warning after 48 h), suspended drivers, verified drivers without a vehicle. Each alert has `severity` (`critical`, `warning`, `info`), up to 10 `items`, `more`, and a dashboard `link`. Dispatch and payment failures are not reported because they are not recorded. |
| `GET /api/admin/business/stats` | `dashboard.view` | Drivers (total, online, eligible), trips (active, searching, today, 7-day series, acceptance and cancellation rate), fares completed today, riders. "Today" is the business's own calendar day (its market time zone). `notAvailable` lists what is not recorded (payments, ratings, driver last-seen). |
| `GET /api/admin/business/riders` | `riders.view` | `q` searches name, phone, email and ID. Includes trip counts. No credentials or tokens are returned. |
| `GET /api/admin/business/riders/:id` | `riders.view` | The rider with their 20 most recent trips. `404` for a rider of another business. |
| `GET /api/admin/business/trips` | `trips.view` | Filters: `statusGroup` (`searching`, `active`, `completed`, `cancelled`, `unanswered`), `status`, `riderId`, `driverId`, `regionId`, `categoryId`, `q` (trip ID), `from`, `to`. |
| `GET /api/admin/business/trips/:id` | `trips.view` | Route, fare breakdown and its source, cancellation details, timeline and system events. `payment` and `rating` say they are not available yet. `404` for another business's trip. |
| `GET /api/admin/platform/overview` | `clients.manage` (super admin) | One row per business with driver, rider, trip and admin counts and setup progress, platform totals, and integration status (configured yes/no only, never values). Counts only; no personal data. |

## Public business config (rider and driver apps)

`GET /api/v1/public/business/config` needs no sign-in. The business is the one named in `X-App-Id`; with no header the default business is returned and `resolvedBy` is `"default"`. An unknown App ID gets `400 Unknown app`, a suspended business `403`. The response holds the business name, app name, brand colour, logo link, support contacts, market (country, currency, time zone), active regions (centre and radius), active vehicle categories (`bookable` is false until a price is set and a region is active), `serviceAvailable`, one public ride setting, and a `version`. It is sent with an `ETag` and `Cache-Control: max-age=60`; a matching `If-None-Match` returns `304`. No fare amounts, requirements, package name or internal tags are included. Limited to 120 requests per address per 10 minutes.

## Local demo data

`DEMO_DATA=1 npm run dev:fake` also loads a demo business with sample drivers, riders, trips, documents and audit events (`scripts/devSeed.js`; local test sign-in printed in the console).

## Driver location heartbeat (driver app)

`POST /api/drivers/location` (driver sign-in; `X-App-Id` like every driver request). Body: `lat`, `lng` (required), `accuracy` (metres), `heading` (degrees), `speedMps`. The server keeps the last position (GeoJSON, 2dsphere index) with its own receive time, and works out the service region. Response: `serverTime`, `nextHeartbeatSeconds` (10), `freshSeconds` (60), `isOnline`, `region`, `inServiceArea` (`null` when the business has drawn no service area) and `available`.

- `400` invalid coordinates (including exactly 0,0, which is a phone with no GPS fix yet); `422 LOCATION_TOO_INACCURATE` for an accuracy worse than 1000 m (keep sending, nothing is stored); `403 WRONG_APP` for another business's driver; `403 DRIVER_ACCOUNT_NOT_ACTIVE` with `shouldGoOffline: true` for a suspended or inactive driver (they are taken offline and no position is stored). Limit: 60 per driver per minute.
- **Presence** (`LIVE`, `STALE`, `NO_SIGNAL`, `OFFLINE`): an online driver is `LIVE` while a position is at most `DRIVER_LOCATION_FRESH_SECONDS` (60) old, `STALE` after that, and `NO_SIGNAL` when the app has never sent one (apps from before heartbeats).
- **Sweeper:** every 30 seconds, a driver who has sent heartbeats before and has been silent for more than `DRIVER_STALE_OFFLINE_SECONDS` (180) is taken offline, with a `PRESENCE` entry on the driver's timeline. `NO_SIGNAL` drivers are never forced offline, so older apps keep working. Turn it off with `DRIVER_STALE_SWEEP=off`. Other settings: `DRIVER_HEARTBEAT_SECONDS`, `DRIVER_MAX_ACCURACY_METERS`.
- **Indexes:** the driver model declares a 2dsphere index on `lastLocation` and one on `isOnline, locationUpdatedAt`. Mongoose creates them when the server starts (auto-index is not disabled).

`GET /api/admin/business/live-map` (`dashboard.view`): online drivers that have a position (`presence`, `ageSeconds`, `eligible` and reasons, vehicle, `currentTripId`), active trips (searching and in progress), the business's drawn service areas, `counts` (live, stale, noSignal, eligibleLive, online, activeTrips, searching) and the freshness settings. Drivers with no position are only counted. The driver list and detail now include `online`, `presence`, `lastSeenAt`, `lastLocationAt`, `position` and `currentTripId`; statistics add `onlineLive`, `onlineStale`, `onlineNoSignal`.
