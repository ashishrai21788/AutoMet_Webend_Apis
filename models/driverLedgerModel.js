const mongoose = require('../lib/db/mongoose');

/**
 * Money the business adds to or takes from a driver's earnings outside a trip fare, in whole minor units.
 *   INCENTIVE   a bonus earned by reaching an incentive's target (credited once per incentive per driver, by the system)
 *   ADJUSTMENT  a correction an admin made, with the reason (positive adds, negative takes away)
 * These are owed to the driver by the business, so they count towards the balance the driver can withdraw.
 */
const driverAdjustmentSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  adjustmentId: { type: String, required: true, unique: true },
  driverId: { type: String, required: true, index: true },
  kind: { type: String, enum: ['INCENTIVE', 'ADJUSTMENT'], required: true },
  amountMinor: { type: Number, required: true },
  currency: { type: String, required: true },
  title: { type: String, default: '' },
  reason: { type: String, default: '' },
  refId: { type: String, default: null }, // the incentive that paid it
  createdBy: { type: String, default: 'system' },
  at: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'driver_adjustments' });
driverAdjustmentSchema.index({ tenantId: 1, driverId: 1, at: -1 });
driverAdjustmentSchema.index({ tenantId: 1, driverId: 1, refId: 1 }, { unique: true, partialFilterExpression: { kind: 'INCENTIVE' } });

const DriverAdjustment = mongoose.models.DriverAdjustment || mongoose.model('DriverAdjustment', driverAdjustmentSchema);

/**
 * An offer the business makes its drivers: complete `targetTrips` trips between two dates and (when bonusMinor is above 0) earn
 * a bonus. With no bonus it is a goal: the driver sees their progress, nothing is paid.
 */
const incentiveSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  incentiveId: { type: String, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },
  targetTrips: { type: Number, required: true, min: 1 },
  bonusMinor: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'INR' },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  categoryId: { type: String, default: null }, // only trips of this vehicle category count; null = any
  active: { type: Boolean, default: true },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'driver_incentives' });
incentiveSchema.index({ tenantId: 1, active: 1, endsAt: -1 });

const Incentive = mongoose.models.Incentive || mongoose.model('Incentive', incentiveSchema);

module.exports = { DriverAdjustment, Incentive };
