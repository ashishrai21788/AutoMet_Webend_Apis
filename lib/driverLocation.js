/**
 * Driver location heartbeat rules. A driver app sends its position every few seconds while it is online; the server
 * keeps the last one and judges how fresh it is. Pure functions, so the rules are tested without a database.
 *
 *   LIVE       online, and a position arrived within FRESH_SECONDS
 *   STALE      online, but the last position is older than that (phone lost signal, app killed, battery saver)
 *   NO_SIGNAL  online, and the app has never sent a position (an older app version that does not send heartbeats)
 *   OFFLINE    not online
 *
 * A STALE driver is taken offline by the sweeper after STALE_OFFLINE_SECONDS. A NO_SIGNAL driver is never forced offline:
 * apps that predate heartbeats must keep working, so they are reported honestly instead.
 */
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const config = () => ({
  freshSeconds: num('DRIVER_LOCATION_FRESH_SECONDS', 60),
  staleOfflineSeconds: num('DRIVER_STALE_OFFLINE_SECONDS', 180),
  nextHeartbeatSeconds: num('DRIVER_HEARTBEAT_SECONDS', 10),
  maxAccuracyMeters: num('DRIVER_MAX_ACCURACY_METERS', 1000)
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toNum = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/** Checks a heartbeat body. Returns { value } or { errors }. */
function validateHeartbeat(body = {}, cfg = config()) {
  const errors = {};
  const lat = toNum(body.lat ?? body.latitude);
  const lng = toNum(body.lng ?? body.longitude);
  if (!isNum(lat) || lat < -90 || lat > 90) errors.lat = 'Latitude must be a number from -90 to 90';
  if (!isNum(lng) || lng < -180 || lng > 180) errors.lng = 'Longitude must be a number from -180 to 180';
  // exactly 0,0 is what a phone reports before it has a GPS fix, never a real position
  if (!errors.lat && !errors.lng && lat === 0 && lng === 0) errors.lat = 'No GPS fix yet';

  const out = { lat, lng };
  const accuracy = toNum(body.accuracy ?? body.accuracyMeters);
  if (accuracy !== undefined) {
    if (!isNum(accuracy) || accuracy < 0) errors.accuracy = 'Accuracy must be a number of metres, 0 or more';
    else if (accuracy > cfg.maxAccuracyMeters) errors.accuracy = `Position is too imprecise (${Math.round(accuracy)} m); waiting for a better fix`;
    else out.accuracyMeters = Math.round(accuracy);
  }
  const heading = toNum(body.heading);
  if (heading !== undefined) {
    if (!isNum(heading) || heading < 0 || heading > 360) errors.heading = 'Heading must be from 0 to 360 degrees';
    else out.heading = Math.round(heading);
  }
  const speedMps = toNum(body.speedMps ?? body.speed);
  if (speedMps !== undefined) {
    if (!isNum(speedMps) || speedMps < 0 || speedMps > 111) errors.speedMps = 'Speed must be 0 to 111 metres per second';
    else out.speedKph = Math.round(speedMps * 3.6 * 10) / 10;
  }
  return Object.keys(errors).length ? { errors } : { value: out };
}

const point = (lat, lng) => ({ type: 'Point', coordinates: [lng, lat] }); // GeoJSON order is longitude first

/** The update to store for an accepted heartbeat. */
function locationUpdate(value, { regionId = null, now = new Date() } = {}) {
  return {
    lastLocation: point(value.lat, value.lng),
    locationUpdatedAt: now,
    locationAccuracyM: value.accuracyMeters ?? null,
    locationHeading: value.heading ?? null,
    locationSpeedKph: value.speedKph ?? null,
    locationRegionId: regionId,
    lastActive: now
  };
}

/** The driver's last position as { lat, lng }, or null when none was ever received. */
function positionOf(driver) {
  const c = driver && driver.lastLocation && driver.lastLocation.coordinates;
  return Array.isArray(c) && isNum(c[0]) && isNum(c[1]) ? { lat: c[1], lng: c[0] } : null;
}

function presenceOf(driver, now = new Date(), cfg = config()) {
  if (!driver || !driver.isOnline) return { state: 'OFFLINE', ageSeconds: null };
  if (!driver.locationUpdatedAt || !positionOf(driver)) return { state: 'NO_SIGNAL', ageSeconds: null };
  const ageSeconds = Math.max(0, Math.round((now.getTime() - new Date(driver.locationUpdatedAt).getTime()) / 1000));
  return { state: ageSeconds <= cfg.freshSeconds ? 'LIVE' : 'STALE', ageSeconds };
}

/** True when the sweeper should take this driver offline: online, has sent heartbeats before, and has gone quiet. */
function shouldGoOffline(driver, now = new Date(), cfg = config()) {
  if (!driver || !driver.isOnline || !driver.locationUpdatedAt) return false;
  return now.getTime() - new Date(driver.locationUpdatedAt).getTime() > cfg.staleOfflineSeconds * 1000;
}

module.exports = { config, validateHeartbeat, locationUpdate, positionOf, presenceOf, shouldGoOffline, point };
