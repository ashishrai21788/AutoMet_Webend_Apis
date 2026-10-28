/**
 * Payment provider adapters. The business logic (lib/payments/service.js) talks only to this contract, so the fare, commission and ledger
 * code never depends on which provider is used:
 *
 *   name, capabilities { upi, webhooks, serverVerification, refunds, payouts, split }
 *   createOrder({ paymentId, amountMinor, currency, merchantId }) -> { providerOrderId, checkout, expiresAt }
 *   fetchPayment(providerOrderId) -> { status, amountMinor, currency, merchantId, providerPaymentId } | null    (the provider's own answer)
 *   verifyWebhook(rawBody, headers) -> { valid, event }      event: { provider, eventId, type, outcome, providerOrderId, providerPaymentId,
 *                                                                    amountMinor, currency, merchantId, occurredAt }
 *   refund({ providerPaymentId, amountMinor, idempotencyKey }) -> { providerRefundId, status }      status: processed | pending | failed
 *   fetchRefund(providerRefundId) -> { status, amountMinor } | null
 *   requestPayout({ payoutId, amountMinor, currency, account, idempotencyKey }) -> { providerPayoutId, status, reference, reason }   status: processed | pending | failed
 *   fetchPayout(providerPayoutId) -> { status, reference, reason } | null
 *     (only adapters with capabilities.payouts true; the same idempotency key must never send two transfers)
 *
 * MOCK exists only when lib/payments/config.js allows it (never in production). RAZORPAY and CASHFREE are declared but NOT implemented:
 * each must be written against that provider's current documentation and tested in its sandbox with real merchant credentials, and until
 * then they refuse to run (PROVIDER_NOT_CONFIGURED without credentials, NOT_IMPLEMENTED with them). No provider behaviour is guessed here.
 */
const crypto = require('crypto');
const { mockEnabled } = require('../config');
const { MockGateway } = require('./mock');

let mock = null;

function unimplemented(name, envKeys) {
  const fail = (env) => {
    const missing = envKeys.filter((k) => !env[k]);
    if (missing.length) throw Object.assign(new Error(`${name} is not configured (missing ${missing.join(', ')})`), { code: 'PROVIDER_NOT_CONFIGURED' });
    throw Object.assign(new Error(`${name} integration is not implemented yet: it must be built against the provider's documentation and sandbox`), { code: 'NOT_IMPLEMENTED' });
  };
  return (env) => ({
    name,
    capabilities: Object.freeze({ upi: true, webhooks: true, serverVerification: true, refunds: true, payouts: false, split: false }),
    createOrder: async () => fail(env),
    fetchPayment: async () => fail(env),
    refund: async () => fail(env),
    fetchRefund: async () => fail(env),
    requestPayout: async () => fail(env),
    fetchPayout: async () => fail(env),
    verifyWebhook: () => fail(env)
  });
}
const razorpay = unimplemented('RAZORPAY', ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']);
const cashfree = unimplemented('CASHFREE', ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY']);

/** The adapter for a provider name, or throws. The mock needs PAYMENTS_MOCK_ENABLED=1 outside production. */
function getAdapter(name, env = process.env) {
  const n = String(name || '').toUpperCase();
  if (n === 'MOCK') {
    if (!mockEnabled(env)) throw Object.assign(new Error('the mock payment gateway is disabled'), { code: 'MOCK_DISABLED' });
    if (!mock) mock = new MockGateway({ secret: env.PAYMENTS_MOCK_SECRET || crypto.randomBytes(24).toString('hex') });
    return mock;
  }
  if (n === 'RAZORPAY') return razorpay(env);
  if (n === 'CASHFREE') return cashfree(env);
  throw Object.assign(new Error(`unknown payment provider ${name}`), { code: 'UNKNOWN_PROVIDER' });
}

/** Tests: drop the shared mock so each test starts with an empty provider. */
function resetMock() { mock = null; }

module.exports = { getAdapter, resetMock };
