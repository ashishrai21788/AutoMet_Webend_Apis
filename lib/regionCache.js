/** A business's service regions, kept for a short time because every driver heartbeat needs them. */
const TTL_MS = 30 * 1000;
const cache = new Map(); // tenantId -> { at, regions }

async function regionsFor(tenantId) {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.regions;
  const { ServiceRegion } = require('../models/businessModels');
  const { forTenant } = require('./tenantData');
  const regions = await forTenant(tenantId).find(ServiceRegion).lean();
  cache.set(tenantId, { at: Date.now(), regions });
  return regions;
}

const clearRegionCache = () => cache.clear();

module.exports = { regionsFor, clearRegionCache };
