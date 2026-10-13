/**
 * Trip start code. The rider is shown a 4-digit code once the driver is on the way; the driver must type it to start the
 * trip. This proves the right person is in the right vehicle and stops a trip being started from the driver's couch.
 *
 * The code is DERIVED, never stored: HMAC(server secret, trip id + the time the driver accepted). That means
 *  - it cannot leak through any trip serializer, list, export or log (there is nothing on the trip to leak);
 *  - only the rider's own details response computes it, and the driver is never sent it;
 *  - it changes if the trip is reassigned (a new accept time).
 * Wrong attempts are counted on the trip (start_otp_attempts) and the trip is locked after MAX_ATTEMPTS.
 *
 * Switch: TRIP_START_OTP=on. Off by default so apps that do not send the code yet keep working; turn it on once both
 * apps are released. (A per-business setting is the next step.)
 */
const crypto = require('crypto');

const MAX_ATTEMPTS = 5;
const SHOW_TO_RIDER_WHEN = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED'];

const enabled = () => String(process.env.TRIP_START_OTP || '').trim().toLowerCase() === 'on';

function secret() {
  const s = process.env.TRIP_OTP_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('A server secret (JWT_SECRET) is required to derive trip start codes');
  return s;
}

/** The 4-digit code for this trip's current assignment. */
function codeFor(trip) {
  const stamp = trip.responded_at ? new Date(trip.responded_at).toISOString() : '';
  const mac = crypto.createHmac('sha256', secret()).update(`${trip.trip_id}|${stamp}`).digest();
  return String(mac.readUInt32BE(0) % 10000).padStart(4, '0');
}

/** What the rider may see: the code only while the driver is coming or has arrived. */
function codeForRider(trip) {
  if (!enabled() || !trip || !SHOW_TO_RIDER_WHEN.includes(trip.status)) return null;
  return codeFor(trip);
}

/**
 * Checks the code the driver typed. Pure: returns what to do, the caller records the attempt.
 * @returns {{ ok: boolean, code?: 'OTP_REQUIRED'|'OTP_INVALID'|'OTP_LOCKED', status?: number, message?: string }}
 */
function check(trip, supplied) {
  if (!enabled()) return { ok: true };
  if ((trip.start_otp_attempts || 0) >= MAX_ATTEMPTS) {
    return { ok: false, code: 'OTP_LOCKED', status: 429, message: 'Too many wrong codes. Ask support to start this trip.' };
  }
  const given = supplied == null ? '' : String(supplied).trim();
  if (!given) return { ok: false, code: 'OTP_REQUIRED', status: 400, message: 'Ask the rider for their 4-digit start code.' };
  // Only four ASCII digits can be right; anything else is refused before comparing (and keeps both buffers equal length).
  const wellFormed = /^[0-9]{4}$/.test(given);
  const same = wellFormed && crypto.timingSafeEqual(Buffer.from(codeFor(trip), 'ascii'), Buffer.from(given, 'ascii'));
  if (!same) return { ok: false, code: 'OTP_INVALID', status: 403, message: 'That code is not correct.' };
  return { ok: true };
}

module.exports = { enabled, codeFor, codeForRider, check, MAX_ATTEMPTS };
