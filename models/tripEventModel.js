const mongoose = require('mongoose');

const tripEventSchema = new mongoose.Schema({
  trip_id: { type: String, required: true, trim: true, index: true },
  event: { type: String, required: true, trim: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  created_at: { type: Date, default: Date.now }
}, { timestamps: false, collection: 'trip_events' });

tripEventSchema.index({ trip_id: 1, created_at: 1 });

const TripEvent = mongoose.model('TripEvent', tripEventSchema);

module.exports = TripEvent;
