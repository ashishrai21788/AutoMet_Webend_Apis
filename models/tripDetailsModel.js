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
