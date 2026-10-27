/**
 * Cash payments. The passenger pays the driver in cash, so the platform receives nothing at that moment: what it is owed is its
 * COMMISSION, which becomes a receivable from the driver (DRIVER_COMMISSION_RECEIVABLE against COMMISSION_REVENUE). It is revenue
 * earned but not collected, and it stays outstanding until it is actually recovered (lib/payments/recovery.js). The driver's own share of
 * a cash fare is already in their hand, so the business owes them nothing for it and no driver-payable entry is made.
 *
 * Flow: the finalised trip leaves a PENDING cash payment (`ensureCashPayment`); the driver confirms the amount they collected
 * (`confirmCash`). The amount is checked against the fare the SERVER finalised: a different amount is not booked, it becomes a dispute
 * for the business to resolve. The rider or driver may also dispute (`disputeCash`). The business resolves (`resolveCash`): confirm the
 * fare as it stands, or adjust it. An adjustment reverses the earlier booking and posts the corrected one; nothing is edited in place,
 * and the original fare and commission snapshot on the payment are never rewritten.
 *
 * Everything is safe to repeat: the confirmation moves the payment with a conditional update (one request wins), the ledger posting is
 * idempotent by event key, and a confirmed payment whose posting was interrupted is completed by the next confirmation or by the repair.
 */
const { TripDetails } = require('../../models/tripDetailsModel');
const { Payment } = require('../../models/paymentModels');
const ledger = require('../ledger');
const { ACCOUNTS: A } = ledger;
const { percentToBasisPoints, splitFare } = require('../paymentMoney');
const { STATUS } = require('./states');
const { tenantPayments } = require('./config');
const svc = require('./service');

const { err } = svc;
const dup = (e) => e && e.code === 11000;
const lean = (d) => (d && d.toObject ? d.toObject() : d);
const history = (p, status, by, note) => [...(p.history || []), { at: new Date(), status, by, note: note || null }];

async function tripFor(tenantId, tripId, driverId) {
  const trip = await TripDetails.findOne({ trip_id: String(tripId), tenant_id: tenantId }).lean();
  if (!trip || (driverId && trip.driver_id !== driverId)) throw err('NOT_FOUND', 'ride not found', 404);
  return trip;
}

async function requireCashEnabled(tenantId) {
  const cfg = tenantPayments(await svc.loadTenant(tenantId));
  if (!cfg.enabledMethods.includes('CASH')) throw err('METHOD_NOT_ENABLED', 'cash payment is not enabled for this business', 403);
}

/** Conditionally change a payment (it must still be at the version we read). -> the updated payment or null. */
async function change(p, set, filter = {}) {
  const updated = await Payment.findOneAndUpdate(
    { paymentId: p.paymentId, tenantId: p.tenantId, version: p.version || 0, ...filter },
    { $set: { ...set, updatedAt: new Date(), version: (p.version || 0) + 1 } },
    { new: true }
  );
  return lean(updated) || null;
}

const cashOf = (tenantId, filter = {}) => svc.find({ tenantId, method: 'CASH', ...filter });

/** The cash payment waiting for the driver on a completed, finalised trip (created once). Null when the ride was paid another way. */
async function ensureCashPayment({ tenantId, trip, now = new Date() }) {
  await requireCashEnabled(tenantId);
  if (!trip || trip.status !== 'COMPLETED') throw err('TRIP_NOT_COMPLETED', 'a ride is paid once it is completed', 409);
  const existing = await cashOf(tenantId, { tripId: trip.trip_id, purpose: 'FARE', live: true });
  if (existing) return existing;
  if (trip.payment_status === 'PAID') return null;
  const money = svc.moneyOfTrip(trip);
  const paymentId = svc.newId('pay');
  try {
    return lean(await Payment.create({
      tenantId, paymentId, tripId: trip.trip_id, riderId: trip.user_id, driverId: trip.driver_id || null, purpose: 'FARE', method: 'CASH', provider: null,
      amountMinor: money.amountMinor, currency: money.currency, status: STATUS.PENDING, cashState: 'PENDING', live: true, idempotencyKey: `cash:${trip.trip_id}`,
      commission: { rule: money.rule, commissionMinor: money.commissionMinor, netMinor: money.netMinor }, history: [{ at: now, status: STATUS.PENDING, by: 'system', note: 'waiting for the driver to confirm the cash' }]
    }));
  } catch (e) {
    if (!dup(e)) throw e;
    return (await cashOf(tenantId, { tripId: trip.trip_id, purpose: 'FARE', live: true })) || (await cashOf(tenantId, { tripId: trip.trip_id, idempotencyKey: `cash:${trip.trip_id}` }));
  }
}

