// Fare calculation, validation and setup-status rules (no database). Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFareRuleInput, calculateFare } = require('../lib/fareRules');
const v = require('../lib/businessValidation');
const { computeSetup } = require('../lib/businessSetup');
const { forTenant } = require('../lib/tenantData');

const baseRule = {
  baseFare: 50, perKm: 12, perMinute: 1.5, minimumFare: 80, bookingFee: 10, waitingFreeMinutes: 3, waitingPerMinute: 2,
  additionalCharges: [], taxes: [], surge: { enabled: false, maxMultiplier: 1 }
};
const valid = (input) => { const r = validateFareRuleInput(input); assert.deepEqual(r.errors, {}); return r.value; };

test('fare: base + distance + time, then fees; lines add up', () => {
  const rule = valid(baseRule);
  const r = calculateFare(rule, { distanceKm: 10, durationMin: 20 }, 'USD');
  // 50 + 120 + 30 = 200 ride charge; booking fee 10; no tax
  assert.equal(r.fare, 200);
  assert.equal(r.feesTotal, 10);
  assert.equal(r.total, 210);
  assert.equal(r.lines.reduce((a, l) => a + l.amount, 0), r.fare);
});

test('fare: minimum fare applies to the ride charge only, not on top of fees', () => {
  const rule = valid(baseRule);
  const r = calculateFare(rule, { distanceKm: 0.5, durationMin: 1 }, 'USD');
  // 50 + 6 + 1.5 = 57.5 < 80 -> fare 80; booking fee 10 is added after
  assert.equal(r.fare, 80);
  assert.equal(r.total, 90);
  assert.ok(r.lines.some((l) => l.key === 'minimum'));
});

test('fare: waiting is charged only beyond the free minutes', () => {
  const rule = valid(baseRule);
  assert.equal(calculateFare(rule, { distanceKm: 10, durationMin: 20, waitingMin: 3 }, 'USD').fare, 200);
  assert.equal(calculateFare(rule, { distanceKm: 10, durationMin: 20, waitingMin: 8 }, 'USD').fare, 210); // 5 min x 2
});

test('fare: surge is capped by the rule and ignored when disabled', () => {
  const off = valid(baseRule);
  assert.equal(calculateFare(off, { distanceKm: 10, durationMin: 20, surgeMultiplier: 3 }, 'USD').fare, 200);
  const on = valid({ ...baseRule, surge: { enabled: true, maxMultiplier: 1.5 } });
  const r = calculateFare(on, { distanceKm: 10, durationMin: 20, surgeMultiplier: 3 }, 'USD');
  assert.equal(r.multiplier, 1.5);
  assert.equal(r.fare, 300);
});

test('fare: taxes apply once to their own base and are not taxed again', () => {
  const rule = valid({
    ...baseRule,
    additionalCharges: [{ name: 'Toll handling', type: 'fixed', amount: 20 }, { name: 'Service', type: 'percent_of_fare', amount: 10 }],
    taxes: [{ name: 'GST', ratePercent: 5, appliesTo: 'fare' }, { name: 'City tax', ratePercent: 2, appliesTo: 'fare_and_fees' }]
  });
  const r = calculateFare(rule, { distanceKm: 10, durationMin: 20 }, 'USD');
  // fare 200; fees = 10 + 20 + 20 (10% of 200) = 50; GST 5% of 200 = 10; city tax 2% of 250 = 5
  assert.equal(r.fare, 200);
  assert.equal(r.feesTotal, 50);
  assert.deepEqual(r.taxes.map((t) => t.amount), [10, 5]);
  assert.equal(r.total, 200 + 50 + 15);
});

test('fare: discount reduces the total but never below zero', () => {
  const rule = valid(baseRule);
  assert.equal(calculateFare(rule, { distanceKm: 10, durationMin: 20, discount: 60 }, 'USD').total, 150);
  assert.equal(calculateFare(rule, { distanceKm: 10, durationMin: 20, discount: 9999 }, 'USD').total, 0);
});

test('fare: rounding follows the currency (JPY has no decimals, USD has two)', () => {
  const rule = valid({ ...baseRule, baseFare: 100, perKm: 33.333, perMinute: 0, minimumFare: 0, bookingFee: 0 });
  assert.equal(calculateFare(rule, { distanceKm: 1, durationMin: 0 }, 'JPY').fare, 133);
  assert.equal(calculateFare(rule, { distanceKm: 1, durationMin: 0 }, 'USD').fare, 133.33);
});

test('fare rule validation: negatives, junk, and an always-zero fare are rejected', () => {
  assert.ok(validateFareRuleInput({ ...baseRule, baseFare: -1 }).errors.baseFare);
  assert.ok(validateFareRuleInput({ ...baseRule, perKm: 'abc' }).errors.perKm);
  assert.ok(validateFareRuleInput({ ...baseRule, perMinute: Infinity }).errors.perMinute);
  assert.ok(validateFareRuleInput({ ...baseRule, minimumFare: 1e9 }).errors.minimumFare);
  assert.ok(validateFareRuleInput({ ...baseRule, waitingFreeMinutes: 500 }).errors.waitingFreeMinutes);
  assert.ok(validateFareRuleInput({ ...baseRule, baseFare: 0, perKm: 0, perMinute: 0, minimumFare: 0 }).errors.baseFare);
  assert.ok(validateFareRuleInput({ ...baseRule, taxes: [{ name: 'X', ratePercent: 150, appliesTo: 'fare' }] }).errors['taxes.0.ratePercent']);
  assert.ok(validateFareRuleInput({ ...baseRule, additionalCharges: [{ name: '', type: 'fixed', amount: 1 }] }).errors['additionalCharges.0.name']);
  assert.ok(validateFareRuleInput({ ...baseRule, surge: { enabled: true, maxMultiplier: 0.5 } }).errors['surge.maxMultiplier']);
  // numeric strings from a form are accepted
  assert.deepEqual(validateFareRuleInput({ ...baseRule, baseFare: '50', perKm: '12' }).errors, {});
});

