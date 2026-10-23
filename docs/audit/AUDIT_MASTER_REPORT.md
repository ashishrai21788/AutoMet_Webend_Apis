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

---

# Cycle 4: pricing drafts, publish and history

**Overall status: still NOT PRODUCTION READY** (see RELEASE_READINESS.md).

| Area | Result | Evidence |
|---|---|---|
| Backend tests | PASS | `npm test`: 571 tests, 567 pass, 0 fail, 4 skipped; 13 new in `test/pricingDrafts.test.js` |
| Draft, publish, versions, rollback on the real engine | PASS | lab backend on Postgres, over HTTP: a draft left the live rule and the riders' estimate unchanged (171), publish made the new prices live (545), rollback restored them (171); every live change is a numbered version; switching modes is recorded in the settings history |
| Pricing page in a browser | PASS | switch on; "Save as draft" saves a draft and says nothing changes for riders; pending panel with the new rule; publish with a note; both rules Live; history with who, when and notes; a version shows what it changed and what going back would change; rollback recorded as a new version |
| Rider apps | not needed | the apps ask the server for the estimate; only live rules are ever read |

**How it works:** a business chooses **direct** (a save goes live at once, as before; each save is still kept as a version) or **draft** (saves wait; Publish makes all of them live together). Publishing checks every draft first (category and region still exist, fields valid, live pricing did not change underneath the draft) and writes nothing if any fails; the writes are upserts and removals, so repeating an interrupted publish finishes it. Rides already booked keep their quoted fare. Rollback applies an old set of rules and is itself a version.

**Scheduled publish and the pricing version on each trip (added after the first cycle 4 push):** a publish can be set for a future time (2 minutes to a year ahead); the drafts are frozen into a schedule and the server applies them together at the time (all checked first; one server claims each; an interrupted run is retried after 5 minutes; a failure applies nothing and keeps the reason; cancelling restores the drafts). Each trip stores the pricing version live when it was priced and the tax rates it was charged. Evidence: 579 backend tests (575 pass, 0 fail, 4 skipped); on Postgres the server applied a GST change at its scheduled time and a trip priced afterwards carried version 3 and GST 5%; in a browser the Schedule option, the waiting-schedule card and the trip detail line ("Priced with pricing version 3; taxes charged: GST 5%") were seen.

**Limits:** regions, categories, cancellation policies, coupons and incentives are not drafted (separate records). (The contract snapshots were refreshed in cycle 6.)

## Cycle 5: demand-based surge

| Area | Result | Evidence |
|---|---|---|
| Backend tests | PASS | `npm test`: 589 tests, 585 pass, 0 fail, 4 skipped; 10 new in `test/surgePricing.test.js` |
| Surge on the real engine | PASS | Postgres lab over HTTP: rule off 171; on with quiet demand 171; demand 5 / supply 1 gave x2.5 capped to 2 = 342 with a surge line; booked fare equalled the quote; pause gave 171, resume 342; lowering the cap to 1.5 gave 256.5; changes in settings history |
| Admin page | PASS | Surge panel shows areas, waiting riders, free drivers and multiplier; pause switch works |
| Rider app (OnePlus) | PASS | ride row shows "High demand x2 - 15 min" at 424-504; info dialog explains the multiplier and that the rider is never charged more than shown |

**How it works:** demand is riders with the app open plus requests in the last 10 minutes within 3 km of the pickup (minimum 3); supply is free online drivers within 3 km. Ratio ladder 1.5/2/3/4 gives x1.2/1.5/2/2.5, capped by the rule, held 60 s. A 5-minute quote lock means a booking never costs more than the quote. Only rules with surge enabled are affected.

**Limits:** quote lock and cache are in memory per server instance (fine for one instance).

## Cycle 6: contract snapshots refreshed

The seven contract scenarios (`npm run contract`, 507 recorded steps) had fallen behind: new fields (`mapIconUrl`, `appVersions`), and four deliberate changes that the scenarios did not yet follow. Each difference was traced before re-recording, not accepted blindly. A first re-record would have hidden a regression-looking change (`ON_GOING` answering 400); the cause was the rider start code, which is deliberate, so the scenarios now read the code from the rider and send it, and also check that no code (400) and a wrong code (403) are refused.

| Change seen | Cause |
|---|---|
| rider detail needs a sign-in | secure rider profile (`dff61a5`) |
| driver status, vehicle details need a sign-in | driver routes closed to anonymous callers |
| `POST /api/drivers` needs a name and phone (400, was 403) | app self-registration reopened on purpose (`b79bad5`) |
| starting a trip needs the 4-digit start code | `lib/tripStartOtp.js` |
| `GET /api/v1/rides/:id` answers 200 (was 404) | endpoint now exists |
| legacy generic collection routes: all creates, updates and deletes refused | hardening |

Result: all seven scenarios match on both Mongo and Postgres, and twice in a row (the start code is aliased because it changes with the accept time). Backend suite unchanged.

## Cycle 7: cancellation policy history and restore

| Area | Result | Evidence |
|---|---|---|
| Backend tests | PASS | `npm test`: 597 tests, 593 pass, 0 fail, 4 skipped; 8 new in `test/cancellationHistory.test.js`; all seven contract scenarios still match |
| On Postgres over HTTP | PASS | save, change, restore, restore again (unchanged), restore over a later change (409 CHANGED_SINCE, nothing changed), force, delete and restore of a deletion, unknown change 404; history newest first |
| Dashboard in a browser | PASS | "Cancellation policy history" card on Pricing: who, when, each term before and after, a Removed badge; the restore confirmation dialog; restoring added a new "Restored" entry |

**Scope decision:** full drafts and scheduled publish (as for fare rules) were not built for cancellation policies. The policies are a few small records applied at the moment of a cancellation, so the proportionate protection is a record of every change with before and after, and one-click restore (itself recorded). Every save, removal and restore writes a change (`cancellation_policy_changes`); a restore over a later edit asks first (`force`).

**Found on the way:** the dashboard said cancellation fees are "not charged yet". The rider fee is charged (`lib/cancellationFee.js`); the driver penalty and free-cancellations-per-day are stored and never applied. The text now says so, and the driver penalty is recorded as open.
