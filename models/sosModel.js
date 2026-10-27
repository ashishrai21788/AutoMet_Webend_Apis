const mongoose = require('../lib/db/mongoose');

/**
 * An emergency raised by a rider or driver during a ride (see controllers/sosController.js). One open alert per person per trip: a
 * second press adds a location and raises the count. The details of the trip are copied in when it is raised, so the record still
 * reads correctly if the trip or the people change later.
 */
const sosSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  sosId: { type: String, required: true, unique: true },
  tripId: { type: String, required: true },
  raisedByRole: { type: String, enum: ['rider', 'driver'], required: true },
  raisedById: { type: String, required: true },
  raisedByName: { type: String, default: null },
  raisedByPhone: { type: String, default: null },
  otherName: { type: String, default: null },
  otherPhone: { type: String, default: null },
  vehicle: { type: String, default: null },
  pickupAddress: { type: String, default: null },
  dropAddress: { type: String, default: null },
  tripStatus: { type: String, default: null },
  /** OPEN until staff acknowledge it, then ACKNOWLEDGED, then RESOLVED */
  status: { type: String, enum: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'], default: 'OPEN' },
  presses: { type: Number, default: 1 },
  locations: { type: mongoose.Schema.Types.Mixed, default: [] },
  lastPressAt: { type: Date, default: Date.now },
  acknowledgedBy: { type: mongoose.Schema.Types.Mixed, default: null },
  acknowledgedAt: { type: Date, default: null },
  resolvedBy: { type: mongoose.Schema.Types.Mixed, default: null },
  resolvedAt: { type: Date, default: null },
  resolution: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'sos_alerts' });
sosSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
sosSchema.index({ tenantId: 1, tripId: 1, raisedById: 1 });

const SosAlert = mongoose.models.SosAlert || mongoose.model('SosAlert', sosSchema);

module.exports = { SosAlert };
