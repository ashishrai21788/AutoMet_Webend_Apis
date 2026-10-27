# Payments: environment, deployment and testing without a gateway account

## Environment variables

| Variable | Where | Meaning |
|---|---|---|
| `PAYMENTS_MOCK_ENABLED` | development and test only | `1` turns the mock gateway on. **A server started with `NODE_ENV=production` and this variable set (to anything) refuses to start.** Outside production, `1` is required for the mock to exist at all. |
| `PAYMENTS_MOCK_SECRET` | development and test only | Secret the mock gateway signs its webhooks with (16+ characters). Random per process when unset. Never reuse a real secret. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | production, when that adapter is built | Server-side only. Never put these in an Android app. |
| `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` | production, when that adapter is built | Server-side only. |

Nothing else is required to run cash payments: they work on every business by default.

## Testing without a payment account

1. `PAYMENTS_MOCK_ENABLED=1 PAYMENTS_MOCK_SECRET=<16+ random characters> npm start` (never in production).
2. Enable online payment on a business: `payments: { enabledMethods: ["CASH","UPI"], provider: "MOCK" }` on its record.
3. A rider opens `POST /api/v1/payments/create` for a completed ride and then drives the outcome with `POST /api/v1/payments/mock/simulate { payment_id, scenario }`.
   The simulator delivers the provider's messages (signed, including duplicates and out-of-order ones) through the **same webhook handler and the same
   verification as a real provider**; it cannot skip the provider check, the amount and currency checks, or the ledger.
4. Dashboard: `GET /api/admin/business/payments`, `/commission`, and `POST /reconciliation/run` show the effect in the payment record, the ledger entries and the findings.

Automated tests (no account, no network): `npm test` (in-memory engine), `TEST_DB=postgres npm test` (Postgres models), `node test/contract/run.js` (real HTTP, both engines).
The payments suites are `test/payments*.test.js`, `test/ledger.test.js`, `test/paymentMoney.test.js`; the HTTP contract is `test/contract/scenarios/payments.js`.

## Deployment checklist

- Production: do **not** set `PAYMENTS_MOCK_ENABLED` (the server will not start if it is). Confirm `NODE_ENV=production`.
- Until a real provider adapter is built and tested in that provider's sandbox, leave every business on cash only. A business that selects `RAZORPAY` or `CASHFREE` gets `PROVIDER_NOT_CONFIGURED` or `NOT_IMPLEMENTED`, not a guess.
- Run the reconciliation (`POST /api/admin/business/reconciliation/run`) daily per business, and look at open findings.
- New collections (created on first use): `ledger_transactions`, `payments`, `payment_events`, `payment_refunds`, `payment_discrepancies`. New indexes are declared on the models: the unique `(tenantId, eventKey)` on the ledger, the unique live payment per ride, and the unique idempotency keys are what make repeats safe; confirm they exist before taking real money.
- Existing completed trips have no payment record or ledger entries. Cash payments for them are created when a driver confirms; there is no backfill yet (see the limitations).
