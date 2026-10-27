const mongoose = require('../lib/db/mongoose');

/**
 * The financial ledger. One document per business event; it carries its debit and credit entries, which must balance, so a
 * transaction is posted whole or not at all (a single insert), and a unique `eventKey` per business makes posting idempotent: the same
 * event (a webhook delivered twice, a retried tap) can never post twice.
 *
 * Posted transactions are never edited or deleted. A mistake is corrected by a reversal (a new transaction with the entries swapped,
 * `reversalOf` pointing at the original, event key `reverse:<txnId>` so an event is reversed once) and, if needed, a new posting. `lib/ledger.js` is the only code that writes here.
 * Amounts are whole minor units (paise).
 */
const ledgerTxnSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  txnId: { type: String, required: true, unique: true },
  /** unique per business: the idempotency key of the event that caused this posting */
  eventKey: { type: String, required: true },
  type: { type: String, required: true },
  currency: { type: String, required: true },
  tripId: { type: String, default: null },
  driverId: { type: String, default: null },
  paymentId: { type: String, default: null },
  /** [{ account, driverId, debitMinor, creditMinor }] */
  entries: { type: mongoose.Schema.Types.Mixed, required: true },
  memo: { type: String, default: '' },
  reversalOf: { type: String, default: null },
  createdBy: { type: String, default: 'system' },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'ledger_transactions' });
ledgerTxnSchema.index({ tenantId: 1, eventKey: 1 }, { unique: true });
ledgerTxnSchema.index({ tenantId: 1, driverId: 1, createdAt: -1 });
ledgerTxnSchema.index({ tenantId: 1, tripId: 1 });

const LedgerTxn = mongoose.models.LedgerTxn || mongoose.model('LedgerTxn', ledgerTxnSchema);

/**
 * One payment attempt for a trip (see lib/payments/service.js).
 *   status         CREATED, PENDING, SUCCEEDED, FAILED, CANCELLED, EXPIRED: what the money did. Only the server moves it, and a
 *                  success only ever comes from a verified provider event (never from an app).
 *   refundStatus   NONE, REFUND_PENDING, PARTIALLY_REFUNDED, REFUNDED: kept apart from status, so a refunded payment still says it succeeded.
 *   cashState      cash only: PENDING (waiting for the driver to confirm), CONFIRMED, DISPUTED, ADJUSTED.
 *   live           true while CREATED, PENDING or SUCCEEDED; the unique index allows one live payment per trip and purpose, so two
 *                  taps can never open two payments for one fare.
 * The amount, the commission split and the driver are copied from the finalised trip when the payment is made; nothing a client sends
 * can change them. Amounts are whole minor units (paise).
 */
const paymentSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  paymentId: { type: String, required: true, unique: true },
  tripId: { type: String, required: true },
  riderId: { type: String, default: null },
  driverId: { type: String, default: null },
  purpose: { type: String, enum: ['FARE', 'COMMISSION'], default: 'FARE' },
  method: { type: String, enum: ['CASH', 'UPI'], required: true },
  provider: { type: String, default: null },
  amountMinor: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true },
  status: { type: String, enum: ['CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'], default: 'CREATED' },
  refundStatus: { type: String, enum: ['NONE', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'], default: 'NONE' },
  refundedMinor: { type: Number, default: 0 },
  cashState: { type: String, enum: ['PENDING', 'CONFIRMED', 'DISPUTED', 'ADJUSTED', null], default: null },
  live: { type: Boolean, default: true },
  idempotencyKey: { type: String, required: true },
  providerOrderId: { type: String, default: null },
  providerPaymentId: { type: String, default: null },
  expiresAt: { type: Date, default: null },
  /** { rule, commissionMinor, netMinor }: the split fixed when the trip was finalised */
  commission: { type: mongoose.Schema.Types.Mixed, default: null },
  ledgerTxnId: { type: String, default: null },
  failureReason: { type: String, default: null },
  /** what happened to it, in order: [{ at, status, by, note }] */
  history: { type: mongoose.Schema.Types.Mixed, default: [] },
  flags: { type: mongoose.Schema.Types.Mixed, default: [] },
  /** refund bookkeeping: { reservedMinor, processedMinor, commissionMinor, netMinor } (reserved includes refunds still pending) */
  refund: { type: mongoose.Schema.Types.Mixed, default: null },
  /** cash only: { collectedMinor, confirmedAt, confirmedBy, dispute: { by, reason, at }, resolution: { by, action, reason, at } } */
  cash: { type: mongoose.Schema.Types.Mixed, default: null },
  /** bumped on every change: an update names the version it read, so two writers cannot silently overwrite each other */
  version: { type: Number, default: 0 },
  succeededAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'payments' });
paymentSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
paymentSchema.index({ tenantId: 1, tripId: 1, purpose: 1 }, { unique: true, partialFilterExpression: { live: true } });
paymentSchema.index({ provider: 1, providerOrderId: 1 });
paymentSchema.index({ tenantId: 1, driverId: 1, createdAt: -1 });

/** Every provider event received, once: a unique (provider, eventId) is how a webhook delivered twice is recognised. */
const paymentEventSchema = new mongoose.Schema({
  provider: { type: String, required: true },
  eventId: { type: String, required: true },
  tenantId: { type: String, default: null },
  paymentId: { type: String, default: null },
  type: { type: String, default: null },
  /** APPLIED, IGNORED_STALE, REJECTED_MISMATCH, UNKNOWN_ORDER, FAILED_VERIFICATION */
  outcome: { type: String, default: null },
  detail: { type: String, default: null },
  payloadHash: { type: String, default: null },
  receivedAt: { type: Date, default: Date.now }
}, { collection: 'payment_events' });
paymentEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
paymentEventSchema.index({ tenantId: 1, paymentId: 1 });

const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
const PaymentEvent = mongoose.models.PaymentEvent || mongoose.model('PaymentEvent', paymentEventSchema);

/**
 * A refund of an online payment, kept as its own record (the payment's `refundStatus` summarises these). REQUESTED until the provider
 * confirms, then PROCESSED (the ledger is posted) or FAILED (nothing is posted and the amount can be refunded again). A unique key per
 * business makes a repeated request return the same refund. `commissionMinor` and `netMinor` are how the refund is shared between the
 * business's commission and the driver's earnings.
 */
const refundSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  refundId: { type: String, required: true, unique: true },
  paymentId: { type: String, required: true },
  tripId: { type: String, default: null },
  driverId: { type: String, default: null },
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true },
  commissionMinor: { type: Number, default: 0 },
  netMinor: { type: Number, default: 0 },
  duplicateCapture: { type: Boolean, default: false },
  status: { type: String, enum: ['REQUESTED', 'PROCESSED', 'FAILED'], default: 'REQUESTED' },
  reason: { type: String, default: '' },
  requestedBy: { type: String, default: null },
  idempotencyKey: { type: String, required: true },
  providerRefundId: { type: String, default: null },
  failureReason: { type: String, default: null },
  ledgerTxnId: { type: String, default: null },
  processedAt: { type: Date, default: null },
  version: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'payment_refunds' });
refundSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
refundSchema.index({ tenantId: 1, paymentId: 1 });
const PaymentRefund = mongoose.models.PaymentRefund || mongoose.model('PaymentRefund', refundSchema);

module.exports = { LedgerTxn, Payment, PaymentEvent, PaymentRefund };
