// The driver's demand heatmap: where riders are asking right now, as areas of about a kilometre. Counts only: a single rider is never shown,
// positions are the middle of the area (never a rider's own spot), and nothing identifies anyone.
process.env.JWT_SECRET = 'test-secret-for-heatmap';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const heatmap = require('../lib/heatmap');

const NOW = new Date('2026-10-28T06:30:00Z');
const HERE = { lat: 28.5746, lng: 77.4858 };
const rider = (dLat, dLng, ageSec = 30) => ({ lat: HERE.lat + dLat, lng: HERE.lng + dLng, lastSeen: new Date(NOW.getTime() - ageSec * 1000), userId: `secret-${dLat}-${dLng}` });
const crowd = (n, dLat, dLng) => Array.from({ length: n }, (_, i) => rider(dLat + i * 0.00005, dLng));

test('areas with two or more riders are shown, with a level and an intensity; a single rider is never shown', () => {
  const m = heatmap.buildHeatmap({ riders: [...crowd(6, 0.001, 0.001), ...crowd(3, 0.02, 0.0), ...crowd(1, 0.03, 0.03)], position: HERE, now: NOW });
  assert.equal(m.cells.length, 2, 'the lone rider\'s area is left out');
  const [busy, quieter] = m.cells;
  assert.deepEqual([busy.count, busy.level, busy.intensity], [6, 'HIGH', 1]);
  assert.deepEqual([quieter.count, quieter.level, quieter.intensity], [3, 'GOOD', 0.5]);
  assert.equal(m.maxCount, 6);
});

test('a position is the middle of its area, never a rider\'s own coordinates, and nothing identifies a rider', () => {
  const m = heatmap.buildHeatmap({ riders: crowd(4, 0.0012, 0.0013), position: HERE, now: NOW });
  const cell = m.cells[0];
  const riders = crowd(4, 0.0012, 0.0013);
  for (const r of riders) assert.ok(cell.lat !== r.lat || cell.lng !== r.lng, 'not a rider\'s spot');
  assert.equal(Math.round(cell.lat * 1000) / 1000, Math.round(cell.lat * 1000) / 1000);
  assert.equal(((cell.lat / 0.01) % 1).toFixed(2), '0.50', 'the centre of a 0.01 degree area');
  const text = JSON.stringify(m);
  assert.ok(!text.includes('secret'), 'no rider id');
  assert.ok(!/userId|riderId|phone/.test(text));
});

test('only riders seen in the last five minutes count', () => {
  const m = heatmap.buildHeatmap({ riders: [rider(0, 0, 30), rider(0, 0.0001, 120), rider(0, 0.0002, 290), rider(0, 0.0003, 301), rider(0, 0.0004, 900)], position: HERE, now: NOW });
  assert.equal(m.cells[0].count, 3);
});

test('recent ride requests add to the demand of the area they were made from', () => {
  const m = heatmap.buildHeatmap({ riders: crowd(1, 0, 0), requests: [{ lat: HERE.lat + 0.0001, lng: HERE.lng }, { lat: HERE.lat + 0.0002, lng: HERE.lng }], position: HERE, now: NOW });
  assert.equal(m.cells[0].count, 3);
});

test('only areas within the asked distance of the driver are returned, and the distance is limited', () => {
  const far = crowd(5, 0.2, 0); // about 22 km north
  const m = heatmap.buildHeatmap({ riders: [...crowd(4, 0.001, 0), ...far], position: HERE, radiusKm: 8, now: NOW });
  assert.equal(m.cells.length, 1);
  assert.equal(m.radiusKm, 8);
  assert.equal(heatmap.buildHeatmap({ riders: [], position: HERE, radiusKm: 500, now: NOW }).radiusKm, heatmap.MAX_RADIUS_KM);
  assert.equal(heatmap.buildHeatmap({ riders: [], position: HERE, radiusKm: -3, now: NOW }).radiusKm, heatmap.DEFAULT_RADIUS_KM);
  assert.equal(heatmap.buildHeatmap({ riders: [], position: HERE, now: NOW }).radiusKm, heatmap.DEFAULT_RADIUS_KM);
});

test('the busiest areas come first and the number of areas is limited', () => {
  const riders = [];
  for (let i = 0; i < 80; i += 1) riders.push(...crowd(2 + (i % 5), (i % 9) * 0.0101 - 0.04, Math.floor(i / 9) * 0.0101 - 0.04));
  const m = heatmap.buildHeatmap({ riders, position: HERE, radiusKm: 15, now: NOW });
  assert.ok(m.cells.length <= heatmap.MAX_CELLS);
  for (let i = 1; i < m.cells.length; i += 1) assert.ok(m.cells[i - 1].count >= m.cells[i].count);
});

test('each area carries the rate the demand there would earn, and free drivers already there bring it down', () => {
  const riders = crowd(8, 0.001, 0.001);
  const noDrivers = heatmap.buildHeatmap({ riders, drivers: [], position: HERE, now: NOW }).cells[0];
  assert.deepEqual([noDrivers.drivers, noDrivers.expectedMultiplier], [0, 2.5], 'eight riders and no drivers is the top step');
  const crowded = heatmap.buildHeatmap({ riders, drivers: Array.from({ length: 8 }, () => ({ lat: HERE.lat + 0.001, lng: HERE.lng + 0.001 })), position: HERE, now: NOW }).cells[0];
  assert.deepEqual([crowded.drivers, crowded.expectedMultiplier], [8, 1], 'as many drivers as riders: no surge');
  const quiet = heatmap.buildHeatmap({ riders: crowd(2, 0.001, 0.001), drivers: [], position: HERE, now: NOW }).cells[0];
  assert.equal(quiet.expectedMultiplier, 1, 'a quiet area never surges');
});

test('no riders is an empty map, not an error', () => {
  const m = heatmap.buildHeatmap({ riders: [], requests: [], drivers: [], position: HERE, now: NOW });
  assert.deepEqual([m.cells, m.maxCount], [[], 0]);
  assert.equal(heatmap.buildHeatmap({ riders: null, position: HERE, now: NOW }).cells.length, 0);
});

test('invalid rows are ignored', () => {
  const m = heatmap.buildHeatmap({ riders: [...crowd(3, 0, 0), { lat: 'x', lng: 1, lastSeen: NOW }, null, { lat: 1, lng: 1 }, { lat: HERE.lat, lng: HERE.lng, lastSeen: 'not a date' }], position: HERE, now: NOW });
  assert.equal(m.cells[0].count, 3);
});
