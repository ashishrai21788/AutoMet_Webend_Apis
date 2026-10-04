/**
 * Prices a trip from a business's own configuration (regions, vehicle categories, fare rules), falling back to the
 * legacy built-in tariff (lib/fare.js) for a business that has not configured any pricing yet.
 *
 *  1. The business has no active fare rule -> LEGACY_TARIFF (nothing changes for it).
 *  2. Otherwise the pickup must lie inside one of its regions when it has set up service areas (centre + radius);
 *     the vehicle must map to one of its active categories that is offered in that region; and a fare rule must
 *     exist for that category (the region's own rule, else the category default). Anything missing is refused with
 *     a clear reason instead of silently charging the legacy tariff in the wrong currency.
 *  3. The fare is lib/fareRules.js calculateFare over the estimated distance and time, in the business currency.
 *
 * Surge is not applied (multiplier 1): the rule's cap is stored for later.
 */
const { estimateTrip, normalizeVehicleType } = require('./fare');
const { calculateFare } = require('./fareRules');
const { hasGeofence, matchRegion } = require('./regionMatch');

const REFUSALS = {
  OUTSIDE_SERVICE_AREA: 'Sorry, this service is not available at the pickup location.',
  CATEGORY_NOT_OFFERED: 'This vehicle type is not offered.',
  CATEGORY_UNAVAILABLE_IN_REGION: 'This vehicle type is not available in this area.',
  PRICING_NOT_CONFIGURED: 'Pricing is not available for this vehicle type yet.'
};

const refuse = (code) => ({ ok: false, status: 422, code, message: REFUSALS[code] });

/** Category whose name matches the vehicle type text (so "e-rickshaw" finds a category named "E Rickshaw"). */
function findCategory(categories, { categoryId, vehicleType }) {
  if (categoryId) return categories.find((c) => c.categoryId === categoryId) || null;
  const wanted = normalizeVehicleType(vehicleType);
  if (!wanted) return null;
  return categories.find((c) => normalizeVehicleType(c.name) === wanted) || null;
}

/**
 * @param {{ market: {currency:string}|null, regions: object[], categories: object[], fareRules: object[] }} config
 * @param {{ pickup:{lat:number,lng:number}, drop:{lat:number,lng:number}, vehicleType?:string, categoryId?:string }} trip
 * @returns {{ok:true, estimate:object} | {ok:false, status:number, code:string, message:string}}
 */
function priceTrip(config, trip) {
  const { market, regions, categories, fareRules } = config;
  const legacy = () => ({
    ok: true,
    estimate: { ...estimateTrip({ pickup: trip.pickup, drop: trip.drop, vehicleType: trip.vehicleType }), fare_source: 'LEGACY_TARIFF', region_id: null, category_id: null }
  });

  const rules = fareRules.filter((r) => r.active);
  if (!market || !market.currency || rules.length === 0) return legacy();

  let region = null;
  if (hasGeofence(regions)) {
    const match = matchRegion(regions, trip.pickup);
    if (!match) return refuse('OUTSIDE_SERVICE_AREA');
    region = match.region;
  }

  const category = findCategory(categories.filter((c) => c.active), trip);
  if (!category) return refuse('CATEGORY_NOT_OFFERED');
  if (region && !(category.regionIds || []).includes(region.regionId)) return refuse('CATEGORY_UNAVAILABLE_IN_REGION');

  const regionId = region ? region.regionId : null;
  const rule =
    (regionId && rules.find((r) => r.categoryId === category.categoryId && r.regionId === regionId)) ||
    rules.find((r) => r.categoryId === category.categoryId && !r.regionId);
  if (!rule) return refuse('PRICING_NOT_CONFIGURED');

  // distance and duration use the same road-factor estimate as before; only the price comes from the business rules
  const base = estimateTrip({ pickup: trip.pickup, drop: trip.drop, vehicleType: 'default' });
  const priced = calculateFare(rule, { distanceKm: base.distance_km, durationMin: base.duration_min }, market.currency);

  return {
    ok: true,
    estimate: {
      distance_km: base.distance_km,
      duration_min: base.duration_min,
      fare: priced.total,
      currency: market.currency,
      vehicle_type: category.name,
      fare_basis: 'ESTIMATE',
      fare_source: 'BUSINESS_RULES',
      region_id: regionId,
      category_id: category.categoryId,
      breakdown: {
        lines: priced.lines, fare: priced.fare, fees: priced.fees, feesTotal: priced.feesTotal,
        taxes: priced.taxes, taxesTotal: priced.taxesTotal, total: priced.total
      }
    }
  };
}

/** Loads one business's pricing configuration (every query is bound to that business's appId). */
async function loadPricingConfig(tenant) {
  if (!tenant) return { market: null, regions: [], categories: [], fareRules: [] };
  const { forTenant } = require('./tenantData');
  const { ServiceRegion, VehicleCategory, FareRule } = require('../models/businessModels');
  const data = forTenant(tenant.tenantId);
  const [regions, categories, fareRules] = await Promise.all([
    data.find(ServiceRegion).lean(), data.find(VehicleCategory).lean(), data.find(FareRule).lean()
  ]);
  return { market: tenant.market && tenant.market.country ? tenant.market : null, regions, categories, fareRules };
}

module.exports = { priceTrip, loadPricingConfig, findCategory, REFUSALS };
