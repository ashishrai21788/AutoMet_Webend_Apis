/**
 * Reconciliation: compare what we recorded with itself and with the provider, and write down every difference.
 *
 * It only FINDS. It never marks a payment paid, posts a ledger entry, repairs, or adjusts anything: a difference stays an OPEN finding
 * until a person records what was done (`resolve`, with a note), and a resolved finding that is detected again is reopened. Each run
 * is for one business; nothing of another business is read or shown.
 *
 * Checks: unbalanced ledger entries; a succeeded payment never posted to the ledger; a trip marked paid with no payment behind it; a
 * ride paid twice; a commission that disagrees with the ledger; webhooks received and never finished; the provider holding money we did
 * not record, or not confirming a success we did record, or holding a different amount; refunds stuck, or finished at the provider but
 * not recorded; cash fares the driver never confirmed.
 *
 * Provider checks use the provider's own records (`fetchPayment`, `fetchRefund`). If a provider cannot be asked (not configured), those
 * checks are skipped and counted in `skippedProviderChecks`, never silently treated as "fine".
 */
const crypto = require('crypto');
const { Payment, PaymentEvent, PaymentRefund, PaymentDiscrepancy } = require('../../models/paymentModels');
const { TripDetails } = require('../../models/tripDetailsModel');
const ledger = require('../ledger');
const { ACCOUNTS: A } = ledger;
const { getAdapter } = require('./adapters');
const svc = require('./service');

const { err } = svc;
const dup = (e) => e && e.code === 11000;
const lean = (d) => (d && d.toObject ? d.toObject() : d);
const HOUR = 3600000;
const LIMITS = { webhookMinutes: 30, refundHours: 24, cashDays: 2 };