test('market validation', () => {
  assert.deepEqual(v.validateMarket({ country: 'in', currency: 'inr', timezone: 'Asia/Kolkata' }).errors, {});
  assert.ok(v.validateMarket({ country: 'India', currency: 'INR', timezone: 'Asia/Kolkata' }).errors.country);
  assert.ok(v.validateMarket({ country: 'IN', currency: 'ZZZ', timezone: 'Asia/Kolkata' }).errors.currency);
  assert.ok(v.validateMarket({ country: 'IN', currency: 'INR', timezone: 'Mars/Base' }).errors.timezone);
});

test('category validation', () => {
  const ok = { name: 'Sedan', passengerCapacity: 4, rideType: 'economy', regionIds: ['rg_1'] };
  assert.deepEqual(v.validateCategory(ok).errors, {});
  assert.ok(v.validateCategory({ ...ok, name: 'S' }).errors.name);
  assert.ok(v.validateCategory({ ...ok, passengerCapacity: 0 }).errors.passengerCapacity);
  assert.ok(v.validateCategory({ ...ok, passengerCapacity: 2.5 }).errors.passengerCapacity);
  assert.ok(v.validateCategory({ ...ok, rideType: 'spaceship' }).errors.rideType);
  assert.ok(v.validateCategory({ ...ok, regionIds: [] }).errors.regionIds);
  assert.ok(v.validateCategory({ ...ok, imageUrl: 'http://insecure.test/x.png' }).errors.imageUrl);
  assert.ok(v.validateCategory({ ...ok, icon: 'rocket' }).errors.icon);
  assert.equal(v.validateCategory({ ...ok, luggageCapacity: '' }).value.luggageCapacity, null);
});

test('region keys ignore case and spacing', () => {
  assert.equal(v.normalizeKey('Maharashtra', ' Pune ', 'All  areas'), v.normalizeKey('maharashtra', 'pune', 'all areas'));
});

test('setup status: steps, next step and warnings come from the data', () => {
  const market = { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' };
  const region = { regionId: 'r1', active: true, city: 'Pune', zoneName: 'All areas', center: { lat: 18.52, lng: 73.86 }, radiusKm: 20 };
  const cat = { categoryId: 'c1', name: 'Sedan', active: true, regionIds: ['r1'] };
  const empty = computeSetup({ market: null, regions: [], categories: [], fareRules: [], completedAt: null });
  assert.equal(empty.nextStep.key, 'regions');
  assert.equal(empty.percent, 0);

  const withRegion = computeSetup({ market, regions: [region], categories: [], fareRules: [], completedAt: null });
  assert.equal(withRegion.nextStep.key, 'categories');

  const unpriced = computeSetup({ market, regions: [region], categories: [cat], fareRules: [], completedAt: null });
  assert.equal(unpriced.nextStep.key, 'pricing');
  assert.ok(unpriced.warnings.some((w) => w.code === 'category_unpriced'));

  const rule = { active: true, categoryId: 'c1', regionId: null };
  const ready = computeSetup({ market, regions: [region], categories: [cat], fareRules: [rule], completedAt: null });
  assert.equal(ready.ready, true);
  assert.equal(ready.complete, false);
  assert.equal(ready.nextStep.key, 'confirm');

  const done = computeSetup({ market, regions: [region], categories: [cat], fareRules: [rule], completedAt: new Date() });
  assert.equal(done.complete, true);
  assert.equal(done.percent, 100);
  assert.deepEqual(done.warnings, []);

  const noArea = computeSetup({ market, regions: [{ ...region, center: null, radiusKm: null }], categories: [cat], fareRules: [rule], completedAt: null });
  assert.ok(noArea.warnings.some((w) => w.code === 'region_no_area'), 'a region without a centre and radius is flagged');

  const regressed = computeSetup({ market, regions: [{ ...region, active: false }], categories: [cat], fareRules: [rule], completedAt: new Date() });
  assert.equal(regressed.complete, false);
  assert.ok(regressed.warnings.some((w) => w.code === 'setup_regressed'));
});

test('forTenant adds the tenant to every query and overrides a supplied tenantId', async () => {
  const seen = [];
  const Model = {
    find: (f) => seen.push(['find', f]), findOne: (f) => seen.push(['findOne', f]), countDocuments: (f) => seen.push(['count', f]),
    exists: (f) => seen.push(['exists', f]), create: (d) => seen.push(['create', d]), deleteOne: (f) => seen.push(['delete', f]),
    findOneAndUpdate: (f, u, o) => seen.push(['update', f, u, o])
  };
  const d = forTenant('app_one');
  d.find(Model); d.find(Model, { tenantId: 'app_other', active: true }); d.findOne(Model, { tenantId: 'app_other' });
  d.count(Model); d.exists(Model, { tenantId: 'app_other' }); d.remove(Model, { tenantId: 'app_other', id: 1 });
  d.create(Model, { tenantId: 'app_other', name: 'x' });
  d.update(Model, { tenantId: 'app_other', id: 1 }, { tenantId: 'app_other', name: 'y' });
  for (const [op, filterOrDoc, update] of seen) {
    assert.equal(filterOrDoc.tenantId, 'app_one', `${op} must be bound to app_one`);
    if (op === 'update') assert.equal(update.$set.tenantId, undefined, 'update cannot move a record to another tenant');
  }
  assert.throws(() => forTenant(''), /appId/);
});
