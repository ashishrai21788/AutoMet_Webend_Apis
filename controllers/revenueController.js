/**
 * Platform billing for the platform owner: plans, each business's subscription, invoices, payments, refunds, settings
 * and the revenue totals. This is what businesses pay AutoMet, never a business's own ride money. Billing events are
 * written to the platform audit log (no business tag), so a business's admins never see them in their own log.
 */
const crypto = require('crypto');
const { Tenant, AdminAudit } = require('../models/adminModels');
const { PlatformPlan, PlatformInvoice, PlatformCounter, PlatformSettings } = require('../models/platformBilling');
const rev = require('../lib/revenue');
const { toCsv, sendCsv } = require('../lib/csv');
const { escapeRegex } = require('../lib/auditQuery');
const c = require('./fleet/common');

const CURRENCY = () => String(process.env.PLATFORM_CURRENCY || 'INR').toUpperCase();
const MAX = 20000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SETTINGS_KEY = 'platform';

async function audit(req, action, targetType, targetId, meta) {
  try {
    await AdminAudit.create({ tenantId: null, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType, targetId, meta, ip: req.ip || null });
  } catch (e) { console.warn('[revenue] audit write failed:', e.message); }
}

const newId = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;

async function loadSettings() {
  const s = await PlatformSettings.findOne({ key: SETTINGS_KEY }).lean();
  return { companyName: '', billingEmail: '', invoiceDueDays: 14, defaultTrialDays: 14, invoiceNotes: '', ...(s || {}) };
}

const settingsShape = (s) => ({ companyName: s.companyName || '', billingEmail: s.billingEmail || '', invoiceDueDays: s.invoiceDueDays, defaultTrialDays: s.defaultTrialDays, invoiceNotes: s.invoiceNotes || '', currency: CURRENCY() });

async function nameMap() {
  const tenants = await Tenant.find({}).select('tenantId name').lean();
  return new Map(tenants.map((t) => [t.tenantId, t.name]));
}

const planShape = (p, subscribers = 0) => ({ id: p.planId, name: p.name, description: p.description || '', price: p.price, cycle: p.cycle, setupFee: p.setupFee || 0, trialDays: p.trialDays ?? null, active: p.active !== false, currency: CURRENCY(), subscribers });

const subscriptionShape = (t) => {
  const s = t.subscription;
  if (!s) return null;
  return { planId: s.planId || null, planName: s.planName || null, price: s.price, cycle: s.cycle, currency: CURRENCY(), setupFee: s.setupFee || 0, status: s.status, startDate: s.startDate || null, trialEndsAt: s.trialEndsAt || null, renewalDate: s.renewalDate || null, cancelledAt: s.cancelledAt || null, cancelReason: s.cancelReason || '', notes: s.notes || '', recurring: rev.isRecurring(t) };
};

const invoiceShape = (i, names) => ({
  id: i.invoiceId, number: i.number, appId: i.tenantId, businessName: names.get(i.tenantId) || i.tenantId, type: i.type || 'subscription', description: i.description,
  periodStart: i.periodStart || null, periodEnd: i.periodEnd || null, amount: i.amount, currency: i.currency, status: i.status,
  overdue: rev.isOverdue(i, new Date()), issuedAt: i.issuedAt, dueDate: i.dueDate, paidAt: i.paidAt || null, paymentMethod: i.paymentMethod || null, reference: i.reference || '',
  refundedAmount: i.refundedAmount || 0, refunds: (i.refunds || []).map((r) => ({ at: r.at, amount: r.amount, reason: r.reason, by: r.by })), netPaid: rev.netPaid(i),
  voidedAt: i.voidedAt || null, voidReason: i.voidReason || ''
});

// ---------------------------------------------------------------- summary

exports.summary = c.handle(async (req, res) => {
  const now = new Date();
  let from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  let to = now;
  if (req.query.from || req.query.to) {
    const f = String(req.query.from || ''); const t = String(req.query.to || '');
    if (req.query.from && (!DAY_RE.test(f) || Number.isNaN(Date.parse(`${f}T00:00:00Z`)))) return c.invalid(res, { from: 'Use a date like 2026-10-04' });
    if (req.query.to && (!DAY_RE.test(t) || Number.isNaN(Date.parse(`${t}T00:00:00Z`)))) return c.invalid(res, { to: 'Use a date like 2026-10-04' });
    if (req.query.from) from = new Date(`${f}T00:00:00.000Z`);
    if (req.query.to) to = new Date(`${t}T23:59:59.999Z`);
    if (to < from) return c.invalid(res, { to: 'The end date is before the start date' });
  }
  const [tenants, invoices, plans] = await Promise.all([Tenant.find({}).lean(), PlatformInvoice.find({}).limit(MAX).lean(), PlatformPlan.find({}).lean()]);
  const s = rev.summarize({ tenants, invoices, plans, now, from, to });
  return c.ok(res, { ...s, currency: CURRENCY(), range: { from: from.toISOString(), to: to.toISOString() }, generatedAt: now.toISOString(), partial: invoices.length >= MAX });
});

