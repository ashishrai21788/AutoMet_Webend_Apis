// Ride sharing endpoints: the rider creates a link for their own live ride; anyone with the link sees a small, sanitised, live view.
// The pure view rules are in tripShare.test.js; this covers who may create a link and what the unauthenticated endpoint will and will not say.
process.env.JWT_SECRET = 'test-secret-for-share';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const shareController = require('../controllers/shareController');

const reset = async (tripOver = {}) => {
  for (const m of ['Tenant', 'TripDetails', 'User', 'Driver']) db[m].rows.length = 0;
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', slug: 'uride', appName: 'uRide', packageName: 'in.uride', isDefault: true });
  await db.User.create({ userId: 'U1', firstName: 'Asha', phone: '+919800000001', email: 'asha@t.test', tenantId: 't1' });
  await db.User.create({ userId: 'U2', firstName: 'Bina', phone: '+919800000009', tenantId: 't1' });
  await db.Driver.create({
    driverId: 'D1', firstName: 'Ravi', lastName: 'Secret', phone: '+919800000002', email: 'ravi@t.test', tenantId: 't1', accessToken: 'driver-jwt', fcmToken: 'fcm-secret',
    vehicleNumber: 'UP16TS4321', vehicleModel: 'Dzire', location: { lat: 28.58, lng: 77.34 }, locationUpdatedAt: new Date(), isOnline: true
  });
  await db.TripDetails.create({
    trip_id: 'T1', request_id: 'R1', tenant_id: 't1', user_id: 'U1', driver_id: 'D1', status: 'ON_GOING', fare: 98765, start_otp: '4455', timeout_at: new Date(),
    pickup: { address: 'Sector 62, Noida', lat: 28.57, lng: 77.35 }, drop: { address: 'Connaught Place', lat: 28.63, lng: 77.21 }, ...tripOver
  });
};

const call = async (fn, { body = {}, params = {}, actor = 'U1' } = {}) => {
  const req = { authActorId: actor, body, params, headers: {}, protocol: 'https', get: () => 'api.example.test', ip: '1.1.1.1' };
  let out; const headers = {};
  const res = { code: 200, status(c) { this.code = c; return this; }, setHeader(k, v) { headers[k] = v; }, json(b) { out = { code: this.code, body: b, headers }; return this; } };
  await fn(req, res);
  return out;
};
const create = (opts) => call(shareController.createShare, opts);
const track = (token) => call(shareController.publicTrack, { params: { token }, actor: null });

test('creating a link needs a trip id, an existing ride, and the rider\'s own ride', async () => {
  await reset();
  assert.equal((await create({ body: {} })).code, 400);
  assert.equal((await create({ body: { trip_id: 'NOPE' } })).code, 404);
  const other = await create({ body: { trip_id: 'T1' }, actor: 'U2' });
  assert.equal(other.code, 403, 'another rider cannot create a link to this ride');
  assert.ok(!db.TripDetails.rows[0].share_token, 'and no token was stored by the refused attempt');
});

test('a link is refused before a driver has accepted and after the ride has ended', async () => {
  await reset({ status: 'REQUESTED' });
  assert.equal((await create({ body: { trip_id: 'T1' } })).code, 409);
  for (const status of ['COMPLETED', 'CANCELLED_BY_USER', 'CANCELLED_BY_DRIVER', 'NO_RESPONSE']) {
    await reset({ status });
    assert.equal((await create({ body: { trip_id: 'T1' } })).code, 409, status);
  }
});

test('a live ride gets a random 32-character link built on the public address, and asking again gives the same link', async () => {
  await reset();
  const first = await create({ body: { trip_id: 'T1' } });
  assert.equal(first.code, 200, JSON.stringify(first.body));
  assert.match(first.body.data.token, /^[a-f0-9]{32}$/);
  assert.equal(first.body.data.url, `https://api.example.test/t/${first.body.data.token}`);
  const again = await create({ body: { trip_id: 'T1' } });
  assert.equal(again.body.data.token, first.body.data.token);
  await reset();
  const other = await create({ body: { trip_id: 'T1' } });
  assert.notEqual(other.body.data.token, first.body.data.token, 'tokens are random, not derived from the trip');
});

test('the public view works with the link alone, is never cached, and carries nothing private', async () => {
  await reset();
  const token = (await create({ body: { trip_id: 'T1' } })).body.data.token;
  const r = await track(token);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.body.data.driver.firstName, 'Ravi');
  assert.equal(r.body.data.pickup.address, 'Sector 62, Noida');
  const text = JSON.stringify(r.body);
  for (const secret of ['+919800000002', '+919800000001', 'ravi@t.test', 'asha@t.test', 'driver-jwt', 'fcm-secret', '4455', 'Secret', 'U1', 'D1', 'R1', '98765']) {
    assert.ok(!text.includes(secret), `the public view must not contain ${secret}`);
  }
});

test('a link that is not a token, or is a token nobody holds, says only that it is not valid (no hint which)', async () => {
  await reset();
  for (const bad of ['', 'short', 'x'.repeat(32), 'g'.repeat(32), '../../etc/passwd', 'T1', 'U1']) {
    const r = await track(bad);
    assert.equal(r.code, 404, bad);
    assert.equal(r.body.message, 'This link is not valid');
  }
  const unknown = await track('a'.repeat(32));
  assert.equal(unknown.code, 404);
  assert.equal(unknown.body.message, 'This link is not valid');
});

test('the link stops working two hours after the ride ended', async () => {
  await reset();
  const token = (await create({ body: { trip_id: 'T1' } })).body.data.token;
  const t = db.TripDetails.rows[0];
  t.status = 'COMPLETED';
  t.updated_at = new Date(Date.now() - 60 * 60 * 1000);
  assert.equal((await track(token)).code, 200, 'an hour after: still shows the finished ride');
  t.updated_at = new Date(Date.now() - 3 * 60 * 60 * 1000);
  assert.equal((await track(token)).code, 410, 'three hours after: expired');
});
