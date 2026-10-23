/**
 * What a rider owes for cancelling a ride the driver had already accepted, from the business's own cancellation policy
 * (set in its dashboard: a free window after the driver accepts, a fee after it, and a fee once the driver has arrived).
 * Pure functions, so the rules are tested without a database. Nothing here is a guess: no policy, no fee.
 */
const LIVE_AFTER_ACCEPT = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED'];

/** The policy for a trip's category: the one for its region when there is one, else the category's general one. */
function policyFor(policies, trip) {
  const list = Array.isArray(policies) ? policies : [];
  const forCategory = list.filter((p) => p && p.categoryId && p.categoryId === (trip && trip.category_id));
  return (trip && trip.region_id && forCategory.find((p) => p.regionId === trip.region_id))
    || forCategory.find((p) => !p.regionId)
    || null;
}

const money = (n) => Math.round(Number(n) * 100) / 100;

/**
 * @returns {{ fee: number, reason: null|'DRIVER_ARRIVED'|'AFTER_FREE_WINDOW', currency: string|null }}
 */
function riderCancelFee(policy, trip, now = new Date()) {
  const none = { fee: 0, reason: null, currency: policy ? policy.currency || null : null };
  const rider = policy && policy.rider;
  if (!rider || !trip || !LIVE_AFTER_ACCEPT.includes(trip.status)) return none;
  const arrivedFee = Number(rider.feeAfterDriverArrived) || 0;
  if (trip.status === 'ARRIVED' && arrivedFee > 0) return { fee: money(arrivedFee), reason: 'DRIVER_ARRIVED', currency: policy.currency || null };
  const windowFee = Number(rider.feeAfterWindow) || 0;
  const accepted = trip.responded_at ? new Date(trip.responded_at).getTime() : null;
  const minutes = accepted == null ? 0 : (now.getTime() - accepted) / 60000;
  if (windowFee > 0 && minutes > (Number(rider.freeCancellationMinutes) || 0)) {
    return { fee: money(windowFee), reason: 'AFTER_FREE_WINDOW', currency: policy.currency || null };
  }
  return none;
}

/**
 * What a driver owes for cancelling a ride they had accepted. The policy gives a number of free cancellations per day
 * (`graceCancellations`); once the driver has used them, each further cancellation costs `penaltyFee`.
 * @param priorToday how many rides this driver cancelled earlier today, not counting this one
 * @returns {{ penalty: number, reason: null|'AFTER_FREE_CANCELLATIONS', freeLeft: number, currency: string|null }}
 */
function driverCancelPenalty(policy, priorToday) {
  const driver = policy && policy.driver;
  const currency = policy ? policy.currency || null : null;
  const grace = Math.max(0, Math.floor(Number(driver && driver.graceCancellations) || 0));
  const used = Math.max(0, Math.floor(Number(priorToday) || 0));
  const penalty = money(Number(driver && driver.penaltyFee) || 0);
  const none = { penalty: 0, reason: null, freeLeft: Math.max(0, grace - used - 1), currency };
  if (!driver || penalty <= 0 || used < grace) return none;
  return { penalty, reason: 'AFTER_FREE_CANCELLATIONS', freeLeft: 0, currency };
}

module.exports = { policyFor, riderCancelFee, driverCancelPenalty, LIVE_AFTER_ACCEPT };
