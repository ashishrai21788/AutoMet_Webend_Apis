/**
 * The payment service: the one place that creates a payment, accepts a provider's word about it, and turns a verified success into
 * ledger entries. It knows nothing about which provider is used (lib/payments/adapters) and nothing about HTTP.
 *
 * Rules it enforces:
 *  - The amount, currency, driver and commission split come from the FINALISED trip (`trip.driver_earning`), never from a caller.
 *  - A payment becomes SUCCEEDED only from a provider message whose signature checks out AND that the provider itself confirms
 *    (`fetchPayment`) with the same order, amount, currency and merchant. An app saying "paid" is not an input to this module.
 *  - Every provider message is stored once by (provider, eventId); a repeat changes nothing. Older messages arriving late cannot undo a
 *    newer result. A success that arrives after the payment was marked failed or expired is real money: it is accepted and flagged.
 *  - The business is taken from the stored payment, never from the message or the caller.
 *  - A success is posted to the ledger once (event key per payment), whatever number of times it is delivered or refreshed.
 *  - Writes that change a payment name the status and version they read, so two requests cannot both win.
 */
const crypto = require('crypto');
const { Tenant } = require('../../models/adminModels');
const { TripDetails } = require('../../models/tripDetailsModel');
const { Payment, PaymentEvent } = require('../../models/paymentModels');
const ledger = require('../ledger');
const { ACCOUNTS: A } = ledger;
const { STATUS, canMove, sourcesFor } = require('./states');
const { tenantPayments, mockEnabled } = require('./config');
const { getAdapter } = require('./adapters');

const newId = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const dup = (e) => e && e.code === 11000;
const err = (code, message, status = 400, extra = {}) => Object.assign(new Error(message), { code, status, ...extra });
const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function loadTenant(tenantId) {
  const t = await Tenant.findOne({ tenantId }).lean();
  if (!t) throw err('NOT_FOUND', 'business not found', 404);
  return t;
}

/** The money facts of a finalised trip, or throws. */
function moneyOfTrip(trip) {
  const s = trip && trip.driver_earning;
  if (!s || !Number.isSafeInteger(s.fareMinor) || !Number.isSafeInteger(s.feeMinor) || !Number.isSafeInteger(s.netMinor)) throw err('TRIP_NOT_FINALISED', 'the fare of this trip is not final yet', 409);
  if (s.fareMinor <= 0) throw err('NOTHING_TO_PAY', 'this trip has no fare to pay', 409);
  if (s.feeMinor + s.netMinor !== s.fareMinor) throw err('FARE_SPLIT_INCONSISTENT', 'the commission split of this trip does not add up to its fare', 409);
  return { amountMinor: s.fareMinor, currency: s.currency || trip.currency || 'INR', commissionMinor: s.feeMinor, netMinor: s.netMinor, rule: { percent: s.percent == null ? null : s.percent } };
}

const push = (payment, status, by, note) => [...(payment.history || []), { at: new Date(), status, by, note: note || null }];

/** Conditionally move a payment: it must still be in a status that may move to `to`, at the version we read. -> the updated payment or null. */
async function move(payment, to, { by = 'system', note = null, set = {} } = {}) {
  if (!canMove(payment.status, to)) return null;
  const updated = await Payment.findOneAndUpdate(
    { paymentId: payment.paymentId, tenantId: payment.tenantId, status: { $in: sourcesFor(to) }, version: payment.version || 0 },
    { $set: { status: to, live: to === STATUS.SUCCEEDED || to === STATUS.PENDING || to === STATUS.CREATED, history: push(payment, to, by, note), updatedAt: new Date(), version: (payment.version || 0) + 1, ...set } },
    { new: true }
  );
  return updated ? (updated.toObject ? updated.toObject() : updated) : null;
}

/** Add a review flag without changing the status. Best effort: a lost race here only means the flag is added by the winner. */
async function flag(payment, reason) {
  await Payment.findOneAndUpdate(
    { paymentId: payment.paymentId, tenantId: payment.tenantId, version: payment.version || 0 },
    { $set: { flags: [...(payment.flags || []), { at: new Date(), reason }], version: (payment.version || 0) + 1, updatedAt: new Date() } }
  );
}

const lean = (d) => (d && d.toObject ? d.toObject() : d);
const find = async (filter) => lean(await Payment.findOne(filter).lean());

