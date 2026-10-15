/**
 * Ride sharing: a rider can send one link that lets anyone follow the ride (driver, vehicle, route and live position)
 * in a web page, with no sign-in. The link carries a random token that belongs to one trip.
 *
 * What the public page may see is decided here, in one place, and is deliberately small: the driver's first name, photo
 * and rating, the vehicle, the two addresses with their points, the status, the driver's live position and an arrival
 * time. Never a phone number, an account id, the fare or the start code.
 *
 * Pure functions (no database), so the privacy rules are covered by tests.
 */
const crypto = require('crypto');
const { distanceKm, etaMinutes } = require('./dispatch');
const { positionOf, presenceOf } = require('./driverLocation');

const LIVE_STATUSES = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];
const ENDED_STATUSES = ['COMPLETED', 'CANCELLED_BY_USER', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE', 'CANCELLED_BY_DRIVER', 'REJECTED', 'REJECTED_WITH_REASON', 'NO_RESPONSE', 'TIMEOUT'];
/** A link keeps working this long after the ride ends, then it says the ride is over. */
const AFTER_END_MS = 2 * 60 * 60 * 1000;

const newToken = () => crypto.randomBytes(16).toString('hex'); // 32 hex characters

const isToken = (t) => typeof t === 'string' && /^[a-f0-9]{32}$/.test(t);

const firstName = (d) => {
  const n = d && d.firstName ? String(d.firstName).trim() : '';
  return n || 'Your driver';
};

/** What the page shows for this status. */
function statusView(status) {
  switch (status) {
    case 'ACCEPTED':
    case 'DRIVER_ON_THE_WAY':
      return { step: 'ON_THE_WAY', title: 'Driver is on the way', live: true };
    case 'ARRIVED':
      return { step: 'ARRIVED', title: 'Driver has arrived', live: true };
    case 'ON_GOING':
      return { step: 'IN_PROGRESS', title: 'Ride in progress', live: true };
    case 'COMPLETED':
      return { step: 'COMPLETED', title: 'Ride completed', live: false };
    default:
      return { step: 'ENDED', title: 'This ride has ended', live: false };
  }
}

/**
 * The public view of a trip, or null when the link no longer works (the ride ended more than AFTER_END_MS ago).
 * `driver` is the driver document (or null), `brand` the business name.
 */
function publicView(trip, driver, brand, now = new Date()) {
  if (!trip) return null;
  const ended = ENDED_STATUSES.includes(trip.status);
  const endedAt = trip.updated_at ? new Date(trip.updated_at).getTime() : null;
  if (ended && endedAt && now.getTime() - endedAt > AFTER_END_MS) return null;

  const view = statusView(trip.status);
  const pickup = trip.pickup ? { address: trip.pickup.address, lat: trip.pickup.lat, lng: trip.pickup.lng } : null;
  const drop = trip.drop ? { address: trip.drop.address, lat: trip.drop.lat, lng: trip.drop.lng } : null;

  let location = null;
  let eta = null;
  if (view.live && driver) {
    const pos = positionOf(driver);
    if (pos) {
      const presence = presenceOf(driver, now);
      location = {
        lat: pos.lat,
        lng: pos.lng,
        heading: Number.isFinite(Number(driver.locationHeading)) ? Number(driver.locationHeading) : null,
        updatedAt: driver.locationUpdatedAt || null,
        state: presence.state
      };
      // the driver is heading to the pickup until the ride starts, then to the drop
      const target = trip.status === 'ON_GOING' ? drop : pickup;
      if (target && Number.isFinite(target.lat) && Number.isFinite(target.lng) && trip.status !== 'ARRIVED') {
        const km = distanceKm(pos, { lat: target.lat, lng: target.lng });
        eta = { minutes: etaMinutes(km), km: Math.round(km * 10) / 10, to: trip.status === 'ON_GOING' ? 'DROP' : 'PICKUP' };
      }
    }
  }

  return {
    brand: brand || null,
    status: trip.status,
    step: view.step,
    title: view.title,
    live: view.live,
    pickup,
    drop,
    distanceKm: Number.isFinite(trip.distance_km) ? trip.distance_km : null,
    durationMin: Number.isFinite(trip.estimated_duration_min) ? trip.estimated_duration_min : null,
    driver: driver
      ? {
        firstName: firstName(driver),
        photo: /^https:\/\//i.test(driver.profilePhoto || '') ? driver.profilePhoto : null,
        rating: driver.rating != null && Number(driver.rating) > 0 ? Number(driver.rating) : null,
        trips: Number.isFinite(Number(driver.totalRides)) ? Number(driver.totalRides) : null,
        vehicleNumber: driver.vehicleNumber || null,
        vehicleModel: driver.vehicleModel || null,
        vehicleColor: driver.vehicleColor || null,
        vehicleType: driver.vehicleType || null
      }
      : null,
    location,
    eta,
    updatedAt: (now instanceof Date ? now : new Date()).toISOString()
  };
}

module.exports = { newToken, isToken, publicView, statusView, LIVE_STATUSES, ENDED_STATUSES, AFTER_END_MS };
