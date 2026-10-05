/**
 * The ride lifecycle across both apps: fare estimate, request, push to the driver, accept / reject / cancel, status updates
 * through completion, and the active / details / timeline reads. Pushes are captured by the test server's Firebase recorder.
 */
const { configuredBusiness, driverSignIn } = require('./common');

module.exports = async function ride(t) {
  const { call, peek, alias, recordPushes } = t;
  const ctx = await configuredBusiness(t);
  const { driverId } = ctx;

  // the rider: register and verify (the rider scenario covers this flow in detail)
  const reg = await call('rider: register', { method: 'POST', path: '/api/users/register', body: { name: 'Rae Rider', phone: '+919800000001', email: 'rae@contract.test' }, expectStatus: 201 });
  const userId = reg.body.data.user.userId;
  alias(userId, 'userId');
  const otp = (await peek('users_otp', { userId, isUsed: false })).otp;
  alias(otp, 'riderOtp');
  const ver = await call('rider: verify OTP', { method: 'POST', path: '/api/users/verify-otp', body: { userId, otp, device_id: 'rider-device-1', fcm_id: 'rider-fcm-1' }, expectStatus: 200 });
  const riderToken = ver.body.data.accessToken || (ver.body.data.user && ver.body.data.user.accessToken);

  // the driver: sign in, go online, and send a position (a driver with no recent position is "unreachable")
  const driverToken = await driverSignIn(t, { driverId, phone: ctx.driverPhone });
  // pricing uses the vehicle type the driver app stores on the driver (it must name one of the business's categories)
  await call('driver: vehicle details', { method: 'PUT', path: '/api/drivers/vehicle-details', body: { driverId, vehicleType: 'Sedan', vehicleNumber: 'MH12AB1234', vehicleModel: 'Dzire', isVehicleAdded: true }, token: driverToken, expectStatus: 200 });
  await call('driver: go online', { method: 'PUT', path: '/api/drivers/online-status', body: { driverId, isOnline: true, onlineAs: 0 }, token: driverToken, expectStatus: 200 });
  await call('driver: position', { method: 'POST', path: '/api/drivers/location', body: { driverId, lat: 18.5204, lng: 73.8567, accuracy: 10 }, token: driverToken, expectStatus: 200 });
  recordPushes('before any ride: nothing pushed yet');

  const trip = (n, extra = {}) => ({
    request_id: `req-contract-${n}`, user_id: userId, driver_id: driverId,
    pickup_address: 'Shivajinagar, Pune', pickup_latitude: 18.5314, pickup_longitude: 73.8446,
    drop_address: 'Hinjewadi, Pune', drop_latitude: 18.5912, drop_longitude: 73.7389, ride_note: 'Two bags', ...extra
  });
  const area = { pickup_latitude: 18.5314, pickup_longitude: 73.8446, drop_latitude: 18.5912, drop_longitude: 73.7389 };

  // ---- estimates
  await call('estimate: no session', { method: 'POST', path: '/api/v1/trips/estimate', body: area, expectStatus: 401 });
  await call('estimate: bad coordinates', { method: 'POST', path: '/api/v1/trips/estimate', body: { ...area, pickup_latitude: 120 }, token: riderToken, expectStatus: 400 });
  await call('estimate: for a driver', { method: 'POST', path: '/api/v1/trips/estimate', body: { ...area, driver_id: driverId }, token: riderToken });
  await call('estimate: for a category', { method: 'POST', path: '/api/v1/trips/estimate', body: { ...area, category_id: ctx.categoryId }, token: riderToken });
  await call('estimate: outside every service area', { method: 'POST', path: '/api/v1/trips/estimate', body: { pickup_latitude: 28.61, pickup_longitude: 77.2, drop_latitude: 28.7, drop_longitude: 77.1, category_id: ctx.categoryId }, token: riderToken });

  // ---- request validation
  await call('request: missing fields', { method: 'POST', path: '/api/v1/trips/create-request', body: { user_id: userId }, token: riderToken, expectStatus: 400 });
  await call('request: same pickup and drop', { method: 'POST', path: '/api/v1/trips/create-request', body: trip(0, { drop_latitude: 18.5314, drop_longitude: 73.8446 }), token: riderToken, expectStatus: 400 });
  await call('request: unknown driver', { method: 'POST', path: '/api/v1/trips/create-request', body: trip(0, { driver_id: '1111111111' }), token: riderToken });
  await call('request: acting as another rider is refused', { method: 'POST', path: '/api/v1/trips/create-request', body: trip(0, { user_id: '2222222222' }), token: riderToken });

  // ---- ride 1: accepted and completed
  const r1 = await call('ride 1: request', { method: 'POST', path: '/api/v1/trips/create-request', body: trip(1), token: riderToken });
  const tripId = r1.body.data && r1.body.data.trip_id;
  recordPushes('ride 1: the driver is pushed the request');
  await call('ride 1: a second request to the same driver', { method: 'POST', path: '/api/v1/trips/create-request', body: trip(2), token: riderToken });
  await call('ride 1: rider active ride', { path: `/api/v1/rides/active?user_id=${userId}`, token: riderToken });
  await call('ride 1: driver active ride', { path: `/api/v1/rides/active?driver_id=${driverId}`, token: driverToken });
  await call('ride 1: details before accept', { path: `/api/v1/rides/details?trip_id=${tripId}&user_id=${userId}`, token: riderToken });
  await call('ride 1: driver responds with a bad value', { method: 'POST', path: '/api/v1/trips/driver-response', body: { trip_id: tripId, driver_id: driverId, response: 'MAYBE' }, token: driverToken, expectStatus: 400 });
  await call('ride 1: another driver may not answer', { method: 'POST', path: '/api/v1/trips/driver-response', body: { trip_id: tripId, driver_id: '3333333333', response: 'ACCEPTED' }, token: driverToken });
  await call('ride 1: driver accepts', { method: 'POST', path: '/api/v1/trips/driver-response', body: { trip_id: tripId, driver_id: driverId, response: 'ACCEPTED' }, token: driverToken });
  recordPushes('ride 1: the rider is told it was accepted');
  await call('ride 1: accept again', { method: 'POST', path: '/api/v1/trips/driver-response', body: { trip_id: tripId, driver_id: driverId, response: 'ACCEPTED' }, token: driverToken });
  await call('ride 1: status without a session', { method: 'PATCH', path: `/api/v1/rides/${tripId}/status`, body: { status: 'ARRIVED' }, expectStatus: 401 });
  await call('ride 1: status out of order', { method: 'PATCH', path: `/api/v1/rides/${tripId}/status`, body: { status: 'COMPLETED' }, token: driverToken });
  await call('ride 1: status unknown', { method: 'PATCH', path: `/api/v1/rides/${tripId}/status`, body: { status: 'FLYING' }, token: driverToken, expectStatus: 400 });
  for (const status of ['DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING', 'COMPLETED']) {
    await call(`ride 1: status ${status}`, { method: 'PATCH', path: `/api/v1/rides/${tripId}/status`, body: { status }, token: driverToken });
    recordPushes(`ride 1: the rider is told ${status}`);
  }
  await call('ride 1: details when completed (rider)', { path: `/api/v1/rides/details?trip_id=${tripId}&user_id=${userId}`, token: riderToken });
  await call('ride 1: details when completed (driver)', { path: `/api/v1/rides/details?trip_id=${tripId}&driver_id=${driverId}`, token: driverToken });
  await call('ride 1: the trip', { path: `/api/v1/rides/${tripId}`, token: riderToken });
  await call('ride 1: timeline', { path: `/api/v1/rides/${tripId}/timeline`, token: riderToken });
  await call('ride 1: the rider history', { path: `/api/v1/rides?user_id=${userId}`, token: riderToken });
  await call('ride 1: no active ride now', { path: `/api/v1/rides/active?user_id=${userId}`, token: riderToken });

  // ---- ride 2: the driver rejects
  const r2 = await call('ride 2: request', { method: 'POST', path: '/api/v1/trips/create-request', body: trip(3), token: riderToken });
  const trip2 = r2.body.data && r2.body.data.trip_id;
  recordPushes('ride 2: the driver is pushed the request');
  await call('ride 2: driver rejects with a reason', { method: 'PATCH', path: `/api/v1/rides/${trip2}/reject`, body: { driver_id: driverId, rejected_reason: 'Too far' }, token: driverToken });
  recordPushes('ride 2: the rider is told it was declined');
  await call('ride 2: details after the rejection', { path: `/api/v1/rides/details?trip_id=${trip2}&user_id=${userId}`, token: riderToken });

  // ---- ride 3: the rider cancels before anyone accepts
  const r3 = await call('ride 3: request', { method: 'POST', path: '/api/v1/trips/create-request', body: trip(4), token: riderToken });
  const trip3 = r3.body.data && r3.body.data.trip_id;
  recordPushes('ride 3: the driver is pushed the request');
  await call('ride 3: cancel without a trip id', { method: 'POST', path: '/api/v1/trips/cancel-request', body: {}, token: riderToken, expectStatus: 400 });
  await call('ride 3: rider cancels the request', { method: 'POST', path: '/api/v1/trips/cancel-request', body: { trip_id: trip3, cancelled_by: 'USER' }, token: riderToken });
  recordPushes('ride 3: the driver is told it was cancelled');
  await call('ride 3: cancel again', { method: 'POST', path: '/api/v1/trips/cancel-request', body: { trip_id: trip3, cancelled_by: 'USER' }, token: riderToken });

  // ---- ride 4: accepted through the rides API, then cancelled by the rider
  const r4 = await call('ride 4: request', { method: 'POST', path: '/api/v1/trips/create-request', body: trip(5), token: riderToken });
  const trip4 = r4.body.data && r4.body.data.trip_id;
  recordPushes('ride 4: the driver is pushed the request');
  await call('ride 4: driver accepts through the rides API', { method: 'PATCH', path: `/api/v1/rides/${trip4}/accept`, body: { driver_id: driverId }, token: driverToken });
  recordPushes('ride 4: the rider is told it was accepted');
  await call('ride 4: rider cancels the accepted ride', { method: 'POST', path: '/api/v1/rides/cancel', body: { user_id: userId, ride_id: trip4, cancel_stage: 'after_accept', cancel_reason: 'Changed my plans' }, token: riderToken });
  recordPushes('ride 4: the driver is told it was cancelled');
  await call('ride 4: details after the cancel', { path: `/api/v1/rides/details?trip_id=${trip4}&user_id=${userId}`, token: riderToken });

  // ---- reads that need no ride
  await call('the driver goes offline', { method: 'PUT', path: '/api/drivers/online-status', body: { driverId, isOnline: false, onlineAs: 0 }, token: driverToken });
  await call('request while the driver is offline', { method: 'POST', path: '/api/v1/trips/create-request', body: trip(6), token: riderToken });
  await call('timeouts check needs the scheduler secret', { method: 'POST', path: '/api/v1/trips/check-timeouts', body: {}, expectStatus: 403 });
  await call('unknown trip', { path: '/api/v1/rides/amt_id_999999', token: riderToken });
};
