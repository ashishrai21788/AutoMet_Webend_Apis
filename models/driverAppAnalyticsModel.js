const mongoose = require('mongoose');

// Event schema: only event-specific fields. deviceId, sessionId, appId, source, platform, appVersion live at document level only.
const eventSchema = new mongoose.Schema({
  eventName: { type: String, required: true, trim: true },
  eventCategory: { type: String, default: 'driver', trim: true },
  pageIdentifier: { type: String, default: null, trim: true },
  params: { type: mongoose.Schema.Types.Mixed, default: {} },
  eventId: { type: String, default: null, trim: true },
  actorId: { type: String, default: null, trim: true },
  actorType: { type: String, default: 'driver', trim: true },
  clientTimestamp: { type: Date, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const driverAppAnalyticsSchema = new mongoose.Schema({
  events: {
    type: [eventSchema],
    required: true,
    validate: {
      validator: (v) => Array.isArray(v) && v.length > 0,
      message: 'events must be a non-empty array'
    }
  },
  driverId: { type: String, default: null, trim: true },
  deviceId: { type: String, required: true, trim: true },
  sessionId: { type: String, required: true, trim: true },
  appId: { type: String, required: true, trim: true },
  appVersion: { type: String, default: null, trim: true },
  platform: { type: String, default: null, trim: true },
  source: { type: String, required: true, trim: true }
}, { timestamps: true, collection: 'driver_app_analytics' });

module.exports = mongoose.model('DriverAppAnalytics', driverAppAnalyticsSchema);
