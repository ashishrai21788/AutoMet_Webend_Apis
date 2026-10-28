/**
 * Backfill: give completed CASH trips from before payments were recorded a payment record and the commission the driver owes on them.
 *
 * For each completed cash trip of a business that has a usable earnings snapshot (`driver_earning`, written at completion) and NO payment record
 * at all, it creates a legacy CASH payment (CONFIRMED, flagged LEGACY_BACKFILL, confirmed by 'backfill') and books the commission as a receivable
 * from the driver, exactly as a confirmed cash fare is booked (lib/payments/cash.js: DR DRIVER_COMMISSION_RECEIVABLE, CR COMMISSION_REVENUE,
 * event key from the payment id). The trip is marked paid by cash, as a confirmed trip is.
 *
 * Safe to run any number of times and at the same time: a trip that already has a payment of any kind (cash, online, a backfill) is never touched,
 * each backfilled payment has a unique key per trip, and the ledger posting is idempotent. A trip is skipped (and counted) when it has no usable
 * snapshot, a split that does not add up to the fare, no driver, or was paid online. Without { apply: true } nothing is written (a dry run).
 * It ignores whether the business has cash switched on: these trips happened, and the money history should say so.
 */
const { Payment } = require('../../models/paymentModels');
const { TripDetails } = require('../../models/tripDetailsModel');
const { Tenant } = require('../../models/adminModels');
const { STATUS } = require('./states');
const cash = require('./cash');
const svc = require('./service');

const dup = (e) => e && e.code === 11000;
const lean = (d) => (d && d.toObject ? d.toObject() : d);
const CHUNK = 500;
const SAMPLE = 20;

/** Pure: what to do with one completed trip. -> { ok: true, money } or { skip: reason } (hasPayment is decided by the caller). */
function analyse(trip) {
  const s = trip && trip.driver_earning;
  const whole = (n) => Number.isSafeInteger(n) && n >= 0;
  if (!s || !whole(s.fareMinor) || !whole(s.feeMinor) || !whole(s.netMinor) || s.fareMinor <= 0) return { skip: 'noSnapshot' };
  if (s.feeMinor + s.netMinor !== s.fareMinor) return { skip: 'splitInconsistent' };
  if (String(trip.payment_mode || 'CASH').toUpperCase() !== 'CASH') return { skip: 'notCash' };
  if (!trip.driver_id) return { skip: 'noDriver' };
  return { ok: true, money: { amountMinor: s.fareMinor, commissionMinor: s.feeMinor, netMinor: s.netMinor, percent: s.percent == null ? null : s.percent, currency: s.currency || trip.currency || 'INR' } };
}

/** One business. -> a report { tenantId, dryRun, scanned, candidates, created, posted, failedToPost, commissionMinor, driversAffected, skipped, sample } */
async function run({ tenantId, apply = false, now = new Date() }) {
  if (!tenantId) throw new TypeError('tenantId is required');
  const report = { tenantId, dryRun: !apply, scanned: 0, candidates: 0, created: 0, posted: 0, failedToPost: 0, commissionMinor: 0, driversAffected: 0, skipped: { hasPayment: 0, noSnapshot: 0, splitInconsistent: 0, notCash: 0, noDriver: 0 }, sample: [] };
  const paid = new Set(((await Payment.find({ tenantId, purpose: 'FARE' }).lean()) || []).map((p) => p.tripId));
  const drivers = new Set();

  for (let skip = 0; ; skip += CHUNK) {
    const trips = (await TripDetails.find({ tenant_id: tenantId, status: 'COMPLETED' }).sort({ trip_id: 1 }).skip(skip).limit(CHUNK).lean()) || [];
    if (!trips.length) break;
    for (const trip of trips) {
      report.scanned += 1;
      if (paid.has(trip.trip_id)) { report.skipped.hasPayment += 1; continue; }
      const a = analyse(trip);
      if (!a.ok) { report.skipped[a.skip] += 1; continue; }
      report.candidates += 1;
      report.commissionMinor += a.money.commissionMinor;
      drivers.add(trip.driver_id);
      if (report.sample.length < SAMPLE) report.sample.push(trip.trip_id);
      if (!apply) continue;

      const paymentId = svc.newId('pay');
      const confirmedAt = trip.completed_at ? new Date(trip.completed_at) : now;
      let payment;
      try {
        payment = lean(await Payment.create({
          tenantId, paymentId, tripId: trip.trip_id, riderId: trip.user_id || null, driverId: trip.driver_id, purpose: 'FARE', method: 'CASH', provider: null,
          amountMinor: a.money.amountMinor, currency: a.money.currency, status: STATUS.SUCCEEDED, cashState: 'CONFIRMED', live: true, idempotencyKey: `backfill:${trip.trip_id}`,
          commission: { rule: { percent: a.money.percent }, commissionMinor: a.money.commissionMinor, netMinor: a.money.netMinor },
          cash: { collectedMinor: a.money.amountMinor, confirmedAt, confirmedBy: 'backfill', backfilled: true },
          flags: [{ at: now, reason: 'LEGACY_BACKFILL' }], succeededAt: confirmedAt,
          history: [{ at: now, status: STATUS.SUCCEEDED, by: 'backfill', note: 'created for a cash trip completed before payments were recorded' }]
        }));
      } catch (e) {
        if (dup(e)) continue; // another run (or a driver's confirmation) created it first
        throw e;
      }
      report.created += 1;
      try { if ((await cash.postCommission(payment)) !== 'NONE') report.posted += 1; } catch (e) { report.failedToPost += 1; console.warn('[backfill] commission not booked for', trip.trip_id, e.message); }
    }
    if (trips.length < CHUNK) break;
  }
  report.driversAffected = drivers.size;
  return report;
}

/** Every business (or the one named). -> [report] */
async function runAll({ apply = false, tenantId = null, now = new Date() } = {}) {
  const ids = tenantId ? [tenantId] : ((await Tenant.find({}).lean()) || []).map((t) => t.tenantId);
  const out = [];
  for (const id of ids) out.push(await run({ tenantId: id, apply, now }));
  return out;
}

module.exports = { analyse, run, runAll };
