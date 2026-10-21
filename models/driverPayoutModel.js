const mongoose = require('../lib/db/mongoose');

/**
 * A driver's withdrawal request and what became of it. Money is whole minor units (paise, cents) so sums never drift.
 *
 *   REQUESTED   the driver asked; waiting for the business
 *   PROCESSING  the business has started paying it
 *   PAID        the business paid it and recorded the bank reference (UTR)
 *   FAILED      the business could not pay it; the amount is back in the driver's balance
 *   CANCELLED   the driver withdrew the request before it was processed
 *
 * `open` is true while the request is REQUESTED or PROCESSING; a unique index on it allows one open request per driver, so two
 * taps (or two phones) can never withdraw the same balance twice.
 */
const driverPayoutSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  payoutId: { type: String, required: true, unique: true },
  driverId: { type: String, required: true, index: true },
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true },
  status: { type: String, enum: ['REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'], default: 'REQUESTED', index: true },
  open: { type: Boolean, default: true },
  /** the account at request time: only the bank name and the last four digits are ever kept here */
  bankLabel: { type: String, default: '' },
  accountLast4: { type: String, default: '' },
  reference: { type: String, default: '' }, // the bank's transaction reference (UTR), set when paid
  failureReason: { type: String, default: '' },
  note: { type: String, default: '' },
  requestedAt: { type: Date, default: Date.now },
  processingAt: { type: Date, default: null },
  paidAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  handledBy: { type: String, default: null }, // the admin who processed it
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'driver_payouts' });
driverPayoutSchema.index({ tenantId: 1, status: 1, requestedAt: -1 });
driverPayoutSchema.index({ tenantId: 1, driverId: 1 }, { unique: true, partialFilterExpression: { open: true } });

const DriverPayout = mongoose.models.DriverPayout || mongoose.model('DriverPayout', driverPayoutSchema);

module.exports = { DriverPayout };
