/**
 * The driver's cancellation penalty, from the dashboard.
 *
 *   penaltyOf(tenantId, trip)                          what the trip's detail shows: the amount and whether it was waived
 *   POST /api/admin/business/trips/:id/waive-driver-penalty { reason }   give the penalty back to the driver
 *
 * A waiver is a positive PENALTY_WAIVER entry in the driver's ledger for the same amount, with the reason and who did it. There is
 * a unique index on (business, driver, trip) for that kind, so two admins clicking at once, or a repeat, cannot give it back twice.
 */
const crypto = require('crypto');
const { AdminAudit } = require('../models/adminModels');
const { TripDetails } = require('../models/tripDetailsModel');
const { DriverAdjustment } = require('../models/driverLedgerModel');
const { tenantMatch } = require('../lib/tenantScope');
const { digitsOf } = require('../lib/riderInvoice');
const c = require('./fleet/common');

const cleanReason = (v) => String(v || '').trim().replace(/\s+/g, ' ');

/** { amount, currency, waived, waivedAt, waivedBy, reason } for a trip the driver was penalised for, else null. */
async function penaltyOf(tenantId, trip) {
  if (!trip || !(Number(trip.driver_penalty_minor) > 0) || !trip.driver_id) return null;
  const rows = await DriverAdjustment.find({ tenantId, driverId: trip.driver_id, refId: trip.trip_id, kind: { $in: ['PENALTY', 'PENALTY_WAIVER'] } }).lean();
  const penalty = rows.find((r) => r.kind === 'PENALTY');
  const waiver = rows.find((r) => r.kind === 'PENALTY_WAIVER');
  const currency = (penalty && penalty.currency) || trip.currency || 'INR';
  const digits = digitsOf(currency);
  return {
    amount: Number(trip.driver_penalty_minor) / 10 ** digits, currency,
    waived: !!waiver, waivedAt: waiver ? waiver.at : null, waivedBy: waiver ? waiver.createdBy : null, reason: waiver ? waiver.reason : ''
  };
}

/** POST .../trips/:id/waive-driver-penalty { reason } */
const waive = c.handle(async (req, res) => {
  const reason = cleanReason(req.body && req.body.reason);
  if (reason.length < 5) return c.invalid(res, { reason: 'Give a reason of at least 5 characters' });
  if (reason.length > 300) return c.invalid(res, { reason: 'Keep the reason under 300 characters' });

  const tenantId = req.business.tenantId;
  const trip = await TripDetails.findOne({ ...tenantMatch(req.business, 'tenant_id'), trip_id: String(req.params.id) }).lean();
  if (!trip) return c.fail(res, 404, 'Trip not found');
  const penalty = await DriverAdjustment.findOne({ tenantId, driverId: trip.driver_id, kind: 'PENALTY', refId: trip.trip_id }).lean();
  if (!penalty || !(Number(trip.driver_penalty_minor) > 0)) return c.fail(res, 409, 'The driver was not charged a penalty for this trip');

  const now = new Date();
  try {
    await DriverAdjustment.create({
      tenantId, adjustmentId: `adj_${crypto.randomBytes(8).toString('hex')}`, driverId: trip.driver_id, kind: 'PENALTY_WAIVER',
      amountMinor: Math.abs(penalty.amountMinor), currency: penalty.currency, title: 'Cancellation penalty waived', reason,
      refId: trip.trip_id, createdBy: req.admin.email || req.admin.adminId, at: now, createdAt: now
    });
  } catch (e) {
    if (e && e.code === 11000) return c.fail(res, 409, 'This penalty has already been waived');
    throw e;
  }
  try {
    await AdminAudit.create({ tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action: 'driver_penalty.waived', targetType: 'trip', targetId: trip.trip_id, meta: { driverId: trip.driver_id, amountMinor: Math.abs(penalty.amountMinor), reason }, ip: req.ip || null });
  } catch (e) { console.warn('[penalty] audit write failed:', e.message); }
  return c.ok(res, await penaltyOf(tenantId, trip));
});

module.exports = { penaltyOf, waive };
