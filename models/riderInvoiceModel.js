const mongoose = require('../lib/db/mongoose');

/**
 * A rider's invoice for one trip: issued once, never edited. Everything printed on it is a snapshot taken when it was issued
 * (the business's name and tax details, the rider, the driver and vehicle, the route, and the fare lines), so editing a business,
 * a vehicle or a fare rule later never changes an invoice that already exists. Money is held in whole minor units (paise).
 */
const lineSchema = new mongoose.Schema({
  label: { type: String, required: true },
  amountMinor: { type: Number, required: true },
  kind: { type: String, enum: ['RIDE', 'FEE', 'TAX', 'DISCOUNT', 'TOLL', 'CANCELLATION'], default: 'RIDE' }
}, { _id: false });

const riderInvoiceSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  invoiceId: { type: String, required: true, unique: true },
  /** e.g. INV-2627-000123: numbered per business and financial year, never reused */
  invoiceNumber: { type: String, required: true },
  /** TRIP for a completed ride, CANCELLATION for the charge after a rider cancelled */
  type: { type: String, enum: ['TRIP', 'CANCELLATION'], default: 'TRIP' },
  tripId: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  driverId: { type: String, default: null },
  issuedAt: { type: Date, required: true },
  currency: { type: String, default: 'INR' },
  currencyDigits: { type: Number, default: 2 },

  /** the business that runs the service */
  business: { type: mongoose.Schema.Types.Mixed, required: true },
  rider: { type: mongoose.Schema.Types.Mixed, required: true },
  driver: { type: mongoose.Schema.Types.Mixed, default: null },
  trip: { type: mongoose.Schema.Types.Mixed, required: true },

  lines: { type: [lineSchema], required: true },
  subtotalMinor: { type: Number, required: true },
  taxMinor: { type: Number, default: 0 },
  totalMinor: { type: Number, required: true },
  paymentMode: { type: String, default: 'CASH' }
}, { collection: 'rider_invoices' });
riderInvoiceSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });
riderInvoiceSchema.index({ userId: 1, issuedAt: -1 });

module.exports = { RiderInvoice: mongoose.models.RiderInvoice || mongoose.model('RiderInvoice', riderInvoiceSchema) };