/**
 * Open (or reopen) the online payment of a finalised trip. Safe to repeat: the same idempotency key, or a payment already open for the
 * trip, returns that payment instead of opening another.
 * -> { payment, created, checkout }
 */
async function createPayment({ tenantId, tripId, riderId, method = 'UPI', idempotencyKey, env = process.env, now = new Date() }) {
  if (method !== 'UPI') throw err('UNSUPPORTED_METHOD', 'only UPI is paid online', 400);
  const tenant = await loadTenant(tenantId);
  const cfg = tenantPayments(tenant);
  if (!cfg.enabledMethods.includes('UPI') || !cfg.provider) throw err('METHOD_NOT_ENABLED', 'online payment is not enabled for this business', 403);

  const trip = await TripDetails.findOne({ trip_id: String(tripId), tenant_id: tenantId }).lean();
  if (!trip || (riderId && trip.user_id !== riderId)) throw err('NOT_FOUND', 'ride not found', 404);
  if (trip.status !== 'COMPLETED') throw err('TRIP_NOT_COMPLETED', 'a ride is paid once it is completed', 409);
  if (trip.payment_status === 'PAID') throw err('ALREADY_PAID', 'this ride is already paid', 409);
  const money = moneyOfTrip(trip);

  const key = idempotencyKey ? String(idempotencyKey).slice(0, 80) : null;
  if (key) {
    const same = await find({ tenantId, idempotencyKey: key });
    if (same) {
      if (same.tripId !== String(tripId)) throw err('IDEMPOTENCY_KEY_REUSED', 'this idempotency key belongs to another payment', 409);
      return { payment: same, created: false };
    }
  }
  const open = await find({ tenantId, tripId: String(tripId), purpose: 'FARE', live: true });
  if (open && open.method === 'CASH') {
    // the rider chose to pay online after all: a cash payment still waiting for the driver gives way; a confirmed or disputed one does not
    if (open.status === STATUS.SUCCEEDED) throw err('ALREADY_PAID', 'this ride is already paid in cash', 409);
    if (open.cashState !== 'PENDING') throw err('PAYMENT_IN_DISPUTE', 'the cash payment for this ride is in dispute', 409);
    if (!(await move(open, STATUS.CANCELLED, { by: 'rider', note: 'rider chose to pay online' }))) throw err('PAYMENT_CHANGED', 'the payment changed; try again', 409);
  } else if (open) {
    if (open.status === STATUS.SUCCEEDED) throw err('ALREADY_PAID', 'this ride is already paid', 409);
    return { payment: open, created: false };
  }

  const adapter = getAdapter(cfg.provider, env);
  const paymentId = newId('pay');
  let payment;
  try {
    payment = lean(await Payment.create({
      tenantId, paymentId, tripId: String(tripId), riderId: trip.user_id, driverId: trip.driver_id || null, purpose: 'FARE', method: 'UPI', provider: adapter.name,
      amountMinor: money.amountMinor, currency: money.currency, status: STATUS.CREATED, live: true, idempotencyKey: key || `auto:${paymentId}`,
      commission: { rule: money.rule, commissionMinor: money.commissionMinor, netMinor: money.netMinor }, history: [{ at: now, status: STATUS.CREATED, by: 'rider', note: null }]
    }));
  } catch (e) {
    if (!dup(e)) throw e;
    const again = (key && await find({ tenantId, idempotencyKey: key })) || await find({ tenantId, tripId: String(tripId), purpose: 'FARE', live: true });
    if (!again) throw e;
    return { payment: again, created: false };
  }

  let order;
  try {
    order = await adapter.createOrder({ paymentId, amountMinor: money.amountMinor, currency: money.currency, merchantId: cfg.merchantId || undefined });
  } catch (e) {
    await move(payment, STATUS.FAILED, { by: 'system', note: `provider could not create the order: ${e.code || e.message}`, set: { failureReason: 'PROVIDER_ERROR' } });
    throw err('PROVIDER_ERROR', 'the payment provider could not start this payment', 502);
  }
  const expiresAt = order.expiresAt || new Date(now.getTime() + cfg.paymentWindowMinutes * 60000);
  const pending = await move(payment, STATUS.PENDING, { by: 'system', set: { providerOrderId: order.providerOrderId, expiresAt } });
  return { payment: pending || (await find({ paymentId })), created: true, checkout: order.checkout };
}

