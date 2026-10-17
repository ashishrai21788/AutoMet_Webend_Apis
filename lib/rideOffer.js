/**
 * What a driver needs to decide on a ride request, beyond the fare and trip size the request already carries:
 * how far the pickup is from where the driver is now, how long that drive takes, and how many rides the rider has finished.
 * Built on the server so the push and the "active ride" answer show the same numbers.
 */
const { distanceKm } = require('./demand');
const { positionOf } = require('./driverLocation');
const { loadConfig } = require('./fare');

// a rider's rating counts once at least this many drivers have rated them (one rating says little)
const MIN_RATINGS = 3;

/**
 * The drive from the driver to the pickup. It uses the same road allowance and city speed as the fare estimate
 * (lib/fare.js, FARE_CONFIG), so the pickup time and the trip time on one request always agree.
 */
function pickupLeg(driver, pickup, config = loadConfig()) {
  const here = positionOf(driver);
  const lat = Number(pickup && pickup.lat);
  const lng = Number(pickup && pickup.lng);
  if (!here || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const km = Math.round(distanceKm(here.lat, here.lng, lat, lng) * config.roadFactor * 10) / 10;
  return { km, minutes: Math.max(1, Math.ceil((km / config.avgSpeedKmh) * 60)) };
}

/** The extra request fields the driver app shows: { pickup_distance, pickup_eta_min, rider_trips } (strings, empty when unknown). */
async function offerExtras(trip, driver, deps = {}) {
  const leg = pickupLeg(driver, trip && trip.pickup);
  let riderTrips = '';
  let riderRating = '';
  try {
    const TripDetails = deps.TripDetails || require('../models/tripDetailsModel').TripDetails;
    const rows = await TripDetails.find({ user_id: trip.user_id, status: 'COMPLETED' }).lean();
    riderTrips = String(rows.length);
    // the average of what drivers gave this rider, once enough of them have
    const stars = rows.map((t) => Number(t.driver_rating && t.driver_rating.stars)).filter((n) => n >= 1 && n <= 5);
    if (stars.length >= MIN_RATINGS) riderRating = String(Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 10) / 10);
  } catch (_) { /* the request still goes out without the count */ }
  return {
    pickup_distance: leg ? String(leg.km) : '',
    pickup_eta_min: leg ? String(leg.minutes) : '',
    rider_trips: riderTrips,
    rider_rating: riderRating
  };
}

module.exports = { pickupLeg, offerExtras, MIN_RATINGS };
