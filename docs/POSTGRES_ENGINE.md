# Postgres engine: design, audit and plan

Goal: the backend runs on **MongoDB (as today, unchanged)** or on **PostgreSQL**, chosen by one setting, with identical
requests, responses and behaviour. MongoDB stays the reference until Postgres has passed the same checks.

```
DB_ENGINE=mongo      (default: exactly today's behaviour)
DB_ENGINE=postgres   (needs DATABASE_URL)
```

The setting is read once at start-up (it is per deployment, not per request).

## 1. Audit of what the code uses (2026-10-05, branch `postgres-engine`, tag `pre-postgres`)

Size: ~17,000 lines (controllers 11,070, lib 4,298, models 1,557, routes 599, services 255, scripts 375), 29 collections,
195 route registrations, 31 test files (311 tests, run against an in-memory stand-in for MongoDB).

**Mongoose models (the large majority).** `Schema`, `model`, `Schema.Types.Mixed`, `timestamps`, indexes, 2 virtuals
(`fullName`) with `toJSON/toObject {virtuals:true}`. No hooks, plugins, discriminators, populate, `$lookup`, change streams,
sessions or transactions. Instance API: `save` (46 uses), `toObject` (18), `isNew` (1). Static API: `find`, `findOne`,
`findById`, `findOneAndUpdate`, `findByIdAndUpdate`, `findByIdAndDelete`, `create`, `countDocuments`, `exists`,
`updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `aggregate` (2). Query modifiers: `sort`, `skip`, `limit`,
`select` (including `+field` for `select:false` fields), `lean`, `exec`. Operators seen: `$set`, `$setOnInsert`, `$inc`,
`$push`, `$in`, `$nin`, `$ne`, `$lt/$lte/$gt/$gte`, `$or`, `$and`, `$regex`.

**Raw MongoDB driver access (not models).** `mongoose.connection.db.collection(...)` and `ObjectId` in
`dynamicController` (9 places) and `userController` (4), `driverAnalyticsController` (`user_app_analytics`,
3 aggregation pipelines), `supportController` (`ObjectId.isValid`). Collections reached this way include
`driver_notification` and `users_notification`.

**Connection surface.** `mongoose.connect`, `connection.readyState`, `connection.on(...)`, `connection.close`
(`config/db.js`, `index.js`, health checks, `lib/integrationStatus.js`, two scripts).

**Unaffected by the engine:** Firebase (FCM push, GeoFire driver positions in Realtime Database), Cloudinary, Socket.IO.

## 2. Architecture

* `lib/db/mongoose.js` is the single place the code obtains "mongoose". With `DB_ENGINE=mongo` it exports the real
  `mongoose` module itself, so every call behaves exactly as before. With `DB_ENGINE=postgres` it exports a facade with the
  same surface (`Schema`, `model`, `models`, `connection`, `Types.ObjectId`).
* Model files keep their Mongoose schema definitions (the schemas are the single source of truth). In Postgres mode
  `model(name, schema)` builds a table-backed model from the schema.
* The Postgres model layer implements the subset in section 1 and nothing more:
  * `_id`: 24-character hex text (same format as an ObjectId), `__v` integer; dates as `timestamptz`, serialised to the
    same ISO strings.
  * Filters, sort, skip, limit, projection, `lean`, documents with `save()` and `toObject()`, defaults, required / enum /
    min / max / trim / lowercase checks, `select:false` fields, `timestamps`.
  * Unique violations raise an error with `code === 11000` (the code already checks that), validation failures raise
    `ValidationError` like Mongoose.
  * Free-form values (`Mixed`, arrays, sub-documents, `strict:false` extras) are `jsonb`.
* Raw-collection access goes through a small engine-neutral facade (`find`, `findOne`, `insertOne`, `updateOne`, `deleteOne`,
  `countDocuments`) backed by one `jsonb` table per collection in Postgres mode.
* The 5 aggregation pipelines are ported by hand to SQL (explicit, tested), not interpreted generically.
* Delicate operations (invoice and credit-note numbering, refund limits, billing-job claim) get hand-written SQL with row
  locks or atomic `UPDATE ... WHERE ... RETURNING`, and their own tests.

## 3. Verification

* The 311 existing tests run against both engines (parity). The in-memory MongoDB stand-in stays for the mongo run.
* A contract suite records the normalised responses of the endpoints the apps and the dashboard use and is replayed on
  each engine. Ids, dates and tokens are masked; field names, types and shapes must match exactly.
* Postgres tests run on an in-process Postgres (PGlite), so no external service is needed.

## 4. Phases and gates

0. Safety: tags `pre-postgres`, branch `postgres-engine`, this document. *(done)*
1. Engine switch with `mongo` as default; nothing changes; all tests still pass.
2. Table definitions generated from the schemas, then reviewed by hand (constraints, foreign keys, indexes, money as paise).
3. Postgres model layer + raw-collection facade, tested against real Mongoose behaviour.
4. Run the whole suite on both engines until identical.
5. Hand-tuned finance and counter code; ported aggregations.
6. Contract suite green on both; both Android apps on staging with `DB_ENGINE=postgres`.
7. Row-level security, indexes from real query plans, backups, load test.
8. Cutover by changing the setting; MongoDB kept as fallback; retire later.

## 5. Rules while this is in progress

* `DB_ENGINE=mongo` behaviour must never change. Every step is merged only with the full suite green.
* No feature work on the branch; bug fixes go to `master` first and are merged in.
* Nothing is pushed or deployed from this branch without an explicit decision.

## 6. Contract suite (phase 0, built)

`npm run contract` runs the REAL server (`index.js`) on a REAL temporary MongoDB (mongodb-memory-server) and replays three
scenarios, each on a fresh server and database: `rider` (38 steps), `driver` (66), `ride` (80, including the push messages
the apps would receive). Snapshots live in `test/contract/snapshots/`; `UPDATE_CONTRACT=1` re-records them (Mongo only).

Isolation: the server is started from an empty temp folder with an explicit environment in production mode with strict
auth. `test/contract/preload.js` makes `dotenv` a no-op (parts of the backend read the project `.env` by absolute path) and
replaces `firebase-admin` with a recorder, so no real credential or service can be reached. Verified: with these in place the
snapshots replay identically (4 consecutive full runs).

Also covered: `platform` (91 steps: owner sign-in, businesses, admin users, team, plans, subscriptions, invoices, refunds, settings, audit) and `business` (121 steps: profile, regions, categories, fares, policies, requirements, drivers, vehicles, riders, trips, reports, CSV, support, audit).
Not captured yet: image and document upload/delete (needs a Cloudinary stand-in), the legacy generic collection routes.

## 7. Behaviour found while capturing the contract (pre-existing, NOT changed by the migration)

The Postgres engine must reproduce these exactly; fixing them is a separate decision, best done on `master` first.

1. `POST /api/otp/resend` answers 500 for a driver created from the dashboard: `DriverOTP validation failed: phoneNumber:
   Path phoneNumber is required` (the driver document has `phone`, the OTP model requires `phoneNumber`). Note that the
   Postgres layer therefore has to produce Mongoose-identical validation messages.
2. `GET /api/v1/rides` (the trip list) is unreachable: the generic `/:collectionName/:id` route registered earlier matches
   `v1/rides` and answers 403 "Collection 'v1' is not allowed".
3. `GET /api/users/detail/:userId` needs no sign-in and returns the full user record, including the access token field.
4. `GET /api/users/notifications` (and mark-read / delete) read the `userId` from the query string, not from the session, so a
   signed-in rider can read or change another rider's notifications.
5. A wrong OTP is echoed back in the error response (`data: { userId, otp }`).
6. OTP codes are stored in plain text in `users_otp` / `drivers_otp`.
7. Driver self sign-up is closed (`POST /api/drivers` answers 403); drivers exist only when created from the dashboard.

## 8. Status of the Postgres engine (built so far)

`lib/db/postgres/`: `client.js` (pg pool, or PGlite in-process for tests), `table.js` (tables and indexes from the Mongoose
schemas, including sparse and partial unique indexes), `filter.js` (Mongo filter -> SQL, unsupported operators raise), `model.js`
(Mongoose models over rows), `plain.js` (raw collections), `aggregate.js` (the pipelines the code uses), `rows.js`, `codec.js`.

Design decisions that matter:

* Models are real Mongoose models on a private, never-connected Mongoose instance: defaults, casting, validation messages,
  virtuals and `toJSON` are Mongoose's own. Only storage is replaced.
* `save()` writes only the modified columns, and documents loaded without a `select:false` field (a password hash) are
  hydrated with that projection, so saving them neither validates nor erases the field (as in Mongoose).
* Updates take a row lock (`SELECT ... FOR UPDATE`), apply `$set/$inc/$push/$setOnInsert` in memory and write back in one
  transaction; the filter (for example `status: 'REQUESTED'`) is re-checked after the lock, so transitions are race-safe.
  Concurrent upserts on one key end with one row (the loser retries once).
* Free-form values (Mixed, arrays, sub-documents, undeclared fields) are `json`, not `jsonb`, because jsonb re-orders keys
  and Mongo keeps insertion order (one CSV export showed it). Filters cast to jsonb.
* Dates and ObjectIds inside free-form documents are stored tagged (`{$date}` / `{$oid}`) and revived on read.
* Unique violations surface as `code 11000` with `keyPattern`; Mongo's `__v`, timestamps and `_id` (24-hex text) are kept.

Verification (all green):

* `npm test` 315/315 in Mongo mode; `npm run test:parity` runs 19 model-layer expectations on Postgres AND on real MongoDB
  (the same checks, the same results);
* `npm run contract` (Mongo) and `npm run contract:postgres`: all five scenarios, 396 steps including the push messages,
  match the Mongo snapshots exactly on Postgres.

Not done yet: the 315 unit tests on Postgres (they run on a Mongo stand-in), a real Postgres server (the driver path was
exercised against PGlite over a socket, not against Supabase), upload/legacy-route contract, RLS, query-plan indexes,
paise money columns, backups, load test.

## 9. The unit tests on Postgres

`TEST_DB=postgres npm test` (or `npm run test:postgres`) runs the same 315 tests with the real Mongoose models on the Postgres
engine (PGlite in-process) instead of the hand-written stand-ins in `test/helpers/fakeDb.js`. `test/helpers/pgDb.js` returns the
same object shape; the `db.Model.rows` arrays the tests read are a mirror reloaded after each write, and a test that edits a
mirrored row directly has the edit written to the database before the server's next database operation.

Result: 315/315 on the stand-in and 315/315 on Postgres. Running on a real database showed that some tests had relied on
the stand-in's looseness, and they were corrected so that they pass on both: fixtures that omitted fields the real models
require (the stand-in never validated), assertions that assumed no schema defaults, rows held across an API call, and a settings
test that did not clear the 60-second business cache (`clearAppTenantCache`) that real Mongo also has.

Contract snapshots mask a date-only `createdAt` (the calendar day the data was made).

## 10. Verified on a real Postgres server (Supabase)

Run against a real, empty Supabase project (PostgreSQL 17, direct connection, SSL) on 2026-10-06:

* the 21 model checks: 21/21 (`PARITY_DATABASE_URL=... PARITY_ENGINE=postgres node --test test/pgmodel.test.js`);
* the 22 database-backed unit-test files, one at a time, each starting from empty tables
  (`TEST_DB=postgres TEST_DB_RESET=1 DATABASE_URL=... node --test test/<file>`): 238/238, plus 77 tests that use no database.

`test/helpers/realDbReset.js` resets a real database safely: it drops only tables AutoMet's own models create and refuses (changing
nothing) if the public schema holds any other table. Never point these runs at a database that holds other data.

What a real network showed: (1) schema creation sent one request per statement, which is very slow when every round trip costs
50 to 200 ms, so each table is now created with ONE request (`tx.exec`); (2) one test measured the age of a location against the
real clock and failed because its own set-up took a minute, so it now freezes the clock.

The contract suite also runs on a real server: `CONTRACT_DATABASE_URL=<postgres url> DB_ENGINE=postgres node test/contract/run.js`
(`test/helpers/realDbReset.js` resets only AutoMet's own tables and refuses if it finds any other). On the Supabase test project all
five scenarios, 396 steps, match the Mongo snapshots. A real network exposed answers that depended on database speed, and the
contract was made independent of it: the first scheduled billing run is pushed out in the test preload (`lastRunAt`); the business
scenario sends unrecorded fresh driver positions before the screens that show presence (a driver is "live" only briefly, and the
region name in a position response comes from a one-minute cache); and measured elapsed times (`ageSeconds`, `avgResponseMinutes`,
`avgTripMinutes`) are masked.

## 11. Uploads and the generic collection routes (contract scenarios `uploads` and `legacy`)

`uploads` (70 steps): the business logo (type, size, replace, remove), driver and vehicle documents (submit, replace, signed link,
review, revoke, history, verification status), and the older `/api/images` upload / delete. `legacy` (48 steps): the generic
`/api/:collectionName` routes (create, list, read, update, delete, odd ids and bodies, the closed collections). The test server's
preload (`test/contract/preload.js`) replaces Cloudinary and the two storage layers with in-memory stand-ins that use counter
names, so nothing leaves the machine and a replay gives the same names; the harness sends multipart uploads and masks the
expiry and signature of a signed link.

Result: both match the Mongo snapshots on local Postgres and on the Supabase test project. Total: 7 scenarios, 514 steps.

Findings: (1) an id that is not an id (`/api/driver_faqs/not-an-id`) makes Mongoose raise a CastError (HTTP 500 with a precise
message). The first Postgres version answered 404; every filter now goes through Mongoose's own query casting
(`require('mongoose/lib/cast')`) first, so the error and its message are identical, and `test/pgmodel.test.js` pins it on both
engines. (2) MongoDB builds a unique index in the background right after a collection is first used, so a duplicate sent within
milliseconds can get in on Mongo; Postgres creates its constraint before the table is used (stricter, and the scenario waits
for the Mongo index so the answer is stable). (3) Pre-existing, reproduced exactly: the open generic collections
(`driver_faqs`, `driver_issues`, `drivers_notification`) accept create / update / delete with no sign-in, and every record needs
`name` and `phone`; `/api/Driver_Faqs` is a separate collection from `/api/driver_faqs` (Mongo collection names are case-sensitive).

## 12. Choosing the database (MongoDB or PostgreSQL)

One setting decides it, read once when the server starts:

| | MongoDB (the default) | PostgreSQL |
|---|---|---|
| `DB_ENGINE` | `mongo` (or not set at all) | `postgres` |
| Connection | `MONGODB_USERNAME`, `MONGODB_PASSWORD`, `MONGODB_CLUSTER`, `DB_NAME` | `DATABASE_URL` (a Postgres connection string) |
| Tables / collections | created by MongoDB on first use | created by the server on start-up, or beforehand with `npm run db:setup` |

**To switch:** change `DB_ENGINE` (and make sure the matching connection values are set), then restart the server. On Render that is
Environment, edit the variable, Save; Render redeploys. **To go back:** set `DB_ENGINE=mongo` (or delete the variable) and restart.
Nothing else changes: the API, the apps and the dashboard are the same. The two databases are separate and are NOT kept in sync:
data written while the server runs on one engine is not in the other.

**Local development:** put the values in `.env` (copy `.env.example`). Start with `npm run dev` as usual.

**Setting up a Postgres database:** `npm run db:setup` creates AutoMet's tables and indexes (safe to repeat, leaves existing rows alone).
`npm run db:setup -- --reset` first drops AutoMet's own tables, for a throw-away test database only; it refuses to run if the database holds
any table that AutoMet does not create.

**Supabase notes:** use the connection string from Project Settings, Database. The direct host (`db.<project>.supabase.co:5432`) is IPv6-only,
so a host without IPv6 (Render's free network) must use the session pooler string instead (see docs/DEPLOY_CHECKLIST.md for the pooler format).
Keep `PG_POOL_MAX` below the project's connection limit.

**Start-up check:** the log says `PostgreSQL connected` (or `MongoDB connected`), and `/health` reports `dbConnected: true`.
An unknown value stops the server at start with `DB_ENGINE must be one of mongo, postgres`.