/**
 * Post a succeeded payment to the ledger and the trip. Idempotent: safe to run again (repairs a success whose posting was interrupted).
 * If the same trip has another succeeded payment that came first (the rider paid twice, e.g. a late success on an earlier attempt), this
 * one is a DUPLICATE: the money is real but the driver and the commission are not credited again; it is booked as owed back to the rider.
 */
async function postSuccess(payment) {
  if (payment.purpose === 'COMMISSION') return postCommissionPayment(payment);
  const c = payment.commission || {};
  const commission = c.commissionMinor || 0;
  const net = c.netMinor == null ? payment.amountMinor - commission : c.netMinor;
  const mine = payment.succeededAt ? new Date(payment.succeededAt).getTime() : 0;
  const others = ((await Payment.find({ tenantId: payment.tenantId, tripId: payment.tripId, purpose: 'FARE', status: STATUS.SUCCEEDED }).lean()) || []).filter((o) => o.paymentId !== payment.paymentId);
  const earlier = others.some((o) => { const t = o.succeededAt ? new Date(o.succeededAt).getTime() : 0; return t < mine || (t === mine && o.paymentId < payment.paymentId); });
  const entries = [{ account: A.GATEWAY_CLEARING, debitMinor: payment.amountMinor }];
  if (earlier) {
    entries.push({ account: A.REFUND_CLEARING, creditMinor: payment.amountMinor });
  } else {
    if (net > 0) entries.push({ account: A.DRIVER_PAYABLE, driverId: payment.driverId, creditMinor: net });
    if (commission > 0) entries.push({ account: A.COMMISSION_REVENUE, creditMinor: commission });
  }
  const posted = await ledger.post({
    tenantId: payment.tenantId, eventKey: `payment:${payment.paymentId}:captured`, type: earlier ? 'DUPLICATE_FARE_CAPTURED' : 'ONLINE_FARE_CAPTURED', currency: payment.currency,
    tripId: payment.tripId, driverId: payment.driverId, paymentId: payment.paymentId, entries, memo: earlier ? 'Second payment for an already paid ride: owed back to the rider' : 'Online fare captured'
  });
  await Payment.findOneAndUpdate({ paymentId: payment.paymentId, tenantId: payment.tenantId, ledgerTxnId: null }, { $set: { ledgerTxnId: posted.txnId, updatedAt: new Date() } });
  if (!earlier) {
    await TripDetails.updateOne({ trip_id: payment.tripId, tenant_id: payment.tenantId }, { $set: { payment_status: 'PAID', payment_mode: 'UPI', payment_id: payment.paymentId, paid_at: payment.succeededAt || new Date() } });
    // the driver's earnings just rose: take back any commission they owe from cash fares, if the business's policy allows it
    try { await require('./recovery').recoverCommission({ tenantId: payment.tenantId, driverId: payment.driverId, trigger: 'auto', currency: payment.currency }); } catch (e) { console.warn('[payments] commission recovery not run for', payment.paymentId, e.message); }
  }
  return { ...posted, duplicateCapture: earlier };
}

/** A driver's own online payment of commission they owe: reduces what they owe, once. Idempotent. */
async function postCommissionPayment(payment) {
  const posted = await ledger.post({
    tenantId: payment.tenantId, eventKey: `payment:${payment.paymentId}:captured`, type: 'COMMISSION_PAID_DIRECT', currency: payment.currency, driverId: payment.driverId, paymentId: payment.paymentId,
    entries: [{ account: A.GATEWAY_CLEARING, debitMinor: payment.amountMinor }, { account: A.DRIVER_COMMISSION_RECEIVABLE, driverId: payment.driverId, creditMinor: payment.amountMinor }],
    memo: 'Commission paid directly by the driver'
  });
  await Payment.findOneAndUpdate({ paymentId: payment.paymentId, tenantId: payment.tenantId, ledgerTxnId: null }, { $set: { ledgerTxnId: posted.txnId, updatedAt: new Date() } });
  return posted;
}

/**
 * The driver pays some or all of the commission they owe (from cash fares) through the business's online payment provider. The amount may
 * not exceed what is owed minus commission payments already open, so a driver cannot overpay by tapping twice. Safe to repeat by key.
 * -> { payment, created, checkout }
 */
