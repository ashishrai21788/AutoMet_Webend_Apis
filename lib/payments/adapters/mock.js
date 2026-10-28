/**
 * The development payment gateway. It needs no merchant account, and it behaves like a real provider where it matters for testing:
 * it keeps its OWN record of every order (so the service must verify with `fetchPayment` instead of trusting a message), it signs its
 * webhooks (HMAC-SHA256 of the exact body) and the service checks that signature with the same code path a real adapter uses.
 *
 * It can only be created through lib/payments/adapters/index.js, which refuses it unless PAYMENTS_MOCK_ENABLED=1 and the server is not
 * in production. Scenarios produce the webhook deliveries a real provider could send (including duplicates and stale, out-of-order
 * messages); the caller delivers them through the same webhook handler as a real provider's.
 */
const crypto = require('crypto');

const TYPE_TO_OUTCOME = { 'payment.captured': 'SUCCEEDED', 'payment.failed': 'FAILED', 'payment.cancelled': 'CANCELLED', 'payment.expired': 'EXPIRED' };
const SCENARIOS = ['SUCCESS', 'FAILURE', 'PENDING', 'DELAYED_SUCCESS', 'CANCELLED', 'EXPIRED', 'DUPLICATE_WEBHOOK', 'OUT_OF_ORDER_WEBHOOK'];

class MockGateway {
  constructor({ secret, now = () => new Date() } = {}) {
    if (!secret || String(secret).length < 16) throw new Error('the mock gateway needs a secret of at least 16 characters');
    this.name = 'MOCK';
    this.capabilities = Object.freeze({ upi: true, webhooks: true, serverVerification: true, refunds: true, payouts: true, split: false });
    this.secret = secret;
    this.now = now;
    this.orders = new Map();
    this.refunds = new Map();
    this.refundsById = new Map();
    this.refundMode = 'processed';
    this.payouts = new Map(); // providerPayoutId -> { status, reference, reason }
    this.payoutsByKey = new Map();
    this.payoutMode = 'processed';
    this.seq = 0;
  }

  async createOrder({ paymentId, amountMinor, currency, merchantId = 'mock-merchant' }) {
    const providerOrderId = `mock_order_${crypto.randomBytes(8).toString('hex')}`;
    this.orders.set(providerOrderId, { providerOrderId, paymentId, amountMinor, currency, merchantId, status: 'created', providerPaymentId: null });
    return { providerOrderId, checkout: { type: 'MOCK', orderId: providerOrderId }, expiresAt: null };
  }

  /** The provider's own answer, used to verify a payment instead of believing a message. */
  async fetchPayment(providerOrderId) {
    const o = this.orders.get(providerOrderId);
    if (!o) return null;
    return { status: o.status, amountMinor: o.amountMinor, currency: o.currency, merchantId: o.merchantId, providerPaymentId: o.providerPaymentId };
  }

  sign(rawBody) { return crypto.createHmac('sha256', this.secret).update(rawBody).digest('hex'); }

