/**
 * SOS rules (no database). A rider or driver on a ride presses Emergency: the business is told, and the app opens the phone's dialler.
 * An SOS can be raised while the ride is under way and for 30 minutes after it completes (the people may still be together).
 * A bad or missing location is never a reason to refuse: an emergency is always recorded.
 */
const ACTIVE_STATUSES = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];
const AFTER_COMPLETION_MS = 30 * 60 * 1000;
const MAX_LOCATIONS = 20;
const NOTE_MAX = 300;

function canRaise(trip, now = new Date()) {
  if (!trip) return false;
  if (ACTIVE_STATUSES.includes(trip.status)) return true;
  if (trip.status === 'COMPLETED' && trip.completed_at) return now.getTime() - new Date(trip.completed_at).getTime() <= AFTER_COMPLETION_MS;
  return false;
}

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/** A usable point, or null. */
function cleanLocation(input) {
  if (!input || typeof input !== 'object') return null;
  const lat = num(input.lat); const lng = num(input.lng); const acc = num(input.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng, accuracy: Number.isFinite(acc) && acc >= 0 ? Math.round(acc * 10) / 10 : null };
}

/** The full name as the apps show it. */
const fullName = (doc, fallback) => {
  const full = doc ? [doc.firstName, doc.lastName].filter((p) => typeof p === 'string' && /[\p{L}\p{N}]/u.test(p)).map((p) => p.trim()).join(' ') : '';
  return full || (doc && doc.name) || fallback;
};

/** What staff are shown of a stored alert. */
function publicAlert(a) {
  const last = (a.locations || []).slice(-1)[0] || null;
  return {
    id: a.sosId, tripId: a.tripId, status: a.status, presses: a.presses || 1, tripStatus: a.tripStatus || null,
    raisedBy: { role: a.raisedByRole, name: a.raisedByName || null, phone: a.raisedByPhone || null },
    other: { name: a.otherName || null, phone: a.otherPhone || null },
    vehicle: a.vehicle || null, pickup: a.pickupAddress || null, drop: a.dropAddress || null,
    locations: (a.locations || []).map((l) => ({ lat: l.lat, lng: l.lng, accuracy: l.accuracy ?? null, at: l.at })),
    mapUrl: last ? `https://www.google.com/maps?q=${last.lat},${last.lng}` : null,
    createdAt: a.createdAt, lastPressAt: a.lastPressAt || a.createdAt,
    acknowledgedBy: a.acknowledgedBy ? { email: a.acknowledgedBy.email || null } : null, acknowledgedAt: a.acknowledgedAt || null,
    resolvedBy: a.resolvedBy ? { email: a.resolvedBy.email || null } : null, resolvedAt: a.resolvedAt || null, resolution: a.resolution || null
  };
}

module.exports = { ACTIVE_STATUSES, AFTER_COMPLETION_MS, MAX_LOCATIONS, NOTE_MAX, canRaise, cleanLocation, fullName, publicAlert };
