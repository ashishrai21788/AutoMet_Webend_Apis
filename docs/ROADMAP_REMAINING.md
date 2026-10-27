# Remaining work: step by step

Written 27 Oct 2026, after a review of all four repositories (backend, dashboard, rider app, driver app). Every step names where the work
happens and how it is proven. "Proven" always means: a test written first, then a check on real phones (apps) or a real browser (dashboard).

Status: **DONE** built and tested, **NEXT** the order to build in, **LATER** deliberately deferred, **OWNER** only the business owner can do it.

| # | Item | Status | Size | Why it matters |
|---|---|---|---|---|
| 1 | SOS (emergency) | **DONE** (this document, section 1) | M | Safety, and the business learns about an emergency |
| 2 | Hindi and other languages | NEXT | L | Both apps are English only; India launch |
| 3 | Accessibility and text size | NEXT | M | The rider app ignores the phone's font size; no accessibility pass has been done |
| 4 | Offers list (coupon discovery) | NEXT | S | Riders must already know a code |
| 5 | Note to driver, book for someone else | NEXT | M | Common pickup needs |
| 6 | Driver sees live surge | NEXT | S | Drivers see it only after the fact, in earnings |
| 7 | Lost-item reporting | NEXT | M | Frequent support request |
| 8 | Real push delivery check, typing indicators | OWNER / NEXT | S | Needs the production Firebase key |
| 9 | Dead code and leftovers | NEXT | S | Old sheet buttons, unused API calls |
| 10 | Scheduled rides | LATER | L | Not needed to launch |
| 11 | Multi-stop rides | LATER | L | Not needed to launch |
| 12 | Referrals and wallet | LATER | L | Growth features, depend on payments |
| 13 | Online payments | LATER (decision needed) | XL | Cash only today |
| 14 | iOS apps (rider and driver) | **LATER** | XL | Every repository is Android only |
| 15 | Launch tasks only the owner can do | OWNER | S | See the end |

---

## 1. SOS: the flow as built

**The rule that cannot be broken: the apps only OPEN the phone's dialler. They never place the call.** The app holds no call permission and
no code uses the call action. A test in each app (`NoAutoCallTest`) fails the build if either ever appears. The number that is dialled is
accepted only as 2 to 4 plain digits, so a wrong value in the business's settings can never send a press to a long or premium-rate number.

### What the person sees (rider or driver, on a ride)

1. During a ride the person opens **Safety** (rider) or taps **Emergency** (driver, on the pickup screen and the drop-off screen).
2. A box says: "This opens your phone's dialler with 112, the emergency number. You choose whether to place the call. We also tell
   *your service* support about this ride and where you are, so they can check on you."
3. They tap **Open dialler** (or **Close**). The dialler opens with the number filled in; they decide whether to press call.
4. Behind the scenes, in the same moment, the app tells the business (step 5 below). Nothing they see depends on it: with no signal the
   dialler still opens.

### What the system does

5. The app sends the ride and its last known location to the server (waits at most 2.5 seconds for the location; retries up to 4 times,
   6 seconds apart, if there is no signal).
6. The server checks the person is the ride's own rider or driver, in their own business, and that the ride is under way or ended less
   than 30 minutes ago. It records one alert per person per ride: pressing again adds the new location and raises the count.
7. A missing or bad location never stops an alert from being recorded.
8. The alert copies in the trip, both people's names and phone numbers, the vehicle, the pickup and drop, and the ride's status.

### What the business does

9. Staff with the support permission (business admin, operations, support) see a red panel at the top of the Dashboard and the Alerts
   page, refreshed every 15 seconds: who raised it, the other person, the vehicle, the route, a map link to the last location, and how
   many times it was pressed. Phone numbers are tap-to-call.
10. **Acknowledge** means "we have seen it". **Resolve** records what was done (up to 300 characters). Both are written to the audit log
    with the staff member's email. An alert cannot be acknowledged or resolved twice. Finance and other roles never see emergencies.

### Number by country

The server names the number from the business's country (India 112, United States 911, United Kingdom 999, Australia 000, and so on; 112
when unknown) and sends it with the business's public settings. The apps fall back to 112.

### Known limits (honest)

- If the app is closed or the phone is off before the retries finish, the business is not told. The person still has the dialler.
- The business learns of it by watching the dashboard. There is no push, SMS or email to staff yet (see section 8).
- A press is recorded only for a ride that is under way (or just ended); an emergency before a driver accepts is not covered.

---

## 2. Hindi and other languages

Goal: every word a rider or driver reads can be shown in Hindi (then more), chosen by the person, without a new app release per language.

1. **Inventory.** List every user-visible string in both apps. Many screens (including the chat) build their text in code, not in
   string files: find them all (search for quoted text near `setText`, `Toast`, `AlertDialog`, `.text =`). Output: one list, grouped by screen.
2. **Move text to string resources.** One screen at a time, in both apps, behind a test per screen that no hard-coded sentence remains.
3. **Server texts.** Messages the server sends that people read (errors, chat banners, notification titles) get a stable code plus a
   default English sentence; the app maps the code to its own translated sentence.
4. **Translate.** Hindi first. A human translator reviews the legal and safety text (this is a legal requirement, not a courtesy).
5. **Language choice.** Follow the phone's language by default; add a language row in the profile. Remember the choice.
6. **Legal documents.** The dashboard already stores one language per document type: allow a document per language and show the
   person's language, falling back to English.
7. **Check.** Run both apps in Hindi on real phones: no cut-off text (Hindi is longer), no English left on any screen, dates and
   numbers in the local format. Add a test that fails if a screen's string is missing in a language.

Done when: both apps, switched to Hindi, show no English on any screen reachable without a ride, and a ride completes end to end.

