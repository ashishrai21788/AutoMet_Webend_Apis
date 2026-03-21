/**
 * Per-driver rate limit for trip/ride requests.
 * When user cancels before driver response, clear so they can request again immediately (no 60s wait).
 */

const TRIP_RATE_LIMIT_SECONDS = Number(process.env.TRIP_RATE_LIMIT_SECONDS) || 60;
const lastRequestByDriver = new Map();

// Clean up expired entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  const windowMs = TRIP_RATE_LIMIT_SECONDS * 1000;
  for (const [driverId, timestamp] of lastRequestByDriver) {
    if (now - timestamp > windowMs) {
      lastRequestByDriver.delete(driverId);
    }
  }
}, 2 * 60 * 1000).unref();

function recordRequest(driverId) {
  if (driverId && typeof driverId === 'string' && driverId.trim()) {
    lastRequestByDriver.set(driverId.trim(), Date.now());
  }
}

function isRateLimited(driverId, windowSeconds = TRIP_RATE_LIMIT_SECONDS) {
  if (!driverId || typeof driverId !== 'string' || !driverId.trim()) return false;
  const last = lastRequestByDriver.get(driverId.trim());
  if (last == null) return false;
  return (Date.now() - last) < windowSeconds * 1000;
}

/**
 * Clear rate limit for a driver. Call when user cancels before driver response
 * so the user can immediately send a new request to the same driver.
 */
function clearForDriver(driverId) {
  if (driverId && typeof driverId === 'string' && driverId.trim()) {
    lastRequestByDriver.delete(driverId.trim());
  }
}

module.exports = {
  recordRequest,
  isRateLimited,
  clearForDriver,
  TRIP_RATE_LIMIT_SECONDS
};
