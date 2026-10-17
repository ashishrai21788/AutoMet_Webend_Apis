const mongoose = require('../lib/db/mongoose');

/**
 * Where a rider is while their app is open on the map: one row per rider, refreshed about once a minute. It is what the
 * driver app's "demand in your area" comes from, so a row older than a few minutes means nothing and is ignored.
 */
const riderPresenceSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  tenantId: { type: String, default: null, index: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  /** the neighbourhood name the rider phone gave for this spot, e.g. "Sector 62" */
  area: { type: String, default: '' },
  lastSeen: { type: Date, required: true }
}, { collection: 'rider_presence' });
riderPresenceSchema.index({ tenantId: 1, lastSeen: -1 });

module.exports = { RiderPresence: mongoose.models.RiderPresence || mongoose.model('RiderPresence', riderPresenceSchema) };
