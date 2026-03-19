const mongoose = require('mongoose');

const tripCounterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
}, { collection: 'trip_counters' });

const TripCounter = mongoose.model('TripCounter', tripCounterSchema);

/**
 * Get next trip number (1, 2, 3, ...) and format as amt_id_XXXXXX (6-digit zero-padded).
 * @returns {Promise<string>} e.g. "amt_id_000001"
 */
async function getNextTripId() {
  const doc = await TripCounter.findByIdAndUpdate(
    'trip_id',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const num = doc.seq;
  const padded = String(num).padStart(6, '0');
  return `amt_id_${padded}`;
}

module.exports = { TripCounter, getNextTripId };
