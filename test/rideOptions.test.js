// Ride options: the ride types a rider can book for a trip, from what the business set in the admin dashboard.
// In-memory stand-ins for the database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-ride-options-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
const { rideOptions } = require('../controllers/tripsController');
const { rankCandidates } = require('../lib/dispatch');

const NOW = new Date();
const PICKUP = { lat: 28.57, lng: 77.48 };
const north = (km) => ({ type: 'Point', coordinates: [PICKUP.lng, PICKUP.lat + km / 111.2] });

const driver = (id, km, extra = {}) => ({
  driverId: id, email: id + '@t.local', isOnline: true, accountStatus: 'ACTIVE', tenantId: 't1',
  lastLocation: north(km), locationUpdatedAt: new Date(NOW.getTime() - 3000), ...extra
});

const run = async (body) => {
  let out;
  const res = { status(code) { this.code = code; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await rideOptions({ body, user: { userId: 'u1', tenantId: 't1' }, appTenant: null }, res);
  return out;
};
const rule = (categoryId, perKm) => ({
  ruleId: 'r_' + categoryId, tenantId: 't1', categoryId, regionId: null, regionKey: 'default', currency: 'INR',
  baseFare: 20, perKm, perMinute: 1, minimumFare: 30, bookingFee: 0, waitingFreeMinutes: 3, waitingPerMinute: 1,
  additionalCharges: [], taxes: [], surge: { enabled: false, maxMultiplier: 1 }, active: true
});

const seed = async () => {
  for (const m of [db.Tenant, db.ServiceRegion, db.VehicleCategory, db.FareRule, db.Driver, db.TripDetails]) m.rows.length = 0;
  await db.Tenant.create({ tenantId: 't1', name: 'Biz', isDefault: true, market: { country: 'IN', currency: 'INR' } });
  await db.ServiceRegion.create({
    tenantId: 't1', regionId: 'rg1', country: 'IN', state: 'UP', city: 'Noida', zoneName: 'All', key: 'up|noida|all',
    center: { lat: PICKUP.lat, lng: PICKUP.lng }, radiusKm: 15, active: true
  });
  await db.VehicleCategory.create({ tenantId: 't1', categoryId: 'c_auto', name: 'Auto', nameKey: 'auto', passengerCapacity: 3, rideType: 'economy', regionIds: ['rg1'], active: true });
  await db.VehicleCategory.create({ tenantId: 't1', categoryId: 'c_cab', name: 'Cab', nameKey: 'cab', passengerCapacity: 4, rideType: 'economy', regionIds: ['rg1'], active: true });
  await db.VehicleCategory.create({ tenantId: 't1', categoryId: 'c_far', name: 'Far', nameKey: 'far', passengerCapacity: 4, rideType: 'economy', regionIds: ['rg_other'], active: true });
  await db.FareRule.create(rule('c_auto', 8));
  await db.FareRule.create(rule('c_cab', 14));
  await db.Driver.create(driver('d_auto', 1, { eligibleCategoryId: 'c_auto' }));
  await db.Driver.create(driver('d_cab1', 2, { eligibleCategoryId: 'c_cab' }));
  await db.Driver.create(driver('d_cab2', 3, { eligibleCategoryId: 'c_cab' }));
};
const trip = { pickup_latitude: PICKUP.lat, pickup_longitude: PICKUP.lng, drop_latitude: PICKUP.lat + 0.05, drop_longitude: PICKUP.lng + 0.02 };

test('rankCandidates filters by category, falling back to the reported vehicle type for drivers with none set', () => {
  const drivers = [
    driver('a', 1, { eligibleCategoryId: 'c_auto' }),
    driver('b', 1, { eligibleCategoryId: 'c_cab' }),
    driver('legacy', 1, { vehicleType: 'auto' })
  ];
  const ranked = rankCandidates(drivers, PICKUP, { categoryId: 'c_auto', categoryName: 'Auto', now: NOW });
  assert.deepEqual(ranked.map((r) => r.driver.driverId).sort(), ['a', 'legacy']);
});

test('offers only the categories of the pickup region, each priced, with nearby drivers and ETA', async () => {
  await seed();
  const { code, body } = await run(trip);
  assert.equal(code, 200);
  assert.equal(body.data.service_available, true);
  assert.equal(body.data.region.city, 'Noida');
  const byId = Object.fromEntries(body.data.options.map((o) => [o.category_id, o]));
  assert.deepEqual(Object.keys(byId).sort(), ['c_auto', 'c_cab']); // c_far is offered in another region
  assert.equal(byId.c_auto.drivers_nearby, 1);
  assert.equal(byId.c_cab.drivers_nearby, 2);
  assert.ok(byId.c_cab.fare > byId.c_auto.fare, 'the cab rule is dearer per km');
  assert.ok(byId.c_auto.eta_min >= 1);
  assert.equal(byId.c_auto.available, true);
  assert.equal(body.data.currency, 'INR');
});

test('a category with no priced rule is not offered', async () => {
  await seed();
  db.FareRule.rows.length = 0;
  await db.FareRule.create(rule('c_cab', 14));
  const { body } = await run(trip);
  assert.deepEqual(body.data.options.map((o) => o.category_id), ['c_cab']);
});

test('a busy driver does not count as nearby', async () => {
  await seed();
  await db.TripDetails.create({ trip_id: 'amt_b', request_id: 'RB', user_id: 'u9', driver_id: 'd_auto', status: 'ON_GOING', pickup: {}, drop: {} });
  const { body } = await run(trip);
  const auto = body.data.options.find((o) => o.category_id === 'c_auto');
  assert.equal(auto.drivers_nearby, 0);
  assert.equal(auto.available, false);
  assert.equal(auto.eta_min, null);
});

test('a pickup outside every service region reports the service as unavailable', async () => {
  await seed();
  const { code, body } = await run({ ...trip, pickup_latitude: 19.07, pickup_longitude: 72.87 });
  assert.equal(code, 200);
  assert.equal(body.data.service_available, false);
  assert.equal(body.data.reason, 'OUTSIDE_SERVICE_AREA');
  assert.deepEqual(body.data.options, []);
});

test('invalid coordinates are refused', async () => {
  const { code } = await run({ pickup_latitude: 'x' });
  assert.equal(code, 400);
});

test('a driver whose app has not sent a position yet is offered as available, without an ETA', async () => {
  await seed();
  db.Driver.rows.length = 0;
  await db.Driver.create({ driverId: 'd_old', email: 'old@t.local', isOnline: true, accountStatus: 'ACTIVE', tenantId: 't1', eligibleCategoryId: 'c_auto' });
  const { body } = await run(trip);
  const auto = body.data.options.find((o) => o.category_id === 'c_auto');
  assert.equal(auto.available, true);
  assert.equal(auto.drivers_nearby, 1);
  assert.equal(auto.eta_min, null);
});
