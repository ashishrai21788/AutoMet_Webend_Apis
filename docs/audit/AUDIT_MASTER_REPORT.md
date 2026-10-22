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

---

# Cycle 2: legal documents

**Overall status: still NOT PRODUCTION READY.**

| Area | Result | Evidence |
|---|---|---|
| Backend tests | PASS | `npm test`: 523 tests, 519 pass, 0 fail, 4 skipped (the same 4 as before); 7 new in `test/legal.test.js` |
| Admin dashboard | PASS (type check and lint) | `tsc -b` and `oxlint` clean; the Legal Documents page was not opened in a browser |
| Rider and driver apps | PASS (build only) | `compileDebugKotlin` clean in both; not seen on a device (none was connected) |
| Legal documents, live | PASS | lab backend over HTTP: 404 before publishing, draft, publish, edit of a published version refused (409), public document and hosted page served, a script tag in the text escaped, consent pending then recorded then none pending, acceptance counted per version |

**What was built:** a versioned legal documents module. Six types (privacy policy, rider terms, driver terms, location disclosure, account deletion, cancellation and refund), each with draft, publish with an effective date (a future date waits), never-edited published versions, history, optional required agreement, and an acceptance record per rider or driver and version. Public API and a public web page per document (the address Google Play asks for). Admin page with editor, live preview and publish dialog. Rider and driver apps show the published text (fallback: the built-in text) and ask for required agreement once per start, again after every new version.

**Limits:** one language per type; text is plain (headings, bullets, paragraphs) by design so it is always safely escaped; a business must write and legally review its own text, this module does not make it sufficient.

---

# Cycle 2b: device verification (rider and driver apps, lab backend on a real phone)

| Area | Result | Evidence |
|---|---|---|
| Legal consent, driver app | PASS | dialog listed the two published documents; Read opened the server text; I agree saved both acceptances (admin counts: drivers 1 each); restart showed no dialog |
| Legal consent, rider app | PASS | same flow with rider terms; the dialog returns after reading until agreed; acceptance counts riders 1 each; a second sign-in did not ask again |
| Rider coupon | PASS | row on the ride-type list; typed code visible; applied ("you save" line); Book button shows the discounted range; booking stores the discounted fare, coupon id and discount (172 = 212 - 40 and 182 = 212 - 30); completed-trip lines add up to the total with a "Coupon discount" line; the first request that timed out gave its use back |
| Rider tip | PASS | tip row on the review screen; 5 stars + 20 submitted; driver earnings show tips 20, trip earnings 212 (business-funded coupon), total 232, available 40 (the business owes the discount on a cash ride) |

Defects found on the device and fixed in this cycle: unreadable consent dialog buttons; invisible coupon text; fare lines on the completed trip not adding up (no discount line); Book button showing the undiscounted range; booking errors shown as raw JSON.

Admin dashboard in a real browser (local lab backend): Coupons (list, uses, create form; uses matched the phone: ride 2 used, ride 1 given back), Legal documents (list with agreement counts, editor with live preview, draft delete), Driver payouts (adjustment recorded and then seen in the driver earnings API: adjustments 25, total 469, available 95) and Incentives (empty state, create form) all rendered and worked. Not exercised in the browser: publishing a legal version, paying a withdrawal, saving a coupon or incentive.

---

# Cycle 3: minimum app version, tolls, settings history

**Overall status: still NOT PRODUCTION READY** (see RELEASE_READINESS.md).

| Area | Result | Evidence |
|---|---|---|
| Backend tests | PASS | `npm test`: 558 tests, 554 pass, 0 fail, 4 skipped (the same 4 as before) |
| Minimum app version and forced update | PASS | tests; live 426 on Postgres; update screen on a OnePlus (readable buttons, Update opens the store, Close leaves the app, shown on the next screen, lifted when the minimum is removed); admin card in a browser |
| Tolls | PASS | tests (limits, invoice line, earnings, no commission on tolls, trip list); two phones end to end (OnePlus rider, Xiaomi driver): prompt, limit refused, ₹40 toll accepted; rider details, history, invoice and PDF, driver complete screen, history, home and receipt all agree |
| Coupon on a cash ride, two phones | PASS after fixes | the driver was told to collect the fare before the coupon, and estimated earnings ignored the business-paid coupon; fixed and re-run: collect ₹99 = 89 - 30 + 40, earnings ₹129 |
| Settings history and rollback | PASS | 12 tests; live on Postgres (found and fixed a bug that reported ride settings as changed on every save); page in a browser: list, a version's changes, what a rollback would change, rollback (recorded as a new version, public config shows the restored values) |

**Found by testing on devices and a real database, not by unit tests:** the invoice of a tolled trip failed to save (the stored invoice did not allow a toll line); the trip list showed the fare without the toll; the update dialog was lost when the splash screen finished; unreadable dialog buttons on two phones; the driver coupon figures above; a settings-history difference that only appeared with the real engine.

**Settings history covers** business details, driver payouts, tolls, minimum app versions and ride settings. It does not cover fare rules, regions, categories, coupons or incentives (separate records; pricing is the next step) or legal documents (they already have draft, publish and immutable versions).
