/**
 * In-memory resolver for create-request: when driver responds, the waiting HTTP request is resolved.
 * Key: trip_id, Value: { resolve(result), reject(err), createdAt }
 */
const pendingTrips = new Map();

// Clean up stale entries every 2 minutes (entries older than 3 minutes)
const STALE_TTL_MS = 3 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [tripId, entry] of pendingTrips) {
    if (now - entry.createdAt > STALE_TTL_MS) {
      pendingTrips.delete(tripId);
    }
  }
}, 2 * 60 * 1000).unref();

function registerWaiter(tripId, resolve, reject) {
  pendingTrips.set(tripId, { resolve, reject, createdAt: Date.now() });
}

function resolveWaiter(tripId, result) {
  const w = pendingTrips.get(tripId);
  if (w) {
    pendingTrips.delete(tripId);
    w.resolve(result);
  }
}

function rejectWaiter(tripId, err) {
  const w = pendingTrips.get(tripId);
  if (w) {
    pendingTrips.delete(tripId);
    w.reject(err);
  }
}

function hasWaiter(tripId) {
  return pendingTrips.has(tripId);
}

module.exports = { registerWaiter, resolveWaiter, rejectWaiter, hasWaiter };
