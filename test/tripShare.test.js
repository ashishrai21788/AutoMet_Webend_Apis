// Sharing a ride: the public view shows only what a follower needs, and expires after the ride.
process.env.JWT_SECRET = 'test-secret-for-trip-share';
const test = require('node:test');
const assert = require('node:assert/strict');
const share = require('../lib/tripShare');

const NOW = new Date('2026-10-15T12:00:00Z');
const trip = (over = {}) => ({
  trip_id: 'amt_1', user_id: 'u1', driver_id: 'd1', status: 'DRIVER_ON_THE_WAY',
  pickup: { address: 'Vaidpura, Greater Noida', lat: 28.57, lng: 77.48 },
  drop: { address: 'Gaur City Mall, Dadri', lat: 28.6, lng: 77.5 },
  fare: 335, distance_km: 8.5, estimated_duration_min: 24, start_otp: '7391', updated_at: new Date(NOW.getTime() - 60000), ...over
});
const driver = (over = {}) => ({
  driverId: 'd1', firstName: 'Ramesh', lastName: 'Kumar', phone: '+919999999999', email: 'r@x.test', rating: 4.8, totalRides: 256,
  vehicleNumber: 'UP16AB1234', vehicleModel: 'Bajaj RE', vehicleColor: 'Green', vehicleType: 'Auto',
  profilePhoto: 'https://cdn.test/r.png', accessToken: 'secret', fcmToken: 'secret',
  lastLocation: { type: 'Point', coordinates: [77.49, 28.58] }, locationUpdatedAt: new Date(NOW.getTime() - 3000), locationHeading: 90, isOnline: true,
  ...over
});

test('tokens are 32 hex characters and validated strictly', () => {
  const t = share.newToken();
  assert.match(t, /^[a-f0-9]{32}$/);
  assert.ok(share.isToken(t));
  for (const bad of ['', 'abc', 'x'.repeat(32), '../etc/passwd', t + 'a', null, undefined]) assert.equal(share.isToken(bad), false);
  assert.notEqual(share.newToken(), share.newToken());
});

test('a live ride shows driver, vehicle, route, position and arrival, and nothing private', () => {
  const v = share.publicView(trip(), driver(), 'uRide', NOW);
  assert.equal(v.live, true);
  assert.equal(v.title, 'Driver is on the way');
  assert.equal(v.driver.firstName, 'Ramesh');
  assert.equal(v.driver.vehicleNumber, 'UP16AB1234');
  assert.equal(v.location.lat, 28.58);
  assert.ok(v.eta.minutes >= 1);
  assert.equal(v.eta.to, 'PICKUP');
  const text = JSON.stringify(v);
  for (const secret of ['+919999999999', 'r@x.test', 'secret', 'Kumar', '"u1"', '"d1"', '7391', '"fare"', 'accessToken', 'phone', 'email']) {
    assert.ok(!text.includes(secret), 'must not contain ' + secret);
  }
});

test('the arrival time points at the drop once the ride is in progress; none when arrived', () => {
  assert.equal(share.publicView(trip({ status: 'ON_GOING' }), driver(), 'uRide', NOW).eta.to, 'DROP');
  assert.equal(share.publicView(trip({ status: 'ARRIVED' }), driver(), 'uRide', NOW).eta, null);
  assert.equal(share.publicView(trip({ status: 'ARRIVED' }), driver(), 'uRide', NOW).title, 'Driver has arrived');
});

test('an ended ride shows no live position, and the link expires after two hours', () => {
  const done = share.publicView(trip({ status: 'COMPLETED' }), driver(), 'uRide', NOW);
  assert.equal(done.live, false);
  assert.equal(done.location, null);
  assert.equal(done.step, 'COMPLETED');
  const old = trip({ status: 'COMPLETED', updated_at: new Date(NOW.getTime() - 3 * 3600 * 1000) });
  assert.equal(share.publicView(old, driver(), 'uRide', NOW), null);
  assert.equal(share.publicView(null, null, null, NOW), null);
});

test('a driver without a position or photo link is handled', () => {
  const v = share.publicView(trip(), driver({ lastLocation: null, profilePhoto: 'http://insecure/x.png', rating: 0 }), null, NOW);
  assert.equal(v.location, null);
  assert.equal(v.eta, null);
  assert.equal(v.driver.photo, null);
  assert.equal(v.driver.rating, null);
});
