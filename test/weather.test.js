// Weather-based pricing: what the weather is, what a business has agreed to charge for it, how it combines with demand surge inside the fare
// rule's own cap, and the protections for riders (a labelled line, never more than they were shown, never a fare blocked by a weather outage).
process.env.JWT_SECRET = 'test-secret-for-weather';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install(); // the surge lookups read rider presence and recent requests

const weather = require('../lib/weather');
const { calculateFare } = require('../lib/fareRules');
const surge = require('../lib/surge');
const { priceTrip, withSurge } = require('../lib/tripPricing');

const NOON = new Date('2026-10-28T06:30:00Z');
const rule = { baseFare: 40, perKm: 12, perMinute: 1, minimumFare: 70, bookingFee: 0, waitingFreeMinutes: 3, waitingPerMinute: 1.5, additionalCharges: [], taxes: [], surge: { enabled: true, maxMultiplier: 2 } };
const TRIP = { distanceKm: 10, durationMin: 20 };

// ---------------------------------------------------------------- what the weather is

test('weather codes and rainfall become one of a few plain conditions', () => {
  const c = (code, precipitationMm = 0, tempC = 25) => weather.conditionFrom({ code, precipitationMm, tempC });
  assert.equal(c(0), 'CLEAR');
  assert.equal(c(3), 'CLEAR', 'cloud is not weather');
  assert.equal(c(45), 'FOG');
  assert.equal(c(48), 'FOG');
  for (const code of [51, 53, 55, 61, 80]) assert.equal(c(code, 0.4), 'LIGHT_RAIN', String(code));
  assert.equal(c(63, 4), 'LIGHT_RAIN', 'moderate rain is still light for pricing');
  for (const code of [65, 82]) assert.equal(c(code, 9), 'HEAVY_RAIN', String(code));
  assert.equal(c(61, 8), 'HEAVY_RAIN', '7.6 mm in an hour or more is heavy whatever the code says');
  assert.equal(c(0, 0.2), 'LIGHT_RAIN', 'measured rain counts even when the code says clear');
  for (const code of [95, 96, 99]) assert.equal(c(code, 3), 'STORM', String(code));
  for (const code of [71, 73, 75, 77, 85, 86]) assert.equal(c(code), 'SNOW', String(code));
  assert.equal(c(0, 0, 43), 'EXTREME_HEAT');
  assert.equal(c(3, 0, 41.9), 'CLEAR');
  assert.equal(c(95, 0, 44), 'STORM', 'a storm outranks heat');
  assert.equal(weather.conditionFrom({}), 'CLEAR', 'no reading is no condition');
  assert.equal(weather.conditionFrom(null), 'CLEAR');
});

// ---------------------------------------------------------------- what a business has agreed to

test('a business\'s weather settings are validated: every multiplier from 1 to 2 with at most two decimals, a cap, and a clear reason when wrong', () => {
  const ok = weather.validateSettings({ enabled: true, multipliers: { HEAVY_RAIN: 1.3, STORM: '1.5', LIGHT_RAIN: 1 }, maxMultiplier: 1.4 });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.value, { enabled: true, multipliers: { HEAVY_RAIN: 1.3, STORM: 1.5 }, maxMultiplier: 1.4 }, 'a multiplier of 1 is no rule');
  const bad = weather.validateSettings({ enabled: true, multipliers: { HEAVY_RAIN: 2.5, STORM: 0.8, FOG: 1.234, NOT_A_CONDITION: 1.2, SNOW: 'lots' }, maxMultiplier: 3 });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['maxMultiplier', 'multipliers.FOG', 'multipliers.HEAVY_RAIN', 'multipliers.NOT_A_CONDITION', 'multipliers.SNOW', 'multipliers.STORM']);
  assert.deepEqual(weather.validateSettings({}).value, { enabled: false, multipliers: {}, maxMultiplier: 1.5 }, 'off by default, with a 1.5 cap ready');
  assert.deepEqual(weather.validateSettings({ enabled: true, multipliers: { STORM: 1.5 } }).errors, {}, 'the cap is optional');
});