/** Book the commission a driver owes for a confirmed cash fare. Idempotent. */
async function postCommission(p, { adjusted = null } = {}) {
  const c = adjusted || p.commission || {};
  const commission = c.commissionMinor || 0;
  let txnId = 'NONE';
  if (commission > 0) {
    const posted = await ledger.post({
      tenantId: p.tenantId, eventKey: adjusted ? `cash:${p.paymentId}:adjusted:${p.version}` : `cash:${p.paymentId}:commission`,
      type: adjusted ? 'CASH_COMMISSION_ADJUSTED' : 'CASH_COMMISSION_ACCRUED', currency: p.currency, tripId: p.tripId, driverId: p.driverId, paymentId: p.paymentId,
      entries: [{ account: A.DRIVER_COMMISSION_RECEIVABLE, driverId: p.driverId, debitMinor: commission }, { account: A.COMMISSION_REVENUE, creditMinor: commission }],
      memo: adjusted ? 'Commission on a cash fare, adjusted by the business' : 'Commission owed by the driver on a cash fare'
    });
    txnId = posted.txnId;
  }
  if (!p.ledgerTxnId || adjusted) await Payment.findOneAndUpdate({ paymentId: p.paymentId, tenantId: p.tenantId }, { $set: { ledgerTxnId: txnId, updatedAt: new Date() } });
  await TripDetails.updateOne({ trip_id: p.tripId, tenant_id: p.tenantId }, { $set: { payment_status: 'PAID', payment_mode: 'CASH', payment_id: p.paymentId, paid_at: p.succeededAt || new Date() } });
  return txnId;
}

/**
 * The driver confirms the cash they collected. `collectedMinor` defaults to the fare. -> { payment, duplicate, disputed }
 */
