/**
 * Demand for a driver: how many riders have their app open near the driver right now, and where the busiest spot close by
 * is. Counts only; no rider is ever identified. A rider counts for FRESH_MS after their app last reported a position.
 */
const FRESH_MS = 5 * 60 * 1000;
const NEAR_KM = 3;
const SEARCH_KM = 12;
const CELL_DEG = 0.01; // about 1.1 km
const KM_PER_DEG = 111.2;

const rad = (d) => (d * Math.PI) / 180;
function distanceKm(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** NONE, LOW, GOOD or HIGH from the number of riders near the driver. */
function levelFor(count) {
  if (count <= 0) return 'NONE';
  if (count <= 2) return 'LOW';
  if (count <= 5) return 'GOOD';
  return 'HIGH';
}

/** Pure: rows are { lat, lng, area, lastSeen }; returns the demand block the driver app shows. */
function computeDemand(rows, position, now = new Date()) {
  const fresh = (rows || []).filter((r) => r && Number.isFinite(r.lat) && Number.isFinite(r.lng) && now - new Date(r.lastSeen) <= FRESH_MS);
  const withDistance = fresh.map((r) => ({ ...r, km: distanceKm(position.lat, position.lng, r.lat, r.lng) })).filter((r) => r.km <= SEARCH_KM);
  const near = withDistance.filter((r) => r.km <= NEAR_KM);

  // the busiest ~1 km cell within reach (at least two riders), the nearer one on a tie
  const cells = new Map();
  for (const r of withDistance) {
    const key = `${Math.floor(r.lat / CELL_DEG)}:${Math.floor(r.lng / CELL_DEG)}`;
    const c = cells.get(key) || { riders: [] };
    c.riders.push(r);
    cells.set(key, c);
  }
  let best = null;
  for (const c of cells.values()) {
    if (c.riders.length < 2) continue;
    const lat = c.riders.reduce((s, r) => s + r.lat, 0) / c.riders.length;
    const lng = c.riders.reduce((s, r) => s + r.lng, 0) / c.riders.length;
    const km = distanceKm(position.lat, position.lng, lat, lng);
    if (!best || c.riders.length > best.count || (c.riders.length === best.count && km < best.km)) best = { count: c.riders.length, lat, lng, km, riders: c.riders };
  }
  let hotspot = null;
  if (best && best.km >= 0.3) {
    const names = {};
    for (const r of best.riders) if (r.area) names[r.area] = (names[r.area] || 0) + 1;
    const name = Object.keys(names).sort((a, b) => names[b] - names[a])[0] || '';
    hotspot = { name, riders: best.count, distanceKm: Math.round(best.km * 10) / 10, lat: Math.round(best.lat * 1000) / 1000, lng: Math.round(best.lng * 1000) / 1000 };
  }
  return { level: levelFor(near.length), ridersNearby: near.length, radiusKm: NEAR_KM, hotspot, asOf: now.toISOString() };
}

/** Loads the fresh riders of one business around a point and computes the demand. */
async function demandAround({ tenantId, position, now = new Date() }, deps = {}) {
  const { RiderPresence } = deps.RiderPresence ? deps : require('../models/riderPresenceModel');
  const dLat = SEARCH_KM / KM_PER_DEG;
  const dLng = SEARCH_KM / (KM_PER_DEG * Math.max(0.2, Math.cos(rad(position.lat))));
  const rows = await RiderPresence.find({
    tenantId: tenantId || null,
    lastSeen: { $gte: new Date(now.getTime() - FRESH_MS) },
    lat: { $gte: position.lat - dLat, $lte: position.lat + dLat },
    lng: { $gte: position.lng - dLng, $lte: position.lng + dLng }
  }).lean();
  return computeDemand(rows, position, now);
}

module.exports = { computeDemand, demandAround, levelFor, distanceKm, FRESH_MS, NEAR_KM, SEARCH_KM };
