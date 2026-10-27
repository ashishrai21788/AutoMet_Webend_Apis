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

module.exports = { LedgerTxn };
