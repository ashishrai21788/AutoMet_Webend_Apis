/**
 * In-memory resolver for create-request: when driver responds, the waiting HTTP request is resolved.
 * Key: trip_id, Value: { resolve(result), reject(err) }
 */
const pendingTrips = new Map();

function registerWaiter(tripId, resolve, reject) {
  pendingTrips.set(tripId, { resolve, reject });
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
