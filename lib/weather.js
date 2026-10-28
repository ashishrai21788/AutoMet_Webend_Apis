/**
 * Weather for pricing. A business can choose to charge a little more while the weather at the pickup is bad (rain, storm, fog, snow,
 * extreme heat). Everything here is built so that choice is safe for riders and for the business:
 *
 *  - It is OFF unless the business switches it on, and it only has effect on a fare rule that has surge switched on (so the rule's own
 *    maximum multiplier always caps demand surge and weather together). A business that has paused surge has paused this too.
 *  - Each business sets its own multiplier per condition (1 to 2, two decimals) and its own cap (default 1.5). Nothing is built in.
 *  - The weather is a separate, labelled line on the fare ("Weather: Heavy rain (x1.3)"), shown in the estimate before booking.
 *  - A rider is never charged more for the weather than the estimate they were shown (see lib/tripPricing.js).
 *  - If the weather cannot be read (the provider is down, slow or sends nonsense) the fare is NOT blocked and NOT changed: there is no
 *    weather adjustment. A recent reading is reused for up to 30 minutes when the provider fails, never longer.
 *
 * The reading comes from a provider with one method, `fetchCurrent({ lat, lng }) -> { code, precipitationMm, tempC, windKph }`, where
 * `code` is a WMO weather code. Open-Meteo is the one provided; its free service is for non-commercial use, so a business running this
 * commercially needs that provider's paid plan (set WEATHER_API_BASE and WEATHER_API_KEY) or a different provider behind the same method.
 * Readings are held per ~5 km cell for 10 minutes, so a busy area makes one request, not one per rider.
 */
const CONDITIONS = ['LIGHT_RAIN', 'HEAVY_RAIN', 'STORM', 'FOG', 'SNOW', 'EXTREME_HEAT'];
const LABELS = { CLEAR: 'Clear', LIGHT_RAIN: 'Rain', HEAVY_RAIN: 'Heavy rain', STORM: 'Storm', FOG: 'Fog', SNOW: 'Snow', EXTREME_HEAT: 'Extreme heat' };
const DEFAULT_CAP = 1.5;
const TTL_MS = 10 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
const FAILURE_PAUSE_MS = 60 * 1000;
const TIMEOUT_MS = 2500;
const CELL_DEG = 0.05; // about 5 km
const HEAVY_MM = 7.6; // millimetres in the last hour; the usual meteorological threshold for heavy rain
const EXTREME_HEAT_C = 42;

/** Plain condition from a reading. A storm outranks everything; measured rain counts even when the code says it is clear. */
function conditionFrom(reading) {
  if (!reading || typeof reading !== 'object') return 'CLEAR';
  const code = Number(reading.code);
  const mm = Number(reading.precipitationMm) || 0;
  const temp = Number(reading.tempC);
  if ([95, 96, 99].includes(code)) return 'STORM';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'SNOW';
  if ([65, 82].includes(code) || mm >= HEAVY_MM) return 'HEAVY_RAIN';
  if ([45, 48].includes(code)) return 'FOG';
  if ((code >= 51 && code <= 67) || [80, 81].includes(code) || mm > 0) return 'LIGHT_RAIN';
  if (Number.isFinite(temp) && temp >= EXTREME_HEAT_C) return 'EXTREME_HEAT';
  return 'CLEAR';
}

const twoDecimals = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;

/** Check what an administrator sent. -> { value, errors }. A multiplier of exactly 1 is "no rule" and is not stored. */
function validateSettings(input) {
  const errors = {};
  const src = input && typeof input === 'object' ? input : {};
  const multipliers = {};
  const given = src.multipliers && typeof src.multipliers === 'object' ? src.multipliers : {};
  for (const [name, raw] of Object.entries(given)) {
    const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
    if (!CONDITIONS.includes(name)) { errors[`multipliers.${name}`] = 'Unknown weather condition'; continue; }
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1 || n > 2 || !twoDecimals(n)) { errors[`multipliers.${name}`] = 'Enter 1 to 2, with at most two decimals'; continue; }
    if (n > 1) multipliers[name] = n;
  }
  let maxMultiplier = DEFAULT_CAP;
  if (src.maxMultiplier != null && src.maxMultiplier !== '') {
    const n = typeof src.maxMultiplier === 'string' ? Number(src.maxMultiplier.trim()) : src.maxMultiplier;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1 || n > 2 || !twoDecimals(n)) errors.maxMultiplier = 'Enter 1 to 2, with at most two decimals';
    else maxMultiplier = n;
  }
  return { value: { enabled: src.enabled === true, multipliers, maxMultiplier }, errors };
}

/** A business's stored settings with safe defaults and the cap applied even to a damaged stored value. */
function rulesOf(tenant) {
  const w = (tenant && tenant.weatherPricing) || {};
  const cap = Number(w.maxMultiplier);
  const maxMultiplier = Number.isFinite(cap) && cap >= 1 && cap <= 2 ? cap : DEFAULT_CAP;
  const multipliers = {};
  for (const name of CONDITIONS) { const n = Number(w.multipliers && w.multipliers[name]); if (Number.isFinite(n) && n > 1) multipliers[name] = n; }
  return { enabled: w.enabled === true, multipliers, maxMultiplier };
}

