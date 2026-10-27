# Release readiness (cycle 14, 27 Oct 2026)

Backend `AutoMet_Webend_Apis`, admin `AutoMet_Admin`, rider app `AutoMet_user`, driver app `AutoMet_driver`.

## What was verified, and how

| Area | Result | Evidence |
|---|---|---|
| Backend, in-memory engine | PASS | 654 passed, 0 failed, 4 skipped (`npm test`) |
| Backend, real Postgres models | PASS | 658 of 658 (`TEST_DB=postgres npm test`, run with nothing else heavy on the machine) |
| API contract snapshots, both engines | PASS | 7 scenarios, every step matches |
| Mongo / Postgres model parity | PASS | 22 of 22 on each |
| Tenant isolation, live over HTTP | PASS | 79 of 79: two businesses, 25 by-id attacks, header spoofing, wrong-app tokens, chat |
| Admin dashboard | PASS | type check + build, lint clean, 24 of 24 tests, 0 dependency vulnerabilities |
| Rider and driver apps, unit tests | PASS | all modules, 41 (rider) and 33 (driver) tests; 21 in each are the chat rules |
| Rider and driver apps, two real phones | PASS for chat, app kill and a stalled connection | sign-in, active ride, chat both directions with live refresh, read marks, day headings, left/right bubbles, typing, chat-off and ride-ended banners, unread badge on both apps, notification tap into the chat (both apps); both apps killed mid-ride and reopened, and the server frozen during a send, then resumed (message arrived once) |
| Dependencies (backend, production) | 28 findings to 8, none critical or high | `npm audit fix` (no breaking changes); the 8 left are moderate and need a major upgrade |

## Fixed in this cycle because it would have hurt on launch day

1. **A published sign-in code worked in production.** With nothing configured, three test numbers accepted the code `123456` on any server. With `NODE_ENV=production` the built-in accounts are now off; a fixed code works there only when both `TEST_LOGIN_OTP` and `TEST_LOGIN_NUMBERS` are set on purpose, and `TEST_LOGIN_DISABLED=1` still turns everything off. Three tests cover it.
2. **Four critical and twelve high dependency vulnerabilities** (websocket-driver, protobufjs, proxy-addr, fast-xml-parser, ws, body-parser, mongoose and others), all fixed without breaking changes.
3. **Chat push notifications were silent.** The apps never created the Android channels the push named, so every message landed in a quiet fallback channel on Android 8 and later. A high-importance chat channel now exists, the push names it, a tap opens the right chat, and a newer message replaces an older one.
4. **Typing in the chat lost text** (scrolling moved keyboard focus off the input), and the timestamp reader would have crashed on Android 7. Both fixed and covered by tests.
5. **A database outage signed everyone out.** While the database could not be reached the server answered 401 (and leaked the raw error); the apps sign the person out on a 401. It is now a generic 503 the apps retry; token problems keep their 401s. Found by freezing the server during a phone test.
6. **Image upload and delete were open to anyone;** now they need a signed-in rider or driver.
7. **The finance role could read every driver's phone number** through the live map; it now needs the permission to see drivers.
8. `local.properties` (a machine path) was tracked in both app repositories; it is now untracked and ignored.

## What only the owner can do before real riders arrive

These are not code and could not be done or tested from here.

| # | Action | Why it matters |
|---|---|---|
| 1 | Set the **production Firebase service account** (`FIREBASE_SERVICE_ACCOUNT_KEY` or `_PATH`) on the server, then send one real chat message between two real devices | Push delivery was only checked at the server (the payload) and on devices through the in-app path. Real delivery through Google's servers has never been exercised |
| 2 | **Restrict the Google Maps key** in the Google Cloud console to the app package names and signing SHA-1s | The key is in the app manifests; unrestricted, anyone can use your quota |
| 3 | Confirm `NODE_ENV=production`, `JWT_SECRET`, database and Cloudinary variables are set on the host; do **not** set `TEST_LOGIN_*` unless you want a fixed code | The server refuses to start without `JWT_SECRET`. Test phones that used code 123456 against the live server will now get a random code |
| 4 | Build the release apps with the real signing key and the business `appId`, over `https` | Debug builds were used for all device testing |
| 5 | File the Play **Data safety** form and enter each business's public privacy-policy URL | Play review blocks the release without them |
| 6 | Decide on online payments | None exist; fares are settled outside the app |

## Known gaps (not blockers for a controlled launch)

- The rider app's full Android lint has never completed on this machine (5.9 GB RAM; retried this cycle and stopped after 20 minutes); the driver app's has. The rider release build's fatal-issue lint check passes.
- Android instrumented tests and an automated multi-device concurrency suite do not exist; device checks were manual.
- The notification tap was run through its intent on both phones; a push actually arriving from Google's servers was not.
- `npm run test:postgres` and `test:parity` use Unix-style variable syntax and fail on Windows cmd; run them from Git Bash.
- 8 moderate dependency advisories remain; each needs a major-version upgrade.
- Tolls and tax-rule versions are not stored; there is no online payment.

## Decision

**Ready for a controlled launch once items 1 to 4 above are done.** The software is tested and the known launch-day defects are fixed. Items 1 to 3 are the ones that can fail silently in production, so they should be checked first, with one real ride between two real phones.

## Production environment checklist

`render-environment-variables.example.csv` lists every variable a launch needs. Beyond the database, `JWT_SECRET`, Cloudinary and `NODE_ENV=production` (which makes sign-in checks strict by default):

- `FIREBASE_SERVICE_ACCOUNT_KEY`: without it no push is sent. After setting it, open `GET /health` and confirm `fcmStatus` is `OK`.
- `SCHEDULER_SECRET`: without it the scheduled ride-timeout endpoints stay disabled.
- `PUBLIC_BASE_URL`, `ADMIN_DASHBOARD_URL`, `CORS_ALLOWED_ORIGINS`: the address shared links and password-reset emails are built on, and the only website allowed to call the API from a browser.
- `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD`: creates the first platform owner once; remove both after the first sign-in.
- Do **not** set `TEST_LOGIN_OTP` or `TEST_LOGIN_NUMBERS` unless you want a fixed sign-in code for those numbers.
- The rate limiter keeps its counters in the server's memory: correct on one instance, per instance if the service is scaled out.
- Release apps are signed from a git-ignored `keystore.properties` (storeFile, storePassword, keyAlias, keyPassword) next to `settings.gradle.kts`; without it the release APK is left unsigned. Build one for a business with `scripts/build-business-apk.sh <appId> "<name>" release`.
