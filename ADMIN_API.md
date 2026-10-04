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
| `GET/POST /business/regions`, `PATCH /business/regions/:id` | POST `{state, cities[], zoneName?}` adds several at once and skips duplicates; PATCH edits the zone or sets `active` (no delete) |
| `GET/POST /business/categories`, `PATCH /business/categories/:id` | duplicate names (case-insensitive) are 409; at least one region; deactivate with `active:false` |
| `GET/PUT /business/fare-rules`, `DELETE /business/fare-rules/:id` | PUT upserts one rule per category and region (`regionId: null` = default for the category) |
| `POST /business/fare-preview` | `{rule, trip}` returns the fare breakdown; same formula as documented in `lib/fareRules.js` |
| `GET/PUT /business/cancellation-policies`, `DELETE ...` | rider fees and driver penalty kept separate from the booking fee |

New collections: `service_regions`, `vehicle_categories`, `fare_rules`, `cancellation_policies`, `business_setup_progress`. The business's appId is `tenants.tenantId` (generated as `app_` + 10 characters, immutable in the schema).

**Not connected yet:** the live rider fare (`lib/fare.js`, `FARE_CONFIG`) does not read these rules, and trips/drivers are not yet tagged per business by the apps.

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
