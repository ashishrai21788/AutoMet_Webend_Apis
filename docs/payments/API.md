# Payments API

All amounts are **whole minor units** (paise for INR) in fields ending `_minor`. The amount to pay is never accepted from a client: it is the
finalised fare the server stored on the completed trip. The business is always taken from the signed-in account, never from a request body.

Replies use the platform envelope `{ success, message, data }`; errors add `error` (a stable code). Payments errors are listed per endpoint.
For anything marked *idempotent*, send an `idempotency_key` in the body (or an `Idempotency-Key` header): repeating the request returns the same result and changes nothing.

## Payment object (what apps see)

| Field | Meaning |
|---|---|
| `payment_id`, `trip_id`, `purpose` (`FARE`, `COMMISSION`) | identity (`trip_id` is null for a commission payment) |
| `method` | `UPI` or `CASH` |
| `status` | `CREATED`, `PENDING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `EXPIRED` |
| `refund_status` | `NONE`, `REFUND_PENDING`, `PARTIALLY_REFUNDED`, `REFUNDED` (separate from `status`) |
| `amount_minor`, `currency`, `refunded_minor` | money |
| `cash_state` | cash only: `PENDING`, `CONFIRMED`, `DISPUTED`, `ADJUSTED` |
| `awaiting_verification` | true while an online payment is waiting for the provider's confirmation: show "verifying", never "paid" |
| `commission_minor` | driver view only (after an adjustment, the adjusted commission) |
| `expires_at`, `created_at`, `paid_at` | times |

A trip also carries `payment_status` (`UNPAID`, `PAID`, `DISPUTED`, `REFUNDED`), `payment_id` and `paid_at`. An app must read these from the server after a restart; a local screen state is never proof of payment.

## Riders and drivers (signed in) `/api/v1/payments`

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /methods` | rider, driver | `{ methods: ["CASH","UPI"], mock }`. Online payment is offered only when the business enabled UPI **and** configured a provider. |
| `POST /create` `{ trip_id, idempotency_key }` | rider | Open the online payment of a **completed** ride. `201` new, `200` an open payment returned. Replies with `payment` and `checkout` (provider-specific; `{type:"MOCK"}` in development). Errors: `400 BAD_REQUEST`, `403 METHOD_NOT_ENABLED`, `404 NOT_FOUND` (not your ride, or another business's), `409 TRIP_NOT_COMPLETED`, `TRIP_NOT_FINALISED`, `ALREADY_PAID`, `PAYMENT_IN_DISPUTE`, `502 PROVIDER_ERROR`. |
| `GET /trip/:tripId` | rider or driver **of that ride** | `{ trip_payment_status, payment, attempts }`: the authoritative state (use after a restart or a return from the payment app). |
| `POST /:paymentId/refresh` | rider (the payer) | Ask the provider what happened. The provider's answer decides; this is how a payment is picked up when no webhook arrived. |
| `POST /cash/confirm` `{ trip_id, collected_minor?, idempotency_key }` | driver of the ride | Confirm the cash collected (defaults to the fare). `201` booked, `200` repeat. A different amount is **not booked**: it becomes a dispute (`disputed:true`). Errors: `400 BAD_AMOUNT`, `404`, `409 TRIP_NOT_COMPLETED`, `ALREADY_PAID`, `ALREADY_CONFIRMED`, `PAYMENT_IN_DISPUTE`. |
| `POST /cash/dispute` `{ trip_id, reason }` | rider or driver of the ride | Dispute a collection (even after it was confirmed). The booking stays until the business decides. |
| `GET /commission` | driver | `{ accrued_minor, collected_minor, outstanding_minor, payable_minor }` from the ledger. |
| `POST /commission/pay` `{ amount_minor, idempotency_key }` | driver | Pay commission owed from cash fares online. At most what is owed minus open commission payments (`409 AMOUNT_TOO_HIGH`, `NOTHING_OWED`). |
| `POST /mock/simulate` `{ payment_id, scenario }` | the payer | Development only. `404` unless the mock gateway is enabled outside production. Scenarios: `SUCCESS, FAILURE, PENDING, DELAYED_SUCCESS, CANCELLED, EXPIRED, DUPLICATE_WEBHOOK, OUT_OF_ORDER_WEBHOOK`. |

## Provider webhook (no sign-in)

`POST /api/v1/payments/webhook/:provider` with the **raw body** the provider sent. Authentication is the provider's signature over those exact bytes.
`400 INVALID_SIGNATURE` (nothing recorded), `404` unknown provider, `503` provider unavailable or not configured, `200` handled (`outcome`: `APPLIED`, `DUPLICATE`,
`IGNORED_STALE`, `IGNORED_ALREADY_SUCCEEDED`, `REJECTED_MISMATCH`, `REJECTED_UNVERIFIED`, `UNKNOWN_ORDER`), `500` internal error (the provider should retry).
A success is accepted only after the provider itself confirms the order, amount, currency and merchant.

## Dashboard `/api/admin/business` (staff; `payments.view` to read, `payments.manage` to change; every change is audited)

| Endpoint | Purpose |
|---|---|
| `GET /payments` `?status&method&driver_id&trip_id&refund_status&purpose&from&to&limit` | payments of this business |
| `GET /payments/:id` | one payment with its refunds and its ledger entries |
| `POST /payments/:id/refund` `{ amount_minor, reason, idempotency_key }` | refund part or all of a successful online fare payment. Audit `payment.refund`. `409 AMOUNT_TOO_HIGH`, `NOT_REFUNDABLE`. |
| `POST /payments/:id/cash/resolve` `{ action: CONFIRM\|ADJUST, adjusted_fare_minor?, reason }` | decide a disputed cash collection. ADJUST reverses the earlier booking and posts the corrected one. Audit `payment.cash.resolved`. |
| `GET /commission` | commission accrued, collected and outstanding per driver, with the amount owed to each |
| `POST /commission/drivers/:driverId/recover` | run the recovery from online earnings now (also works when the business's policy is `MANUAL_ONLY`). Audit `commission.recovered`. |
| `POST /reconciliation/run`, `GET /reconciliation?status=open`, `POST /reconciliation/:id/resolve` `{ note }` | find, list and record the resolution of differences. Nothing is adjusted automatically. Audit `reconciliation.run`, `reconciliation.resolved`. |

## Business settings (`tenant.payments`)

`{ enabledMethods: ["CASH","UPI"], provider: "MOCK"|"RAZORPAY"|"CASHFREE", merchantId, commissionRecovery: "DEDUCT_FROM_PAYABLE"|"MANUAL_ONLY", paymentWindowMinutes }`.
Defaults: cash only, no provider, `DEDUCT_FROM_PAYABLE`, 15 minutes. There is not yet a dashboard form for these; set them through the platform owner's tools or the database.

## Accounting (ledger accounts and what each event posts)

| Event | Debit | Credit |
|---|---|---|
| Online fare captured (`ONLINE_FARE_CAPTURED`) | `GATEWAY_CLEARING` fare | `DRIVER_PAYABLE` net, `COMMISSION_REVENUE` commission |
| Second payment for a paid ride (`DUPLICATE_FARE_CAPTURED`) | `GATEWAY_CLEARING` | `REFUND_CLEARING` |
| Cash confirmed (`CASH_COMMISSION_ACCRUED`) | `DRIVER_COMMISSION_RECEIVABLE` commission | `COMMISSION_REVENUE` commission (the driver's share is already in their hand: no payable) |
| Cash adjusted | reversal of the above, then `CASH_COMMISSION_ADJUSTED` for the corrected commission | |
| Recovery from online earnings (`COMMISSION_RECOVERED`) | `DRIVER_PAYABLE` | `DRIVER_COMMISSION_RECEIVABLE` |
| Driver pays commission online (`COMMISSION_PAID_DIRECT`) | `GATEWAY_CLEARING` | `DRIVER_COMMISSION_RECEIVABLE` |
| Refund processed (`ONLINE_REFUND`) | `COMMISSION_REVENUE` and `DRIVER_PAYABLE` in proportion | `GATEWAY_CLEARING` |
| Driver withdrawal requested or processing (`PAYOUT_RESERVED`, key `payout:<id>:reserve`) | `DRIVER_PAYABLE` | `PAYOUT_RESERVED` |
| Payout paid, by hand or by a provider (`PAYOUT_PAID`, key `payout:<id>:paid`) | `PAYOUT_RESERVED` | `SETTLEMENT_CLEARING` |
| Payout failed or cancelled (`PAYOUT_RELEASED`, key `payout:<id>:release`) | `PAYOUT_RESERVED` | `DRIVER_PAYABLE` (owed to the driver again) |
| Cash trip from before payments were recorded, backfilled (`CASH_COMMISSION_ACCRUED`) | `DRIVER_COMMISSION_RECEIVABLE` | `COMMISSION_REVENUE` |

Rounding: commission = fare x rate, rounded half up to a paisa, in integer arithmetic; the driver's share is the remainder, so the two always add up to the fare.
A refund's shares follow the same split, and the refund that completes the payment takes the exact remainder.

## Payouts and the ledger (shadow mode)

The manual payout flow is unchanged (driver requests, the business pays outside the app and records the bank reference or marks it failed, the driver may cancel while it is only requested) and still decides what a driver can withdraw. The ledger follows every step through `lib/payments/payouts.js`: the postings above, each by its own event key, so they are safe to repeat. A ledger problem never fails a payout action; the payout's `ledgerSyncedStatus` then differs from its `status` and the scheduled upkeep (`POST /api/v1/payments/jobs/run`) catches it up, including payouts made before the ledger followed them.

A business whose payment provider can send payouts (only the mock gateway today) can have a payout sent through the adapter (`disburse`, then `settleDisbursement` for one the provider is still processing). The adapter contract adds `requestPayout({ payoutId, amountMinor, currency, account, idempotencyKey })` and `fetchPayout(providerPayoutId)`; the same idempotency key never sends two transfers, and a payout is settled once whichever way it is settled. Mock scenarios: `PAYOUT_SUCCESS`, `PAYOUT_FAILURE`, `PAYOUT_DELAYED`. These are library functions with tests, not HTTP endpoints; the real providers refuse (`PROVIDER_NOT_CONFIGURED`, `NOT_IMPLEMENTED`).

Reconciliation adds `PAYABLE_MISMATCH`: the ledger is compared with the existing balance part by part (online earnings, money set aside for open payouts, money sent in paid payouts). The old balance also counts tips, incentives, adjustments, penalties, coupon top-ups, older online trips and a deduction for the commission on every cash trip, which the ledger does not carry, so those are not flagged. Nothing is adjusted automatically.
