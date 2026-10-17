const mongoose = require('../lib/db/mongoose');

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
  'CANCELLED_BY_USER_AFTER_ACCEPTANCE',
  'CANCELLED_BY_DRIVER' // written by POST /api/v1/trips/cancel-request when the driver cancels
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
  // Random token of the public ride-tracking link the rider shared (null until shared). See lib/tripShare.js.
  share_token: { type: String, default: null, index: true },

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
  cancelled_by: { type: String, default: null, enum: ['USER', 'DRIVER', 'ADMIN', null], trim: true },
  // what the rider owes for cancelling after the driver accepted, from the business's cancellation policy (0 when nothing)
  cancellation_fee: { type: Number, default: 0, min: 0 },
  cancellation_fee_reason: { type: String, default: null, trim: true },

  // Automatic dispatch (lib/dispatch.js): the request is offered to one driver at a time, nearest first.
  dispatch_mode: { type: String, default: 'MANUAL', enum: ['MANUAL', 'AUTO'], trim: true },
  dispatch_attempted: { type: [String], default: [] },
  dispatch_attempts: { type: Number, default: 0, min: 0 },

  // Wrong start-code attempts for this trip (see lib/tripStartOtp.js). The code itself is derived, never stored.
  start_otp_attempts: { type: Number, default: 0, min: 0 },
  // when the rider's start code was accepted. A trip with started_at but no value here began without the code check.
  start_otp_verified_at: { type: Date, default: null },

  // When the rider's app showed the finished-trip receipt and the rider dismissed it (POST /api/v1/rides/receipt-ack),
  // or rated the trip. Until then a finished trip is still offered to the rider on the next app start. Separate from the rating.
  rider_receipt_ack_at: { type: Date, default: null },

  // The rider's rating of the driver for this trip. Written once, after the trip is COMPLETED (POST /api/v1/rides/rating).
  rider_rating: {
    stars: { type: Number, default: null, min: 1, max: 5 },
    comment: { type: String, default: null, trim: true, maxlength: 300 },
    // what the rider picked from the quick feedback chips (see RATING_TAGS in rideController)
    tags: { type: [String], default: [] },
    rated_at: { type: Date, default: null }
  },

  // The driver's rating of the rider for this trip. Written once, after the trip is COMPLETED (POST /api/v1/rides/rate-rider).
  driver_rating: {
    stars: { type: Number, default: null, min: 1, max: 5 },
    comment: { type: String, default: null, trim: true, maxlength: 300 },
    rated_at: { type: Date, default: null }
  },

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
// a rider's or a driver's trip list, newest first (the history screens page through these)
tripDetailsSchema.index({ user_id: 1, requested_at: -1 });
tripDetailsSchema.index({ driver_id: 1, requested_at: -1 });

const TripDetails = mongoose.model('TripDetails', tripDetailsSchema);

module.exports = { TripDetails, TRIP_DETAIL_STATUSES };