async function createCommissionPayment({ tenantId, driverId, amountMinor, idempotencyKey, env = process.env, now = new Date() }) {
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw err('BAD_AMOUNT', 'the amount must be a whole, positive number of minor units', 400);
  const tenant = await loadTenant(tenantId);
  const cfg = tenantPayments(tenant);
  if (!cfg.enabledMethods.includes('UPI') || !cfg.provider) throw err('METHOD_NOT_ENABLED', 'online payment is not enabled for this business', 403);
  const key = idempotencyKey ? String(idempotencyKey).slice(0, 80) : null;
  if (key) {
    const same = await find({ tenantId, idempotencyKey: key });
    if (same) {
      if (same.purpose !== 'COMMISSION' || same.driverId !== driverId) throw err('IDEMPOTENCY_KEY_REUSED', 'this idempotency key belongs to another payment', 409);
      return { payment: same, created: false };
    }
  }
  const owed = await ledger.commissionOutstanding({ tenantId, driverId });
  if (owed <= 0) throw err('NOTHING_OWED', 'this driver owes no commission', 409);
  const open = (await Payment.find({ tenantId, driverId, purpose: 'COMMISSION', status: { $in: [STATUS.CREATED, STATUS.PENDING] } }).lean()) || [];
  const reserved = open.reduce((n, p) => n + p.amountMinor, 0);
  if (amountMinor > owed - reserved) throw err('AMOUNT_TOO_HIGH', `at most ${Math.max(0, owed - reserved)} can be paid now`, 409);

  const adapter = getAdapter(cfg.provider, env);
  const paymentId = newId('pay');
  let payment;
  try {
    payment = lean(await Payment.create({
      tenantId, paymentId, tripId: `commission:${paymentId}`, riderId: null, driverId, purpose: 'COMMISSION', method: 'UPI', provider: adapter.name, amountMinor, currency: 'INR',
      status: STATUS.CREATED, live: true, idempotencyKey: key || `auto:${paymentId}`, history: [{ at: now, status: STATUS.CREATED, by: 'driver', note: null }]
    }));
  } catch (e) {
    if (!dup(e)) throw e;
    const again = key && await find({ tenantId, idempotencyKey: key });
    if (!again) throw e;
    return { payment: again, created: false };
  }
  let order;
  try {
    order = await adapter.createOrder({ paymentId, amountMinor, currency: payment.currency, merchantId: cfg.merchantId || undefined });
  } catch (e) {
    await move(payment, STATUS.FAILED, { by: 'system', note: `provider could not create the order: ${e.code || e.message}`, set: { failureReason: 'PROVIDER_ERROR' } });
    throw err('PROVIDER_ERROR', 'the payment provider could not start this payment', 502);
  }
  const expiresAt = order.expiresAt || new Date(now.getTime() + cfg.paymentWindowMinutes * 60000);
  const pending = await move(payment, STATUS.PENDING, { by: 'system', set: { providerOrderId: order.providerOrderId, expiresAt } });
  return { payment: pending || (await find({ paymentId })), created: true, checkout: order.checkout };
}

/** Confirm with the provider that this payment was really made, for the right amount, currency and merchant. -> { ok, reason } */
async function confirmWithProvider(payment, adapter, cfg) {
  if (!adapter.capabilities || !adapter.capabilities.serverVerification) return { ok: false, reason: 'PROVIDER_CANNOT_VERIFY' };
  const seen = await adapter.fetchPayment(payment.providerOrderId);
  if (!seen) return { ok: false, reason: 'ORDER_UNKNOWN_TO_PROVIDER' };
  if (seen.status !== 'paid') return { ok: false, reason: `PROVIDER_SAYS_${String(seen.status).toUpperCase()}` };
  if (seen.amountMinor !== payment.amountMinor) return { ok: false, reason: 'AMOUNT_MISMATCH' };
  if (seen.currency !== payment.currency) return { ok: false, reason: 'CURRENCY_MISMATCH' };
  if (cfg.merchantId && seen.merchantId !== cfg.merchantId) return { ok: false, reason: 'MERCHANT_MISMATCH' };
  return { ok: true, providerPaymentId: seen.providerPaymentId };
}