// ---------------------------------------------------------------- plans

exports.listPlans = c.handle(async (req, res) => {
  const [plans, tenants] = await Promise.all([PlatformPlan.find({}).sort({ price: 1 }).lean(), Tenant.find({}).select('subscription').lean()]);
  const count = (id) => tenants.filter((t) => t.subscription && t.subscription.planId === id && ['active', 'trialing'].includes(t.subscription.status)).length;
  return c.ok(res, plans.map((p) => planShape(p, count(p.planId))));
});

exports.createPlan = c.handle(async (req, res) => {
  const { value, errors } = rev.validatePlan(req.body);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  try {
    const plan = await PlatformPlan.create({ planId: newId('plan'), description: '', setupFee: 0, trialDays: null, active: true, ...value });
    await audit(req, 'plan.created', 'plan', plan.planId, { name: plan.name, price: plan.price, cycle: plan.cycle });
    return c.ok(res, planShape(plan), 201);
  } catch (e) {
    if (c.DUP(e)) return c.fail(res, 409, 'A plan with that name already exists', { name: 'A plan with that name already exists' });
    throw e;
  }
});

/** PATCH /platform/plans/:id: a price change affects new subscriptions only; each business keeps the price it agreed. */
exports.updatePlan = c.handle(async (req, res) => {
  const { value, errors } = rev.validatePlan(req.body, { partial: true });
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const existing = await PlatformPlan.findOne({ planId: req.params.id }).lean();
  if (!existing) return c.fail(res, 404, 'Plan not found');
  const before = { name: existing.name, price: existing.price, cycle: existing.cycle, active: existing.active };
  try {
    const plan = await PlatformPlan.findOneAndUpdate({ planId: req.params.id }, { $set: value }, { new: true });
    await audit(req, 'plan.updated', 'plan', plan.planId, { name: plan.name, price: value.price !== undefined ? `${before.price} -> ${value.price}` : undefined, active: value.active !== undefined ? String(value.active) : undefined });
    return c.ok(res, planShape(plan));
  } catch (e) {
    if (c.DUP(e)) return c.fail(res, 409, 'A plan with that name already exists', { name: 'A plan with that name already exists' });
    throw e;
  }
});

// ---------------------------------------------------------------- one business's subscription and billing

exports.getBilling = c.handle(async (req, res) => {
  const t = await Tenant.findOne({ tenantId: req.params.id }).lean();
  if (!t) return c.fail(res, 404, 'Business not found');
  const invoices = await PlatformInvoice.find({ tenantId: t.tenantId }).sort({ issuedAt: -1 }).limit(200).lean();
  const names = new Map([[t.tenantId, t.name]]);
  const mine = invoices.filter((i) => i.status !== 'void');
  const sum = (list, pick = (i) => i.amount) => Math.round(list.reduce((s, i) => s + (pick(i) || 0), 0) * 100) / 100;
  return c.ok(res, {
    subscription: subscriptionShape(t), businessStatus: t.status,
    totals: { billed: sum(mine), collected: sum(mine.filter((i) => i.status === 'paid')), refunded: sum(mine, (i) => i.refundedAmount), outstanding: sum(mine.filter((i) => i.status === 'issued')) },
    invoices: invoices.map((i) => invoiceShape(i, names))
  });
});

/**
 * PUT /tenants/:id/subscription  { planId, price?, startDate?, trial?, trialDays?, notes?, issueSetupInvoice? }
 * Assigns (or changes) the plan. The business keeps the agreed price even if the plan's list price changes later.
 * A trial makes the business a trial; a paid subscription makes it active (a suspended business stays suspended).
 */
