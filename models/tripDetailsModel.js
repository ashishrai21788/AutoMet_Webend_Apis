const mongoose = require('mongoose');

const TRIP_DETAIL_STATUSES = [
  'REQUESTED',
  'ACCEPTED',
  'DRIVER_ON_THE_WAY',
  'ARRIVED',
  'ON_GOING',
  'COMPLETED',
  'REJECTED',
  'REJECTED_WITH_REASON',
  'NO_RESPONSE',
  'CANCELLED_BY_USER',
  'CANCELLED_BY_USER_AFTER_ACCEPTANCE'
];

const tripDetailsSchema = new mongoose.Schema({
  trip_id: { type: String, required: true, unique: true, trim: true },
  request_id: { type: String, required: true, unique: true, trim: true, index: true },
  user_id: { type: String, required: true, trim: true, index: true },
  driver_id: { type: String, required: true, trim: true, index: true },
  // Which client (white-label app) the trip belongs to. Null = the default client (records from before multi-client).
  tenant_id: { type: String, default: null, trim: true, index: true },

  pickup: {
    address: { type: String, required: true, trim: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  drop: {
    address: { type: String, required: true, trim: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },

  ride_note: { type: String, default: null, trim: true },

  // Fare and trip size. Computed on the server when the request is created (see lib/fare.js), so every client shows
  // the same numbers. fare_basis is 'ESTIMATE' until a real meter / GPS trace exists, then 'ACTUAL'.
  fare: { type: Number, default: null },
  currency: { type: String, default: null, trim: true },
  distance_km: { type: Number, default: null },
  estimated_duration_min: { type: Number, default: null },
  fare_basis: { type: String, default: null, enum: ['ESTIMATE', 'ACTUAL', null] },
  payment_mode: { type: String, default: 'CASH', trim: true },
  // Where the fare came from: the business's own fare rules, or the legacy built-in tariff (see lib/tripPricing.js).
  fare_source: { type: String, default: null, enum: ['BUSINESS_RULES', 'LEGACY_TARIFF', null] },
  fare_breakdown: { type: mongoose.Schema.Types.Mixed, default: null },
  region_id: { type: String, default: null },
  category_id: { type: String, default: null },

  status: {
    type: String,
    required: true,
    enum: TRIP_DETAIL_STATUSES,
    default: 'REQUESTED',
    index: true
  },
  driver_response: { type: String, default: null, trim: true },
  reject_reason: { type: String, default: null, trim: true },
  cancellation_reason: { type: String, default: null, trim: true },
  cancelled_at: { type: Date, default: null },
  cancel_stage: { type: String, default: null, enum: ['before_accept', 'after_accept', null], trim: true },
  cancelled_by: { type: String, default: null, enum: ['USER', 'DRIVER', null], trim: true },

  requested_at: { type: Date, required: true, default: Date.now },
  responded_at: { type: Date, default: null },
  driver_on_the_way_at: { type: Date, default: null },
  arrived_at: { type: Date, default: null },
  started_at: { type: Date, default: null },
  completed_at: { type: Date, default: null },
  timeout_at: { type: Date, required: true },

  push_sent: { type: Boolean, default: false },
  push_message_id: { type: String, default: null, trim: true },
  push_sent_at: { type: Date, default: null },
  push_status: { type: String, default: null, enum: ['DELIVERED', 'FAILED', null], trim: true },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, {
  timestamps: false,
  collection: 'trip_details'
});

tripDetailsSchema.index({ user_id: 1, driver_id: 1, status: 1 });
tripDetailsSchema.index({ timeout_at: 1, status: 1 });

const TripDetails = mongoose.model('TripDetails', tripDetailsSchema);

module.exports = { TripDetails, TRIP_DETAIL_STATUSES };