test('the multiplier for a condition is the business\'s own rule, never above its cap, and 1 when weather pricing is off', () => {
  const on = weather.rulesOf({ weatherPricing: { enabled: true, multipliers: { LIGHT_RAIN: 1.1, HEAVY_RAIN: 1.3, STORM: 1.8 }, maxMultiplier: 1.5 } });
  assert.equal(weather.multiplierFor('CLEAR', on), 1);
  assert.equal(weather.multiplierFor('LIGHT_RAIN', on), 1.1);
  assert.equal(weather.multiplierFor('HEAVY_RAIN', on), 1.3);
  assert.equal(weather.multiplierFor('STORM', on), 1.5, 'capped');
  assert.equal(weather.multiplierFor('FOG', on), 1, 'no rule, no charge');
  const off = weather.rulesOf({ weatherPricing: { enabled: false, multipliers: { STORM: 1.5 } } });
  assert.equal(weather.multiplierFor('STORM', off), 1);
  assert.equal(weather.multiplierFor('STORM', weather.rulesOf({})), 1);
  assert.equal(weather.multiplierFor('STORM', weather.rulesOf({ weatherPricing: { enabled: true, multipliers: { STORM: 9 } } })), 1.5, 'a corrupted stored value is still capped at the default');
});

// ---------------------------------------------------------------- reading the weather

const tenant = (over = {}) => ({ tenantId: 't1', weatherPricing: { enabled: true, multipliers: { LIGHT_RAIN: 1.1, HEAVY_RAIN: 1.3, STORM: 1.5 }, maxMultiplier: 1.5 }, ...over });
const provider = (reading, calls = []) => ({ name: 'test', fetchCurrent: async (p) => { calls.push(p); if (reading instanceof Error) throw reading; return reading; } });

test('the weather at a pickup comes from the provider, is named, and is held for ten minutes for everyone in the same area', async () => {
  weather.clearWeatherCache();
  const calls = [];
  const p = provider({ code: 65, precipitationMm: 9, tempC: 24 }, calls);
  const a = await weather.weatherAt({ tenant: tenant(), pickup: { lat: 28.5746, lng: 77.4858 }, now: NOON }, { provider: p });
  assert.deepEqual([a.condition, a.label, a.multiplier, a.source, a.available], ['HEAVY_RAIN', 'Heavy rain', 1.3, 'test', true]);
  await weather.weatherAt({ tenant: tenant(), pickup: { lat: 28.5801, lng: 77.4902 }, now: new Date(NOON.getTime() + 9 * 60000) }, { provider: p });
  assert.equal(calls.length, 1, 'a few hundred metres away, nine minutes later: the same reading');
  await weather.weatherAt({ tenant: tenant(), pickup: { lat: 28.5746, lng: 77.4858 }, now: new Date(NOON.getTime() + 11 * 60000) }, { provider: p });
  assert.equal(calls.length, 2, 'after ten minutes it is read again');
  await weather.weatherAt({ tenant: tenant(), pickup: { lat: 28.9, lng: 77.9 }, now: NOON }, { provider: p });
  assert.equal(calls.length, 3, 'another area is its own reading');
});

test('a business with weather pricing off never causes a weather lookup', async () => {
  weather.clearWeatherCache();
  const calls = [];
  const r = await weather.weatherAt({ tenant: tenant({ weatherPricing: { enabled: false } }), pickup: { lat: 28.5, lng: 77.4 }, now: NOON }, { provider: provider({ code: 95 }, calls) });
  assert.deepEqual([r.multiplier, r.enabled, calls.length], [1, false, 0]);
});

