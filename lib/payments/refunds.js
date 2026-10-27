/**
 * Refunds of online fare payments.
 *
 *  - Only a SUCCEEDED online FARE payment of the same business can be refunded; the payment's `status` is untouched, its separate
 *    `refundStatus` moves NONE -> REFUND_PENDING -> PARTIALLY_REFUNDED / REFUNDED.
 *  - A refund is its own record with a unique key per business: asking again with the same key returns the same refund.
 *  - The refundable amount is RESERVED on the payment with a conditional (versioned) update before the provider is asked, so any number of
 *    simultaneous requests can never reserve more than the payment holds. A failed refund releases its reservation.
 *  - The ledger is posted only when the provider says the refund is processed (a pending refund books nothing): the gateway is credited,
 *    and the refund is taken from the business's commission and the driver's earnings in proportion to the original split (half-up
 *    rounding, and the refund that finishes the payment takes the exact remainder, so the two shares always add up to the fare).
 *    If the driver was already paid, their payable simply goes negative (they owe it): history is never rewritten.
 *  - A duplicate payment (the rider paid the ride twice) was booked as money owed back, so refunding it clears that, not the driver's share.
 */
const { Payment, PaymentRefund } = require('../../models/paymentModels');
const { TripDetails } = require('../../models/tripDetailsModel');
const ledger = require('../ledger');
const { ACCOUNTS: A } = ledger;
const { STATUS } = require('./states');
const { tenantPayments } = require('./config');
const { getAdapter } = require('./adapters');
const svc = require('./service');

const { err } = svc;
const dup = (e) => e && e.code === 11000;
const lean = (d) => (d && d.toObject ? d.toObject() : d);
const emptyRefund = () => ({ reservedMinor: 0, processedMinor: 0, commissionMinor: 0, netMinor: 0 });
const findRefund = async (filter) => lean(await PaymentRefund.findOne(filter).lean());

/** The commission/driver split of refunding `amount`, given what is already reserved on the payment. */
function sharesFor(payment, amount) {
  const c = payment.commission || {};
  const fare = payment.amountMinor;
  const totalC = c.commissionMinor || 0;
  const totalN = c.netMinor == null ? fare - totalC : c.netMinor;
  const r = payment.refund || emptyRefund();
  const remaining = fare - r.reservedMinor;
  if (amount === remaining) return { commissionMinor: totalC - r.commissionMinor, netMinor: totalN - r.netMinor };
  let cs = Number((BigInt(totalC) * BigInt(amount) * 2n + BigInt(fare)) / (2n * BigInt(fare)));
  cs = Math.min(cs, totalC - r.commissionMinor);
  let ns = Math.min(amount - cs, totalN - r.netMinor);
  cs = amount - ns;
  return { commissionMinor: cs, netMinor: ns };
}

async function isDuplicateCapture(payment) {
  return (await ledger.list({ tenantId: payment.tenantId, type: 'DUPLICATE_FARE_CAPTURED' })).some((t) => t.paymentId === payment.paymentId);
}

/** Change the payment's refund bookkeeping at the version we read. -> updated payment or null */
async function writeRefundState(p, refund, refundStatus, extra = {}) {
  return lean(await Payment.findOneAndUpdate(
    { paymentId: p.paymentId, tenantId: p.tenantId, version: p.version || 0 },
    { $set: { refund, refundStatus, refundedMinor: refund.processedMinor, version: (p.version || 0) + 1, updatedAt: new Date(), ...extra } },
    { new: true }
  )) || null;
}

async function statusAfter(payment, refund) {
  const pending = (await PaymentRefund.find({ tenantId: payment.tenantId, paymentId: payment.paymentId, status: 'REQUESTED' }).lean()) || [];
  if (pending.length) return 'REFUND_PENDING';
  if (refund.processedMinor >= payment.amountMinor) return 'REFUNDED';
  return refund.processedMinor > 0 ? 'PARTIALLY_REFUNDED' : 'NONE';
}

