const mongoose = require('../lib/db/mongoose');

/**
 * One stretch of a driver being online: opened when the driver goes online, closed when they go offline. It is what the
 * driver app's "online hours" are added up from. A session left open (the phone died, the sweeper took the driver offline)
 * is closed lazily; see lib/dutyLog.js.
 */
const driverDutySessionSchema = new mongoose.Schema({
  driverId: { type: String, required: true, index: true },
  tenantId: { type: String, default: null },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, default: null }
}, { collection: 'driver_duty_sessions' });
driverDutySessionSchema.index({ driverId: 1, startedAt: -1 });

module.exports = { DriverDutySession: mongoose.models.DriverDutySession || mongoose.model('DriverDutySession', driverDutySessionSchema) };
