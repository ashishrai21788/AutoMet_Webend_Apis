const mongoose = require('mongoose');

const userDriverMapViewSchema = new mongoose.Schema({
  driverId: { type: String, required: true, trim: true },
  sessionId: { type: String, required: true, trim: true },
  lastSeen: { type: Date, required: true, default: Date.now }
}, { collection: 'user_driver_map_views', timestamps: false });

userDriverMapViewSchema.index({ lastSeen: 1 }, { expireAfterSeconds: 60 });
userDriverMapViewSchema.index({ driverId: 1, sessionId: 1 }, { unique: true });

module.exports = mongoose.model('UserDriverMapView', userDriverMapViewSchema);
