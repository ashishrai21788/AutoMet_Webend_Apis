const { haversineKm } = require('./fare');

const validCenter = (c) =>
  !!c && Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.lat >= -90 && c.lat <= 90 && c.lng >= -180 && c.lng <= 180;

/** A region has a usable area only when it has both a centre point and a radius. */
const hasGeometry = (r) => !!r && validCenter(r.center) && Number.isFinite(r.radiusKm) && r.radiusKm > 0;

/** True when at least one active region has an area, i.e. the business restricts service to its regions. */
const hasGeofence = (regions) => regions.some((r) => r.active && hasGeometry(r));

/**
 * The active region whose circle contains the point. Where circles overlap the most specific one wins: the smallest
 * radius (an airport zone inside a city beats the city), and between equal radii the nearest centre.
 * Returns { region, distanceKm } or null.
 */
function matchRegion(regions, point) {
  if (!validCenter(point)) return null;
  let best = null;
  for (const region of regions) {
    if (!region.active || !hasGeometry(region)) continue;
    const distanceKm = haversineKm(point.lat, point.lng, region.center.lat, region.center.lng);
    if (distanceKm > region.radiusKm) continue;
    if (!best || region.radiusKm < best.region.radiusKm || (region.radiusKm === best.region.radiusKm && distanceKm < best.distanceKm)) {
      best = { region, distanceKm };
    }
  }
  return best ? { region: best.region, distanceKm: Math.round(best.distanceKm * 100) / 100 } : null;
}

module.exports = { hasGeometry, hasGeofence, matchRegion, validCenter };