async function findings({ tenantId, now, env }) {
  const out = [];
  const add = (type, ref, detail) => out.push({ key: `${type}:${ref}`, type, ref: String(ref), detail });
  let skipped = 0;

  const payments = (await Payment.find({ tenantId }).lean()) || [];
  const trips = (await TripDetails.find({ tenant_id: tenantId }).lean()) || [];
  const refundRows = (await PaymentRefund.find({ tenantId }).lean()) || [];
  const events = (await PaymentEvent.find({ tenantId }).lean()) || [];
  const txns = await ledger.list({ tenantId });
  const txnById = new Map(txns.map((t) => [t.txnId, t]));

  for (const problem of (await ledger.verify({ tenantId })).problems) add('LEDGER_UNBALANCED', (/^transaction (\S+):/.exec(problem) || [])[1] || 'unknown', problem);

  const succeededByTrip = new Map();
  for (const p of payments) {
    if (p.purpose === 'FARE' && p.status === 'SUCCEEDED') succeededByTrip.set(p.tripId, (succeededByTrip.get(p.tripId) || 0) + 1);
    if (p.status === 'SUCCEEDED' && !p.ledgerTxnId) add('SUCCESS_NOT_POSTED', p.paymentId, `payment ${p.paymentId} succeeded but has no ledger posting`);
    if (p.method === 'CASH' && p.status === 'PENDING' && p.cashState === 'PENDING' && now.getTime() - new Date(p.createdAt).getTime() > LIMITS.cashDays * 24 * HOUR) {
      add('CASH_NOT_CONFIRMED', p.paymentId, `the driver has not confirmed the cash for trip ${p.tripId}`);
    }
    // the commission we say we took must be the commission in the ledger
    if (p.method === 'UPI' && p.purpose === 'FARE' && p.status === 'SUCCEEDED' && p.ledgerTxnId && p.commission) {
      const t = txnById.get(p.ledgerTxnId);
      if (t && t.type === 'ONLINE_FARE_CAPTURED') {
        const booked = t.entries.filter((e) => e.account === A.COMMISSION_REVENUE).reduce((n, e) => n + (e.creditMinor || 0), 0);
        if (booked !== (p.commission.commissionMinor || 0)) add('COMMISSION_MISMATCH', p.paymentId, `payment says commission ${p.commission.commissionMinor}, the ledger booked ${booked}`);
      }
    }
    // the provider's own record
    if (p.method === 'UPI' && p.providerOrderId && ['PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(p.status)) {
      let seen = null;
      try { seen = await getAdapter(p.provider, env).fetchPayment(p.providerOrderId); } catch (e) { skipped += 1; continue; }
      if (!seen) { if (p.status === 'SUCCEEDED') add('SUCCESS_NOT_CONFIRMED_BY_PROVIDER', p.paymentId, 'the provider has no record of this order'); continue; }
      if (seen.status === 'paid' && p.status !== 'SUCCEEDED') add('PROVIDER_PAID_NOT_RECORDED', p.paymentId, `the provider reports order ${p.providerOrderId} paid but the payment is ${p.status}`);
      if (p.status === 'SUCCEEDED' && seen.status !== 'paid') add('SUCCESS_NOT_CONFIRMED_BY_PROVIDER', p.paymentId, `we recorded a success but the provider says ${seen.status}`);
      if (seen.status === 'paid' && seen.amountMinor !== p.amountMinor) add('PROVIDER_AMOUNT_MISMATCH', p.paymentId, `the provider holds ${seen.amountMinor}, we expected ${p.amountMinor}`);
    }
  }
  for (const [tripId, n] of succeededByTrip) if (n > 1) add('DUPLICATE_PAYMENT', tripId, `ride ${tripId} has ${n} succeeded payments`);
  for (const t of trips) if (t.payment_status === 'PAID' && !succeededByTrip.has(t.trip_id)) add('TRIP_PAID_WITHOUT_PAYMENT', t.trip_id, `trip ${t.trip_id} is marked paid but has no succeeded payment`);

  for (const e of events) {
    if ((!e.outcome || e.outcome === 'ERROR') && now.getTime() - new Date(e.receivedAt).getTime() > LIMITS.webhookMinutes * 60000) add('UNPROCESSED_WEBHOOK', e.eventId, `provider event ${e.eventId} was received and never finished`);
  }

  for (const r of refundRows.filter((x) => x.status === 'REQUESTED')) {
    if (r.providerRefundId) {
      let seen = null;
      const pay = payments.find((p) => p.paymentId === r.paymentId);
      try { seen = await getAdapter((pay && pay.provider) || 'MOCK', env).fetchRefund(r.providerRefundId); } catch (e) { skipped += 1; }
      if (seen && seen.status === 'processed') { add('REFUND_PROVIDER_FINISHED_NOT_RECORDED', r.refundId, `the provider processed refund ${r.refundId} but we still show it requested`); continue; }
      if (seen && seen.status === 'failed') { add('REFUND_PROVIDER_FAILED_NOT_RECORDED', r.refundId, `the provider failed refund ${r.refundId} but we still show it requested`); continue; }
    }
    if (now.getTime() - new Date(r.createdAt).getTime() > LIMITS.refundHours * HOUR) add('REFUND_STUCK', r.refundId, `refund ${r.refundId} has been waiting more than ${LIMITS.refundHours} hours`);
  }
  return { list: out, skipped, checked: { payments: payments.length, trips: trips.length, events: events.length, refunds: refundRows.length, ledgerTransactions: txns.length } };
}

/** Run every check for one business and record the findings. -> { discrepancies, newCount, checked, skippedProviderChecks } */
async function run({ tenantId, now = new Date(), env = process.env }) {
  if (!tenantId) throw new TypeError('tenantId is required');
  const { list, skipped, checked } = await findings({ tenantId, now, env });
  let newCount = 0;
  const discrepancies = [];
  for (const f of list) {
    let row = lean(await PaymentDiscrepancy.findOne({ tenantId, key: f.key }).lean());
    if (!row) {
      try {
        row = lean(await PaymentDiscrepancy.create({ tenantId, discrepancyId: `dis_${crypto.randomBytes(8).toString('hex')}`, key: f.key, type: f.type, ref: f.ref, detail: f.detail, status: 'OPEN', firstSeenAt: now, lastSeenAt: now }));
        newCount += 1;
      } catch (e) { if (!dup(e)) throw e; row = lean(await PaymentDiscrepancy.findOne({ tenantId, key: f.key }).lean()); }
    } else if (row.status === 'RESOLVED') {
      row = lean(await PaymentDiscrepancy.findOneAndUpdate({ tenantId, key: f.key }, { $set: { status: 'OPEN', detail: f.detail, lastSeenAt: now, reopenedCount: (row.reopenedCount || 0) + 1 } }, { new: true }));
    } else {
      row = lean(await PaymentDiscrepancy.findOneAndUpdate({ tenantId, key: f.key }, { $set: { detail: f.detail, lastSeenAt: now } }, { new: true }));
    }
    discrepancies.push(row);
  }
  return { discrepancies, newCount, checked, skippedProviderChecks: skipped };
}

async function list({ tenantId, status = null }) {
  return ((await PaymentDiscrepancy.find({ tenantId, ...(status ? { status } : {}) }).lean()) || []).map(lean);
}

/** A person records what was done about a finding. Nothing is changed in the books by this. */
async function resolve({ tenantId, discrepancyId, adminId, note, now = new Date() }) {
  const row = lean(await PaymentDiscrepancy.findOne({ tenantId, discrepancyId }).lean());
  if (!row) throw err('NOT_FOUND', 'finding not found', 404);
  const text = String(note || '').trim();
  if (text.length < 3) throw err('NOTE_REQUIRED', 'say what was done', 400);
  const done = await PaymentDiscrepancy.findOneAndUpdate({ tenantId, discrepancyId }, { $set: { status: 'RESOLVED', resolvedBy: adminId, resolvedAt: now, resolutionNote: text.slice(0, 500) } }, { new: true });
  return lean(done);
}

module.exports = { run, list, resolve, LIMITS };
