/**
 * Ride model for Vehicle Booking / Live Tracking.
 * Status flow: REQUESTED → ACCEPTED → DRIVER_ON_THE_WAY → ARRIVED → STARTED → COMPLETED | REQUESTED/ACCEPTED → CANCELLED | REQUESTED → REJECTED
 */

const mongoose = require('mongoose');

const RideStatus = Object.freeze({
  REQUESTED: 'REQUESTED',
  ACCEPTED: 'ACCEPTED',
  DRIVER_ON_THE_WAY: 'DRIVER_ON_THE_WAY',
  ARRIVED: 'ARRIVED',
  STARTED: 'STARTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED'
});

const RIDE_STATUSES = Object.values(RideStatus);

const terminalStatuses = [RideStatus.COMPLETED, RideStatus.CANCELLED, RideStatus.REJECTED];
const cancellableStatuses = [RideStatus.REQUESTED, RideStatus.ACCEPTED];
const acceptRejectStatus = RideStatus.REQUESTED;

const rideSchema = new mongoose.Schema({
  ride_id: { type: String, required: true, unique: true, trim: true, index: true },
  user_id: { type: String, required: true, trim: true, index: true },
  driver_id: { type: String, required: false, trim: true, index: true },

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
    enum: RIDE_STATUSES,
    default: RideStatus.REQUESTED,
    index: true
  },

  requested_at: { type: Date, required: true, default: Date.now },
  accepted_at: { type: Date, default: null },
  driver_on_the_way_at: { type: Date, default: null },
  arrived_at: { type: Date, default: null },
  started_at: { type: Date, default: null },
  completed_at: { type: Date, default: null },
  cancelled_at: { type: Date, default: null },
  rejected_at: { type: Date, default: null },

  reject_reason: { type: String, default: null, trim: true },
  cancellation_reason: { type: String, default: null, trim: true },
  cancelled_by: { type: String, default: null, enum: ['USER', 'DRIVER', 'SYSTEM', null], trim: true },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, {
  timestamps: false,
  collection: 'rides'
});

rideSchema.index({ user_id: 1, status: 1 });
rideSchema.index({ driver_id: 1, status: 1 });
rideSchema.index({ status: 1, requested_at: 1 });

const Ride = mongoose.model('Ride', rideSchema);

module.exports = {
  Ride,
  RideStatus,
  RIDE_STATUSES,
  terminalStatuses,
  cancellableStatuses,
  acceptRejectStatus
};
