// Region matching (centre + radius) and trip pricing from a business's own rules. No database. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchRegion, hasGeofence, hasGeometry } = require('../lib/regionMatch');
const { priceTrip, REFUSALS } = require('../lib/tripPricing');
const { validateFareRuleInput } = require('../lib/fareRules');
const v = require('../lib/businessValidation');

const PUNE = { lat: 18.5204, lng: 73.8567 };
const MUMBAI = { lat: 19.076, lng: 72.8777 };
const NASHIK = { lat: 19.9975, lng: 73.7898 };
const NEAR_PUNE = { lat: 18.5304, lng: 73.8467 }; // about 1.5 km from the centre
const NAGPUR = { lat: 21.1458, lng: 79.0882 };

const region = (id, city, center, radiusKm, extra = {}) => ({ regionId: id, city, zoneName: 'All areas', active: true, center, radiusKm, ...extra });
const rule = (categoryId, regionId, fields = {}) => ({
  active: true, categoryId, regionId, currency: 'INR',
  ...validateFareRuleInput({ baseFare: 40, perKm: 12, perMinute: 1, minimumFare: 70, bookingFee: 5, waitingFreeMinutes: 3, waitingPerMinute: 2, additionalCharges: [], taxes: [], surge: { enabled: false }, ...fields }).value
});

test('matchRegion: inside, outside, inactive, missing geometry', () => {
  const regions = [region('pune', 'Pune', PUNE, 20), region('mumbai', 'Mumbai', MUMBAI, 25), region('off', 'Off', NASHIK, 30, { active: false }), region('none', 'None', null, null)];
  assert.equal(matchRegion(regions, NEAR_PUNE).region.regionId, 'pune');
  assert.equal(matchRegion(regions, MUMBAI).region.regionId, 'mumbai');
  assert.equal(matchRegion(regions, NASHIK), null, 'an inactive region never matches');
  assert.equal(matchRegion(regions, NAGPUR), null);
  assert.equal(matchRegion(regions, { lat: 'x', lng: 1 }), null);
  assert.equal(hasGeometry(regions[3]), false);
  assert.equal(hasGeofence(regions), true);
  assert.equal(hasGeofence([region('none', 'None', null, null)]), false);
});

test('matchRegion: where circles overlap the most specific (smallest) area wins, then the nearest centre', () => {
  const big = region('big', 'Big', PUNE, 100);
  const small = region('small', 'Small', { lat: 18.53, lng: 73.85 }, 5);
  assert.equal(matchRegion([big, small], NEAR_PUNE).region.regionId, 'small', 'an airport zone inside a city beats the city');
  assert.equal(matchRegion([big, small], { lat: 18.9, lng: 73.9 }).region.regionId, 'big', 'outside the small area only the big one contains the point');
  const a = region('a', 'A', { lat: 18.52, lng: 73.85 }, 10);
  const b = region('b', 'B', { lat: 18.54, lng: 73.87 }, 10);
  assert.equal(matchRegion([a, b], { lat: 18.538, lng: 73.868 }).region.regionId, 'b', 'equal radii: the nearest centre');
});

const config = (over = {}) => ({
  market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' },
  regions: [region('pune', 'Pune', PUNE, 30)],
  categories: [{ categoryId: 'c_sedan', name: 'Sedan', active: true, regionIds: ['pune'] }, { categoryId: 'c_auto', name: 'Auto Rickshaw', active: true, regionIds: ['pune'] }],
  fareRules: [rule('c_sedan', null)],
  ...over
});
const trip = (over = {}) => ({ pickup: NEAR_PUNE, drop: { lat: 18.58, lng: 73.9 }, vehicleType: 'sedan', ...over });

test('pricing: a business with no fare rules keeps the legacy tariff', () => {
  const r = priceTrip(config({ fareRules: [] }), trip({ vehicleType: 'auto' }));
  assert.equal(r.ok, true);
  assert.equal(r.estimate.fare_source, 'LEGACY_TARIFF');
  assert.equal(r.estimate.currency, 'INR');
  const noMarket = priceTrip(config({ market: null }), trip());
  assert.equal(noMarket.estimate.fare_source, 'LEGACY_TARIFF');
});

test('pricing: the fare comes from the business rule, in its currency, and matches the calculation', () => {
  const r = priceTrip(config(), trip());
  assert.equal(r.ok, true);
  assert.equal(r.estimate.fare_source, 'BUSINESS_RULES');
  assert.equal(r.estimate.region_id, 'pune');
  assert.equal(r.estimate.category_id, 'c_sedan');
  const { distance_km: km, duration_min: min } = r.estimate;
  const ride = Math.max(70, Math.round((40 + km * 12 + min * 1) * 100) / 100);
  assert.ok(Math.abs(r.estimate.fare - (ride + 5)) < 0.02, `fare ${r.estimate.fare} should be about ${ride + 5}`);
  assert.equal(r.estimate.breakdown.total, r.estimate.fare);
});

