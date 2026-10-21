/**
 * Incentives and goals. An incentive says "complete N trips between these dates"; a bonus (when it has one) is credited to the
 * driver once, the moment they reach the target. The credit is an INCENTIVE row in the driver's ledger; a unique index on
 * (business, driver, incentive) makes a second credit impossible however many times this runs.
 */
const { Incentive, DriverAdjustment } = require('../models/driverLedgerModel');
const { TripDetails } = require('../models/tripDetailsModel');
const crypto = require('crypto');

const inWindow = (t, inc) => {
  const at = t.completed_at ? new Date(t.completed_at).getTime() : NaN;
  return at >= new Date(inc.startsAt).getTime() && at <= new Date(inc.endsAt).getTime();
};

/** How many of the driver's completed trips count towards this incentive. */
const progressOf = (inc, completed) => completed.filter((t) => inWindow(t, inc) && (!inc.categoryId || t.category_id === inc.categoryId)).length;

/** The incentives open to drivers now (or still running at `now`). */
async function activeIncentives(tenantId, now = new Date()) {
  const rows = await Incentive.find({ tenantId, active: true }).lean();
  return rows.filter((i) => new Date(i.startsAt) <= now && new Date(i.endsAt) >= now);
}

/**
 * Credits every bonus the driver has earned and not yet been paid. Safe to run any time and as often as wanted.
 * Returns the adjustments it created.
 */
async function settle({ tenantId, driverId, currency, now = new Date(), completed = null }) {
  const trips = completed || await TripDetails.find({ driver_id: driverId, status: 'COMPLETED' }).limit(20000).lean();
  const offers = (await Incentive.find({ tenantId, active: true, bonusMinor: { $gt: 0 } }).lean())
    .filter((i) => new Date(i.startsAt) <= now);
  if (!offers.length) return [];
  const credited = new Set((await DriverAdjustment.find({ tenantId, driverId, kind: 'INCENTIVE' }).lean()).map((a) => a.refId));
  const made = [];
  for (const inc of offers) {
    if (credited.has(inc.incentiveId)) continue;
    if (progressOf(inc, trips) < inc.targetTrips) continue;
    try {
      const doc = await DriverAdjustment.create({
        tenantId, adjustmentId: `adj_${crypto.randomBytes(8).toString('hex')}`, driverId, kind: 'INCENTIVE', amountMinor: inc.bonusMinor,
        currency: inc.currency || currency, title: inc.name, reason: `Completed ${inc.targetTrips} trips`, refId: inc.incentiveId, createdBy: 'system', at: now, createdAt: now
      });
      made.push(doc.toObject ? doc.toObject() : doc);
    } catch (e) { if (!(e && e.code === 11000)) throw e; } // already credited by another request
  }
  return made;
}

/** What the driver's screen shows for each open offer: progress, bonus and whether it is already paid. */
async function offersFor({ tenantId, driverId, now = new Date(), completed = null }) {
  const trips = completed || await TripDetails.find({ driver_id: driverId, status: 'COMPLETED' }).limit(20000).lean();
  const [open, ledger] = await Promise.all([activeIncentives(tenantId, now), DriverAdjustment.find({ tenantId, driverId, kind: 'INCENTIVE' }).lean()]);
  const paid = new Map(ledger.map((a) => [a.refId, a]));
  return open.map((i) => {
    const progress = progressOf(i, trips);
    return {
      id: i.incentiveId, name: i.name, description: i.description || '', targetTrips: i.targetTrips, progress: Math.min(progress, i.targetTrips), reached: progress >= i.targetTrips,
      bonusMinor: i.bonusMinor, startsAt: i.startsAt, endsAt: i.endsAt, paid: paid.has(i.incentiveId), paidAt: paid.has(i.incentiveId) ? paid.get(i.incentiveId).at : null,
      goal: !(i.bonusMinor > 0)
    };
  }).sort((a, b) => new Date(a.endsAt) - new Date(b.endsAt));
}

module.exports = { settle, offersFor, activeIncentives, progressOf };
