const mongoose = require('../lib/db/mongoose');

/**
 * What the platform owner (AutoMet) charges businesses for using the platform: plans, invoices and platform settings.
 * Not the businesses' own rides, fares or earnings. A business's subscription lives on its tenant record (`subscription`).
 */

const planSchema = new mongoose.Schema({
  planId: { type: String, required: true, unique: true },
  name: { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '', trim: true },
  price: { type: Number, required: true, min: 0 }, // per billing cycle, in the platform currency
  cycle: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
  setupFee: { type: Number, default: 0, min: 0 }, // one-time onboarding fee
  trialDays: { type: Number, default: null }, // null: use the platform default
  active: { type: Boolean, default: true } // an inactive plan cannot be assigned to new subscriptions; existing ones keep it
}, { collection: 'platform_plans', timestamps: true });

// amount is what was given back (tax included); exTax and tax split it in the invoice's proportion, for the revenue figures
// number: the credit note issued for this refund (CN-000001); cgst/sgst/igst split the tax portion the way the invoice did
const refundSchema = new mongoose.Schema({ at: Date, number: String, amount: Number, exTax: Number, tax: Number, cgst: Number, sgst: Number, igst: Number, reason: String, by: String }, { _id: false });

const invoiceSchema = new mongoose.Schema({
  invoiceId: { type: String, required: true, unique: true },
  number: { type: String, required: true, unique: true }, // INV-000001
  tenantId: { type: String, required: true, index: true },
  type: { type: String, enum: ['subscription', 'setup_fee', 'other'], default: 'subscription' },
  description: { type: String, default: 'Platform subscription' },
  periodStart: { type: Date, default: null },
  periodEnd: { type: Date, default: null },
  /** the taxable value (before GST). What the client pays is `total`; invoices without tax have total = amount. */
  amount: { type: Number, required: true, min: 0 },
  taxRate: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  total: { type: Number, default: null },
  sac: { type: String, default: '' },
  /** seller and buyer exactly as they were when the invoice was issued (later edits never change an issued invoice) */
  seller: { type: mongoose.Schema.Types.Mixed, default: null },
  buyer: { type: mongoose.Schema.Types.Mixed, default: null },
  notes: { type: String, default: '' },
  remindersSent: { type: [Number], default: [] },
  lapsedAt: { type: Date, default: null },
  emailedAt: { type: Date, default: null },
  currency: { type: String, required: true },
  status: { type: String, enum: ['issued', 'paid', 'void'], default: 'issued', index: true },
  issuedAt: { type: Date, default: Date.now },
  dueDate: { type: Date, required: true },
  paidAt: { type: Date, default: null },
  paymentMethod: { type: String, default: null },
  reference: { type: String, default: '' },
  /** money given back after payment; the invoice stays "paid" and keeps its amount */
  refundedAmount: { type: Number, default: 0 },
  refunds: { type: [refundSchema], default: [] },
  voidedAt: { type: Date, default: null },
  voidReason: { type: String, default: '' },
  createdBy: { type: String, default: null }
}, { collection: 'platform_invoices', timestamps: true });
invoiceSchema.index({ tenantId: 1, issuedAt: -1 });

/** Sequence numbers: invoice numbers never repeat, even when two invoices are issued at once. */
const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 }
}, { collection: 'platform_counters' });

/** One document (key "platform"): defaults used when billing a business. */
const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  companyName: { type: String, default: '' },
  billingEmail: { type: String, default: '' },
  invoiceDueDays: { type: Number, default: 14 },
  defaultTrialDays: { type: Number, default: 14 },
  invoiceNotes: { type: String, default: '' },
  /** the platform's own legal and GST details; with no GSTIN no tax is charged */
  legalName: { type: String, default: '' },
  gstin: { type: String, default: '' },
  address: { type: String, default: '' },
  stateCode: { type: String, default: '' },
  sac: { type: String, default: '998314' },
  gstRate: { type: Number, default: 18 },
  /** overdue handling: reminder days relative to the due date, grace before an invoice lapses, and what a lapse does */
  reminderOffsets: { type: [Number], default: [-3, 1, 7] },
  graceDays: { type: Number, default: 15 },
  lapseAction: { type: String, enum: ['none', 'cancel', 'suspend'], default: 'none' },
  lastRunAt: { type: Date, default: null }
}, { collection: 'platform_settings', timestamps: true });

const reuse = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

module.exports = {
  PlatformPlan: reuse('PlatformPlan', planSchema),
  PlatformInvoice: reuse('PlatformInvoice', invoiceSchema),
  PlatformCounter: reuse('PlatformCounter', counterSchema),
  PlatformSettings: reuse('PlatformSettings', settingsSchema)
};
