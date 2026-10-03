/**
 * Trip distance / duration / fare estimation.
 *
 * There is no road-routing service on the backend, so the distance is the straight-line (great-circle) distance
 * between pickup and drop multiplied by a road factor. The fare is derived from that estimate, so it is an
 * ESTIMATE; when a real meter or GPS trace is added, set `fare_basis: 'ACTUAL'` on the trip and overwrite it.
 *
 * Tariffs are PLACEHOLDERS. Set the real ones per deployment with the FARE_CONFIG env var (JSON), for example:
 *   FARE_CONFIG={"currency":"INR","roadFactor":1.3,"avgSpeedKmh":22,
 *                "vehicles":{"auto":{"base":30,"baseKm":1,"perKm":13,"min":35},
 *                            "e_rickshaw":{"base":20,"baseKm":1,"perKm":9,"min":25}}}
 * Any key left out falls back to the defaults below.
 */

const DEFAULT_CONFIG = {
  currency: 'INR',
  // Real roads are longer than the straight line between two points.
  roadFactor: 1.3,
  // Average city speed used to estimate the ride duration.
  avgSpeedKmh: 22,
  // base: fare covering the first `baseKm` km; perKm: charged for each further km; min: minimum fare.
  vehicles: {
    default: { base: 25, baseKm: 1, perKm: 12, min: 30 },
    e_rickshaw: { base: 20, baseKm: 1, perKm: 9, min: 25 },
    auto: { base: 30, baseKm: 1, perKm: 13, min: 35 },
    cab: { base: 50, baseKm: 1, perKm: 16, min: 70 }
  }
};

function loadConfig(env = process.env) {
  const config = {
    currency: DEFAULT_CONFIG.currency,
    roadFactor: DEFAULT_CONFIG.roadFactor,
    avgSpeedKmh: DEFAULT_CONFIG.avgSpeedKmh,
    vehicles: { ...DEFAULT_CONFIG.vehicles }
  };
  const raw = env && env.FARE_CONFIG;
  if (raw && String(raw).trim()) {
    let override;
    try {
      override = JSON.parse(raw);
    } catch (e) {
      console.warn('[fare] FARE_CONFIG is not valid JSON, using the default tariffs:', e.message);
      return config;
    }
    if (typeof override.currency === 'string' && override.currency.trim()) config.currency = override.currency.trim();
    if (isPositive(override.roadFactor)) config.roadFactor = Number(override.roadFactor);
    if (isPositive(override.avgSpeedKmh)) config.avgSpeedKmh = Number(override.avgSpeedKmh);
    if (override.vehicles && typeof override.vehicles === 'object') {
      for (const [type, tariff] of Object.entries(override.vehicles)) {
        config.vehicles[normalizeVehicleType(type)] = { ...DEFAULT_CONFIG.vehicles.default, ...config.vehicles[normalizeVehicleType(type)], ...tariff };
      }
    }
  }
  return config;
}

function isPositive(n) {
  return n != null && Number.isFinite(Number(n)) && Number(n) > 0;
}

/** "E Rickshaw", "e-rickshaw", "AUTO" -> "e_rickshaw", "e_rickshaw", "auto". */
function normalizeVehicleType(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in km between two coordinates. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function validCoord(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

/**
 * Estimate distance, duration and fare for a trip.
 * @param {{ pickup: {lat:number,lng:number}, drop: {lat:number,lng:number}, vehicleType?: string, config?: object }} input
 * @returns {{ distance_km:number, duration_min:number, fare:number, currency:string, vehicle_type:string,
 *            fare_basis:'ESTIMATE', breakdown:{ base:number, extra_km:number, per_km:number, extra:number, min:number } }}
 */
function estimateTrip({ pickup, drop, vehicleType, config } = {}) {
  if (!pickup || !drop || !validCoord(pickup.lat, pickup.lng) || !validCoord(drop.lat, drop.lng)) {
    throw new Error('estimateTrip needs numeric pickup and drop coordinates');
  }
  const cfg = config || loadConfig();
  const type = normalizeVehicleType(vehicleType);
  const tariff = cfg.vehicles[type] || cfg.vehicles.default;

  const straightKm = haversineKm(pickup.lat, pickup.lng, drop.lat, drop.lng);
  const distanceKm = round1(straightKm * cfg.roadFactor);
  const durationMin = Math.max(1, Math.ceil((distanceKm / cfg.avgSpeedKmh) * 60));

  const extraKm = Math.max(0, distanceKm - tariff.baseKm);
  const extra = extraKm * tariff.perKm;
  const fare = Math.max(tariff.min, Math.round(tariff.base + extra));

  return {
    distance_km: distanceKm,
    duration_min: durationMin,
    fare,
    currency: cfg.currency,
    vehicle_type: cfg.vehicles[type] ? type : 'default',
    fare_basis: 'ESTIMATE',
    breakdown: {
      base: tariff.base,
      extra_km: round1(extraKm),
      per_km: tariff.perKm,
      extra: Math.round(extra),
      min: tariff.min
    }
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { estimateTrip, haversineKm, normalizeVehicleType, loadConfig, DEFAULT_CONFIG };