test('if the weather cannot be read, the fare is not blocked and not changed: no adjustment, and the failure is visible but harmless', async () => {
  weather.clearWeatherCache();
  const r = await weather.weatherAt({ tenant: tenant(), pickup: { lat: 28.5, lng: 77.4 }, now: NOON }, { provider: provider(new Error('timeout')) });
  assert.deepEqual([r.multiplier, r.available, r.condition], [1, false, 'CLEAR']);
  const garbage = await weather.weatherAt({ tenant: tenant(), pickup: { lat: 28.6, lng: 77.5 }, now: NOON }, { provider: provider({ nonsense: true }) });
  assert.equal(garbage.multiplier, 1, 'a reading that is not a reading is no adjustment');
  const none = await weather.weatherAt({ tenant: tenant(), pickup: { lat: 28.7, lng: 77.6 }, now: NOON }, { provider: provider(null) });
  assert.equal(none.multiplier, 1);
});

test('a recent reading is reused for up to half an hour when the provider is failing, then dropped (never trusted for long)', async () => {
  weather.clearWeatherCache();
  const good = provider({ code: 65, precipitationMm: 9 });
  await weather.weatherAt({ tenant: tenant(), pickup: { lat: 28.5, lng: 77.4 }, now: NOON }, { provider: good });
  const failing = provider(new Error('down'));
  const soon = await weather.weatherAt({ tenant: tenant(), pickup: { lat: 28.5, lng: 77.4 }, now: new Date(NOON.getTime() + 20 * 60000) }, { provider: failing });
  assert.deepEqual([soon.condition, soon.multiplier, soon.stale], ['HEAVY_RAIN', 1.3, true]);
  const late = await weather.weatherAt({ tenant: tenant(), pickup: { lat: 28.5, lng: 77.4 }, now: new Date(NOON.getTime() + 40 * 60000) }, { provider: failing });
  assert.deepEqual([late.multiplier, late.available], [1, false]);
});

