/**
 * Ride chat rules (no database): who may talk, when, what a message may be, and how fast. Pure functions, tested on their own.
 *
 * A chat belongs to one trip. It opens when a driver accepts and closes when the ride ends (it stays readable afterwards, to the two
 * of them and to the business's own staff). Only the trip's rider and the trip's driver may write.
 */
const OPEN_STATUSES = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];
const MAX_LENGTH = 500;
const RATE_LIMIT = 20; // messages
const RATE_WINDOW_MS = 60 * 1000;

/** The roles an account has in this trip, or null when the account is not one of its two people. */
function participantOf(trip, authRole, actorId) {
  if (!trip || !actorId) return null;
  if (authRole === 'user' && trip.user_id && trip.user_id === actorId && trip.driver_id) {
    return { role: 'rider', me: actorId, other: trip.driver_id, otherRole: 'driver' };
  }
  if (authRole === 'driver' && trip.driver_id && trip.driver_id === actorId && trip.user_id) {
    return { role: 'driver', me: actorId, other: trip.user_id, otherRole: 'rider' };
  }
  return null;
}

const isOpen = (trip) => !!trip && OPEN_STATUSES.includes(trip.status);

/** Trimmed, control characters and line breaks turned into single spaces. Never shortens: a message that is too long is refused. */
function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function validate(value) {
  const text = cleanText(value);
  if (!text) return { ok: false, text, message: 'Write a message first.' };
  if (text.length > MAX_LENGTH) return { ok: false, text, message: `A message can be ${MAX_LENGTH} characters at most.` };
  return { ok: true, text };
}

/** `recent` is this sender's earlier messages on this ride. */
function tooFast(recent, now = new Date()) {
  const since = now.getTime() - RATE_WINDOW_MS;
  return (recent || []).filter((m) => new Date(m.createdAt).getTime() > since).length >= RATE_LIMIT;
}

/** What an app is shown of a stored message. `viewerRole` is 'rider' or 'driver'. */
function publicMessage(row, viewerRole) {
  return {
    id: row.messageId,
    trip_id: row.tripId,
    from: row.senderRole,
    mine: row.senderRole === viewerRole,
    text: row.text,
    at: new Date(row.createdAt).toISOString(),
    read: !!row.readAt
  };
}

module.exports = { OPEN_STATUSES, MAX_LENGTH, RATE_LIMIT, RATE_WINDOW_MS, participantOf, isOpen, cleanText, validate, tooFast, publicMessage };
