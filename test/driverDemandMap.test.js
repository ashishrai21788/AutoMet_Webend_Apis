// GET /api/v1/driver/summary/demand-map: what a driver sees of demand around them, for their own business only, with counts and no identities.
process.env.JWT_SECRET = 'test-secret-for-demand-map';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const S = require('../controllers/driverSummaryController');
const weather = require('../lib/weather');
const surge = require('../lib/surge');

const HERE = { lat: 28.5746, lng: 77.4858 };
const MODELS = ['Tenant', 'RiderPresence', 'TripDetails', 'User', 'Driver'];
const flush = async () => { for (const m of MODELS) await db[m].find({}); };
let n = 0;
const phone = () => `+9198100${String((n += 1)).padStart(5, '0')}`;

const reset = async () => {
  for (const m of MODELS) db[m].rows.length = 0;
  await flush();
  weather.clearWeatherCache(); weather.useProvider(null); surge.clearSurgeCache();
  for (const id of ['t1', 't2']) await db.Tenant.create({ tenantId: id, name: id, slug: id, appName: id, packageName: `in.${id}`, isDefault: id === 't1' });
};
const presence = (i, tenantId, dLat = 0.001, dLng = 0.001, ageSec = 20) => db.RiderPresence.create({ userId: `U${tenantId}${i}`, tenantId, lat: HERE.lat + dLat + i * 0.00005, lng: HERE.lng + dLng, lastSeen: new Date(Date.now() - ageSec * 1000) });
const driver = (id, tenantId, over = {}) => db.Driver.create({ driverId: id, tenantId, phone: phone(), email: `${id}@t.test`, isOnline: true, lastLocation: { type: 'Point', coordinates: [HERE.lng, HERE.lat] }, locationUpdatedAt: new Date(), ...over });

const call = async ({ driverId = 'D1', tenant = 't1', query = {} } = {}) => {
  const ownDriver = await db.Driver.findOne({ driverId }).lean();
  const business = JSON.parse(JSON.stringify(await db.Tenant.findOne({ tenantId: tenant }).lean()));
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await S.demandMap({ ownDriver, business, query, params: {}, headers: {}, ip: '1.1.1.1' }, res);
  return out;
};

test('the driver sees the busy areas around where they are, counts only', async () => {
  await reset();
  await driver('D1', 't1');
  for (let i = 0; i < 5; i += 1) await presence(i, 't1');
  await presence(9, 't1', 0.04, 0.04); // a lone rider elsewhere
  const r = await call();
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.cells.length, 1, 'a single rider is not shown');
  assert.deepEqual([r.body.data.cells[0].count, r.body.data.cells[0].level], [5, 'GOOD']);
  assert.deepEqual(r.body.data.center, HERE, 'centred on the driver\'s own last position');
  const text = JSON.stringify(r.body);
  assert.ok(!/userId|riderId|Ut1/.test(text), 'nothing identifies a rider');
});

test('only this business\'s riders, requests and drivers are read', async () => {
  await reset();
  await driver('D1', 't1'); await driver('Y1', 't2');
  for (let i = 0; i < 4; i += 1) await presence(i, 't2'); // plenty of demand, but in another business
  assert.deepEqual((await call()).body.data.cells, [], 'the other business\'s riders are invisible');
  for (let i = 0; i < 4; i += 1) await presence(i, 't1');
  const mine = await call();
  assert.equal(mine.body.data.cells[0].count, 4);
  assert.equal(mine.body.data.cells[0].drivers, 1, 'only this business\'s online driver counts as supply (the other business\'s does not)');
  const theirs = await call({ driverId: 'Y1', tenant: 't2' });
  assert.equal(theirs.body.data.cells[0].count, 4);
  assert.equal(theirs.body.data.cells[0].drivers, 1);
});

