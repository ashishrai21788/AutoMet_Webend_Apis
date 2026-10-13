/**
 * Automatic dispatch: picks which driver a ride request is offered to, and which one is next when a driver rejects or
 * does not answer.
 *
 * The rider no longer chooses a driver. The request is offered to the nearest driver who is online, has a fresh
 * location, is free (not on or being offered another ride) and drives the same vehicle type, one at a time. Each offer
 * has its own short window; a rejection or silence moves the request to the next nearest driver, up to a maximum number
 * of drivers, and then the rider is told nobody is available.
 *
 * Everything here is pure (no database, no network) so the rules are easy to test; the controller loads the drivers and
 * applies the result with conditional writes.
 */
const { positionOf, presenceOf } = require('./driverLocation');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

function dispatchConfig(env = process.env) {
  return {
    radiusKm: num(env.DISPATCH_RADIUS_KM, 5),
    maxAttempts: Math.floor(num(env.DISPATCH_MAX_ATTEMPTS, 3)),
    offerSeconds: Math.floor(num(env.DISPATCH_OFFER_SECONDS, 40))
  };
}

const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km between two { lat, lng } points. */
function distanceKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const sameType = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * Nearest-first candidates for a pickup.
 * @param {object[]} drivers driver documents (already limited to the rider's business)
 * @param {{ lat:number, lng:number }} pickup
 * @param {{ exclude?: string[], vehicleType?: string, radiusKm?: number, now?: Date }} [opts]
 * @returns {{ driver: object, distanceKm: number }[]}
 */
function rankCandidates(drivers, pickup, opts = {}) {
  const cfg = dispatchConfig();
  const { exclude = [], vehicleType, radiusKm = cfg.radiusKm, now = new Date() } = opts;
  const skip = new Set(exclude.map(String));
  const out = [];
  for (const driver of drivers || []) {
    if (!driver || skip.has(String(driver.driverId))) continue;
    if (vehicleType && !sameType(driver.vehicleType, vehicleType)) continue;
    const state = presenceOf(driver, now).state;
    if (state === 'NO_SIGNAL') { out.push({ driver, distanceKm: Infinity }); continue; } // app predates heartbeats: last resort
    if (state !== 'LIVE') continue; // offline, or the last position is stale
    const pos = positionOf(driver);
    if (!pos) continue;
    const d = distanceKm(pickup, pos);
    if (d <= radiusKm) out.push({ driver, distanceKm: d });
  }
  return out.sort((x, y) => x.distanceKm - y.distanceKm);
}

/** True while the request may still be offered to another driver. */
function canReoffer(trip, cfg = dispatchConfig()) {
  return Boolean(trip) && trip.dispatch_mode === 'AUTO' && (trip.dispatch_attempts || 0) < cfg.maxAttempts;
}

module.exports = { dispatchConfig, distanceKm, rankCandidates, canReoffer };