test('the Open-Meteo reader asks for the current conditions at the point, and turns the reply into a reading', async () => {
  const seen = [];
  const reader = weather.openMeteo({ base: 'http://weather.test', fetchImpl: async (url, opts) => { seen.push({ url: String(url), signal: !!opts.signal }); return { ok: true, json: async () => ({ current: { time: '2026-10-28T06:30', temperature_2m: 27.4, precipitation: 3.2, weather_code: 63, wind_speed_10m: 12 } }) }; } });
  const r = await reader.fetchCurrent({ lat: 28.5746, lng: 77.4858 });
  assert.deepEqual(r, { code: 63, precipitationMm: 3.2, tempC: 27.4, windKph: 12 });
  const u = new URL(seen[0].url);
  assert.equal(u.origin + u.pathname, 'http://weather.test/v1/forecast');
  assert.equal(u.searchParams.get('latitude'), '28.5746');
  assert.equal(u.searchParams.get('longitude'), '77.4858');
  assert.match(u.searchParams.get('current'), /weather_code/);
  assert.equal(seen[0].signal, true, 'every call has a timeout');
  const bad = weather.openMeteo({ base: 'http://weather.test', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  await assert.rejects(bad.fetchCurrent({ lat: 1, lng: 1 }), /429/);
});

test('the fixed development weather gives the configured reading, and is not available in production', async () => {
  const dev = weather.defaultProvider({ WEATHER_PROVIDER: 'fixed', WEATHER_FIXED_CODE: '95', WEATHER_FIXED_PRECIP: '4', NODE_ENV: 'development' });
  assert.deepEqual(await dev.fetchCurrent({ lat: 1, lng: 1 }), { code: 95, precipitationMm: 4, tempC: 24, windKph: 0 });
  assert.equal(weather.conditionFrom(await dev.fetchCurrent({})), 'STORM');
  const defaults = weather.defaultProvider({ WEATHER_PROVIDER: 'fixed' });
  assert.equal(weather.conditionFrom(await defaults.fetchCurrent({})), 'HEAVY_RAIN', 'heavy rain unless told otherwise');
  assert.equal(weather.defaultProvider({ WEATHER_PROVIDER: 'fixed', NODE_ENV: 'production' }), null, 'a production server has no pretend weather');
  assert.equal(weather.defaultProvider({ WEATHER_PROVIDER: 'off' }), null);
  assert.equal(weather.defaultProvider({}).name, 'open-meteo');
});

// ---------------------------------------------------------------- in the fare

test('the fare shows weather as its own line, apart from demand surge, and the two together never pass the fare rule\'s maximum', () => {
  const plain = calculateFare(rule, TRIP, 'INR');
  const rain = calculateFare(rule, { ...TRIP, weatherMultiplier: 1.3, weatherLabel: 'Heavy rain' }, 'INR');
  const ride = plain.fare; // 40 + 120 + 20 = 180
  assert.equal(ride, 180);
  const wLine = rain.lines.find((l) => l.key === 'weather');
  assert.deepEqual([wLine.label, wLine.amount], ['Weather: Heavy rain (x1.3)', 54]);
  assert.equal(rain.lines.find((l) => l.key === 'surge'), undefined, 'no demand surge, no surge line');
  assert.equal(rain.fare, 234);

  const both = calculateFare(rule, { ...TRIP, surgeMultiplier: 1.5, weatherMultiplier: 1.3, weatherLabel: 'Heavy rain' }, 'INR');
  assert.equal(both.lines.find((l) => l.key === 'surge').amount, 90);
  assert.equal(both.lines.find((l) => l.key === 'weather').amount, 81, 'weather is charged on the surged charge: 270 x 0.3');
  assert.equal(both.multiplier, 1.95);
  assert.equal(both.fare, 351, 'x1.95 of 180, shown as the ride charge plus two lines');
  const capped = calculateFare(rule, { ...TRIP, surgeMultiplier: 2, weatherMultiplier: 1.5, weatherLabel: 'Storm' }, 'INR');
  assert.equal(capped.multiplier, 2, 'the rule\'s own maximum caps both together');
  assert.equal(capped.fare, 360);
  assert.equal(capped.lines.find((l) => l.key === 'weather'), undefined, 'when demand alone already reaches the cap there is no room left for weather, and no weather line');
});

test('weather does nothing on a rule that has surge switched off, and a multiplier of 1 or less adds nothing', () => {
  const noSurge = { ...rule, surge: { enabled: false, maxMultiplier: 1 } };
  const r = calculateFare(noSurge, { ...TRIP, weatherMultiplier: 1.5, weatherLabel: 'Storm' }, 'INR');
  assert.equal(r.fare, 180);
  assert.equal(r.lines.find((l) => l.key === 'weather'), undefined);
  for (const w of [1, 0.5, 0, -2, NaN, 'x', undefined, null]) assert.equal(calculateFare(rule, { ...TRIP, weatherMultiplier: w }, 'INR').fare, 180, String(w));
});

test('the lines always add up to the fare, whatever the multipliers', () => {
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 400; i += 1) {
    const d = 1 + (next() % 30); const t = 5 + (next() % 60);
    const s = 1 + (next() % 150) / 100; const w = 1 + (next() % 100) / 100;
    const r = calculateFare(rule, { distanceKm: d, durationMin: t, surgeMultiplier: s, weatherMultiplier: w, weatherLabel: 'Rain' }, 'INR');
    const sum = r.lines.filter((l) => l.key !== 'minimum').reduce((a, l) => a + l.amount, 0) + (r.lines.find((l) => l.key === 'minimum') || { amount: 0 }).amount;
    assert.ok(Math.abs(sum - r.fare) < 0.011, `d=${d} t=${t} s=${s} w=${w}: lines ${sum} vs fare ${r.fare}`);
    assert.ok(r.multiplier <= 2 + 1e-9);
  }
});

// ---------------------------------------------------------------- end to end in pricing

const config = () => ({
  market: { country: 'IN', currency: 'INR' },
  regions: [],
  categories: [{ categoryId: 'c1', name: 'Sedan', active: true, regionIds: [] }],
  fareRules: [{ ruleId: 'r1', categoryId: 'c1', regionId: null, regionKey: 'default', active: true, currency: 'INR', ...rule, updatedAt: NOON }],
  pricingVersion: null
});
const trip = { pickup: { lat: 28.5746, lng: 77.4858 }, drop: { lat: 28.62, lng: 77.5 }, categoryId: 'c1' };
const ctx = (mode, extra = {}) => ({ tenant: tenant(), userId: 'U1', surge: { mode, loadFreeDrivers: async () => [] }, ...extra });

test('pricing a trip in the rain adds the weather line; a clear day, weather pricing off, or a provider outage leaves the fare as it was', async () => {
  surge.clearSurgeCache(); weather.clearWeatherCache();
  const cfg = config();
  const base = priceTrip(cfg, trip).estimate.fare;
  const rainy = await withSurge(cfg, trip, ctx('estimate', { weather: { provider: provider({ code: 65, precipitationMm: 9 }) } }));
  const priced = priceTrip(cfg, rainy).estimate;
  assert.ok(priced.fare > base, 'dearer in heavy rain');
  assert.ok(priced.breakdown.lines.some((l) => l.key === 'weather' && /Heavy rain/.test(l.label)));
  assert.equal(priced.weather.condition, 'HEAVY_RAIN');
  assert.equal(priced.weather.multiplier, 1.3);

  weather.clearWeatherCache();
  const clear = priceTrip(cfg, await withSurge(cfg, trip, ctx('estimate', { weather: { provider: provider({ code: 0 }) } }))).estimate;
  assert.equal(clear.fare, base);
  assert.equal(clear.weather, null);
  weather.clearWeatherCache();
  const off = priceTrip(cfg, await withSurge(cfg, trip, { ...ctx('estimate', { weather: { provider: provider({ code: 95 }) } }), tenant: tenant({ weatherPricing: { enabled: false } }) })).estimate;
  assert.equal(off.fare, base);
  weather.clearWeatherCache();
  const down = priceTrip(cfg, await withSurge(cfg, trip, ctx('estimate', { weather: { provider: provider(new Error('down')) } }))).estimate;
  assert.equal(down.fare, base, 'an outage never blocks or changes a fare');
});

test('a business that has paused surge has paused weather pricing too', async () => {
  surge.clearSurgeCache(); weather.clearWeatherCache();
  const cfg = config();
  const t = tenant({ surgeSettings: { paused: true } });
  const r = priceTrip(cfg, await withSurge(cfg, trip, { ...ctx('estimate', { weather: { provider: provider({ code: 95 }) } }), tenant: t })).estimate;
  assert.equal(r.fare, priceTrip(cfg, trip).estimate.fare);
});

test('a rider is never charged more for the weather than the estimate they were shown: the booking uses the lower of the two', async () => {
  surge.clearSurgeCache(); weather.clearWeatherCache();
  const cfg = config();
  const shown = await withSurge(cfg, trip, ctx('estimate', { weather: { provider: provider({ code: 63, precipitationMm: 3 }) } })); // light rain: x1.1
  assert.equal(shown.weatherMultiplier, 1.1);
  weather.clearWeatherCache(); // the weather has got worse by the time they book
  const booked = await withSurge(cfg, trip, ctx('book', { weather: { provider: provider({ code: 95, precipitationMm: 9 }) } })); // storm: x1.5
  assert.equal(booked.weatherMultiplier, 1.1, 'held at what they saw');
  weather.clearWeatherCache(); // and if it improves, they pay less
  const better = await withSurge(cfg, trip, ctx('book', { weather: { provider: provider({ code: 0 }) } }));
  assert.ok(!better.weatherMultiplier || better.weatherMultiplier === 1);
});