async function confirmCash({ tenantId, tripId, driverId, collectedMinor, idempotencyKey, now = new Date() }) {
  const trip = await tripFor(tenantId, tripId, driverId);
  if (collectedMinor != null && (typeof collectedMinor !== 'number' || !Number.isSafeInteger(collectedMinor) || collectedMinor < 0)) throw err('BAD_AMOUNT', 'the collected amount must be whole minor units', 400);
  if (trip.status !== 'COMPLETED') throw err('TRIP_NOT_COMPLETED', 'a ride is confirmed once it is completed', 409);
  let p = await ensureCashPayment({ tenantId, trip, now });
  if (!p) throw err('ALREADY_PAID', 'this ride was already paid another way', 409);
  const amount = collectedMinor == null ? p.amountMinor : collectedMinor;

  if (p.cashState === 'CONFIRMED' || p.cashState === 'ADJUSTED') {
    if (p.cash && p.cash.collectedMinor !== amount && p.cashState === 'CONFIRMED') throw err('ALREADY_CONFIRMED', 'this collection was already confirmed with a different amount', 409);
    if (!p.ledgerTxnId) await postCommission(p); // an earlier confirmation was interrupted before it was booked
    return { payment: (await cashOf(tenantId, { paymentId: p.paymentId })), duplicate: true, disputed: false };
  }
  if (p.cashState === 'DISPUTED') {
    if (p.cash && p.cash.collectedMinor === amount) return { payment: p, duplicate: true, disputed: true };
    throw err('PAYMENT_IN_DISPUTE', 'this collection is in dispute; the business must resolve it', 409);
  }

  if (amount !== p.amountMinor) {
    const moved = await change(p, {
      cashState: 'DISPUTED', cash: { collectedMinor: amount, dispute: { by: 'driver', reason: `driver collected ${amount} but the fare is ${p.amountMinor}`, at: now } },
      history: history(p, p.status, `driver:${driverId}`, `collected ${amount}, fare ${p.amountMinor}: disputed`)
    }, { cashState: 'PENDING' });
    await TripDetails.updateOne({ trip_id: p.tripId, tenant_id: tenantId }, { $set: { payment_status: 'DISPUTED', payment_mode: 'CASH', payment_id: p.paymentId } });
    if (moved) return { payment: moved, duplicate: false, disputed: true };
    p = await cashOf(tenantId, { paymentId: p.paymentId });
    return { payment: p, duplicate: true, disputed: p.cashState === 'DISPUTED' };
  }

  const done = await svc.move(p, STATUS.SUCCEEDED, {
    by: `driver:${driverId}`, note: 'cash confirmed by the driver',
    set: { cashState: 'CONFIRMED', succeededAt: now, cash: { collectedMinor: amount, confirmedAt: now, confirmedBy: `driver:${driverId}`, confirmKey: idempotencyKey || null } }
  });
  if (!done) { // another request confirmed it first
    const now2 = await cashOf(tenantId, { paymentId: p.paymentId });
    if (now2 && now2.cashState === 'CONFIRMED' && !now2.ledgerTxnId) await postCommission(now2);
    return { payment: await cashOf(tenantId, { paymentId: p.paymentId }), duplicate: true, disputed: false };
  }
  await postCommission(done);
  return { payment: await cashOf(tenantId, { paymentId: p.paymentId }), duplicate: false, disputed: false };
}

/** The rider or the driver disputes a cash collection. The booking (if any) stays until the business resolves it. */
async function disputeCash({ tenantId, tripId, by, actorId, reason, now = new Date() }) {
  const trip = await TripDetails.findOne({ trip_id: String(tripId), tenant_id: tenantId }).lean();
  const owner = by === 'rider' ? trip && trip.user_id : by === 'driver' ? trip && trip.driver_id : null;
  if (!trip || !owner || owner !== actorId) throw err('NOT_FOUND', 'ride not found', 404);
  const text = String(reason || '').trim();
  if (text.length < 3) throw err('REASON_REQUIRED', 'say what is wrong', 400);
  const p = await cashOf(tenantId, { tripId: String(tripId), purpose: 'FARE', live: true });
  if (!p) throw err('NOT_FOUND', 'no cash payment for this ride', 404);
  if (p.cashState === 'DISPUTED') return p;
  const moved = await change(p, {
    cashState: 'DISPUTED', cash: { ...(p.cash || {}), dispute: { by, reason: text.slice(0, 300), at: now } },
    history: history(p, p.status, `${by}:${actorId}`, `disputed: ${text.slice(0, 120)}`)
  });
  await TripDetails.updateOne({ trip_id: p.tripId, tenant_id: tenantId }, { $set: { payment_status: 'DISPUTED' } });
  return moved || (await cashOf(tenantId, { paymentId: p.paymentId }));
}

/**
 * The business decides a dispute. action CONFIRM: the fare stands. action ADJUST: `adjustedFareMinor` is the fare actually owed; the
 * commission is recomputed with the rule the trip was finalised under, the earlier booking (if any) is reversed and the corrected one posted.
 * Always needs a reason; the caller records the admin audit entry.
 */