  /** -> { valid, event } where event is the normalised message. A bad signature is { valid: false }. */
  verifyWebhook(rawBody, headers = {}) {
    const given = String(headers['x-mock-signature'] || '');
    const want = this.sign(rawBody);
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(want, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, event: null };
    let body;
    try { body = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch (e) { return { valid: false, event: null }; }
    const outcome = TYPE_TO_OUTCOME[body.type];
    if (!body.id || !outcome) return { valid: false, event: null };
    return {
      valid: true,
      event: {
        provider: 'MOCK', eventId: String(body.id), type: body.type, outcome, providerOrderId: body.orderId, providerPaymentId: body.paymentId || null,
        amountMinor: body.amountMinor, currency: body.currency, merchantId: body.merchantId || null, occurredAt: new Date(body.occurredAt)
      }
    };
  }

  /** Build one signed delivery. */
  delivery({ id, type, order, occurredAt, amountMinor, currency, merchantId }) {
    const o = order;
    const rawBody = Buffer.from(JSON.stringify({
      id, type, orderId: o.providerOrderId, paymentId: o.providerPaymentId || `mock_pay_${o.providerOrderId.slice(-8)}`,
      amountMinor: amountMinor == null ? o.amountMinor : amountMinor, currency: currency || o.currency, merchantId: merchantId || o.merchantId, occurredAt: occurredAt.toISOString()
    }));
    return { rawBody, headers: { 'x-mock-signature': this.sign(rawBody) } };
  }

  /**
   * What the provider does for a scenario: it updates its own order and returns the deliveries to send now and (for DELAYED_SUCCESS) later.
   * `overrides` (amountMinor, currency, merchantId) let a test send a message that disagrees with the order.
   * -> { deliverNow: [{ rawBody, headers }], deliverLater: [{ apply(), delivery }] }
   */
  scenario(name, providerOrderId, overrides = {}) {
    const o = this.orders.get(providerOrderId);
    if (!o) throw Object.assign(new Error('unknown order'), { code: 'UNKNOWN_ORDER' });
    if (!SCENARIOS.includes(name)) throw Object.assign(new Error(`unknown scenario ${name}`), { code: 'UNKNOWN_SCENARIO' });
    const t0 = this.now().getTime();
    const at = (ms) => new Date(t0 + ms);
    const k = () => `mock_evt_${(this.seq += 1)}_${crypto.randomBytes(4).toString('hex')}`;
    const d = (type, ms, extra = {}) => this.delivery({ id: extra.id || k(), type, order: o, occurredAt: at(ms), ...overrides, ...extra });
    o.providerPaymentId = o.providerPaymentId || `mock_pay_${crypto.randomBytes(6).toString('hex')}`;
    const out = { deliverNow: [], deliverLater: [] };
    switch (name) {
      case 'SUCCESS': o.status = 'paid'; out.deliverNow.push(d('payment.captured', 0)); break;
      case 'FAILURE': o.status = 'failed'; out.deliverNow.push(d('payment.failed', 0)); break;
      case 'PENDING': o.status = 'created'; break;
      case 'DELAYED_SUCCESS': o.status = 'created'; out.deliverLater.push({ apply: () => { o.status = 'paid'; }, delivery: d('payment.captured', 5000) }); break;
      case 'CANCELLED': o.status = 'cancelled'; out.deliverNow.push(d('payment.cancelled', 0)); break;
      case 'EXPIRED': o.status = 'expired'; out.deliverNow.push(d('payment.expired', 0)); break;
      case 'DUPLICATE_WEBHOOK': { o.status = 'paid'; const id = k(); out.deliverNow.push(d('payment.captured', 0, { id }), d('payment.captured', 0, { id })); break; }
      case 'OUT_OF_ORDER_WEBHOOK': o.status = 'paid'; out.deliverNow.push(d('payment.captured', 2000), d('payment.failed', 1000)); break; // the older "failed" arrives after the newer "captured"
      default: break;
    }
    return out;
  }

  /**
   * A refund. `refundMode` (processed, pending or failed) is what the provider does with the next one, so tests can drive every
   * outcome. Asking again with the same idempotency key returns the same refund and never creates a second.
   */
  async refund({ providerPaymentId, amountMinor, idempotencyKey }) {
    if (this.refunds.has(idempotencyKey)) return { ...this.refunds.get(idempotencyKey) };
    const r = { providerRefundId: `mock_rf_${crypto.randomBytes(6).toString('hex')}`, status: this.refundMode, amountMinor, providerPaymentId };
    this.refunds.set(idempotencyKey, r);
    this.refundsById.set(r.providerRefundId, r);
    return { ...r };
  }

  /** The provider's own record of a refund (`processed`, `pending` or `failed`). */
  async fetchRefund(providerRefundId) {
    const r = this.refundsById.get(providerRefundId);
    return r ? { status: r.status, amountMinor: r.amountMinor } : null;
  }

  /** What the provider does with the next payout: PAYOUT_SUCCESS (sent), PAYOUT_FAILURE (rejected) or PAYOUT_DELAYED (still pending). */
  payoutScenario(name) {
    const mode = { PAYOUT_SUCCESS: 'processed', PAYOUT_FAILURE: 'failed', PAYOUT_DELAYED: 'pending' }[name];
    if (!mode) throw Object.assign(new Error(`unknown payout scenario ${name}`), { code: 'UNKNOWN_SCENARIO' });
    this.payoutMode = mode;
  }

  /** Send money to a driver's bank account. The same idempotency key always returns the same transfer: it is never sent twice. */
  async requestPayout({ payoutId, amountMinor, currency, idempotencyKey }) {
    const key = idempotencyKey || payoutId;
    const hit = this.payoutsByKey.get(key);
    if (hit) return { ...hit };
    const providerPayoutId = `mock_po_${crypto.randomBytes(6).toString('hex')}`;
    const status = this.payoutMode;
    const r = { providerPayoutId, status, amountMinor, currency, reference: status === 'processed' ? providerPayoutId : null, reason: status === 'failed' ? 'The provider could not send the payout (mock)' : null };
    this.payoutsByKey.set(key, r);
    this.payouts.set(providerPayoutId, r);
    return { ...r };
  }

  /** The provider's own record of a payout. */
  async fetchPayout(providerPayoutId) {
    const r = this.payouts.get(providerPayoutId);
    return r ? { status: r.status, reference: r.reference, reason: r.reason } : null;
  }

  /** Tests: the provider finishes a pending payout. */
  completePayout(providerPayoutId, outcome) {
    const r = this.payouts.get(providerPayoutId);
    if (!r) throw Object.assign(new Error('unknown payout'), { code: 'UNKNOWN_PAYOUT' });
    r.status = outcome;
    r.reference = outcome === 'processed' ? providerPayoutId : null;
    r.reason = outcome === 'failed' ? 'The provider could not send the payout (mock)' : null;
  }

  /** Tests: the provider finishes a pending refund. */
  completeRefund(providerRefundId, outcome) {
    const r = this.refundsById.get(providerRefundId);
    if (!r) throw Object.assign(new Error('unknown refund'), { code: 'UNKNOWN_REFUND' });
    r.status = outcome;
  }
}

module.exports = { MockGateway, SCENARIOS };
