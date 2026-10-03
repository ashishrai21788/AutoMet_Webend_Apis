// Run with: node test/fare.test.js   (or: npm test)
const assert = require('assert');
const { estimateTrip, haversineKm, normalizeVehicleType, loadConfig } = require('../lib/fare');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// Real coordinates from the live test trip: pickup Vaidpura (Greater Noida), drop Sahibabad Industrial Area.
const pickup = { lat: 28.5746, lng: 77.4858 };
const drop = { lat: 28.6533, lng: 77.3599 };

test('haversine: same point is 0 km', () => assert.strictEqual(haversineKm(10, 20, 10, 20), 0));
test('haversine: 1 degree of latitude is ~111 km', () => {
  const d = haversineKm(0, 0, 1, 0);
  assert.ok(d > 110.5 && d < 111.8, `got ${d}`);
});
test('haversine is symmetric', () => {
  assert.ok(Math.abs(haversineKm(pickup.lat, pickup.lng, drop.lat, drop.lng) - haversineKm(drop.lat, drop.lng, pickup.lat, pickup.lng)) < 1e-9);
});

test('vehicle type normalization', () => {
  assert.strictEqual(normalizeVehicleType('E Rickshaw'), 'e_rickshaw');
  assert.strictEqual(normalizeVehicleType('e-rickshaw'), 'e_rickshaw');
  assert.strictEqual(normalizeVehicleType(' AUTO '), 'auto');
  assert.strictEqual(normalizeVehicleType(null), '');
});

test('the live test trip is a realistic length (not the 2.1 km / 4.2 km placeholders)', () => {
  const t = estimateTrip({ pickup, drop, vehicleType: 'auto' });
  assert.ok(t.distance_km > 15 && t.distance_km < 30, `distance ${t.distance_km}`);
  assert.ok(t.duration_min > 30 && t.duration_min < 90, `duration ${t.duration_min}`);
  assert.ok(t.fare > 100, `fare ${t.fare}`);
  assert.strictEqual(t.currency, 'INR');
  assert.strictEqual(t.fare_basis, 'ESTIMATE');
});

test('fare formula: base + extra km, rounded to a whole rupee', () => {
  const cfg = { currency: 'INR', roadFactor: 1, avgSpeedKmh: 20, vehicles: { default: { base: 30, baseKm: 1, perKm: 10, min: 30 } } };
  // ~11.1 km straight line (0.1 degree of latitude), road factor 1 -> 11.1 km; 30 + (11.1-1)*10 = 131
  const t = estimateTrip({ pickup: { lat: 0, lng: 0 }, drop: { lat: 0.1, lng: 0 }, config: cfg });
  assert.strictEqual(t.distance_km, 11.1);
  assert.strictEqual(t.fare, 131);
  assert.strictEqual(t.duration_min, 34); // ceil(11.1 / 20 * 60) = 34
});

test('minimum fare applies to very short trips', () => {
  const cfg = { currency: 'INR', roadFactor: 1.3, avgSpeedKmh: 22, vehicles: { default: { base: 25, baseKm: 1, perKm: 12, min: 40 } } };
  const t = estimateTrip({ pickup: { lat: 28.5746, lng: 77.4858 }, drop: { lat: 28.5747, lng: 77.4858 }, config: cfg });
  assert.strictEqual(t.fare, 40);
  assert.ok(t.duration_min >= 1);
});

test('unknown vehicle types fall back to the default tariff', () => {
  const t = estimateTrip({ pickup, drop, vehicleType: 'hoverboard' });
  assert.strictEqual(t.vehicle_type, 'default');
});

test('cab costs more than e-rickshaw for the same trip', () => {
  const cab = estimateTrip({ pickup, drop, vehicleType: 'cab' }).fare;
  const erick = estimateTrip({ pickup, drop, vehicleType: 'e_rickshaw' }).fare;
  assert.ok(cab > erick, `${cab} vs ${erick}`);
});

test('FARE_CONFIG overrides tariffs and keeps unspecified defaults', () => {
  const cfg = loadConfig({ FARE_CONFIG: JSON.stringify({ currency: 'USD', vehicles: { auto: { perKm: 100 } } }) });
  assert.strictEqual(cfg.currency, 'USD');
  assert.strictEqual(cfg.vehicles.auto.perKm, 100);
  assert.strictEqual(cfg.vehicles.auto.base, 30);           // kept from the defaults
  assert.strictEqual(cfg.vehicles.e_rickshaw.perKm, 9);     // other vehicle untouched
});

test('invalid FARE_CONFIG falls back to the defaults instead of crashing', () => {
  const cfg = loadConfig({ FARE_CONFIG: '{not json' });
  assert.strictEqual(cfg.currency, 'INR');
});

test('bad coordinates are rejected', () => {
  assert.throws(() => estimateTrip({ pickup: { lat: 'x', lng: 1 }, drop }), /coordinates/);
  assert.throws(() => estimateTrip({ pickup: { lat: 91, lng: 0 }, drop }), /coordinates/);
  assert.throws(() => estimateTrip({}), /coordinates/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
