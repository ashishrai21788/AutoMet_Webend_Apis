const { MAX_MONEY } = require('./fareRules');

const RIDE_TYPES = ['economy', 'comfort', 'premium', 'shared', 'two_wheeler', 'three_wheeler', 'van'];
const ICONS = ['car', 'suv', 'hatchback', 'premium', 'auto', 'bike', 'electric', 'van'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PHONE_RE = /^\+?[0-9 ()-]{6,20}$/;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
const normalizeKey = (...parts) => parts.map((p) => str(p).toLowerCase().replace(/\s+/g, ' ')).join('|');

function validCurrency(code) {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency').includes(code) : true;
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return typeof tz === 'string' && tz.length > 0;
  } catch {
    return false;
  }
}

function validateMarket(input = {}) {
  const errors = {};
  const country = str(input.country).toUpperCase();
  const currency = str(input.currency).toUpperCase();
  const timezone = str(input.timezone);
  if (!/^[A-Z]{2}$/.test(country)) errors.country = 'Choose a country';
  if (!validCurrency(currency)) errors.currency = 'Choose a valid currency';
  if (!validTimezone(timezone)) errors.timezone = 'Choose a valid time zone';
  return { value: { country, currency, timezone }, errors };
}

const DEFAULT_RADIUS_KM = 15;
const MAX_RADIUS_KM = 200;