/** The refund finished at the provider: post the ledger once and count it on the payment once. */
async function finalizeProcessed(refund) {
  const payment = await svc.find({ tenantId: refund.tenantId, paymentId: refund.paymentId });
  const entries = [{ account: A.GATEWAY_CLEARING, creditMinor: refund.amountMinor }];
  if (refund.duplicateCapture) {
    entries.unshift({ account: A.REFUND_CLEARING, debitMinor: refund.amountMinor });
  } else {
    if (refund.commissionMinor > 0) entries.unshift({ account: A.COMMISSION_REVENUE, debitMinor: refund.commissionMinor });
    if (refund.netMinor > 0) entries.unshift({ account: A.DRIVER_PAYABLE, driverId: refund.driverId, debitMinor: refund.netMinor });
  }
  const posted = await ledger.post({
    tenantId: refund.tenantId, eventKey: `refund:${refund.refundId}`, type: 'ONLINE_REFUND', currency: refund.currency, tripId: refund.tripId, driverId: refund.driverId,
    paymentId: refund.paymentId, entries, memo: `Refund: ${String(refund.reason).slice(0, 120)}`, createdBy: refund.requestedBy || 'system'
  });
  const won = await PaymentRefund.findOneAndUpdate({ refundId: refund.refundId, tenantId: refund.tenantId, status: 'REQUESTED' }, { $set: { status: 'PROCESSED', ledgerTxnId: posted.txnId, processedAt: new Date(), updatedAt: new Date() } }, { new: true });
  if (!won) return findRefund({ refundId: refund.refundId }); // another request finished it
  for (let i = 0; i < 8; i += 1) {
    const p = await svc.find({ tenantId: refund.tenantId, paymentId: refund.paymentId });
    const r = { ...emptyRefund(), ...(p.refund || {}) };
    r.processedMinor += refund.amountMinor;
    const updated = await writeRefundState(p, r, await statusAfter(p, r));
    if (updated) {
      if (updated.refundStatus === 'REFUNDED') await TripDetails.updateOne({ trip_id: p.tripId, tenant_id: p.tenantId }, { $set: { payment_status: 'REFUNDED' } });
      break;
    }
  }
  return findRefund({ refundId: refund.refundId });
}

/** The refund failed at the provider: nothing is booked and the reservation is released. */
async function finalizeFailed(refund, reason) {
  const won = await PaymentRefund.findOneAndUpdate({ refundId: refund.refundId, tenantId: refund.tenantId, status: 'REQUESTED' }, { $set: { status: 'FAILED', failureReason: reason, updatedAt: new Date() } }, { new: true });
  if (!won) return findRefund({ refundId: refund.refundId });
  for (let i = 0; i < 8; i += 1) {
    const p = await svc.find({ tenantId: refund.tenantId, paymentId: refund.paymentId });
    const r = { ...emptyRefund(), ...(p.refund || {}) };
    r.reservedMinor = Math.max(0, r.reservedMinor - refund.amountMinor);
    r.commissionMinor = Math.max(0, r.commissionMinor - refund.commissionMinor);
    r.netMinor = Math.max(0, r.netMinor - refund.netMinor);
    if (await writeRefundState(p, r, await statusAfter(p, r))) break;
  }
  return findRefund({ refundId: refund.refundId });
}

async function applyProviderResult(refund, result) {
  if (result.status === 'processed') return finalizeProcessed({ ...refund, providerRefundId: result.providerRefundId || refund.providerRefundId });
  if (result.status === 'failed') {
    await PaymentRefund.findOneAndUpdate({ refundId: refund.refundId, tenantId: refund.tenantId }, { $set: { providerRefundId: result.providerRefundId || refund.providerRefundId } });
    return finalizeFailed(refund, 'PROVIDER_FAILED');
  }
  await PaymentRefund.findOneAndUpdate({ refundId: refund.refundId, tenantId: refund.tenantId, status: 'REQUESTED' }, { $set: { providerRefundId: result.providerRefundId || refund.providerRefundId, updatedAt: new Date() } });
  return findRefund({ refundId: refund.refundId });
}

/**
 * Refund part or all of an online fare payment. Safe to repeat by idempotencyKey (required). -> { refund, duplicate }
 * The caller (an administrator, with permission and an audit entry) is responsible for who may ask; this checks everything else.
 */
