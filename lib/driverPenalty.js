/**
 * The penalty a driver pays for cancelling a ride they had accepted, from the business's cancellation policy:
 * `driver.graceCancellations` free cancellations per day (in the business's time zone), then `driver.penaltyFee` for each further one.
 * It is taken from the driver's earnings as a PENALTY entry in the ledger and is noted on the trip.
 * No policy, or a penalty of 0: nothing is taken. Safe to repeat for the same trip: it is taken once.
 */
const crypto = require('crypto');
const { Tenant } = require('../models/adminModels');
const { TripDetails } = require('../models/tripDetailsModel');
const { DriverAdjustment } = require('../models/driverLedgerModel');
const { driverCancelPenalty } = require('./cancellationFee');
const { startOfDay } = require('./timeZone');
const { digitsOf, toMinor } = require('./riderInvoice');

/** How many rides this driver cancelled earlier today (the business's day), not counting `trip`. */
async function cancelledToday(trip, tz, now) {
  const since = startOfDay(now, tz);
  const rows = await TripDetails.find({ driver_id: trip.driver_id, status: 'CANCELLED_BY_DRIVER', cancelled_at: { $gte: since } }).select('trip_id').limit(500).lean();
  return rows.filter((r) => r.trip_id !== trip.trip_id).length;
}

/**
 * What cancelling this trip costs the driver, as things stand now (nothing is taken). Used for the warning before the driver
 * confirms, and by the charge itself, so the two always agree.
 * @returns {Promise<{ penalty: number, currency: string|null, freeLeft: number, tenant: object|null }>}
 */
async function previewForCancel({ trip, policy, now = new Date() }) {
  const none = { penalty: 0, currency: policy ? policy.currency || null : null, freeLeft: 0, tenant: null };
  if (!trip || !trip.tenant_id || !trip.driver_id || !policy) return none;
  const tenant = await Tenant.findOne({ tenantId: trip.tenant_id }).lean();
  const tz = (tenant && tenant.market && tenant.market.timezone) || 'Asia/Kolkata';
  const verdict = driverCancelPenalty(policy, await cancelledToday(trip, tz, now));
  return { penalty: verdict.penalty, currency: verdict.currency, freeLeft: verdict.freeLeft, tenant };
}

/**
 * @param trip the trip the driver just cancelled (it must already be marked cancelled)
 * @param policy the cancellation policy for the trip's category, or null
 * @returns {Promise<{ penalty: number, penaltyMinor: number, currency: string|null, freeLeft: number }>}
 */
async function chargeForCancel({ trip, policy, now = new Date() }) {
  const none = { penalty: 0, penaltyMinor: 0, currency: policy ? policy.currency || null : null, freeLeft: 0 };
  if (!trip || !trip.tenant_id || !trip.driver_id || !policy) return none;
  const verdict = await previewForCancel({ trip, policy, now });
  if (verdict.penalty <= 0) return { ...none, freeLeft: verdict.freeLeft };

  const { tenant } = verdict;
  const currency = verdict.currency || (tenant && tenant.market && tenant.market.currency) || 'INR';
  const penaltyMinor = toMinor(verdict.penalty, digitsOf(currency));
  const already = await DriverAdjustment.findOne({ tenantId: trip.tenant_id, driverId: trip.driver_id, kind: 'PENALTY', refId: trip.trip_id }).lean();
  if (!already) {
    await DriverAdjustment.create({
      tenantId: trip.tenant_id, adjustmentId: `adj_${crypto.randomBytes(8).toString('hex')}`, driverId: trip.driver_id, kind: 'PENALTY',
      amountMinor: -penaltyMinor, currency, title: 'Cancellation penalty', reason: `Cancelled trip ${trip.trip_id}`, refId: trip.trip_id, createdBy: 'system', at: now, createdAt: now
    });
  }
  await TripDetails.updateOne({ trip_id: trip.trip_id }, { $set: { driver_penalty_minor: penaltyMinor } });
  return { penalty: verdict.penalty, penaltyMinor, currency, freeLeft: 0 };
}

module.exports = { chargeForCancel, previewForCancel, cancelledToday };