function parseCenter(c) {
  const lat = num(c && c.lat);
  const lng = num(c && c.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 ? { lat, lng } : null;
}

function parseRadius(v) {
  const r = num(v);
  return Number.isFinite(r) && r >= 0.5 && r <= MAX_RADIUS_KM ? Math.round(r * 100) / 100 : null;
}

/**
 * One or more cities in a state, all with the same zone name and service radius. A city is a name, or
 * { name, lat, lng } to give its centre point (without one the region is created without an area and cannot be
 * matched to a pickup until the admin sets one).
 */
function validateRegionBatch(input = {}) {
  const errors = {};
  const state = str(input.state);
  const zoneName = str(input.zoneName) || 'All areas';
  const raw = Array.isArray(input.cities) ? input.cities : input.city ? [input.city] : [];
  const seen = new Set();
  const cities = [];
  for (const item of raw) {
    const name = str(typeof item === 'string' ? item : item && item.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const center = typeof item === 'object' && item ? parseCenter(item) : null;
    if (typeof item === 'object' && item && (item.lat != null || item.lng != null) && !center) errors.cities = 'A city has an invalid centre point';
    cities.push({ name, center });
  }
  let radiusKm = DEFAULT_RADIUS_KM;
  if (input.radiusKm != null && input.radiusKm !== '') {
    radiusKm = parseRadius(input.radiusKm);
    if (radiusKm === null) errors.radiusKm = 'Radius must be 0.5 to ' + MAX_RADIUS_KM + ' km';
  }
  if (!state || state.length > 80) errors.state = 'State or province is required (80 characters at most)';
  if (cities.length === 0) errors.cities = 'Choose or enter at least one city';
  if (cities.length > 25) errors.cities = 'Add at most 25 cities at a time';
  if (cities.some((c) => c.name.length > 80)) errors.cities = 'City names are 80 characters at most';
  if (zoneName.length > 80) errors.zoneName = 'Zone name is 80 characters at most';
  return { value: { state, cities, zoneName, radiusKm }, errors };
}

function validateRegionUpdate(input = {}) {
  const errors = {};
  const out = {};
  if ('zoneName' in input) {
    const z = str(input.zoneName);
    if (!z || z.length > 80) errors.zoneName = 'Zone name is required (80 characters at most)';
    else out.zoneName = z;
  }
  if ('active' in input) {
    if (typeof input.active !== 'boolean') errors.active = 'active must be true or false';
    else out.active = input.active;
  }
  if ('center' in input || 'radiusKm' in input) {
    if (input.center === null) {
      out.center = null; // clearing the area clears the radius too
      out.radiusKm = null;
    } else {
      const center = parseCenter(input.center);
      const radius = parseRadius(input.radiusKm);
      if (!center) errors.center = 'Enter a latitude from -90 to 90 and a longitude from -180 to 180';
      if (radius === null) errors.radiusKm = 'Radius must be 0.5 to ' + MAX_RADIUS_KM + ' km';
      if (center && radius !== null) { out.center = center; out.radiusKm = radius; }
    }
  }
  if (Object.keys(out).length === 0 && Object.keys(errors).length === 0) errors.zoneName = 'Nothing to update';
  return { value: out, errors };
}

function validateCategory(input = {}, { partial = false } = {}) {
  const errors = {};
  const out = {};
  const has = (k) => !partial || k in input;

  if (has('name')) {
    const name = str(input.name);
    if (name.length < 2 || name.length > 40) errors.name = 'Name is required (2 to 40 characters)';
    else out.name = name;
  }
  if (has('description')) {
    const d = str(input.description);
    if (d.length > 300) errors.description = 'Description is 300 characters at most';
    else out.description = d;
  }
  if (has('icon')) {
    const icon = str(input.icon) || 'car';
    if (!ICONS.includes(icon)) errors.icon = 'Choose one of the available icons';
    else out.icon = icon;
  }
  if (has('imageUrl')) {
    const url = str(input.imageUrl);
    if (url && !/^https:\/\/[^\s]+$/i.test(url)) errors.imageUrl = 'Image link must start with https://';
    else if (url.length > 500) errors.imageUrl = 'Image link is too long';
    else out.imageUrl = url;
  }
  if (has('passengerCapacity')) {
    const n = num(input.passengerCapacity);
    if (!Number.isInteger(n) || n < 1 || n > 20) errors.passengerCapacity = 'Passenger capacity must be a whole number from 1 to 20';
    else out.passengerCapacity = n;
  }
  if (has('luggageCapacity')) {
    const raw = input.luggageCapacity;
    if (raw === null || raw === '' || raw === undefined) out.luggageCapacity = null;
    else {
      const n = num(raw);
      if (!Number.isInteger(n) || n < 0 || n > 20) errors.luggageCapacity = 'Luggage capacity must be a whole number from 0 to 20, or empty';
      else out.luggageCapacity = n;
    }
  }
  if (has('rideType')) {
    const t = str(input.rideType);
    if (!RIDE_TYPES.includes(t)) errors.rideType = 'Choose a ride type';
    else out.rideType = t;
  }
  if (has('regionIds')) {
    const ids = Array.isArray(input.regionIds) ? [...new Set(input.regionIds.map(str).filter(Boolean))] : [];
    if (ids.length === 0) errors.regionIds = 'Choose at least one region where this category is available';
    else out.regionIds = ids;
  }
  if ('active' in input) {
    if (typeof input.active !== 'boolean') errors.active = 'active must be true or false';
    else out.active = input.active;
  }
  return { value: out, errors };
}

function validateBusinessSettings(input = {}) {
  const errors = {};
  const out = {};
  if ('name' in input) {
    const v = str(input.name);
    if (v.length < 2 || v.length > 80) errors.name = 'Business name is required (2 to 80 characters)';
    else out.name = v;
  }
  if ('appName' in input) {
    const v = str(input.appName);
    if (v.length < 2 || v.length > 40) errors.appName = 'App name is required (2 to 40 characters)';
    else out.appName = v;
  }
  if ('brandColor' in input) {
    const v = str(input.brandColor);
    if (!COLOR_RE.test(v)) errors.brandColor = 'Use a colour like #f5a300';
    else out.brandColor = v.toLowerCase();
  }
  if ('logoUrl' in input) {
    const v = str(input.logoUrl);
    if (v && !/^https:\/\/[^\s]{3,290}$/i.test(v)) errors.logoUrl = 'Use a link that starts with https://';
    else out.logoUrl = v;
  }
  if ('supportEmail' in input) {
    const v = str(input.supportEmail);
    if (v && !EMAIL_RE.test(v)) errors.supportEmail = 'Enter a valid email address';
    else out.supportEmail = v;
  }
  if ('supportPhone' in input) {
    const v = str(input.supportPhone);
    if (v && !PHONE_RE.test(v)) errors.supportPhone = 'Enter a valid phone number';
    else out.supportPhone = v;
  }
  if (Object.keys(out).length === 0 && Object.keys(errors).length === 0) errors.name = 'Nothing to update';
  return { value: out, errors };
}

function validateCancellationPolicy(input = {}) {
  const errors = {};
  const rider = input.rider || {};
  const driver = input.driver || {};
  const out = { rider: {}, driver: {} };

  const money = (target, source, field, path, label) => {
    const v = num(source[field]);
    if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MONEY)) errors[path] = `${label} must be 0 or more`;
    else target[field] = v;
  };
  const count = (target, source, field, path, label, max) => {
    const v = num(source[field]);
    if (!(Number.isInteger(v) && v >= 0 && v <= max)) errors[path] = `${label} must be a whole number from 0 to ${max}`;
    else target[field] = v;
  };

  count(out.rider, rider, 'freeCancellationMinutes', 'rider.freeCancellationMinutes', 'Free cancellation window', 60);
  money(out.rider, rider, 'feeAfterWindow', 'rider.feeAfterWindow', 'Rider fee after the free window');
  money(out.rider, rider, 'feeAfterDriverArrived', 'rider.feeAfterDriverArrived', 'Rider fee after the driver arrived');
  money(out.rider, rider, 'noShowFee', 'rider.noShowFee', 'No-show fee');
  money(out.driver, driver, 'penaltyFee', 'driver.penaltyFee', 'Driver cancellation penalty');
  count(out.driver, driver, 'graceCancellations', 'driver.graceCancellations', 'Free driver cancellations per day', 50);

  const conditions = str(input.conditions);
  if (conditions.length > 500) errors.conditions = 'Conditions are 500 characters at most';
  out.conditions = conditions;
  return { value: out, errors };
}

module.exports = {
  RIDE_TYPES, ICONS, normalizeKey, validateMarket, validateRegionBatch, validateRegionUpdate, validateCategory,
  validateBusinessSettings, validateCancellationPolicy, parseCenter, DEFAULT_RADIUS_KM
};
