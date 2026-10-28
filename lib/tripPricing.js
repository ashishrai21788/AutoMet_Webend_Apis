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
  const discount = Number(trip.discount) > 0 ? Number(trip.discount) : 0; // a coupon's discount, worked out by the server (lib/coupons.js)
  const surgeMultiplier = Number(trip.surgeMultiplier) > 1 ? Number(trip.surgeMultiplier) : 1; // chosen by lib/surge.js from the demand around the pickup; the rule's own maximum caps it
  // weather: chosen by lib/weather.js for the pickup, only where the business switched it on; it shares the rule's cap with the demand surge
  const weatherMultiplier = Number(trip.weatherMultiplier) > 1 ? Number(trip.weatherMultiplier) : 1;
  const weatherLabel = trip.weatherLabel || '';
  const priced = calculateFare(rule, { distanceKm: base.distance_km, durationMin: base.duration_min, discount, surgeMultiplier, weatherMultiplier, weatherLabel }, market.currency);
  // what the same trip costs when traffic makes it slower (a quarter longer): the top of the range shown to riders
  const slow = calculateFare(rule, { distanceKm: base.distance_km, durationMin: Math.ceil(base.duration_min * 1.25), discount, surgeMultiplier, weatherMultiplier, weatherLabel }, market.currency);

  return {
    ok: true,
    estimate: {
      distance_km: base.distance_km,
      duration_min: base.duration_min,
      fare: priced.total,
      fare_min: priced.total,
      fare_max: Math.max(slow.total, priced.total),
      duration_min_low: Math.max(1, Math.round(base.duration_min * 0.9)),
      duration_min_high: Math.max(1, Math.round(base.duration_min * 1.15)),
      currency: market.currency,
      vehicle_type: category.name,
      fare_basis: 'ESTIMATE',
      fare_source: 'BUSINESS_RULES',
      surge_enabled: !!(rule.surge && rule.surge.enabled),
      surge_multiplier: rule.surge && rule.surge.enabled ? Math.min(surgeMultiplier, Number(rule.surge.maxMultiplier) || 1) : 1,
      // what the weather adds to this fare (null when nothing): the condition, its plain name and the multiplier actually applied under the cap
      weather: priced.weatherMultiplier > 1 ? { condition: trip.weatherCondition || null, label: weatherLabel || null, multiplier: priced.weatherMultiplier } : null,
      pricing_version: config.pricingVersion ?? null,
      pricing_rule: { rule_id: rule.ruleId, rule_updated_at: rule.updatedAt || null, taxes: (rule.taxes || []).map((t) => ({ name: t.name, ratePercent: t.ratePercent, appliesTo: t.appliesTo })) },
      region_id: regionId,
      category_id: category.categoryId,
      breakdown: {
        lines: priced.lines, fare: priced.fare, fees: priced.fees, feesTotal: priced.feesTotal,
        taxes: priced.taxes, taxesTotal: priced.taxesTotal, discount: priced.discount, total: priced.total
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
  // the pricing version live right now, so a trip can say which pricing it was charged under (null until pricing has ever been versioned)
  let pricingVersion = null;
  try {
    const { PricingVersion } = require('../models/pricingModels');
    const latest = (await PricingVersion.find({ tenantId: tenant.tenantId }).sort({ version: -1 }).limit(1).lean())[0];
    pricingVersion = latest ? latest.version : null;
  } catch (_) { /* a trip is priced without the number rather than not priced */ }
  return { market: tenant.market && tenant.market.country ? tenant.market : null, regions, categories, fareRules, pricingVersion };
}

/**
 * Adds the surge multiplier to a trip about to be priced, when the fare rule it will be priced with has surge switched on (so a
 * business that does not use surge pays for no extra queries). ctx.surge = { mode: 'estimate' | 'book', loadFreeDrivers }:
 * an estimate remembers what the rider was quoted; a booking never charges more than that.
 */
async function withSurge(config, trip, ctx) {
  if (!ctx || !ctx.surge || !ctx.tenant) return trip;
  const probe = priceTrip(config, trip);
  if (!probe.ok || !probe.estimate.surge_enabled) return trip;
  const surge = require('./surge');
  const free = await ctx.surge.loadFreeDrivers();
  const at = await surge.surgeAt({ tenant: ctx.tenant, pickup: trip.pickup, categoryId: probe.estimate.category_id, freeDrivers: free });
  const common = { tenantId: ctx.tenant.tenantId, userId: ctx.userId, categoryId: probe.estimate.category_id, pickup: trip.pickup };
  let multiplier = at.multiplier;
  if (ctx.surge.mode === 'book') multiplier = surge.quotedMultiplier({ ...common, current: multiplier });
  else surge.rememberQuote({ ...common, multiplier });
  const out = { ...trip, surgeMultiplier: multiplier };
  // weather pricing: only for a business that switched it on and has not paused surge; a failure to read the weather is no adjustment, never an error
  const rules = require('./weather').rulesOf(ctx.tenant);
  if (rules.enabled && !surge.settingsOf(ctx.tenant).paused) {
    try {
      const w = await require('./weather').weatherAt({ tenant: ctx.tenant, pickup: trip.pickup }, ctx.weather || {});
      const wCommon = { ...common, categoryId: `${common.categoryId}|weather` };
      let wm = w.multiplier;
      if (ctx.surge.mode === 'book') wm = surge.quotedMultiplier({ ...wCommon, current: wm });
      else surge.rememberQuote({ ...wCommon, multiplier: wm });
      if (wm > 1) { out.weatherMultiplier = wm; out.weatherLabel = w.label; out.weatherCondition = w.condition; }
    } catch (_) { /* weather is optional: the trip is priced without it */ }
  }
  return out;
}

/**
 * Prices a trip and, when a coupon code is given, applies it. The discount is worked out here from the ride's own total (never taken
 * from the client): price without the coupon, evaluate the coupon on that total, then price again with the discount.
 * Returns the priced result plus { coupon }: { code, applied, discount, message, couponDoc }.
 * A code that does not apply never silently falls back to the full fare for a booking: the caller decides (estimate shows the
 * message, create-request refuses).
 */
async function priceTripWithCoupon(config, originalTrip, { tenant, userId, code, surge }) {
  const trip = await withSurge(config, originalTrip, { tenant, userId, surge });
  const first = priceTrip(config, trip);
  if (!first.ok || !code) return { ...first, coupon: code ? { code: String(code), applied: false, message: 'Coupon cannot be used here.' } : null };
  if (first.estimate.fare_source !== 'BUSINESS_RULES' || !tenant) return { ...first, coupon: { code: String(code), applied: false, message: 'Coupons are not available for this ride.' } };
  const { digitsOf, toMinor } = require('./riderInvoice');
  const coupons = require('./coupons');
  const digits = digitsOf(first.estimate.currency);
  const gross = toMinor(first.estimate.breakdown.total, digits);
  const result = await coupons.check({ tenantId: tenant.tenantId, code, userId, grossMinor: gross, categoryId: first.estimate.category_id, regionId: first.estimate.region_id });
  if (!result.ok) return { ...first, coupon: { code: coupons.normalizeCode(code), applied: false, code_error: result.code, message: result.message } };
  const second = priceTrip(config, { ...trip, discount: result.discountMinor / 10 ** digits });
  return {
    ...second,
    coupon: { code: result.coupon.code, applied: true, discount: result.discountMinor / 10 ** digits, discountMinor: result.discountMinor, message: 'Coupon applied.', couponDoc: result.coupon }
  };
}

module.exports = { priceTrip, priceTripWithCoupon, withSurge, loadPricingConfig, findCategory, REFUSALS };