test('requests made recently add to the demand, and old riders do not', async () => {
  await reset();
  await driver('D1', 't1');
  await presence(0, 't1', 0.001, 0.001, 20); await presence(1, 't1', 0.001, 0.001, 600);
  for (let i = 0; i < 2; i += 1) await db.TripDetails.create({ trip_id: `T${i}`, request_id: `R${i}`, tenant_id: 't1', user_id: `X${i}`, status: 'REQUESTED', timeout_at: new Date(), requested_at: new Date(), pickup: { address: 'a', lat: HERE.lat + 0.001, lng: HERE.lng + 0.001 }, drop: { address: 'b', lat: HERE.lat + 0.05, lng: HERE.lng } });
  const r = await call();
  assert.equal(r.body.data.cells[0].count, 3, 'one fresh rider and two requests; the ten-minute-old rider is gone');
});

test('a driver already on a ride is not counted as supply, so the area looks more in need', async () => {
  await reset();
  await driver('D1', 't1'); await driver('D2', 't1');
  for (let i = 0; i < 8; i += 1) await presence(i, 't1');
  await db.TripDetails.create({ trip_id: 'T1', request_id: 'R1', tenant_id: 't1', user_id: 'X', driver_id: 'D2', status: 'ON_GOING', timeout_at: new Date(), pickup: { address: 'a', lat: HERE.lat, lng: HERE.lng }, drop: { address: 'b', lat: HERE.lat + 0.05, lng: HERE.lng } });
  const c = (await call()).body.data.cells[0];
  assert.deepEqual([c.drivers, c.expectedMultiplier], [1, 2.5]);
});

test('the driver\'s position can be sent, must be a real position, and is needed when the driver has none', async () => {
  await reset();
  await driver('D1', 't1', { lastLocation: null, locationUpdatedAt: null });
  const none = await call();
  assert.equal(none.code, 409);
  assert.match(none.body.message, /location is not available/);
  for (const bad of [{ lat: 'x', lng: '77' }, { lat: '95', lng: '77' }, { lat: '28', lng: '200' }, { lat: '', lng: '' }, { lat: '28' }]) assert.equal((await call({ query: bad })).code, 400, JSON.stringify(bad));
  for (let i = 0; i < 3; i += 1) await presence(i, 't1');
  const sent = await call({ query: { lat: String(HERE.lat), lng: String(HERE.lng), radius_km: '3' } });
  assert.equal(sent.code, 200);
  assert.deepEqual([sent.body.data.radiusKm, sent.body.data.cells[0].count], [3, 3]);
  assert.equal((await call({ query: { lat: String(HERE.lat), lng: String(HERE.lng), radius_km: '900' } })).body.data.radiusKm, 15, 'the distance is limited');
});

test('the weather is shown only when the business uses weather pricing, with what it adds to fares; an outage shows as unavailable', async () => {
  await reset();
  await driver('D1', 't1');
  assert.equal((await call()).body.data.weather, null, 'weather pricing off: nothing to show');
  await db.Tenant.findOneAndUpdate({ tenantId: 't1' }, { $set: { weatherPricing: { enabled: true, multipliers: { HEAVY_RAIN: 1.3 }, maxMultiplier: 1.5 } } });
  weather.useProvider({ name: 'test', fetchCurrent: async () => ({ code: 65, precipitationMm: 9, tempC: 24 }) });
  const rain = (await call()).body.data.weather;
  assert.deepEqual([rain.available, rain.condition, rain.label, rain.multiplier], [true, 'HEAVY_RAIN', 'Heavy rain', 1.3]);
  weather.clearWeatherCache();
  weather.useProvider({ name: 'test', fetchCurrent: async () => { throw new Error('down'); } });
  const down = (await call()).body.data.weather;
  assert.deepEqual([down.available, down.multiplier], [false, 1]);
});

test('whether surge is paused is reported, so the driver knows rate hints are off', async () => {
  await reset();
  await driver('D1', 't1');
  assert.equal((await call()).body.data.surgePaused, false);
  await db.Tenant.findOneAndUpdate({ tenantId: 't1' }, { $set: { surgeSettings: { paused: true } } });
  assert.equal((await call()).body.data.surgePaused, true);
});