async function resolveCash({ tenantId, paymentId, adminId, action, adjustedFareMinor, reason, now = new Date() }) {
  const p = await cashOf(tenantId, { paymentId });
  if (!p) throw err('NOT_FOUND', 'payment not found', 404);
  const text = String(reason || '').trim();
  if (text.length < 3) throw err('REASON_REQUIRED', 'a resolution needs a reason', 400);
  if (p.cashState !== 'DISPUTED') throw err('NOT_DISPUTED', 'this payment is not in dispute', 409);
  const by = `admin:${adminId}`;
  const resolution = { by: adminId, action, reason: text.slice(0, 300), at: now };

  if (action === 'CONFIRM') {
    const set = { cashState: 'CONFIRMED', cash: { ...(p.cash || {}), collectedMinor: p.amountMinor, confirmedAt: now, confirmedBy: by, resolution } };
    const done = p.status === STATUS.SUCCEEDED
      ? await change(p, { ...set, history: history(p, STATUS.SUCCEEDED, by, `dispute resolved: ${text.slice(0, 100)}`) }, { cashState: 'DISPUTED' })
      : await svc.move(p, STATUS.SUCCEEDED, { by, note: `dispute resolved: ${text.slice(0, 100)}`, set: { ...set, succeededAt: now } });
    if (!done) throw err('PAYMENT_CHANGED', 'the payment changed; reload and try again', 409);
    if (!done.ledgerTxnId) await postCommission(done);
    await TripDetails.updateOne({ trip_id: p.tripId, tenant_id: tenantId }, { $set: { payment_status: 'PAID' } });
    return cashOf(tenantId, { paymentId });
  }

  if (action === 'ADJUST') {
    if (typeof adjustedFareMinor !== 'number' || !Number.isSafeInteger(adjustedFareMinor) || adjustedFareMinor < 0) throw err('BAD_AMOUNT', 'the adjusted fare must be whole minor units', 400);
    const percent = p.commission && p.commission.rule ? p.commission.rule.percent : null;
    if (percent == null) throw err('NO_COMMISSION_RULE', 'this payment has no commission rule to recompute with', 409);
    const split = splitFare(adjustedFareMinor, { type: 'PERCENT', rateBp: percentToBasisPoints(percent), ruleId: 'trip-snapshot', version: 1 });
    const set = {
      cashState: 'ADJUSTED', status: STATUS.SUCCEEDED, succeededAt: p.succeededAt || now,
      cash: { ...(p.cash || {}), collectedMinor: adjustedFareMinor, adjustedFareMinor, adjustedCommission: { commissionMinor: split.commissionMinor, netMinor: split.netMinor }, resolution },
      history: history(p, STATUS.SUCCEEDED, by, `adjusted to ${adjustedFareMinor}: ${text.slice(0, 100)}`)
    };
    const done = await change(p, set, { cashState: 'DISPUTED' });
    if (!done) throw err('PAYMENT_CHANGED', 'the payment changed; reload and try again', 409);
    if (p.ledgerTxnId && p.ledgerTxnId !== 'NONE') await ledger.reverse({ tenantId, txnId: p.ledgerTxnId, reason: `fare adjusted: ${text}`, createdBy: by });
    await postCommission(done, { adjusted: done.cash.adjustedCommission });
    await TripDetails.updateOne({ trip_id: p.tripId, tenant_id: tenantId }, { $set: { payment_status: 'PAID' } });
    return cashOf(tenantId, { paymentId });
  }
  throw err('BAD_ACTION', 'action must be CONFIRM or ADJUST', 400);
}

/** Repair: book every confirmed cash payment whose commission booking never completed. Idempotent. -> number completed */
async function repairUnposted({ tenantId }) {
  const rows = (await Payment.find({ tenantId, method: 'CASH', status: STATUS.SUCCEEDED, ledgerTxnId: null }).lean()) || [];
  for (const p of rows) await postCommission(p);
  return rows.length;
}

module.exports = { ensureCashPayment, confirmCash, disputeCash, resolveCash, repairUnposted, postCommission };
