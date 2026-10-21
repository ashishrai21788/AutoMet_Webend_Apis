/**
 * The driver's money, worked out in whole minor units (paise, cents) so that totals always add up exactly.
 *
 *  - Each finished trip has a fare (what the passenger paid, line by line), a platform share (the business's commission,
 *    0 by default) and the driver's earnings (fare minus share). That split is written onto the trip the moment it completes
 *    (`driver_earning`), so changing the commission later never rewrites past earnings or a balance that was already paid out.
 *    Trips finished before this existed are worked out from the current commission instead.
 *  - Cash rides: the driver was paid in cash by the passenger, so that money is already in their hand. It is earnings, but it is
 *    not owed to them. What the business is owed on a cash ride is its platform share.
 *  - Online rides (when they exist): the business received the fare and owes the driver their earnings.
 *  - Tips go 100% to the driver and are paid the way the ride was (cash tips are in hand, online tips are owed). Incentives and
 *    admin adjustments are always owed by the business.
 *  - Balance the driver can withdraw = online earnings + online tips + incentives + adjustments - platform share owed on cash rides
 *    - payouts paid or still open. A business can switch `cashWithdrawable` on in its payout settings to count cash earnings too.
 */
const { earningsFor } = require('./driverEarnings');
const { digitsOf, toMinor } = require('./riderInvoice');

const isCash = (trip) => String(trip.payment_mode || 'CASH').toUpperCase() === 'CASH';
/** A trip whose fare included a surge charge. */
const isSurged = (trip) => !!(trip.fare_breakdown && Array.isArray(trip.fare_breakdown.lines) && trip.fare_breakdown.lines.some((l) => l && l.key === 'surge' && Number(l.amount) > 0));

/** { currency, digits, fareMinor, feeMinor, netMinor, percent, cash, lines: [{label, amountMinor, kind}] } for one completed trip. */
function tripMoney(trip, tenant) {
  const snap = trip && trip.driver_earning;
  const currency = (snap && snap.currency) || trip.currency || (tenant && tenant.market && tenant.market.currency) || 'INR';
  const digits = digitsOf(currency);
  const e = earningsFor(trip, tenant);
  const lines = e.lines.map((l) => ({ label: l.label, amountMinor: toMinor(l.amount, digits), kind: l.kind }));
  if (snap && Number.isInteger(snap.netMinor) && Number.isInteger(snap.feeMinor) && Number.isInteger(snap.fareMinor)) {
    return { currency, digits, fareMinor: snap.fareMinor, feeMinor: snap.feeMinor, netMinor: snap.netMinor, percent: snap.percent || 0, cash: isCash(trip), lines, tipMinor: Number(trip.tip_minor) || 0, surged: isSurged(trip) };
  }
  const fareMinor = toMinor(e.passenger_fare, digits);
  const feeMinor = toMinor(e.platform_fee, digits);
  return { currency, digits, fareMinor, feeMinor, netMinor: fareMinor - feeMinor, percent: e.platform_fee_percent || 0, cash: isCash(trip), lines, tipMinor: Number(trip.tip_minor) || 0, surged: isSurged(trip) };
}

/** What to store on the trip when it completes. */
function snapshotFor(trip, tenant, at = new Date()) {
  const m = tripMoney({ ...trip, driver_earning: null }, tenant);
  return { fareMinor: m.fareMinor, feeMinor: m.feeMinor, netMinor: m.netMinor, percent: m.percent, currency: m.currency, at };
}

/** The business's payout settings with safe defaults. */
function settingsOf(tenant) {
  const s = (tenant && tenant.payoutSettings) || {};
  const pct = Number(s.commissionPercent);
  const min = Number(s.minWithdrawalMinor);
  return {
    commissionPercent: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : Number(tenant && tenant.market && tenant.market.driverCommissionPercent) || 0,
    minWithdrawalMinor: Number.isInteger(min) && min > 0 ? min : 0,
    cashWithdrawable: !!s.cashWithdrawable,
    processingNote: String(s.processingNote || '').slice(0, 140)
  };
}

/** Totals for a set of completed trips, and (optionally) the incentives and adjustments credited in the same period. */
function totals(trips, tenant, adjustments = []) {
  const t = { trips: 0, fareMinor: 0, feeMinor: 0, netMinor: 0, cashNetMinor: 0, onlineNetMinor: 0, cashFeeMinor: 0, onlineFeeMinor: 0, cashFareMinor: 0, onlineFareMinor: 0,
    tipMinor: 0, cashTipMinor: 0, onlineTipMinor: 0, incentiveMinor: 0, adjustMinor: 0, surgeNetMinor: 0, normalNetMinor: 0, surgeTrips: 0, currency: null };
  for (const trip of trips) {
    const m = tripMoney(trip, tenant);
    t.currency = t.currency || m.currency;
    t.trips += 1; t.fareMinor += m.fareMinor; t.feeMinor += m.feeMinor; t.netMinor += m.netMinor;
    t.tipMinor += m.tipMinor;
    if (m.surged) { t.surgeNetMinor += m.netMinor; t.surgeTrips += 1; } else t.normalNetMinor += m.netMinor;
    if (m.cash) { t.cashNetMinor += m.netMinor; t.cashFeeMinor += m.feeMinor; t.cashFareMinor += m.fareMinor; t.cashTipMinor += m.tipMinor; } else { t.onlineNetMinor += m.netMinor; t.onlineFeeMinor += m.feeMinor; t.onlineFareMinor += m.fareMinor; t.onlineTipMinor += m.tipMinor; }
  }
  for (const a of adjustments) { if (a.kind === 'INCENTIVE') t.incentiveMinor += a.amountMinor; else t.adjustMinor += a.amountMinor; }
  t.totalMinor = t.netMinor + t.tipMinor + t.incentiveMinor + t.adjustMinor;
  return t;
}

/** The withdrawable balance from the lifetime totals and the payouts on record. */
function balanceOf(lifetime, payouts, settings) {
  const sum = (status) => payouts.filter((p) => status.includes(p.status)).reduce((s, p) => s + p.amountMinor, 0);
  const paid = sum(['PAID']);
  const open = sum(['REQUESTED', 'PROCESSING']);
  const credited = settings.cashWithdrawable ? lifetime.totalMinor : lifetime.onlineNetMinor + lifetime.onlineTipMinor + lifetime.incentiveMinor + lifetime.adjustMinor - lifetime.cashFeeMinor;
  return { creditedMinor: credited, paidMinor: paid, openMinor: open, availableMinor: Math.max(0, credited - paid - open) };
}

const major = (minor, digits) => minor / 10 ** digits;

/** Mask an account number to its last four digits. */
const last4 = (n) => String(n || '').replace(/\D/g, '').slice(-4);

module.exports = { tripMoney, snapshotFor, settingsOf, totals, balanceOf, major, isCash, last4 };