async function requestRefund({ tenantId, paymentId, amountMinor, reason, requestedBy, idempotencyKey, env = process.env }) {
  const payment = await svc.find({ tenantId, paymentId });
  if (!payment) throw err('NOT_FOUND', 'payment not found', 404);
  if (!idempotencyKey) throw err('IDEMPOTENCY_KEY_REQUIRED', 'a refund request needs an idempotency key', 400);
  const key = String(idempotencyKey).slice(0, 80);
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw err('BAD_AMOUNT', 'the refund amount must be whole, positive minor units', 400);
  const text = String(reason || '').trim();
  if (text.length < 3) throw err('REASON_REQUIRED', 'a refund needs a reason', 400);
  const same = await findRefund({ tenantId, idempotencyKey: key });
  if (same) {
    if (same.paymentId !== paymentId) throw err('IDEMPOTENCY_KEY_REUSED', 'this key belongs to another refund', 409);
    return { refund: same, duplicate: true };
  }
  if (payment.purpose !== 'FARE' || payment.method !== 'UPI' || payment.status !== STATUS.SUCCEEDED) throw err('NOT_REFUNDABLE', 'only a successful online fare payment can be refunded', 409);
  const pre = payment.refund || emptyRefund();
  if (amountMinor > payment.amountMinor - pre.reservedMinor) throw err('AMOUNT_TOO_HIGH', `at most ${payment.amountMinor - pre.reservedMinor} can still be refunded`, 409);

  const refundId = svc.newId('rf');
  const duplicateCapture = await isDuplicateCapture(payment);
  let refund;
  try {
    refund = lean(await PaymentRefund.create({
      tenantId, refundId, paymentId, tripId: payment.tripId, driverId: payment.driverId, amountMinor, currency: payment.currency, duplicateCapture,
      status: 'REQUESTED', reason: text.slice(0, 300), requestedBy: requestedBy || null, idempotencyKey: key
    }));
  } catch (e) {
    if (!dup(e)) throw e;
    return { refund: await findRefund({ tenantId, idempotencyKey: key }), duplicate: true };
  }

  // reserve the amount on the payment: only one of any number of simultaneous requests gets each paisa
  let reserved = null;
  for (let i = 0; i < 10 && !reserved; i += 1) {
    const p = await svc.find({ tenantId, paymentId });
    const r = { ...emptyRefund(), ...(p.refund || {}) };
    if (amountMinor > p.amountMinor - r.reservedMinor) { await PaymentRefund.findOneAndUpdate({ refundId }, { $set: { status: 'FAILED', failureReason: 'AMOUNT_TOO_HIGH', updatedAt: new Date() } }); throw err('AMOUNT_TOO_HIGH', 'the rest of this payment is already being refunded', 409); }
    const shares = duplicateCapture ? { commissionMinor: 0, netMinor: 0 } : sharesFor(p, amountMinor);
    const next = { ...r, reservedMinor: r.reservedMinor + amountMinor, commissionMinor: r.commissionMinor + shares.commissionMinor, netMinor: r.netMinor + shares.netMinor };
    if (await writeRefundState(p, next, 'REFUND_PENDING')) { reserved = shares; }
  }
  if (!reserved) { await PaymentRefund.findOneAndUpdate({ refundId }, { $set: { status: 'FAILED', failureReason: 'BUSY', updatedAt: new Date() } }); throw err('BUSY', 'try again', 409); }
  refund = lean(await PaymentRefund.findOneAndUpdate({ refundId }, { $set: { commissionMinor: reserved.commissionMinor, netMinor: reserved.netMinor, updatedAt: new Date() } }, { new: true }));

  let result;
  try {
    const adapter = getAdapter(payment.provider, env);
    result = await adapter.refund({ providerPaymentId: payment.providerPaymentId, amountMinor, idempotencyKey: `${tenantId}:${refundId}` });
  } catch (e) {
    return { refund, duplicate: false }; // left REQUESTED: settleRefund asks the provider again with the same key
  }
  return { refund: await applyProviderResult(refund, result), duplicate: false };
}

/** Ask the provider how a pending refund ended, and book or release it. Safe to repeat. */
async function settleRefund({ tenantId, refundId, env = process.env }) {
  const refund = await findRefund({ tenantId, refundId });
  if (!refund) throw err('NOT_FOUND', 'refund not found', 404);
  if (refund.status !== 'REQUESTED') return refund;
  const payment = await svc.find({ tenantId, paymentId: refund.paymentId });
  const cfg = tenantPayments(await svc.loadTenant(tenantId));
  const adapter = getAdapter(payment.provider || cfg.provider, env);
  const result = refund.providerRefundId
    ? { ...(await adapter.fetchRefund(refund.providerRefundId) || { status: 'pending' }), providerRefundId: refund.providerRefundId }
    : await adapter.refund({ providerPaymentId: payment.providerPaymentId, amountMinor: refund.amountMinor, idempotencyKey: `${tenantId}:${refundId}` });
  return applyProviderResult(refund, result);
}

module.exports = { requestRefund, settleRefund, sharesFor };
