const { presenceOf, positionOf, config } = require('./driverLocation');

/** How the dashboard describes a driver's presence: online or not, how fresh the location is, and when they were last seen. */
function presenceFields(driver, { now = new Date(), currentTripId = null } = {}) {
  const p = presenceOf(driver, now);
  const pos = positionOf(driver);
  return {
    online: !!driver.isOnline,
    presence: p.state, // LIVE, STALE, NO_SIGNAL or OFFLINE
    locationAgeSeconds: p.ageSeconds,
    lastLocationAt: driver.locationUpdatedAt || null,
    // the last time the platform heard from the driver in any way (a heartbeat, going online, signing in)
    lastSeenAt: driver.locationUpdatedAt || driver.lastActive || null,
    position: pos,
    wentOfflineReason: !driver.isOnline && driver.wentOfflineReason ? driver.wentOfflineReason : null,
    currentTripId
  };
}

module.exports = { presenceFields, config };