## 3. Accessibility and text size

1. **Stop locking the text size.** The rider app overrides the phone's font scale (`lockTextSizeToTheApp`): remove it; fix the screens
   that break at large sizes (use `sp`, allow wrapping, no fixed heights).
2. **Touch targets.** Every button at least 48 dp (the chat already is); fix the rest.
3. **Screen-reader labels.** Every icon button gets a content description; every image that carries meaning gets one.
4. **Contrast.** Check text against its background (WCAG AA); fix the greys.
5. **Test.** Run both apps at the largest font and display size and with TalkBack on real phones; record what was fixed. Add lint
   rules for missing content descriptions so it stays fixed.

Done when: both apps are usable at 200% text size and a person can complete login, a booking and a ride with TalkBack alone.

## 4. Offers list (coupon discovery)

1. **Backend.** `GET` the offers a rider may use now (active, in date, not used up, for their business and region), without revealing
   codes meant to stay private. Test: only eligible offers, never another business's.
2. **Dashboard.** A "show in the app" switch per coupon.
3. **Rider app.** An "Offers" row in the booking sheet and the profile: tap to apply.
4. **Check.** On a phone: an offer appears, applies, and the fare shows the discount.

## 5. Note to driver; book for someone else

1. **Backend.** Optional `note` (up to 200 characters) and `passenger` (name and phone) on a ride request; stored on the trip; sent to the driver.
   The other person gets a trip-share link, not an account.
2. **Driver app.** Show the note and the passenger's name on the accept screen and the pickup screen.
3. **Rider app.** A note box, and a "Booking for someone else" switch with a name and phone.
4. **Tests.** Length limits, no phone number leaks to anyone but the driver, the rider's own number is unchanged for billing.

## 6. Driver sees live surge

1. **Backend.** Include the current multiplier in the ride request the driver receives (it is already known when the fare is quoted).
2. **Driver app.** A small "1.4x" label on the request and the active ride; a hint on the home screen when the area is surging.
3. **Check.** Turn surge on in a lab business and confirm the label on a phone.

## 7. Lost-item reporting

1. **Backend.** A report tied to a completed trip (rider writes what was lost); the driver is told; staff see it; both can reply once;
   status open, found, closed.
2. **Dashboard.** A list under Support with status and the trip.
3. **Rider app.** "I lost something" on a completed trip. **Driver app.** "A rider left something".
4. **Tests.** Only the trip's own people; the other person's phone number is shown only after both agree.

## 8. Real push delivery, staff notifications, typing

1. **OWNER:** set the production Firebase key (see the owner list). Then send one chat message between two real phones and confirm
   the push arrives with the app closed.
2. **Staff notification for SOS.** Email (and later SMS) to the business's support address when an emergency is raised, so staff do not
   have to be watching the dashboard. Test: one email per new alert, none for repeat presses.
3. **Typing indicator in chat.** A short-lived "typing…" signal; tested not to leak after a ride ends.

## 9. Dead code and leftovers

1. Remove the unused API calls in both apps (`add`, `edit`, `delete`, the unused auth constants) and the old active-ride sheet whose
   buttons only show a toast. Test: the apps still build, and a search finds no reference.
2. Remove backend routes no app calls (the old `rides/request`, `ride-actions`) after one release with a deprecation notice.
3. The driver's all-time history builds a row per trip (about 3 seconds at 5,000 trips): page it.

## 10. Scheduled rides (later)

Backend: a ride with a future pickup time; a job that starts matching a set time before; cancellation rules for the wait. Dashboard:
a list of upcoming rides. Rider app: pick a time. Driver app: upcoming list and a reminder. Needs a decision on how early matching starts
and the fee for a late cancel. Proven with a clock-controlled test (no real waiting) plus one real scheduled ride.

## 11. Multi-stop rides (later)

Backend: an ordered list of stops, fare by total route, driver arrival per stop. Rider app: add up to 3 stops. Driver app: next-stop
navigation. Needs a pricing decision (waiting time at each stop).

## 12. Referrals and wallet (later)

Both depend on money moving, so build them with online payments (item 13): a referral credit and a wallet are ledger entries that
must reconcile with fares, coupons and driver earnings.

## 13. Online payments (decision needed)

Not built. Before any code: choose the provider, and decide who bears fees and refunds. Then: a payment state machine
(created, authorised, captured, failed, refunded), provider webhooks with signature checks and idempotency, refunds that also reverse
coupon use and driver earnings, reconciliation against the provider's settlement report, and an online/cash split in the driver balance
(already modelled). Proven in the provider's test mode first.

## 14. iOS apps (LATER)

Every repository today is Android only. When the time comes:
1. Decide native (Swift) or cross-platform; the apps are small enough that native is realistic.
2. Reuse the server unchanged: it already serves both apps through the same endpoints, and the business is chosen by the app id.
3. Build in this order: sign-in and business config, the rider booking and tracking flow, chat, SOS (the dialler, never a silent
   call: on iOS this is `tel://`), driver go-online and ride flow, earnings.
4. Each screen is checked against the Android app's behaviour using the same contract tests, then on real iPhones.
5. App Store requirements: privacy labels, account deletion in the app (already present on Android), push (APNs) credentials.

## 15. Owner list (before real riders arrive)

1. Set the production Firebase service account on the server and confirm `GET /health` shows `fcmStatus: OK`.
2. Restrict the Google Maps key to the app packages in the Google Cloud console.
3. Confirm `NODE_ENV=production` and `JWT_SECRET`; do not set `TEST_LOGIN_*`.
4. Build the release apps with the real signing key (`keystore.properties`).
5. Have the legal texts (terms, privacy) written and reviewed, and file Play's Data safety form.
6. Decide on online payments (item 13) and on iOS timing (item 14).