exports.assignSubscription = c.handle(async (req, res) => {
  const tenant = await Tenant.findOne({ tenantId: req.params.id });
  if (!tenant) return c.fail(res, 404, 'Business not found');
  const plan = req.body && req.body.planId ? await PlatformPlan.findOne({ planId: String(req.body.planId) }).lean() : null;
  const settings = await loadSettings();
  const { value, errors } = rev.validateSubscription(req.body, plan, settings);
  if (Object.keys(errors).length) return c.invalid(res, errors);

  const previous = tenant.subscription ? { plan: tenant.subscription.planName, status: tenant.subscription.status } : null;
  tenant.subscription = value;
  if (tenant.status !== 'suspended') { tenant.status = value.status === 'trialing' ? 'trial' : 'active'; tenant.plan = value.status === 'trialing' ? 'trial' : 'standard'; }
  await tenant.save();

  let setupInvoice = null;
  if (req.body.issueSetupInvoice === true && value.setupFee > 0) {
    setupInvoice = await issue(req, tenant, { type: 'setup_fee', amount: value.setupFee }, settings);
  }
  await audit(req, previous ? 'subscription.changed' : 'subscription.assigned', 'tenant', tenant.tenantId, { plan: value.planName, status: value.status, price: value.price, from: previous ? `${previous.plan} (${previous.status})` : undefined, setupInvoice: setupInvoice ? setupInvoice.number : undefined });
  return c.ok(res, { subscription: subscriptionShape(tenant), setupInvoice: setupInvoice ? invoiceShape(setupInvoice, new Map([[tenant.tenantId, tenant.name]])) : null });
});

/** POST /tenants/:id/subscription/renew  { invoice? }: starts the next period (and converts a trial to a paid subscription). */
exports.renewSubscription = c.handle(async (req, res) => {
  const tenant = await Tenant.findOne({ tenantId: req.params.id });
  if (!tenant) return c.fail(res, 404, 'Business not found');
  const sub = tenant.subscription;
  if (!sub || sub.status === 'cancelled') return c.fail(res, 409, 'There is no active subscription to renew');
  const periodStart = sub.renewalDate ? new Date(sub.renewalDate) : new Date();
  const periodEnd = rev.addCycle(periodStart, sub.cycle);
  const wasTrial = sub.status === 'trialing';
  tenant.subscription = { ...(typeof sub.toObject === 'function' ? sub.toObject() : sub), status: 'active', renewalDate: periodEnd, trialEndsAt: wasTrial ? sub.trialEndsAt : sub.trialEndsAt || null };
  if (tenant.status !== 'suspended') { tenant.status = 'active'; tenant.plan = 'standard'; }
  await tenant.save();

  let invoice = null;
  if (req.body && req.body.invoice === true && sub.price > 0) {
    const settings = await loadSettings();
    invoice = await issue(req, tenant, { type: 'subscription', amount: sub.price, periodStart: periodStart.toISOString(), periodEnd: new Date(periodEnd.getTime() - 86400000).toISOString() }, settings);
  }
  await audit(req, wasTrial ? 'subscription.converted' : 'subscription.renewed', 'tenant', tenant.tenantId, { plan: sub.planName, until: periodEnd.toISOString().slice(0, 10), invoice: invoice ? invoice.number : undefined });
  return c.ok(res, { subscription: subscriptionShape(tenant), invoice: invoice ? invoiceShape(invoice, new Map([[tenant.tenantId, tenant.name]])) : null });
});

/** POST /tenants/:id/subscription/cancel  { reason }: it stops counting as recurring revenue. The business is not suspended by this. */
exports.cancelSubscription = c.handle(async (req, res) => {
  const reason = String((req.body && req.body.reason) || '').trim().replace(/\s+/g, ' ');
  if (reason.length < 5) return c.invalid(res, { reason: 'Give a reason of at least 5 characters' });
  if (reason.length > 300) return c.invalid(res, { reason: 'Keep the reason under 300 characters' });
  const tenant = await Tenant.findOne({ tenantId: req.params.id });
  if (!tenant) return c.fail(res, 404, 'Business not found');
  const sub = tenant.subscription;
  if (!sub || sub.status === 'cancelled') return c.fail(res, 409, 'There is no subscription to cancel');
  tenant.subscription = { ...(typeof sub.toObject === 'function' ? sub.toObject() : sub), status: 'cancelled', cancelledAt: new Date(), cancelReason: reason };
  await tenant.save();
  await audit(req, 'subscription.cancelled', 'tenant', tenant.tenantId, { plan: sub.planName, reason });
  return c.ok(res, { subscription: subscriptionShape(tenant) });
});

// ---------------------------------------------------------------- invoices

