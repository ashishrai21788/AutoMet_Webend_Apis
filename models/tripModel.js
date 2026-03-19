const mongoose = require('mongoose');

const TRIP_STATUSES = [
  'REQUESTED',
  'ACCEPTED',
  'DRIVER_ON_THE_WAY',
  'ARRIVED',
  'ON_GOING',
  'COMPLETED',
  'REJECTED',
  'NO_RESPONSE',
  'REJECTED_WITH_REASON',
  'CANCELLED_BY_USER',
  'CANCELLED_BY_USER_AFTER_ACCEPTANCE'
];

const tripSchema = new mongoose.Schema({
  trip_id: { type: String, required: true, unique: true, trim: true },
  request_id: { type: String, default: null, trim: true, index: true },
  user_id: { type: String, required: true, trim: true, index: true },
  driver_id: { type: String, required: true, trim: true, index: true },

  pickup_address: { type: String, required: true, trim: true },
  pickup_latitude: { type: Number, required: true },
  pickup_longitude: { type: Number, required: true },

  drop_address: { type: String, required: true, trim: true },
  drop_latitude: { type: Number, required: true },
  drop_longitude: { type: Number, required: true },

  ride_note: { type: String, default: null, trim: true },
  status: {
    type: String,
    required: true,
    enum: TRIP_STATUSES,
    default: 'REQUESTED',
    index: true
  },
  rejected_reason: { type: String, default: null, trim: true },
  rejected_by: { type: String, default: null, enum: ['USER', 'DRIVER', null], trim: true },

  cancellation_reason: { type: String, default: null, trim: true },
  cancelled_at: { type: Date, default: null },
  cancel_stage: { type: String, default: null, enum: ['before_accept', 'after_accept', null], trim: true },
  cancelled_by: { type: String, default: null, enum: ['USER', 'DRIVER', null], trim: true },

  requested_at: { type: Date, required: true, default: Date.now },
  accepted_at: { type: Date, default: null },
  driver_on_the_way_at: { type: Date, default: null },
  arrived_at: { type: Date, default: null },
  started_at: { type: Date, default: null },
  completed_at: { type: Date, default: null }
}, {
  timestamps: true,
  collection: 'trips'
});

tripSchema.index({ user_id: 1, driver_id: 1, status: 1 });
tripSchema.index({ requested_at: 1 });

const Trip = mongoose.model('Trip', tripSchema);

module.exports = { Trip, TRIP_STATUSES };
