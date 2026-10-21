# Audit master report (cycle 1)

Date: 2026-10-21. Repos inspected from source: `AutoMet_Webend_Apis` (backend), `AutoMet_Admin` (dashboard), `AutoMet_user` (rider app), `AutoMet_driver` (driver app).

**Overall status: NOT PRODUCTION READY.** This is the first cycle of a multi-cycle audit. It verified and completed one workstream end to end (coupons) and recorded what is missing elsewhere. Nothing below is marked PASS unless a test or a live run is named.

## How statuses are used
PASS = executed and verified (evidence named). PARTIAL = some of it works. NOT IMPLEMENTED = no code. BLOCKED = needs something outside the code. NOT VERIFIED = code exists, not exercised in this cycle.

## Verified this cycle (evidence)
| Area | Result | Evidence |
|---|---|---|
| Backend automated tests | PASS | `npm test`: 516 tests, 512 pass, 0 fail, 4 skipped (the skips pre-date this cycle) |
| Admin dashboard | PASS | `tsc -b` clean, `oxlint` clean, `vitest`: 4 files, 24 tests pass (run before the Coupons page was added; `tsc` and `oxlint` re-run after) |
| Rider and driver apps | PASS (build only) | `compileDebugKotlin` clean; the driver app was installed and exercised on a device |
| Coupons end to end | PASS | `test/coupons.test.js` (8 tests) and a live run against the real backend on a local Postgres: create, duplicate refused, estimate with discount (171.00 to 136.80 for 20%), booking stores the discounted fare and the coupon, cancel gives the use back (redeemed 1 then 0, redemption RELEASED) |
| Driver earnings, payouts, incentives, tips, adjustments | PASS | `test/driverEarnings.test.js` (12 tests) plus on-device runs of Overview, Analytics, Payouts, Incentives |
| Driver data rights (export, delete) | PASS | `test/driverAccount.test.js` plus an on-device delete that signed the driver out |

## Implemented this cycle
- **Coupons (new, was NOT IMPLEMENTED):** percent or fixed, caps, minimum fare, dates, total and per-rider limits (conditional counter updates), vehicle-category and area restrictions, new-rider-only, who funds the discount. The discount is computed on the server only. The estimate shows it, the booking stores it, the invoice names it, and driver earnings and balance treat it correctly (business-funded by default: the driver is paid on the fare before the discount, and on a cash ride the business owes the driver the difference). Admin page `/coupons` with a usage list and audit entries. Rider app: a "Have a coupon?" row on the ride-type list; the booking sends the code and the server checks it again and refuses the booking if it no longer applies.
- Earlier in the same engagement: driver ride history and details, profile and privacy screens, earnings screens, payouts and incentives (see the git history of the four repos).

## Not done in this cycle (honest list)
See `AUDIT_MISSING_FEATURES.md`. The large ones: policy and legal document management, configuration versioning with draft, publish and rollback, minimum app version and forced update, tolls, tax effective dating, a branded build pipeline, the independent multi-agent review, a complete UI and accessibility pass, and a full cross-platform concurrency suite.

## Limits of the evidence
- The coupon limits rely on conditional database updates (Mongo and Postgres engines). The in-memory test database runs one request at a time, so the unit tests prove the logic and the rollback paths, not true parallel races. A parallel load test against the real engine has not been run.
- Admin pages were type-checked and linted but not opened in a browser.

## Deferred by instruction
Chat and online payments: not implemented and not claimed. Booking, invoice and earnings logic keep a cash-only payment mode and are shaped so a provider can be added later (see `AUDIT_MISSING_FEATURES.md`, Deferred).

## Release decision
See `RELEASE_READINESS.md`: blocked by the gaps above.