/** Make a payment succeed after the provider has confirmed it. Accepts a late success and flags it. */
async function succeed(payment, { by, providerPaymentId }) {
  const late = payment.status !== STATUS.PENDING && payment.status !== STATUS.CREATED;
  const set = { providerPaymentId: providerPaymentId || payment.providerPaymentId, succeededAt: new Date(), failureReason: null };
  const note = late ? `late success after ${payment.status}` : null;
  let done; let clash = false;
  try {
    done = await move(payment, STATUS.SUCCEEDED, { by, note, set });
  } catch (e) {
    if (!dup(e)) throw e;
    clash = true; // another attempt for this ride is open: this success is kept, but not as the ride's live payment
    done = await move(payment, STATUS.SUCCEEDED, { by, note, set: { ...set, live: false } });
  }
  const current = done || (await find({ paymentId: payment.paymentId }));
  if (done && (late || clash)) await flag(done, clash ? 'paid while another payment attempt for this ride was open: check for a double payment' : `success arrived after the payment was ${payment.status}`);
  if (current && current.status === STATUS.SUCCEEDED) await postSuccess(current);
  return current;
}

/**
 * Receive a provider's webhook. `rawBody` is the request body exactly as received. -> { httpStatus, outcome, payment? }
 * Unsigned or forged messages are refused and change nothing. Everything else is answered 200 once handled (so the provider stops
 * retrying), and an internal error is answered 500 (so it retries).
 */
async function handleWebhook({ provider, rawBody, headers = {}, env = process.env }) {
  let adapter;
  try { adapter = getAdapter(provider, env); } catch (e) { return { httpStatus: e.code === 'UNKNOWN_PROVIDER' ? 404 : 503, outcome: e.code || 'PROVIDER_UNAVAILABLE' }; }
  let verdict;
  try { verdict = adapter.verifyWebhook(rawBody, headers); } catch (e) { return { httpStatus: 503, outcome: e.code || 'PROVIDER_UNAVAILABLE' }; }
  if (!verdict.valid) return { httpStatus: 400, outcome: 'INVALID_SIGNATURE' };
  const ev = verdict.event;

  let record;
  try {
    record = await PaymentEvent.create({ provider: adapter.name, eventId: ev.eventId, type: ev.type, payloadHash: hashOf(rawBody), receivedAt: new Date() });
  } catch (e) {
    if (!dup(e)) throw e;
    const prior = await PaymentEvent.findOne({ provider: adapter.name, eventId: ev.eventId }).lean();
    const stuck = prior && (!prior.outcome || prior.outcome === 'ERROR') && Date.now() - new Date(prior.receivedAt).getTime() > 30000;
    if (!stuck) return { httpStatus: 200, outcome: 'DUPLICATE' };
    record = prior; // the first attempt never finished: process it now
  }
  const settle = async (outcome, detail, payment) => {
    await PaymentEvent.findOneAndUpdate({ provider: adapter.name, eventId: ev.eventId }, { $set: { outcome, detail: detail || null, paymentId: payment ? payment.paymentId : null, tenantId: payment ? payment.tenantId : null } });
    return { httpStatus: 200, outcome, payment: payment || null };
  };
  try {
    const payment = await find({ provider: adapter.name, providerOrderId: ev.providerOrderId });
    if (!payment) return settle('UNKNOWN_ORDER', `no payment for order ${ev.providerOrderId}`, null);
    await PaymentEvent.findOneAndUpdate({ provider: adapter.name, eventId: ev.eventId }, { $set: { tenantId: payment.tenantId, paymentId: payment.paymentId } });
    const tenant = await loadTenant(payment.tenantId);
    const cfg = tenantPayments(tenant);

    if (ev.currency !== payment.currency) { await flag(payment, `event ${ev.eventId} had currency ${ev.currency}`); return settle('REJECTED_MISMATCH', 'currency', payment); }
    if (ev.outcome === 'SUCCEEDED' && ev.amountMinor !== payment.amountMinor) { await flag(payment, `event ${ev.eventId} had amount ${ev.amountMinor}`); return settle('REJECTED_MISMATCH', 'amount', payment); }

    if (ev.outcome === 'SUCCEEDED') {
      if (payment.status === STATUS.SUCCEEDED) { await postSuccess(payment); return settle('IGNORED_ALREADY_SUCCEEDED', null, payment); }
      const check = await confirmWithProvider(payment, adapter, cfg);
      if (!check.ok) { await flag(payment, `success message not confirmed by the provider: ${check.reason}`); return settle('REJECTED_UNVERIFIED', check.reason, payment); }
      const now = await succeed(payment, { by: `provider:${adapter.name}`, providerPaymentId: check.providerPaymentId || ev.providerPaymentId });
      return settle('APPLIED', null, now);
    }
    // failure, cancellation or expiry
    const to = STATUS[ev.outcome];
    if (!to || !canMove(payment.status, to)) return settle('IGNORED_STALE', `${payment.status} cannot become ${ev.outcome}`, payment);
    const moved = await move(payment, to, { by: `provider:${adapter.name}`, note: ev.type, set: { failureReason: to === STATUS.FAILED ? 'PROVIDER_FAILED' : null } });
    return settle(moved ? 'APPLIED' : 'IGNORED_STALE', null, moved || payment);
  } catch (e) {
    await PaymentEvent.findOneAndUpdate({ provider: adapter.name, eventId: ev.eventId }, { $set: { outcome: 'ERROR', detail: String(e.message).slice(0, 200) } }).catch(() => {});
    throw e;
  }
}

