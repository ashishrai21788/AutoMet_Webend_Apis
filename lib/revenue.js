/**
 * AutoMet's own revenue: what businesses pay the platform. Pure functions over tenants (each carries a `subscription`),
 * plans and invoices. This is NEVER the businesses' ride fares, commissions or earnings, and none of those are counted here.
 *
 *   billed          invoices issued in the period (not voided)
 *   collected       invoices marked paid, by the day they were paid
 *   refunded        money given back, by the day it was refunded
 *   net collected   collected minus refunded
 *   outstanding     issued invoices not yet paid (as of now)
 *   overdue         outstanding invoices past their due date
 *   MRR / ARR       recurring revenue, only from ACTIVE paid subscriptions of businesses that are not suspended
 *                   (a trial, a cancelled subscription and a business with no subscription are not recurring revenue)
 *
 * There is no payment gateway: invoices are issued, and payments and refunds recorded, by the platform owner.
 */
const gst = require('./gst');
const round = (n) => Math.round(n * 100) / 100;
const DAY = 86400000;

const CYCLES = ['monthly', 'yearly'];
const PAYMENT_METHODS = ['bank_transfer', 'upi', 'card', 'cash', 'other'];
const INVOICE_TYPES = ['subscription', 'setup_fee', 'other'];
const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'cancelled'];

function addCycle(date, cycle) {
  const d = new Date(date);
  const months = cycle === 'yearly' ? 12 : 1;
  const day = d.getUTCDate();
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay)); // 31 January + 1 month is 28 or 29 February, not March
  return out;
}

const monthlyEquivalent = (sub) => (!sub || !(sub.price > 0) ? 0 : sub.cycle === 'yearly' ? sub.price / 12 : sub.price);

/** A business is recurring revenue only with an active, priced subscription, and while it is not suspended. */
const isRecurring = (t) => !!t.subscription && t.subscription.status === 'active' && t.subscription.price > 0 && t.status !== 'suspended';

const mrrOf = (tenants) => round(tenants.filter(isRecurring).reduce((s, t) => s + monthlyEquivalent(t.subscription), 0));

