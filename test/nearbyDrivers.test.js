// Nearby drivers for the rider's map: positions only, no identity, only drivers who could be offered a ride.
// In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-nearby-drivers';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
const { nearbyDrivers } = require('../controllers/tripsController');

const NOW = new Date();
const CENTRE = { lat: 28.57, lng: 77.48 };
const at = (km) => ({ type: 'Point', coordinates: [CENTRE.lng, CENTRE.lat + km / 111.2] });
const driver = (id, km, extra = {}) => ({
  driverId: id, email: id + '@t.local', isOnline: true, accountStatus: 'ACTIVE', tenantId: 't1',
  lastLocation: at(km), locationUpdatedAt: new Date(NOW.getTime() - 3000), locationHeading: 90, eligibleCategoryId: 'c1', vehicleType: 'VIP',
  ...extra
});

const run = async (body) => {
  let out;
  const res = { status(code) { this.code = code; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await nearbyDrivers({ body, user: { userId: 'u1', tenantId: 't1' }, appTenant: null }, res);
  return out;
};

const seed = async () => {
  for (const m of ['Tenant', 'Driver', 'TripDetails']) db[m].rows.length = 0;
  await db.Tenant.create({ tenantId: 't1', name: 'Biz', isDefault: true, market: { country: 'IN', currency: 'INR' } });
};

test('only available drivers of the rider\'s business near the point are returned, without identity', async () => {
  await seed();
  await db.Driver.create(driver('near', 1));
  await db.Driver.create(driver('far', 30)); // outside the dispatch radius
  await db.Driver.create(driver('offline', 1, { isOnline: false }));
  await db.Driver.create(driver('stale', 1, { locationUpdatedAt: new Date(NOW.getTime() - 3600 * 1000) }));
  await db.Driver.create(driver('busy', 2));
  await db.TripDetails.create({ trip_id: 'amt_1', request_id: 'R1', user_id: 'u9', driver_id: 'busy', status: 'ON_GOING', pickup: {}, drop: {} });
  await db.Driver.create(driver('other', 1, { tenantId: 't2' }));

  const r = await run({ latitude: CENTRE.lat, longitude: CENTRE.lng });
  assert.equal(r.code, 200);
  assert.equal(r.body.data.count, 1);
  const v = r.body.data.vehicles[0];
  assert.equal(v.vehicle_type, 'VIP');
  assert.equal(v.heading, 90);
  assert.ok(v.distance_km <= 1.5);
  const text = JSON.stringify(r.body);
  for (const secret of ['near', 'driverId', 'email', 'phone', 'busy', 'other']) assert.ok(!text.includes(`"${secret}"`) || secret === 'near', secret);
  assert.equal(Object.keys(v).sort().join(','), 'category_id,distance_km,heading,lat,lng,map_icon_url,vehicle_type');
});

test('a driver whose app has not reported a position is not drawn', async () => {
  await seed();
  await db.Driver.create({ driverId: 'old', email: 'o@t.local', isOnline: true, accountStatus: 'ACTIVE', tenantId: 't1', eligibleCategoryId: 'c1' });
  const r = await run({ latitude: CENTRE.lat, longitude: CENTRE.lng });
  assert.equal(r.body.data.count, 0);
});

test('at most thirty vehicles, nearest first', async () => {
  await seed();
  for (let i = 0; i < 40; i++) await db.Driver.create(driver('d' + i, 0.05 * (i + 1)));
  const r = await run({ latitude: CENTRE.lat, longitude: CENTRE.lng });
  assert.equal(r.body.data.count, 30);
  const d = r.body.data.vehicles.map((x) => x.distance_km);
  assert.deepEqual([...d].sort((a, b) => a - b), d);
});

test('invalid coordinates are refused', async () => {
  assert.equal((await run({ latitude: 'x', longitude: 1 })).code, 400);
  assert.equal((await run({})).code, 400);
});

test('radius_km narrows what is drawn and is clamped', async () => {
  await seed();
  await db.Driver.create(driver('a', 0.4));
  await db.Driver.create(driver('b', 3));
  let r = await run({ latitude: CENTRE.lat, longitude: CENTRE.lng, radius_km: 1 });
  assert.equal(r.body.data.count, 1);
  r = await run({ latitude: CENTRE.lat, longitude: CENTRE.lng, radius_km: 99 });
  assert.equal(r.body.data.count, 2);
});