/**
 * Ask the provider what happened (the app came back from the payment screen, or no webhook arrived). The provider's answer decides; the
 * caller's word never does. -> the payment (possibly now SUCCEEDED, FAILED, CANCELLED or EXPIRED).
 */
async function refresh({ tenantId, paymentId, env = process.env }) {
  const payment = await find({ tenantId, paymentId });
  if (!payment) throw err('NOT_FOUND', 'payment not found', 404);
  if (payment.status === STATUS.SUCCEEDED) { await postSuccess(payment); return find({ tenantId, paymentId }); }
  if (!payment.providerOrderId) return payment;
  const cfg = tenantPayments(await loadTenant(tenantId));
  const adapter = getAdapter(payment.provider, env);
  const seen = await adapter.fetchPayment(payment.providerOrderId);
  if (!seen) return payment;
  if (seen.status === 'paid') {
    const check = await confirmWithProvider(payment, adapter, cfg);
    if (!check.ok) { await flag(payment, `provider reports paid but: ${check.reason}`); return find({ tenantId, paymentId }); }
    return succeed(payment, { by: 'verify', providerPaymentId: check.providerPaymentId });
  }
  const to = { failed: STATUS.FAILED, cancelled: STATUS.CANCELLED, expired: STATUS.EXPIRED }[seen.status];
  if (to && canMove(payment.status, to)) await move(payment, to, { by: 'verify', note: `provider says ${seen.status}` });
  return find({ tenantId, paymentId });
}

/** Close payments left open past their window, after asking the provider (a payment that was really made is succeeded, not expired). */
async function expireStale({ tenantId, now = new Date(), env = process.env }) {
  const open = (await Payment.find({ tenantId, live: true, status: { $in: [STATUS.CREATED, STATUS.PENDING] } }).lean()) || [];
  const out = [];
  for (const p of open) {
    if (!p.expiresAt || new Date(p.expiresAt) > now) continue;
    const after = await refresh({ tenantId, paymentId: p.paymentId, env });
    if (after.status === STATUS.PENDING || after.status === STATUS.CREATED) {
      const moved = await move(after, STATUS.EXPIRED, { by: 'system', note: 'payment window ended' });
      out.push((moved || after).paymentId);
    }
  }
  return out;
}

/** Repair: post every succeeded payment whose ledger posting never completed. Idempotent. -> number repaired */
async function repairUnposted({ tenantId }) {
  const rows = (await Payment.find({ tenantId, status: STATUS.SUCCEEDED, ledgerTxnId: null }).lean()) || [];
  for (const p of rows) await postSuccess(p);
  return rows.length;
}

/** Mock only: run a provider scenario for a payment and deliver its messages through the same webhook path a real provider uses. */
async function simulate({ tenantId, paymentId, scenario, env = process.env, overrides = {} }) {
  if (!mockEnabled(env)) throw err('MOCK_DISABLED', 'the mock payment gateway is disabled', 403);
  const payment = await find({ tenantId, paymentId });
  if (!payment || payment.provider !== 'MOCK') throw err('NOT_FOUND', 'payment not found', 404);
  const gw = getAdapter('MOCK', env);
  const plan = gw.scenario(scenario, payment.providerOrderId, overrides);
  const replies = [];
  for (const d of plan.deliverNow) replies.push(await handleWebhook({ provider: 'MOCK', rawBody: d.rawBody, headers: d.headers, env }));
  return { replies, later: plan.deliverLater, payment: await find({ tenantId, paymentId }) };
}

module.exports = { createPayment, createCommissionPayment, handleWebhook, refresh, expireStale, repairUnposted, simulate, postSuccess, moneyOfTrip, find, move, flag, loadTenant, err, newId };
