/**
 * The driver's demand heatmap: where riders are asking for rides right now, as areas of about one kilometre. Built from what the platform
 * already counts for demand (riders with their app open on the map, and ride requests made in the last few minutes), so it agrees with the
 * "demand near you" figure and with demand surge.
 *
 * Privacy: only counts leave this module. An area with fewer than K_MIN people is not shown at all (a single rider is never visible), the
 * position of an area is its middle (never a rider's own spot), and no rider identity or contact detail is ever part of the output.
 *
 * Each area also carries `expectedMultiplier`: the demand surge that area's riders-to-drivers ratio would earn under the same ladder the
 * fare uses. It is a hint for where to go, not a promise: the fare a rider pays is set when they ask, and weather (if the business uses it)
 * is shown separately.
 */
const { levelFor, distanceKm, FRESH_MS } = require('./demand');
const { multiplierFor } = require('./surge');

const CELL_DEG = 0.01; // about 1.1 km
const K_MIN = 2;
const DEFAULT_RADIUS_KM = 8;
const MAX_RADIUS_KM = 15;
const MAX_CELLS = 60;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const cellOf = (p) => `${Math.floor(p.lat / CELL_DEG)}:${Math.floor(p.lng / CELL_DEG)}`;
const centreOf = (key) => { const [a, b] = key.split(':').map(Number); return { lat: (a + 0.5) * CELL_DEG, lng: (b + 0.5) * CELL_DEG }; };

/**
 * Pure. riders: [{ lat, lng, lastSeen }], requests: [{ lat, lng }], drivers (online and free): [{ lat, lng }], position: { lat, lng }.
 * -> { cells: [{ lat, lng, count, level, intensity, drivers, expectedMultiplier }], maxCount, radiusKm, asOf }
 */
function buildHeatmap({ riders = [], requests = [], drivers = [], position, radiusKm, now = new Date() }) {
  const radius = finite(radiusKm) && radiusKm > 0 ? Math.min(radiusKm, MAX_RADIUS_KM) : DEFAULT_RADIUS_KM;
  const counts = new Map();
  const supply = new Map();
  const add = (map, p) => { const k = cellOf(p); map.set(k, (map.get(k) || 0) + 1); };

  for (const r of riders || []) {
    if (!r || !finite(r.lat) || !finite(r.lng)) continue;
    const seen = new Date(r.lastSeen).getTime();
    if (!Number.isFinite(seen) || now.getTime() - seen > FRESH_MS) continue;
    add(counts, r);
  }
  for (const q of requests || []) if (q && finite(q.lat) && finite(q.lng)) add(counts, q);
  for (const d of drivers || []) if (d && finite(d.lat) && finite(d.lng)) add(supply, d);

  const cells = [];
  for (const [key, count] of counts) {
    if (count < K_MIN) continue;
    const c = centreOf(key);
    if (position && distanceKm(position.lat, position.lng, c.lat, c.lng) > radius) continue;
    const near = supply.get(key) || 0;
    cells.push({ lat: Math.round(c.lat * 1e6) / 1e6, lng: Math.round(c.lng * 1e6) / 1e6, count, level: levelFor(count), drivers: near, expectedMultiplier: multiplierFor({ demand: count, supply: near }) });
  }
  cells.sort((a, b) => b.count - a.count);
  const top = cells.slice(0, MAX_CELLS);
  const maxCount = top.length ? top[0].count : 0;
  for (const c of top) c.intensity = Math.round((c.count / maxCount) * 100) / 100;
  return { cells: top, maxCount, radiusKm: radius, asOf: now.toISOString() };
}

module.exports = { buildHeatmap, CELL_DEG, K_MIN, DEFAULT_RADIUS_KM, MAX_RADIUS_KM, MAX_CELLS };
