/**
 * What a driver needs to decide on a ride request, beyond the fare and trip size the request already carries:
 * how far the pickup is from where the driver is now, how long that drive takes, and how many rides the rider has finished.
 * Built on the server so the push and the "active ride" answer show the same numbers.
 */
const { distanceKm } = require('./demand');
const { positionOf } = require('./driverLocation');

// a typical city speed for an auto or a cab with a passenger-less drive to the pickup
const PICKUP_SPEED_KPH = 22;

function pickupLeg(driver, pickup) {
  const here = positionOf(driver);
  const lat = Number(pickup && pickup.lat);
  const lng = Number(pickup && pickup.lng);
  if (!here || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // roads are longer than the straight line between two points
  const km = Math.round(distanceKm(here.lat, here.lng, lat, lng) * 1.3 * 10) / 10;
  return { km, minutes: Math.max(1, Math.round((km / PICKUP_SPEED_KPH) * 60)) };
}

/** The extra request fields the driver app shows: { pickup_distance, pickup_eta_min, rider_trips } (strings, empty when unknown). */
async function offerExtras(trip, driver, deps = {}) {
  const leg = pickupLeg(driver, trip && trip.pickup);
  let riderTrips = '';
  try {
    const TripDetails = deps.TripDetails || require('../models/tripDetailsModel').TripDetails;
    const rows = await TripDetails.find({ user_id: trip.user_id, status: 'COMPLETED' }).select('trip_id').lean();
    riderTrips = String(rows.length);
  } catch (_) { /* the request still goes out without the count */ }
  return {
    pickup_distance: leg ? String(leg.km) : '',
    pickup_eta_min: leg ? String(leg.minutes) : '',
    rider_trips: riderTrips
  };
}

module.exports = { pickupLeg, offerExtras, PICKUP_SPEED_KPH };