const monthKey = (d) => { const x = new Date(d); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`; };
function lastMonths(now, n = 12) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  return out;
}

const isOverdue = (inv, now) => inv.status === 'issued' && !!inv.dueDate && new Date(inv.dueDate) < now;
/** What the client owes or paid: the taxable value plus GST (older invoices have no tax, so it is the amount). */
const totalOf = (inv) => (inv.total != null ? inv.total : inv.amount || 0);
/** A refund's effect on revenue, which is counted before GST. */
const exTaxOf = (r) => (r.exTax != null ? r.exTax : r.amount || 0);
/** Cash kept from a paid invoice: what was paid minus what was given back, GST included. */
const netPaid = (inv) => (inv.status === 'paid' ? round(totalOf(inv) - (inv.refundedAmount || 0)) : 0);
const RENEWAL_WINDOW_DAYS = 30;

function summarize({ tenants, invoices, plans = [], now = new Date(), from, to }) {
  const live = invoices.filter((i) => i.status !== 'void');
  const inRange = (d) => !!d && (!from || new Date(d) >= from) && (!to || new Date(d) <= to);
  const sum = (list, pick = (i) => i.amount) => round(list.reduce((s, i) => s + (pick(i) || 0), 0));

  const billedList = live.filter((i) => inRange(i.issuedAt));
  const collectedList = live.filter((i) => i.status === 'paid' && inRange(i.paidAt));
  const refunds = live.flatMap((i) => (i.refunds || []).map((r) => ({ ...r, tenantId: i.tenantId }))).filter((r) => inRange(r.at));
  const outstandingList = live.filter((i) => i.status === 'issued');
  const overdueList = outstandingList.filter((i) => isOverdue(i, now));

  const months = lastMonths(now);
  const series = months.map((m) => {
    const billed = sum(live.filter((i) => i.issuedAt && monthKey(i.issuedAt) === m));
    const collected = sum(live.filter((i) => i.status === 'paid' && i.paidAt && monthKey(i.paidAt) === m));
    const refunded = sum(live.flatMap((i) => i.refunds || []).filter((r) => r.at && monthKey(r.at) === m), exTaxOf);
    return { month: m, billed, collected, refunded, net: round(collected - refunded) };
  });
  const acquisition = months.map((m) => ({ month: m, newBusinesses: tenants.filter((t) => t.createdAt && monthKey(t.createdAt) === m).length }));

  const subs = tenants.map((t) => t.subscription || null);
  const horizon = new Date(now.getTime() + RENEWAL_WINDOW_DAYS * DAY);
  const withRenewal = tenants.filter((t) => t.subscription && ['active', 'trialing'].includes(t.subscription.status) && t.subscription.renewalDate);
  const upcomingRenewals = withRenewal
    .filter((t) => new Date(t.subscription.renewalDate) >= now && new Date(t.subscription.renewalDate) <= horizon)
    .map((t) => ({ appId: t.tenantId, name: t.name, renewalDate: t.subscription.renewalDate, status: t.subscription.status, planName: t.subscription.planName || null, price: t.subscription.price, cycle: t.subscription.cycle }))
    .sort((a, b) => new Date(a.renewalDate) - new Date(b.renewalDate));
  const renewalsOverdue = withRenewal.filter((t) => new Date(t.subscription.renewalDate) < now).length;

  const byPlan = plans.map((p) => {
    const mine = tenants.filter((t) => t.subscription && t.subscription.planId === p.planId && ['active', 'trialing'].includes(t.subscription.status));
    return { planId: p.planId, name: p.name, price: p.price, cycle: p.cycle, active: p.active !== false, subscribers: mine.length, mrr: round(mine.filter(isRecurring).reduce((s, t) => s + monthlyEquivalent(t.subscription), 0)) };
  }).sort((a, b) => b.mrr - a.mrr || b.subscribers - a.subscribers || a.name.localeCompare(b.name));

  const byBusiness = tenants.map((t) => {
    const mine = live.filter((i) => i.tenantId === t.tenantId);
    const mineOut = mine.filter((i) => i.status === 'issued');
    const sub = t.subscription || null;
    return {
      appId: t.tenantId, name: t.name, status: t.status,
      subscriptionStatus: sub ? sub.status : 'none', planName: sub ? sub.planName || null : null,
      price: sub && sub.price > 0 ? sub.price : null, cycle: sub ? sub.cycle || null : null, mrr: isRecurring(t) ? round(monthlyEquivalent(sub)) : 0,
      renewalDate: sub ? sub.renewalDate || null : null,
      billed: sum(mine.filter((i) => inRange(i.issuedAt))), collected: sum(mine.filter((i) => i.status === 'paid' && inRange(i.paidAt))),
      refunded: sum(mine.flatMap((i) => i.refunds || []).filter((r) => inRange(r.at)), exTaxOf),
      outstanding: sum(mineOut, totalOf), overdue: sum(mineOut.filter((i) => isOverdue(i, now)), totalOf)
    };
  }).sort((a, b) => b.mrr - a.mrr || b.collected - a.collected || a.name.localeCompare(b.name));

  const collected = sum(collectedList);
  const refunded = sum(refunds, exTaxOf);
  const mrr = mrrOf(tenants);
  return {
    mrr, arr: round(mrr * 12),
    billed: sum(billedList), collected, refunded, netCollected: round(collected - refunded),
    outstanding: sum(outstandingList, totalOf), overdue: sum(overdueList, totalOf),
    gstCharged: sum(billedList, (i) => i.taxAmount), gstCollected: sum(collectedList, (i) => i.taxAmount),
    counts: {
      businesses: tenants.length, suspended: tenants.filter((t) => t.status === 'suspended').length,
      activeSubscriptions: subs.filter((s) => s && s.status === 'active').length, trialing: subs.filter((s) => s && s.status === 'trialing').length,
      cancelled: subs.filter((s) => s && s.status === 'cancelled').length, withoutSubscription: subs.filter((s) => !s).length,
      recurring: tenants.filter(isRecurring).length, renewalsDue: upcomingRenewals.length, renewalsOverdue,
      overdueInvoices: overdueList.length, outstandingInvoices: outstandingList.length
    },
    upcomingRenewals, byPlan, byBusiness, series, acquisition
  };
}

// ------------------------------------------------------------------ validation

const date = (v) => { const d = new Date(v); return v && !Number.isNaN(d.getTime()) ? d : null; };
const money = (v, { min = 0, allowZero = true } = {}) => { const n = Number(v); return Number.isFinite(n) && (allowZero ? n >= min : n > min) && n <= 100000000 ? round(n) : null; };

function validatePlan(input = {}, { partial = false } = {}) {
  const errors = {};
  const out = {};
  if (!partial || 'name' in input) { const v = String(input.name || '').trim(); if (v.length < 2 || v.length > 60) errors.name = 'Name must be 2 to 60 characters'; else out.name = v; }
  if ('description' in input) { const v = String(input.description || '').trim(); if (v.length > 300) errors.description = 'Keep the description under 300 characters'; else out.description = v; }
  if (!partial || 'price' in input) { const v = money(input.price); if (v === null) errors.price = 'The price must be a number, 0 or more'; else out.price = v; }
  if (!partial || 'cycle' in input) { if (!CYCLES.includes(String(input.cycle))) errors.cycle = 'Choose monthly or yearly'; else out.cycle = String(input.cycle); }
  if ('setupFee' in input) { const v = money(input.setupFee || 0); if (v === null) errors.setupFee = 'The setup fee must be a number, 0 or more'; else out.setupFee = v; }
  if ('trialDays' in input) {
    if (input.trialDays === null || input.trialDays === '') out.trialDays = null;
    else { const n = Number(input.trialDays); if (!Number.isInteger(n) || n < 0 || n > 365) errors.trialDays = 'Trial days must be a whole number from 0 to 365'; else out.trialDays = n; }
  }
  if ('active' in input) { if (typeof input.active !== 'boolean') errors.active = 'active must be true or false'; else out.active = input.active; }
  if (partial && Object.keys(out).length === 0 && Object.keys(errors).length === 0) errors.name = 'Nothing to update';
  return { value: out, errors };
}

/** Assigning a plan to a business. `plan` is the chosen plan record; `settings` supplies the default trial length. */
function validateSubscription(input = {}, plan, settings = {}, now = new Date()) {
  const errors = {};
  if (!plan) errors.planId = 'Choose a plan';
  else if (plan.active === false) errors.planId = 'That plan is not available for new subscriptions';
  let price = plan ? plan.price : null;
  if (input.price !== undefined && input.price !== '' && input.price !== null) { price = money(input.price); if (price === null) errors.price = 'The price must be a number, 0 or more'; }
  const startDate = input.startDate ? date(input.startDate) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (!startDate) errors.startDate = 'Enter a valid start date';
  const trial = input.trial === true;
  let trialDays = 0;
  if (trial) {
    const wanted = input.trialDays !== undefined && input.trialDays !== '' ? Number(input.trialDays) : (plan && plan.trialDays != null ? plan.trialDays : settings.defaultTrialDays ?? 14);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 365) errors.trialDays = 'Trial days must be a whole number from 1 to 365'; else trialDays = wanted;
  }
  const notes = String(input.notes || '').trim();
  if (notes.length > 500) errors.notes = 'Keep notes under 500 characters';
  if (Object.keys(errors).length) return { errors, value: {} };

  const status = trial ? 'trialing' : 'active';
  const trialEndsAt = trial ? new Date(startDate.getTime() + trialDays * DAY) : null;
  const renewalDate = trial ? trialEndsAt : addCycle(startDate, plan.cycle);
  return {
    errors,
    value: { planId: plan.planId, planName: plan.name, price, cycle: plan.cycle, setupFee: plan.setupFee || 0, status, startDate, trialEndsAt, renewalDate, notes, cancelledAt: null, cancelReason: '' }
  };
}

function validateInvoice(input = {}, { subscription = null, settings = {}, now = new Date() } = {}) {
  const errors = {};
  const out = {};
  const type = input.type === undefined ? 'subscription' : String(input.type);
  if (!INVOICE_TYPES.includes(type)) errors.type = 'Unknown invoice type'; else out.type = type;
  let amount = input.amount === undefined || input.amount === '' ? null : money(input.amount, { allowZero: false });
  if (input.amount !== undefined && input.amount !== '' && amount === null) errors.amount = 'Enter an amount greater than 0';
  if (amount === null && !errors.amount) amount = type === 'setup_fee' ? (subscription && subscription.setupFee) || null : type === 'subscription' ? (subscription && subscription.price) || null : null;
  if (!errors.amount && !(amount > 0)) errors.amount = 'Enter an amount greater than 0';
  else if (!errors.amount) out.amount = round(amount);
  out.periodStart = input.periodStart ? date(input.periodStart) : null;
  out.periodEnd = input.periodEnd ? date(input.periodEnd) : null;
  if (type === 'subscription') {
    if (!out.periodStart) errors.periodStart = 'Enter the first day this invoice covers';
    if (!out.periodEnd) errors.periodEnd = 'Enter the last day this invoice covers';
  }
  if (out.periodStart && out.periodEnd && out.periodEnd < out.periodStart) errors.periodEnd = 'The end is before the start';
  const dueDays = Number.isInteger(settings.invoiceDueDays) ? settings.invoiceDueDays : 14;
  out.dueDate = input.dueDate ? date(input.dueDate) : new Date(now.getTime() + dueDays * DAY);
  if (!out.dueDate) errors.dueDate = 'Enter the date payment is due';
  const description = String(input.description || '').trim();
  if (description.length > 200) errors.description = 'Keep the description under 200 characters';
  out.description = description || (type === 'setup_fee' ? 'Platform setup fee' : type === 'other' ? 'Platform charge' : 'Platform subscription');
  return { value: out, errors };
}

function validatePayment(input = {}, now = new Date()) {
  const errors = {};
  const method = String(input.paymentMethod || '');
  if (!PAYMENT_METHODS.includes(method)) errors.paymentMethod = 'Choose how it was paid';
  const reference = String(input.reference || '').trim();
  if (reference.length > 100) errors.reference = 'Keep the reference under 100 characters';
  let paidAt = now;
  if (input.paidAt) { paidAt = new Date(input.paidAt); if (Number.isNaN(paidAt.getTime())) errors.paidAt = 'Enter a valid date'; else if (paidAt > new Date(now.getTime() + DAY)) errors.paidAt = 'The payment date cannot be in the future'; }
  return { value: { paymentMethod: method, reference, paidAt }, errors };
}

/** A refund on a paid invoice: positive, and never more than what has not been refunded yet. */
function validateRefund(input = {}, invoice) {
  const errors = {};
  const remaining = round(totalOf(invoice) - (invoice.refundedAmount || 0));
  const amount = money(input.amount, { allowZero: false });
  if (amount === null) errors.amount = 'Enter an amount greater than 0';
  else if (amount > remaining) errors.amount = `At most ${remaining} can still be refunded`;
  const reason = String(input.reason || '').trim().replace(/\s+/g, ' ');
  if (reason.length < 5) errors.reason = 'Give a reason of at least 5 characters';
  else if (reason.length > 300) errors.reason = 'Keep the reason under 300 characters';
  return { value: { amount, reason, remaining }, errors };
}

function validateSettings(input = {}) {
  const errors = {};
  const out = {};
  for (const [f, max] of [['companyName', 100], ['billingEmail', 120], ['invoiceNotes', 500], ['legalName', 120], ['address', 300], ['sac', 10]]) {
    if (f in input) { const v = String(input[f] || '').trim(); if (v.length > max) errors[f] = `Keep this under ${max} characters`; else out[f] = v; }
  }
  if ('gstin' in input) {
    const v = String(input.gstin || '').trim().toUpperCase();
    if (v && !gst.isGstin(v)) errors.gstin = 'Enter a valid 15-character GSTIN';
    else { out.gstin = v; if (v) out.stateCode = gst.stateOfGstin(v); else if (!('stateCode' in input)) out.stateCode = ''; }
  }
  if ('stateCode' in input && !out.stateCode) { const v = String(input.stateCode || '').trim(); if (v && !gst.isStateCode(v)) errors.stateCode = 'Choose a state'; else out.stateCode = v; }
  if ('gstRate' in input) { const n = Number(input.gstRate); if (!Number.isFinite(n) || n < 0 || n > 40) errors.gstRate = 'Use a rate from 0 to 40'; else out.gstRate = n; }
  if ('graceDays' in input) { const n = Number(input.graceDays); if (!Number.isInteger(n) || n < 0 || n > 120) errors.graceDays = 'Use a whole number from 0 to 120'; else out.graceDays = n; }
  if ('lapseAction' in input) { if (!['none', 'cancel', 'suspend'].includes(String(input.lapseAction))) errors.lapseAction = 'Choose what a lapse does'; else out.lapseAction = String(input.lapseAction); }
  if ('reminderOffsets' in input) {
    const list = Array.isArray(input.reminderOffsets) ? input.reminderOffsets.map(Number) : String(input.reminderOffsets || '').split(',').map((x) => x.trim()).filter((x) => x !== '').map(Number);
    if (list.length > 8 || list.some((n) => !Number.isInteger(n) || n < -60 || n > 120)) errors.reminderOffsets = 'Use up to 8 whole numbers of days from -60 to 120, for example -3, 1, 7';
    else out.reminderOffsets = [...new Set(list)].sort((a, b) => a - b);
  }
  if (out.gstin && !(out.legalName || input.legalName)) { /* the legal name is checked when an invoice is issued */ }
  if (out.billingEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.billingEmail)) errors.billingEmail = 'Enter a valid email address';
  for (const [f, min, max] of [['invoiceDueDays', 0, 90], ['defaultTrialDays', 0, 365]]) {
    if (f in input) { const n = Number(input[f]); if (!Number.isInteger(n) || n < min || n > max) errors[f] = `Use a whole number from ${min} to ${max}`; else out[f] = n; }
  }
  if (Object.keys(out).length === 0 && Object.keys(errors).length === 0) errors.companyName = 'Nothing to update';
  return { value: out, errors };
}

/** Who is invoiced. A GSTIN fixes the state; without one the state must be chosen (it decides CGST+SGST or IGST). */
function validateBillingDetails(input = {}) {
  const errors = {};
  const out = {};
  const text = (f, max) => { const v = String(input[f] || '').trim().replace(/[ \t]+/g, ' '); if (v.length > max) errors[f] = `Keep this under ${max} characters`; else out[f] = v; };
  text('legalName', 120); text('address', 300);
  const email = String(input.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address'; else out.email = email;
  const g = String(input.gstin || '').trim().toUpperCase();
  if (g && !gst.isGstin(g)) errors.gstin = 'Enter a valid 15-character GSTIN'; else out.gstin = g;
  if (g && !errors.gstin) out.stateCode = gst.stateOfGstin(g);
  else { const sc = String(input.stateCode || '').trim(); if (sc && !gst.isStateCode(sc)) errors.stateCode = 'Choose a state'; else out.stateCode = sc; }
  return { value: out, errors };
}

module.exports = {
  totalOf, exTaxOf, validateBillingDetails,
  CYCLES, PAYMENT_METHODS, INVOICE_TYPES, SUBSCRIPTION_STATUSES, RENEWAL_WINDOW_DAYS,
  addCycle, monthlyEquivalent, isRecurring, mrrOf, lastMonths, monthKey, isOverdue, netPaid, summarize,
  validatePlan, validateSubscription, validateInvoice, validatePayment, validateRefund, validateSettings
};
