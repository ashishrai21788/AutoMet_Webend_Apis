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

Still to add: an `admin` scenario for the dashboard routes not exercised by the set-up steps, and image upload/delete
(needs a Cloudinary stand-in).

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
