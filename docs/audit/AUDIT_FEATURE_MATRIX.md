# Feature matrix

Status key is in AUDIT_MASTER_REPORT.md. "Evidence" names the test or run; a blank means it was not exercised this cycle.

## Rider app
| Feature | Status | Notes / evidence |
|---|---|---|
| Login by phone and OTP | NOT VERIFIED | worked in earlier on-device runs against the lab backend; not re-run this cycle |
| Pickup, destination, ride types, fare range | NOT VERIFIED | backend `trips/ride-options`: `test/rideOptions.test.js` |
| Fare estimate with itemised fare | PASS (backend) | `test/pricing.test.js`, `test/fare.test.js` |
| Coupon apply on booking | PASS (backend), PARTIAL (app) | `test/coupons.test.js` and the live run; the rider UI compiled but was **not seen on a device** |
| Booking and dispatch | NOT VERIFIED here | `test/dispatch.test.js`, `test/tripRaces.test.js`, `test/tripTimeout.test.js` pass |
| Active ride, cancel, rating | NOT VERIFIED here | `test/rideRating.test.js`, `test/rideLifecycle.test.js` pass |
| Tip after the ride | PARTIAL | `POST /rides/tip` verified live (200, duplicate 409, over-cap 400, zero 400) and rating-with-tip 200; the UI row compiled, not seen on a device |
| Invoice screen and PDF | PASS (backend) | `test/riderInvoice.test.js`; the discount line now carries the coupon code |
| Ride history | NOT VERIFIED here | paged on the server (`skip`/`limit`) |
| Saved places, SOS, notification centre | NOT IMPLEMENTED or NOT VERIFIED | see AUTOMET_SYSTEM_AUDIT.md |

## Driver app
| Feature | Status | Notes / evidence |
|---|---|---|
| Landing, go online, ride request, pickup, arrived, PIN, in progress, complete | PASS | exercised on a device against the lab backend; backend `test/tripStartOtp.test.js` |
| Ride history, details, receipt PDF, report an issue | PASS | `test/driverSummary.test.js`; on device |
| Earnings overview, analytics with CSV export, payouts, bank account, withdraw | PASS | `test/driverEarnings.test.js`; on device |
| Incentives and goals | PASS | tests and on device |
| Profile, privacy and data (export, delete, background-location disclosure) | PASS | `test/driverAccount.test.js`; on device |
| Tolls | NOT IMPLEMENTED | no field, endpoint or screen |
| Chat | NOT IMPLEMENTED | deferred by instruction |

## Backend
| Feature | Status | Evidence |
|---|---|---|
| Multi-tenant data isolation | PASS | `test/apptenant.api.test.js`, `test/roleboundary.api.test.js`, `test/security.test.js` |
| Fare rules and taxes | PASS with gaps | `lib/fareRules.js`; taxes have no effective date; **surge is stored in the rule but never applied** (`lib/tripPricing.js`) |
| Coupons | PASS | see above |
| Commission and earnings | PASS | `lib/driverMoney.js`; the split is fixed on the trip at completion; `test/driverEarnings.test.js` |
| Payouts and ledger | PASS | tests; the admin pays and records the bank reference |
| Pagination | PARTIAL | history, payouts, coupons, issues, riders, drivers are paged; not audited: admin audit log, reports, invoice list, live map |
| Cancellation fee | PASS | `test/cancellationFee.test.js` |
| Online payments | NOT IMPLEMENTED (deferred) | `payment_mode` is always CASH |

## Admin dashboard
| Page | Status |
|---|---|
| Regions, categories, pricing and fare rules, ride settings | PASS (existing tests) |
| Drivers, vehicles, verification, riders, trips, reports, support, alerts, team, audit | PASS (existing tests) |
| Coupons, Driver Payouts, Incentives and Goals (new) | PASS for type check, lint and backend tests; **not opened in a browser** |
| Legal documents, configuration publish and rollback, app-build settings | NOT IMPLEMENTED |
