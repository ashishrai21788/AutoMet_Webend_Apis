const mongoose = require('mongoose');

/**
 * Business-owned configuration. Every document carries `tenantId` (the business's appId) and every unique rule
 * includes it, so two businesses can use the same names without ever touching each other's records.
 * Access goes through lib/tenantData.js, which adds the tenant filter to every query.
 */

const serviceRegionSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  regionId: { type: String, required: true, unique: true },
  country: { type: String, required: true }, // ISO 3166-1 alpha-2, equals the business market country
  state: { type: String, required: true, trim: true },
  city: { type: String, required: true, trim: true },
  zoneName: { type: String, required: true, trim: true },
  /** lower-cased state|city|zone, used to stop duplicates inside one business */
  key: { type: String, required: true },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'service_regions' });
serviceRegionSchema.index({ tenantId: 1, key: 1 }, { unique: true });

const vehicleCategorySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  categoryId: { type: String, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  nameKey: { type: String, required: true },
  description: { type: String, default: '', trim: true },
  icon: { type: String, default: 'car' }, // preset icon key
  imageUrl: { type: String, default: '' }, // optional https image
  passengerCapacity: { type: Number, required: true },
  luggageCapacity: { type: Number, default: null },
  rideType: { type: String, required: true },
  regionIds: { type: [String], default: [] },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'vehicle_categories' });
vehicleCategorySchema.index({ tenantId: 1, nameKey: 1 }, { unique: true });

const additionalChargeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: { type: String, enum: ['fixed', 'percent_of_fare'], required: true },
  amount: { type: Number, required: true }
}, { _id: false });

const taxSchema = new mongoose.Schema({
  name: { type: String, required: true },
  ratePercent: { type: Number, required: true },
  appliesTo: { type: String, enum: ['fare', 'fare_and_fees'], required: true }
}, { _id: false });

const fareRuleSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  ruleId: { type: String, required: true, unique: true },
  categoryId: { type: String, required: true },
  /** null = default for the category in every region that has no override of its own */
  regionId: { type: String, default: null },
  regionKey: { type: String, required: true }, // regionId or 'default', so the unique index treats default as a value
  currency: { type: String, required: true }, // snapshot of the business currency when saved
  baseFare: { type: Number, required: true },
  perKm: { type: Number, required: true },
  perMinute: { type: Number, required: true },
  minimumFare: { type: Number, required: true },
  bookingFee: { type: Number, required: true },
  waitingFreeMinutes: { type: Number, required: true },
  waitingPerMinute: { type: Number, required: true },
  additionalCharges: { type: [additionalChargeSchema], default: [] },
  taxes: { type: [taxSchema], default: [] },
  surge: {
    type: new mongoose.Schema({ enabled: Boolean, maxMultiplier: Number }, { _id: false }),
    default: () => ({ enabled: false, maxMultiplier: 1 })
  },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'fare_rules' });
fareRuleSchema.index({ tenantId: 1, categoryId: 1, regionKey: 1 }, { unique: true });

const cancellationPolicySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  policyId: { type: String, required: true, unique: true },
  categoryId: { type: String, required: true },
  regionId: { type: String, default: null },
  regionKey: { type: String, required: true },
  currency: { type: String, required: true },
  rider: {
    type: new mongoose.Schema({
      freeCancellationMinutes: Number, // free window after the driver accepts
      feeAfterWindow: Number, // charged to the rider when cancelling after the free window
      feeAfterDriverArrived: Number, // charged to the rider when cancelling after the driver arrived
      noShowFee: Number // charged when the rider does not show up
    }, { _id: false })
  },
  driver: {
    type: new mongoose.Schema({
      penaltyFee: Number, // charged to the driver for cancelling after accepting
      graceCancellations: Number // cancellations per day before the penalty applies
    }, { _id: false })
  },
  conditions: { type: String, default: '', trim: true },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'cancellation_policies' });
cancellationPolicySchema.index({ tenantId: 1, categoryId: 1, regionKey: 1 }, { unique: true });

const setupProgressSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, unique: true },
  completedAt: { type: Date, default: null },
  completedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'business_setup_progress' });

const reuse = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

module.exports = {
  ServiceRegion: reuse('ServiceRegion', serviceRegionSchema),
  VehicleCategory: reuse('VehicleCategory', vehicleCategorySchema),
  FareRule: reuse('FareRule', fareRuleSchema),
  CancellationPolicy: reuse('CancellationPolicy', cancellationPolicySchema),
  SetupProgress: reuse('SetupProgress', setupProgressSchema)
};