test('pricing: a region override beats the category default; other regions use the default', () => {
  const two = config({
    regions: [region('pune', 'Pune', PUNE, 30), region('mumbai', 'Mumbai', MUMBAI, 30)],
    categories: [{ categoryId: 'c_sedan', name: 'Sedan', active: true, regionIds: ['pune', 'mumbai'] }],
    fareRules: [rule('c_sedan', null), rule('c_sedan', 'pune', { baseFare: 100 })]
  });
  const pune = priceTrip(two, trip());
  const mumbai = priceTrip(two, trip({ pickup: MUMBAI, drop: { lat: 19.1, lng: 72.9 } }));
  assert.equal(pune.estimate.region_id, 'pune');
  assert.equal(mumbai.estimate.region_id, 'mumbai');
  assert.ok(pune.estimate.breakdown.lines.find((l) => l.key === 'base').amount === 100);
  assert.ok(mumbai.estimate.breakdown.lines.find((l) => l.key === 'base').amount === 40);
});

test('pricing: pickup outside every region is refused when service areas are set', () => {
  const r = priceTrip(config(), trip({ pickup: NAGPUR, drop: { lat: 21.2, lng: 79.1 } }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.equal(r.code, 'OUTSIDE_SERVICE_AREA');
  assert.equal(r.message, REFUSALS.OUTSIDE_SERVICE_AREA);
});

test('pricing: with no service areas drawn yet, any pickup uses the category default rule', () => {
  const r = priceTrip(config({ regions: [region('pune', 'Pune', null, null)] }), trip({ pickup: NAGPUR, drop: { lat: 21.2, lng: 79.1 } }));
  assert.equal(r.ok, true);
  assert.equal(r.estimate.region_id, null);
});

test('pricing: unknown or inactive category, category not offered here, and missing price are refused clearly', () => {
  assert.equal(priceTrip(config(), trip({ vehicleType: 'helicopter' })).code, 'CATEGORY_NOT_OFFERED');
  assert.equal(priceTrip(config({ categories: [{ categoryId: 'c_sedan', name: 'Sedan', active: false, regionIds: ['pune'] }] }), trip()).code, 'CATEGORY_NOT_OFFERED');
  const elsewhere = config({ categories: [{ categoryId: 'c_sedan', name: 'Sedan', active: true, regionIds: ['other'] }] });
  assert.equal(priceTrip(elsewhere, trip()).code, 'CATEGORY_UNAVAILABLE_IN_REGION');
  // Auto Rickshaw is offered in Pune but has no rule, and the business does price other categories
  assert.equal(priceTrip(config(), trip({ vehicleType: 'auto rickshaw' })).code, 'PRICING_NOT_CONFIGURED');
  assert.equal(priceTrip(config(), trip({ vehicleType: 'Auto-Rickshaw' })).code, 'PRICING_NOT_CONFIGURED', 'names match ignoring case and punctuation');
});

test('pricing: a category id picks the category directly', () => {
  const r = priceTrip(config(), trip({ vehicleType: 'something else', categoryId: 'c_sedan' }));
  assert.equal(r.ok, true);
  assert.equal(r.estimate.category_id, 'c_sedan');
});

test('region validation: centre point and radius', () => {
  const ok = v.validateRegionBatch({ state: 'Maharashtra', cities: [{ name: 'Pune', lat: 18.52, lng: 73.86 }, 'Nashik'], radiusKm: '20' });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.value.cities, [{ name: 'Pune', center: { lat: 18.52, lng: 73.86 } }, { name: 'Nashik', center: null }]);
  assert.equal(ok.value.radiusKm, 20);
  assert.equal(v.validateRegionBatch({ state: 'M', cities: ['Pune'] }).value.radiusKm, 15, 'default radius');
  assert.ok(v.validateRegionBatch({ state: 'M', cities: ['Pune'], radiusKm: 0 }).errors.radiusKm);
  assert.ok(v.validateRegionBatch({ state: 'M', cities: ['Pune'], radiusKm: 500 }).errors.radiusKm);
  assert.ok(v.validateRegionBatch({ state: 'M', cities: [{ name: 'Pune', lat: 95, lng: 10 }] }).errors.cities);

  assert.deepEqual(v.validateRegionUpdate({ center: { lat: 18.5, lng: 73.8 }, radiusKm: 12 }).value, { center: { lat: 18.5, lng: 73.8 }, radiusKm: 12 });
  assert.ok(v.validateRegionUpdate({ center: { lat: 18.5, lng: 73.8 } }).errors.radiusKm, 'a centre needs a radius');
  assert.ok(v.validateRegionUpdate({ center: { lat: 'x', lng: 73.8 }, radiusKm: 12 }).errors.center);
  assert.deepEqual(v.validateRegionUpdate({ center: null }).value, { center: null, radiusKm: null });
});
