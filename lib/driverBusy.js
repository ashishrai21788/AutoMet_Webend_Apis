/**
 * One driver, one trip at a time. The driver app already ignores a second request while it is on a ride, but the server
 * must not rely on the client: without this a second rider could book, and the driver could accept, a driver who was
 * already on another trip.
 *
 * "Committed" trips are ones the driver has accepted and not finished. A pending request (REQUESTED, still inside its
 * answer window) also counts when a NEW request is created, so a driver is offered one ride at a time; a pending request
 * does not block accepting another (the new-request check prevents two being pending in the first place).
 */
const COMMITTED_STATUSES = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];

/**
 * @param {object} TripDetails the trip model
 * @param {string} driverId
 * @param {{ exceptTripId?: string, includePending?: boolean, now?: Date }} [opts]
 * @returns {Promise<{ trip_id: string, status: string } | null>} a conflicting trip, or null when the driver is free
 */
async function findDriverConflict(TripDetails, driverId, opts = {}) {
  const { exceptTripId = null, includePending = false, now = new Date() } = opts;
  if (!driverId) return null;
  const pick = (rows) => (rows || []).find((t) => t && t.trip_id !== exceptTripId) || null;

  const committed = pick(await TripDetails.find({ driver_id: driverId, status: { $in: COMMITTED_STATUSES } }).limit(5));
  if (committed) return { trip_id: committed.trip_id, status: committed.status };
  if (!includePending) return null;

  const pending = pick(await TripDetails.find({ driver_id: driverId, status: 'REQUESTED', timeout_at: { $gt: now } }).limit(5));
  return pending ? { trip_id: pending.trip_id, status: pending.status } : null;
}

module.exports = { COMMITTED_STATUSES, findDriverConflict };
