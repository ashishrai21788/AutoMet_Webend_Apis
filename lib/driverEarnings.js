/**
 * What a driver earns on one trip, worked out on the server from the trip's own fare lines. The business may keep a share of
 * each fare (market.driverCommissionPercent on its record, 0 by default: the driver then receives the whole fare). Money is
 * computed in whole minor units so the lines always add up to the total.
 */
const { linesFromTrip, toMinor, digitsOf } = require('./riderInvoice');

function earningsFor(trip, tenant) {
  const currency = trip.currency || (tenant && tenant.market && tenant.market.currency) || 'INR';
  const digits = digitsOf(currency);
  const unit = 10 ** digits;
  const { lines, totalMinor } = linesFromTrip(trip, digits);
  const raw = Number(tenant && tenant.market && tenant.market.driverCommissionPercent);
  const percent = Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 0;
  const feeMinor = Math.round((totalMinor * percent) / 100);
  return {
    currency,
    passenger_fare: totalMinor / unit,
    lines: lines.map((l) => ({ label: l.label, amount: l.amountMinor / unit, kind: l.kind })),
    platform_fee_percent: percent,
    platform_fee: feeMinor / unit,
    earnings: (totalMinor - feeMinor) / unit
  };
}

module.exports = { earningsFor };
