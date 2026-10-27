# Payments: architecture assessment, assumptions and plan

Written before any payment code (27 Oct 2026). Everything under "Found" was read in the code, not assumed.

## 1. What exists today (found)

| Area | Where | State |
|---|---|---|
| Stack | Node 24, Express 5, CommonJS; Mongo (Mongoose) **and** real Postgres models behind the same model API (`lib/db/`), both exercised by the whole test suite | in use |
| Auth | `lib/authMiddleware.js` `requireAuth({roles})`; JWT per rider/driver, one session per account; admin JWT + permissions (`lib/adminPermissions.js`) | in use |
| Tenancy | `X-App-Id` -> `req.appTenant`; `tenantId` on every business record; `WRONG_APP` 403; `req.data` scoped helpers in admin routes; live isolation script (79 checks) | in use |
| Trip lifecycle | `models/tripDetailsModel.js`, `controllers/tripsController.js`, `rideController.js` (`PATCH /api/v1/rides/:id/status`); atomic conditional updates | in use |
| Fare | `lib/fare.js`, `fareRules.js`, `tripPricing.js`: fare in rupees (float) on the trip, `fare_breakdown`, tolls in minor units | in use |
| Payment on a trip | `payment_mode` (always `CASH`), no payment status, no attempts | **minimal** |
| Commission | `payoutSettings.commissionPercent` (tenant); at completion `driver_earning` snapshot `{fareMinor, feeMinor, netMinor, percent}` written onto the trip (`lib/driverMoney.js`) so later rate changes never rewrite history | in use |
| Driver balance | **derived on read** from trips + adjustments + payouts (`balanceOf`); cash trips: the platform share is deducted from what the driver can withdraw (an implicit recovery) | in use, not a ledger |
| Payouts | `models/driverPayoutModel.js`, manual: driver requests, business pays and records a UTR; one open request per driver (unique partial index) | in use |
| Adjustments, incentives, penalties | `driver_adjustments` (kinds INCENTIVE, ADJUSTMENT, PENALTY, PENALTY_WAIVER), audited | in use |
| Rider invoice / GST | `lib/riderInvoice.js`, `gst.js`: invoice per trip with tax lines | in use |
| AutoMet's own revenue | `lib/revenue.js`, `platformBilling.js`: businesses' subscription invoices. **Separate from ride money; untouched** | in use |
| Driver app | earnings overview, payouts, history (read-only money) | in use |
| Rider app | trip history, invoice screen, "Cash" shown | in use |
| Dashboard | payout settings, payouts queue, adjustments, incentives, reports | in use |
| Tests | `node --test`, fake DB + PGlite Postgres; contract snapshots; concurrency and load harnesses | in use |

## 2. What is missing (confirmed by search: no `razorpay`, `cashfree`, `webhook`, `ledger`, `refund` for rides anywhere)

- A payment object per trip with a state machine, attempts, idempotency, and verification.
- Any online (UPI) payment flow, provider adapter, webhook receiver, signature check.
- Cash collection **confirmation** by the driver (today cash is assumed at completion).
- A double-entry ledger; commission receivable as an explicit account; reconciliation of cached balances against it.
- Ride refunds; gateway fees; refund-adjusted earnings.
- Payout through an adapter (today a human records the UTR).
- A reconciliation process and a mock gateway/simulator.
- Android payment screens; dashboard Commission and Collections module.

## 3. Assumptions (financially consequential: each is configurable or documented, none is silent)

1. **Merchant of record is the tenant business.** The "platform commission" is the business's share of a driver's fare (the existing `commissionPercent`), not AutoMet's subscription fee. Online fares are collected into the **business's** gateway account; the business owes the driver the net. A future "split at source" arrangement is a different ledger flow, selected by `payments.fundsFlow` (only `MERCHANT_COLLECTS` is implemented).
2. **Recovery of cash commission from online earnings** is a tenant policy `payments.commissionRecovery`: `DEDUCT_FROM_PAYABLE` (the behaviour the platform already has) or `MANUAL_ONLY`. It needs a basis in the driver agreement; the owner must confirm which applies.
3. **Rounding:** all money is integer minor units (paise). Commission = `round_half_up(fare_minor * rate_bp / 10000)` with the rate in basis points; driver net = fare - commission, so the two always sum to the fare exactly. Percentages with more than two decimals are rejected.
4. **Tax:** no rate is applied by default. A tax configuration is a named, dated reference the owner enters after taking Indian tax advice; an unresolved configuration is reported as "needs configuration", never defaulted. Ride GST, GST on commission, TDS and gateway-fee tax are separate ledger accounts.
5. **The ledger starts in shadow mode.** It is written alongside the existing derived balance and a reconciliation compares the two, so the live payout behaviour does not change until the owner is satisfied the two agree.
6. **Mock gateway** exists only when `PAYMENTS_MOCK_ENABLED=1` and `NODE_ENV !== 'production'`; in production the server refuses to start with it enabled.
7. **Real gateways (Razorpay, Cashfree)** are adapters that declare their capabilities and raise `PROVIDER_NOT_CONFIGURED` without credentials. No provider API behaviour is invented here: the adapter contract is what the business logic needs, and each real adapter must be written against the provider's current documentation and tested in its sandbox.

## 4. Risks

- **Financial consistency:** duplicate webhooks, out-of-order events, a client claiming success, double recovery, double payout, a refund after earnings were counted. Mitigation: one `eventKey` per business event, unique in the ledger (idempotent posting), conditional state transitions, a single posting function, reconciliation.
- **Security:** mock endpoints in production, client-supplied tenant or amount, webhook forgery, provider secrets. Mitigation: environment guard that fails start-up, amounts only from the server's own finalised trip, HMAC verification with constant-time compare, secrets only in server environment variables.
- **Migration:** existing completed trips have `driver_earning` snapshots but no payment record or ledger entries. A backfill script creates `CASH`/`CONFIRMED_LEGACY` payments and opening ledger entries per trip, idempotent by event key; run in shadow mode first.

## 5. Plan (each stage ends with tests run on both database engines)

1. Money and commission library (integer paise, basis points, rounding), the double-entry ledger (accounts, idempotent balanced posting, reversal, balance by account, verification), models for both engines. **Tests first.**
2. Payment service: payment object and state machine, attempts, provider-adapter contract, mock gateway, webhook receiver (signature, duplicates, out of order), server-side verification, amount/currency/trip/tenant validation.
3. Cash collection: driver confirmation, disputes, adjustments; commission receivable posted at confirmation; completion hook.
4. Commission recovery (from online earnings), direct commission payment, refunds (separate refund status), payouts through the ledger and an adapter, reconciliation against the existing derived balance and against provider records.
5. Admin APIs and the Commission and Collections dashboard module; tenant-isolation tests over HTTP; simulator.
6. Android (rider and driver) screens, then device runs.

Stages 1 to 5 are backend plus dashboard; stage 6 depends on them and on a decision about the Android payment sheet (see `KNOWN_LIMITATIONS.md` once written).