async function issue(req, tenant, input, settings) {
  const { value, errors } = rev.validateInvoice(input, { subscription: tenant.subscription, settings });
  if (Object.keys(errors).length) { const e = new Error('invoice invalid'); e.errors = errors; throw e; }
  const counter = await PlatformCounter.findOneAndUpdate({ key: 'invoice' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  const invoice = await PlatformInvoice.create({
    invoiceId: newId('inv'), number: `INV-${String(counter.seq).padStart(6, '0')}`, tenantId: tenant.tenantId, ...value,
    currency: CURRENCY(), status: 'issued', issuedAt: new Date(), createdBy: req.admin.email
  });
  await audit(req, 'invoice.issued', 'invoice', invoice.invoiceId, { number: invoice.number, business: tenant.tenantId, type: value.type, amount: value.amount });
  return invoice;
}

/** POST /tenants/:id/invoices { type?, amount?, periodStart, periodEnd, dueDate?, description? } */
exports.createInvoice = c.handle(async (req, res) => {
  const tenant = await Tenant.findOne({ tenantId: req.params.id }).lean();
  if (!tenant) return c.fail(res, 404, 'Business not found');
  const settings = await loadSettings();
  const check = rev.validateInvoice(req.body, { subscription: tenant.subscription, settings });
  if (Object.keys(check.errors).length) return c.invalid(res, check.errors);
  const invoice = await issue(req, tenant, req.body, settings);
  return c.ok(res, invoiceShape(invoice, new Map([[tenant.tenantId, tenant.name]])), 201);
});

function invoiceFilter(query) {
  const filter = {};
  const status = String(query.status || '').trim();
  if (status) { if (!['issued', 'paid', 'void'].includes(status)) return { errors: { status: 'Unknown status' } }; filter.status = status; }
  const type = String(query.type || '').trim();
  if (type) { if (!rev.INVOICE_TYPES.includes(type)) return { errors: { type: 'Unknown type' } }; filter.type = type; }
  const tenantId = String(query.tenantId || '').trim();
  if (tenantId) filter.tenantId = tenantId;
  const q = String(query.q || '').trim().slice(0, 60);
  if (q) filter.$or = [{ number: { $regex: escapeRegex(q), $options: 'i' } }, { description: { $regex: escapeRegex(q), $options: 'i' } }, { reference: { $regex: escapeRegex(q), $options: 'i' } }];
  if (query.overdue === '1') { filter.status = 'issued'; filter.dueDate = { $lt: new Date() }; }
  return { filter };
}

exports.listInvoices = c.handle(async (req, res) => {
  const { page, pageSize, skip } = c.pageParams(req.query);
  const { filter, errors } = invoiceFilter(req.query);
  if (errors) return c.invalid(res, errors);
  const [rows, total, names] = await Promise.all([PlatformInvoice.find(filter).sort({ issuedAt: -1 }).skip(skip).limit(pageSize).lean(), PlatformInvoice.countDocuments(filter), nameMap()]);
  return c.ok(res, { items: rows.map((i) => invoiceShape(i, names)), total, page, pageSize });
});

exports.invoicesCsv = c.handle(async (req, res) => {
  const { filter, errors } = invoiceFilter(req.query);
  if (errors) return c.invalid(res, errors);
  const [rows, names] = await Promise.all([PlatformInvoice.find(filter).sort({ issuedAt: -1 }).limit(MAX + 1).lean(), nameMap()]);
  const partial = rows.length > MAX;
  const items = (partial ? rows.slice(0, MAX) : rows).map((i) => invoiceShape(i, names));
  const csv = toCsv(items, [
    { header: 'Invoice', value: (i) => i.number }, { header: 'Business', value: (i) => i.businessName }, { header: 'App ID', value: (i) => i.appId }, { header: 'Type', value: (i) => i.type },
    { header: 'Description', value: (i) => i.description }, { header: 'Period start', value: (i) => i.periodStart }, { header: 'Period end', value: (i) => i.periodEnd },
    { header: 'Amount', value: (i) => i.amount }, { header: 'Currency', value: (i) => i.currency }, { header: 'Status', value: (i) => (i.overdue ? 'overdue' : i.status) },
    { header: 'Issued', value: (i) => i.issuedAt }, { header: 'Due', value: (i) => i.dueDate }, { header: 'Paid', value: (i) => i.paidAt }, { header: 'Payment method', value: (i) => i.paymentMethod },
    { header: 'Reference', value: (i) => i.reference }, { header: 'Refunded', value: (i) => i.refundedAmount }, { header: 'Net paid', value: (i) => i.netPaid }
  ]);
  await audit(req, 'export.invoices', 'export', null, { rows: items.length });
  res.set({ 'X-Row-Count': String(items.length), 'X-Truncated': String(partial) });
  return sendCsv(res, 'platform-invoices.csv', csv);
});

/** POST /invoices/:id/pay { paymentMethod, reference?, paidAt? }: an issued invoice, once (atomic). */
exports.payInvoice = c.handle(async (req, res) => {
  const { value, errors } = rev.validatePayment(req.body);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const existing = await PlatformInvoice.findOne({ invoiceId: req.params.id }).lean();
  if (!existing) return c.fail(res, 404, 'Invoice not found');
  const updated = await PlatformInvoice.findOneAndUpdate({ invoiceId: req.params.id, status: 'issued' }, { $set: { status: 'paid', paidAt: value.paidAt, paymentMethod: value.paymentMethod, reference: value.reference } }, { new: true });
  if (!updated) return c.fail(res, 409, `This invoice is already ${existing.status}`);
  await audit(req, 'invoice.paid', 'invoice', updated.invoiceId, { number: updated.number, method: value.paymentMethod, amount: updated.amount });
  return c.ok(res, invoiceShape(updated, await nameMap()));
});

/** POST /invoices/:id/void { reason }: only an invoice that is still unpaid. A paid one is refunded instead. */
exports.voidInvoice = c.handle(async (req, res) => {
  const reason = String((req.body && req.body.reason) || '').trim().replace(/\s+/g, ' ');
  if (reason.length < 5) return c.invalid(res, { reason: 'Give a reason of at least 5 characters' });
  if (reason.length > 300) return c.invalid(res, { reason: 'Keep the reason under 300 characters' });
  const existing = await PlatformInvoice.findOne({ invoiceId: req.params.id }).lean();
  if (!existing) return c.fail(res, 404, 'Invoice not found');
  const updated = await PlatformInvoice.findOneAndUpdate({ invoiceId: req.params.id, status: 'issued' }, { $set: { status: 'void', voidedAt: new Date(), voidReason: reason } }, { new: true });
  if (!updated) return c.fail(res, 409, existing.status === 'paid' ? 'A paid invoice cannot be voided. Refund it instead.' : `This invoice is already ${existing.status}`);
  await audit(req, 'invoice.voided', 'invoice', updated.invoiceId, { number: updated.number, reason });
  return c.ok(res, invoiceShape(updated, await nameMap()));
});

/** POST /invoices/:id/refund { amount, reason }: money given back on a paid invoice; the invoice stays paid, and more than the paid amount can never be refunded. */
exports.refundInvoice = c.handle(async (req, res) => {
  const existing = await PlatformInvoice.findOne({ invoiceId: req.params.id }).lean();
  if (!existing) return c.fail(res, 404, 'Invoice not found');
  if (existing.status !== 'paid') return c.fail(res, 409, existing.status === 'issued' ? 'Only a paid invoice can be refunded. Void an unpaid one instead.' : 'A voided invoice cannot be refunded');
  const { value, errors } = rev.validateRefund(req.body, existing);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  // atomic: only if the refunded total is still low enough, so two refunds at once cannot exceed the invoice
  const updated = await PlatformInvoice.findOneAndUpdate(
    { invoiceId: req.params.id, status: 'paid', refundedAmount: { $lte: Math.round((existing.amount - value.amount) * 100) / 100 } },
    { $inc: { refundedAmount: value.amount }, $push: { refunds: { at: new Date(), amount: value.amount, reason: value.reason, by: req.admin.email } } }, { new: true }
  );
  if (!updated) return c.fail(res, 409, 'The refund could not be applied because the invoice changed. Reload and try again.');
  await audit(req, 'invoice.refunded', 'invoice', updated.invoiceId, { number: updated.number, amount: value.amount, reason: value.reason });
  return c.ok(res, invoiceShape(updated, await nameMap()));
});

// ---------------------------------------------------------------- platform settings

exports.getSettings = c.handle(async (req, res) => c.ok(res, settingsShape(await loadSettings())));

exports.updateSettings = c.handle(async (req, res) => {
  const { value, errors } = rev.validateSettings(req.body);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  await PlatformSettings.findOneAndUpdate({ key: SETTINGS_KEY }, { $set: value, $setOnInsert: { key: SETTINGS_KEY } }, { new: true, upsert: true });
  await audit(req, 'platform.settings_updated', 'platform', SETTINGS_KEY, { fields: Object.keys(value).join(',') });
  return c.ok(res, settingsShape(await loadSettings()));
});
