# Payments: known limitations and what remains

Written honestly at the end of this build. "Done" means built and tested; the list below is what is **not** done.

## Needs something only the owner can supply

- **Real gateways (Razorpay, Cashfree) are not implemented.** They need merchant accounts, credentials, the provider's current documentation and sandbox testing. The adapter contract (`lib/payments/adapters/index.js`) is what they must satisfy; until then they refuse to run. No provider API behaviour has been assumed anywhere.
- **Tax.** No tax rate is applied. The ledger has a `TAX_PAYABLE` account but nothing posts to it. Ride GST, GST on commission, TDS and gateway-fee tax each need a validated rule with effective dates, taken after qualified Indian tax advice, before any calculation is switched on. The existing rider invoice GST (`lib/gst.js`, `lib/riderInvoice.js`) is unchanged and separate.
- **Funds flow.** Only "the business collects and owes drivers their net" (`MERCHANT_COLLECTS`) exists. A provider that splits funds at source (route/marketplace settlement) needs a different posting and the provider's rules.
- **Commission recovery** from online earnings needs a basis in each driver's agreement; the default matches what the platform already did when it worked out a payout. Confirm it is right for the business.
- **UPI intent without a provider** cannot verify a payment, so it is not offered. A direct UPI deep link would need the business's own merchant arrangement and manual verification.

## Built, but not everywhere yet

- **Android (rider and driver) and the dashboard UI are not built.** The server side is complete and tested (the apps read `GET /api/v1/payments/trip/:id` and call the endpoints in `API.md`), but there is no payment screen, cash-confirmation button, earnings/commission screen or Commission and Collections dashboard page yet. This is the largest remaining piece.
- **Payouts through the ledger.** The existing manual payout flow (`controllers/payoutsController.js`) is unchanged and still the source of truth for what a driver can withdraw. The ledger accounts for payouts exist (`PAYOUT_RESERVED`, `SETTLEMENT_CLEARING`) and refunds already read the driver's payable from the ledger, but payout requests do not yet post to it, so the ledger's driver payable and the existing derived balance can differ until that is wired in. There is no payout adapter or payout simulator yet (`PAYOUT_SUCCESS`, `PAYOUT_FAILURE`, `PAYOUT_DELAYED` are not implemented).
- **Adjusted cash fares** are applied to the ledger and the payment record; the trip's original `driver_earning` snapshot (which the existing earnings screens read) is not rewritten.
- **Gateway fees and settlement** (`GATEWAY_FEES`, `SETTLEMENT_CLEARING`) have accounts but nothing posts to them: they need the provider's fee and settlement data. The reconciliation does not yet compare provider settlements.
- **Backfill.** Completed trips from before this system have no payment or ledger records. Their cash commission is not in the ledger until backfilled; the existing derived balance still covers them.
- **No scheduled jobs.** Expiring old payments (`expireStale`), repairing interrupted postings (`repairUnposted`) and settling pending refunds (`settleRefund`) are functions with tests but nothing calls them on a schedule yet. Wire them to the existing scheduler endpoints before taking real online payments.
- **Business settings form.** `tenant.payments` has no dashboard form yet.
- **Reports** are limited to the payments list, the commission report and the reconciliation findings; there are no date-range totals, exports or tax reports yet.

## Limits of the evidence

- The concurrency tests run on the in-memory engine and an in-process, single-connection Postgres (PGlite). They prove the guards (conditional updates, unique keys, numbered recoveries) work under parallel requests there; they do not prove behaviour on a multi-connection Postgres server.
- The mock gateway models a provider's behaviour; a real provider's timing and edge cases will differ and must be tested in its sandbox.
