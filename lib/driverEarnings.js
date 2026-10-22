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
  const { lines, totalMinor, tollMinor } = linesFromTrip(trip, digits);
  const configured = tenant && tenant.payoutSettings && Number(tenant.payoutSettings.commissionPercent);
  const raw = Number.isFinite(configured) && configured > 0 ? configured : Number(tenant && tenant.market && tenant.market.driverCommissionPercent);
  const percent = Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 0;
  // A coupon the business funds (the default) is paid by the business, so the driver is paid on the fare before the discount.
  // A driver-funded coupon leaves the driver earning on what the rider paid.
  const coupon = trip.coupon && Number(trip.coupon.discount_minor) > 0 ? trip.coupon : null;
  const businessFunded = !!coupon && String(coupon.funded_by || 'BUSINESS').toUpperCase() === 'BUSINESS';
  const discountMinor = businessFunded ? Math.min(Number(coupon.discount_minor), 10 ** 12) : 0;
  const fareMinor = totalMinor + discountMinor; // everything the rider paid plus what the business covered; includes the toll
  const feeBaseMinor = fareMinor - tollMinor; // no commission on a toll: it is the driver's money back
  const kept = businessFunded ? lines.filter((l) => l.kind !== 'DISCOUNT') : lines;
  const feeMinor = Math.round((feeBaseMinor * percent) / 100);
  return {
    currency,
    passenger_fare: fareMinor / unit,
    rider_paid: totalMinor / unit,
    toll: tollMinor / unit,
    coupon_discount_funded: discountMinor / unit,
    lines: kept.map((l) => ({ label: l.label, amount: l.amountMinor / unit, kind: l.kind })),
    platform_fee_percent: percent,
    platform_fee: feeMinor / unit,
    earnings: (fareMinor - feeMinor) / unit
  };
}

module.exports = { earningsFor };