/** The multiplier this business charges for a condition: its own rule, never above its cap, 1 when off. */
function multiplierFor(condition, rules) {
  if (!rules || !rules.enabled) return 1;
  const m = Number(rules.multipliers && rules.multipliers[condition]);
  return Number.isFinite(m) && m > 1 ? Math.min(m, rules.maxMultiplier) : 1;
}

/** The Open-Meteo reader. `base` and `key` come from WEATHER_API_BASE / WEATHER_API_KEY for a paid plan; every call has a timeout. */
function openMeteo({ base = 'https://api.open-meteo.com', key = null, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  return {
    name: 'open-meteo',
    async fetchCurrent({ lat, lng }) {
      const url = new URL('/v1/forecast', base);
      url.searchParams.set('latitude', String(lat));
      url.searchParams.set('longitude', String(lng));
      url.searchParams.set('current', 'temperature_2m,precipitation,weather_code,wind_speed_10m');
      url.searchParams.set('timezone', 'auto');
      if (key) url.searchParams.set('apikey', key);
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`weather provider HTTP ${res.status}`);
      const c = (await res.json()).current;
      if (!c || !Number.isFinite(Number(c.weather_code))) throw new Error('weather provider sent no reading');
      return { code: Number(c.weather_code), precipitationMm: Number(c.precipitation) || 0, tempC: Number(c.temperature_2m), windKph: Number(c.wind_speed_10m) };
    }
  };
}

/**
 * A weather that never changes, for development and QA ("what does a rider pay in a storm?"): WEATHER_PROVIDER=fixed with WEATHER_FIXED_CODE
 * (a WMO code, default 65 = heavy rain), WEATHER_FIXED_PRECIP (mm, default 9) and WEATHER_FIXED_TEMP (degrees C, default 24). It does not exist in
 * production: a production server with it set simply has no weather provider, so real fares can never be priced on pretend weather.
 */
const fixedProvider = (env) => ({
  name: 'fixed',
  async fetchCurrent() {
    return { code: Number(env.WEATHER_FIXED_CODE != null ? env.WEATHER_FIXED_CODE : 65), precipitationMm: Number(env.WEATHER_FIXED_PRECIP != null ? env.WEATHER_FIXED_PRECIP : 9), tempC: Number(env.WEATHER_FIXED_TEMP != null ? env.WEATHER_FIXED_TEMP : 24), windKph: 0 };
  }
});

const defaultProvider = (env = process.env) => {
  const which = String(env.WEATHER_PROVIDER || 'open-meteo');
  if (which === 'off') return null;
  if (which === 'fixed') return String(env.NODE_ENV || '').toLowerCase() === 'production' ? null : fixedProvider(env);
  return openMeteo({ base: env.WEATHER_API_BASE || undefined, key: env.WEATHER_API_KEY || null });
};

let override; // set by tests so nothing reaches the network
const useProvider = (p) => { override = p; };
const cache = new Map(); // cell -> { at, reading }
const failures = new Map(); // cell -> time of the last failure
const clearWeatherCache = () => { cache.clear(); failures.clear(); };
const cellOf = (p) => `${Math.floor(p.lat / CELL_DEG)}:${Math.floor(p.lng / CELL_DEG)}`;
const validReading = (r) => !!r && typeof r === 'object' && Number.isFinite(Number(r.code));

/**
 * The weather at a pickup and what it costs this business: { enabled, available, condition, label, multiplier, source, stale, asOf }.
 * Never throws and never blocks a fare: an unreadable weather is { available: false, multiplier: 1 }.
 */
async function weatherAt({ tenant, pickup, now = new Date() }, deps = {}) {
  const rules = rulesOf(tenant);
  const none = { enabled: rules.enabled, available: false, condition: 'CLEAR', label: LABELS.CLEAR, multiplier: 1, source: null, stale: false, asOf: null };
  if (!rules.enabled || !pickup || !Number.isFinite(pickup.lat) || !Number.isFinite(pickup.lng)) return none;
  const provider = deps.provider !== undefined ? deps.provider : override !== undefined ? override : defaultProvider();
  if (!provider) return none;
  const cell = cellOf(pickup);
  const t = now.getTime();
  const answer = (reading, at, stale) => {
    const condition = conditionFrom(reading);
    return { enabled: true, available: true, condition, label: LABELS[condition], multiplier: multiplierFor(condition, rules), source: provider.name || 'provider', stale, asOf: new Date(at).toISOString() };
  };
  const hit = cache.get(cell);
  if (hit && t - hit.at <= TTL_MS) return answer(hit.reading, hit.at, false);
  const failedAt = failures.get(cell);
  if (!(failedAt && t - failedAt < FAILURE_PAUSE_MS)) {
    try {
      const reading = await provider.fetchCurrent({ lat: pickup.lat, lng: pickup.lng });
      if (validReading(reading)) { cache.set(cell, { at: t, reading }); failures.delete(cell); return answer(reading, t, false); }
      failures.set(cell, t);
    } catch (e) { failures.set(cell, t); }
  }
  if (hit && t - hit.at <= STALE_MS) return answer(hit.reading, hit.at, true);
  return none;
}

module.exports = { defaultProvider, CONDITIONS, LABELS, DEFAULT_CAP, conditionFrom, validateSettings, rulesOf, multiplierFor, openMeteo, weatherAt, clearWeatherCache, useProvider };
