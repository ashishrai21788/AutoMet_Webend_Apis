/**
 * Demand-based surge pricing.
 *
 * The fare engine (lib/fareRules.calculateFare) already applies a surge multiplier, capped by the fare rule's own maximum, and only
 * when the rule has surge switched on. This module decides the multiplier from what is happening around the pickup right now:
 *
 *   demand  riders with the app open within NEAR_KM of the pickup (rider presence) plus ride requests made there in the last
 *           REQUEST_WINDOW_MIN minutes
 *   supply  drivers of the business who are online and free within NEAR_KM of the pickup
 *   ratio   demand / max(supply, 1)
 *
 * and then looks the ratio up in a fixed ladder (below). Fewer than MIN_DEMAND of demand never surges, so a quiet area with no
 * drivers is not surged. A business can pause surge entirely (surgeSettings.paused), and the rule's maximum always caps it.
 *
 * Two protections for riders:
 *   - the multiplier for a spot is held for CACHE_MS, so the estimate, the ride options and the booking agree, and it cannot flicker;
 *   - a rider is never charged a higher multiplier than the one they were shown: an estimate remembers its multiplier for
 *     QUOTE_MS and the booking uses the lower of that and the current one.
 */
const NEAR_KM = 3;
const MIN_DEMAND = 3;
const REQUEST_WINDOW_MIN = 10;
const CACHE_MS = 60 * 1000;
const QUOTE_MS = 5 * 60 * 1000;
const CELL_DEG = 0.01; // about 1.1 km

/** [minimum ratio, multiplier], highest first */
const LADDER = [[4, 2.5], [3, 2.0], [2, 1.5], [1.5, 1.2]];

const { positionOf } = require('./driverLocation');

const rad = (d) => (d * Math.PI) / 180;
function kmBetween(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat); const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Pure: the multiplier for these counts (1 = no surge). */
function multiplierFor({ demand, supply }) {
  if (!(demand >= MIN_DEMAND)) return 1;
  const ratio = demand / Math.max(supply, 1);
  for (const [min, mult] of LADDER) if (ratio >= min) return mult;
  return 1;
}

const settingsOf = (tenant) => ({ paused: !!(tenant && tenant.surgeSettings && tenant.surgeSettings.paused) });

const cellKey = (pickup) => `${Math.floor(pickup.lat / CELL_DEG)}:${Math.floor(pickup.lng / CELL_DEG)}`;

/** Pure: drivers (with lat/lng under `position` or `lat`/`lng`) within NEAR_KM of the pickup. */
function supplyNear(freeDrivers, pickup) {
  let n = 0;
  for (const d of freeDrivers || []) {
    const p = positionOf(d);
    if (p && kmBetween(pickup.lat, pickup.lng, p.lat, p.lng) <= NEAR_KM) n += 1;
  }
  return n;
}

/** Counts the demand near a pickup from the database. */
async function demandNear({ tenantId, pickup, now = new Date() }, deps = {}) {
  const { demandAround } = require('./demand');
  const { TripDetails } = deps.TripDetails ? deps : require('../models/tripDetailsModel');
  const riders = (await demandAround({ tenantId, position: pickup, now }, deps)).ridersNearby || 0;
  const since = new Date(now.getTime() - REQUEST_WINDOW_MIN * 60 * 1000);
  // only the business and the time window go to the database (a few hundred rows at most); the distance is checked here, so no engine needs to range-filter inside the pickup document
  const recent = await TripDetails.find({ tenant_id: tenantId || null, requested_at: { $gte: since } }).select('pickup').limit(500).lean();
  const requests = recent.filter((t) => t.pickup && kmBetween(pickup.lat, pickup.lng, t.pickup.lat, t.pickup.lng) <= NEAR_KM).length;
  return { riders, requests, demand: riders + requests };
}

const cache = new Map(); // `${tenantId}|${categoryId}|${cell}` -> { at, value }
const quotes = new Map(); // `${tenantId}|${userId}|${categoryId}|${cell}` -> { at, multiplier }
const clearSurgeCache = () => { cache.clear(); quotes.clear(); };

/**
 * What the multiplier is at this pickup for this category: { multiplier, demand, supply, paused }.
 * `freeDrivers` is the business's online, free drivers (the caller already has them or loads them only when surge is on).
 */
async function surgeAt({ tenant, pickup, categoryId, freeDrivers, now = new Date() }, deps = {}) {
  const tenantId = tenant && tenant.tenantId;
  if (settingsOf(tenant).paused) return { multiplier: 1, demand: 0, supply: 0, paused: true };
  const key = `${tenantId}|${categoryId || ''}|${cellKey(pickup)}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.value;
  const { demand, riders, requests } = await demandNear({ tenantId, pickup, now }, deps);
  const supply = supplyNear(freeDrivers, pickup);
  const value = { multiplier: multiplierFor({ demand, supply }), demand, riders, requests, supply, paused: false };
  cache.set(key, { at: now.getTime(), value });
  return value;
}

const quoteKey = (tenantId, userId, categoryId, pickup) => `${tenantId}|${userId}|${categoryId || ''}|${cellKey(pickup)}`;

/** An estimate shown to a rider: remember what they were quoted. */
function rememberQuote({ tenantId, userId, categoryId, pickup, multiplier, now = new Date() }) {
  if (!userId) return;
  quotes.set(quoteKey(tenantId, userId, categoryId, pickup), { at: now.getTime(), multiplier });
}

/** At booking: never more than the rider was shown (and the current multiplier if it is lower, or if they were shown none recently). */
function quotedMultiplier({ tenantId, userId, categoryId, pickup, current, now = new Date() }) {
  const q = userId ? quotes.get(quoteKey(tenantId, userId, categoryId, pickup)) : null;
  if (!q || now.getTime() - q.at > QUOTE_MS) return current;
  return Math.min(current, q.multiplier);
}

module.exports = { NEAR_KM, MIN_DEMAND, REQUEST_WINDOW_MIN, LADDER, multiplierFor, supplyNear, demandNear, surgeAt, rememberQuote, quotedMultiplier, settingsOf, clearSurgeCache, cellKey };
