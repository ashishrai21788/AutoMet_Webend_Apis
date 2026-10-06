/**
 * The business admin's dashboard: business profile and settings, regions, categories, fare rules and preview,
 * cancellation policies, verification requirements, ride settings, drivers and vehicles (edit, status, history,
 * assignment), riders, trips (list, detail, cancel), reports, CSV exports, alerts, live map, support issues and audit.
 * Uploading documents and the logo needs Cloudinary and is not captured here.
 */
const { configuredBusiness, driverSignIn } = require('./common');

module.exports = async function business(t) {
  const { call, peek, alias } = t;
  const ctx = await configuredBusiness(t);
  const { admin, H, regionId, categoryId, driverId, vehicleId } = ctx;
  const biz = (name, opts) => call(name, { token: admin, headers: H, ...opts });

  // ---- some activity to report on: one rider, one completed ride, one open request, one support issue
  const reg = await call('rider: register', { method: 'POST', path: '/api/users/register', body: { name: 'Rae Rider', phone: '+919800000001', email: 'rae@contract.test' }, expectStatus: 201 });
  const userId = reg.body.data.user.userId;
  alias(userId, 'userId');
  const otp = (await peek('users_otp', { userId, isUsed: false })).otp;
  alias(otp, 'riderOtp');
  const ver = await call('rider: verify OTP', { method: 'POST', path: '/api/users/verify-otp', body: { userId, otp, device_id: 'rider-device-1', fcm_id: 'rider-fcm-1' }, expectStatus: 200 });
  const riderToken = ver.body.data.accessToken || (ver.body.data.user && ver.body.data.user.accessToken);
  const driverToken = await driverSignIn(t, { driverId, phone: ctx.driverPhone });
  await call('driver: vehicle details', { method: 'PUT', path: '/api/drivers/vehicle-details', body: { driverId, vehicleType: 'Sedan', vehicleNumber: 'MH12AB1234', vehicleModel: 'Dzire', isVehicleAdded: true }, token: driverToken, expectStatus: 200 });
  await call('driver: go online', { method: 'PUT', path: '/api/drivers/online-status', body: { driverId, isOnline: true, onlineAs: 0 }, token: driverToken, expectStatus: 200 });
  await call('driver: position', { method: 'POST', path: '/api/drivers/location', body: { driverId, lat: 18.5204, lng: 73.8567, accuracy: 10 }, token: driverToken, expectStatus: 200 });
  // A driver counts as "live" only for a short time after the last position. A fresh position is sent just before each screen
  // that shows presence, so the answers do not depend on how fast the database is. It is NOT recorded: the response carries the
  // region name from the server's one-minute region cache, which is itself timing dependent.
  const fresh = async (why) => {
    const res = await fetch(`${t.server.base}/api/drivers/location`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${driverToken}` }, body: JSON.stringify({ driverId, lat: 18.5204, lng: 73.8567, accuracy: 10 }) });
    if (res.status !== 200) throw new Error(`keeping the driver live (${why}) failed: HTTP ${res.status}`);
  };
  const trip = (n) => ({ request_id: `req-biz-${n}`, user_id: userId, driver_id: driverId, pickup_address: 'Shivajinagar, Pune', pickup_latitude: 18.5314, pickup_longitude: 73.8446, drop_address: 'Hinjewadi, Pune', drop_latitude: 18.5912, drop_longitude: 73.7389 });
  const r1 = await call('ride 1: request', { method: 'POST', path: '/api/v1/trips/create-request', body: trip(1), token: riderToken });
  const trip1 = r1.body.data && r1.body.data.trip_id;
  await call('ride 1: accept', { method: 'POST', path: '/api/v1/trips/driver-response', body: { trip_id: trip1, driver_id: driverId, response: 'ACCEPTED' }, token: driverToken });
  for (const status of ['DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING', 'COMPLETED']) {
    await call(`ride 1: ${status}`, { method: 'PATCH', path: `/api/v1/rides/${trip1}/status`, body: { status }, token: driverToken });
  }
  const r2 = await call('ride 2: request', { method: 'POST', path: '/api/v1/trips/create-request', body: trip(2), token: riderToken });
  const trip2 = r2.body.data && r2.body.data.trip_id;
  await call('issue: the driver reports a problem', { method: 'POST', path: '/api/drivers/issues', body: { driverId, issueText: 'The map takes long to load on the trip screen' }, token: driverToken });

  // ---- business profile and settings
  await biz('business: read', { path: '/api/admin/business', expectStatus: 200 });
  await fresh('before the overview');
  await biz('business: overview', { path: '/api/admin/business/overview', expectStatus: 200 });
  await biz('settings: nothing to update', { method: 'PUT', path: '/api/admin/business/settings', body: {}, expectStatus: 400 });
  await biz('settings: too short', { method: 'PUT', path: '/api/admin/business/settings', body: { name: 'x' }, expectStatus: 400 });
  await biz('settings: update', { method: 'PUT', path: '/api/admin/business/settings', body: { appName: 'Contract Rides', supportEmail: 'help@contract.test', supportPhone: '+911234567890' } });
  await biz('market: invalid', { method: 'PUT', path: '/api/admin/business/market', body: { country: 'ZZ' }, expectStatus: 400 });
  await biz('market: save', { method: 'PUT', path: '/api/admin/business/market', body: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }, expectStatus: 200 });
  await biz('setup: complete', { method: 'POST', path: '/api/admin/business/setup/complete', body: {} });

  // ---- regions
  await biz('regions: list', { path: '/api/admin/business/regions', expectStatus: 200 });
  await biz('regions: locate', { method: 'POST', path: '/api/admin/business/regions/locate', body: { lat: 18.5204, lng: 73.8567 } });
  await biz('regions: update, invalid', { method: 'PATCH', path: `/api/admin/business/regions/${regionId}`, body: { active: 'maybe' }, expectStatus: 400 });
  await biz('regions: update', { method: 'PATCH', path: `/api/admin/business/regions/${regionId}`, body: { zoneName: 'Pune and suburbs', center: { lat: 18.5204, lng: 73.8567 }, radiusKm: 35 } });
  const reg2 = await biz('regions: add a second city', { method: 'POST', path: '/api/admin/business/regions', body: { state: 'Maharashtra', cities: [{ name: 'Nashik', lat: 19.9975, lng: 73.7898 }], zoneName: 'All areas', radiusKm: 20 }, expectStatus: 201 });
  const region2 = reg2.body.data.created[0].id;
  await biz('regions: deactivate the second city', { method: 'PATCH', path: `/api/admin/business/regions/${region2}`, body: { active: false } });
  await biz('regions: list after changes', { path: '/api/admin/business/regions' });

  // ---- categories, fares, cancellation policies
  await biz('categories: list', { path: '/api/admin/business/categories', expectStatus: 200 });
  await biz('categories: create, invalid', { method: 'POST', path: '/api/admin/business/categories', body: {}, expectStatus: 400 });
  const cat2 = await biz('categories: create', { method: 'POST', path: '/api/admin/business/categories', body: { name: 'Mini', passengerCapacity: 3, rideType: 'economy', regionIds: [regionId] }, expectStatus: 201 });
  const category2 = cat2.body.data.id;
  await biz('categories: update', { method: 'PATCH', path: `/api/admin/business/categories/${category2}`, body: { name: 'Mini Plus' } });
  await biz('categories: list after changes', { path: '/api/admin/business/categories' });
  await biz('fares: list', { path: '/api/admin/business/fare-rules', expectStatus: 200 });
  await biz('fares: save, invalid', { method: 'PUT', path: '/api/admin/business/fare-rules', body: { categoryId, regionId, baseFare: -1 }, expectStatus: 400 });
  const fare2 = await biz('fares: save for the second category', { method: 'PUT', path: '/api/admin/business/fare-rules', body: { categoryId: category2, regionId, baseFare: 30, perKm: 10, perMinute: 1, minimumFare: 60, bookingFee: 4, waitingFreeMinutes: 3, waitingPerMinute: 1 } });
  await biz('fares: preview', { method: 'POST', path: '/api/admin/business/fare-preview', body: { rule: { baseFare: 40, perKm: 12, perMinute: 1, minimumFare: 70, bookingFee: 5, waitingFreeMinutes: 3, waitingPerMinute: 1.5 }, trip: { distanceKm: 8.5, durationMin: 22, waitingMin: 4 } } });
  const fareId = fare2.body.data && (fare2.body.data.id || fare2.body.data.fareRuleId);
  if (fareId) await biz('fares: delete', { method: 'DELETE', path: `/api/admin/business/fare-rules/${fareId}` });
  await biz('policies: list', { path: '/api/admin/business/cancellation-policies', expectStatus: 200 });
  await biz('policies: save, invalid', { method: 'PUT', path: '/api/admin/business/cancellation-policies', body: { categoryId, regionId, rider: { freeCancellationMinutes: 999 }, driver: {} }, expectStatus: 400 });
  const pol = await biz('policies: save', { method: 'PUT', path: '/api/admin/business/cancellation-policies', body: { categoryId, regionId, rider: { freeCancellationMinutes: 3, feeAfterWindow: 20, feeAfterDriverArrived: 40, noShowFee: 50 }, driver: { penaltyFee: 25, graceCancellations: 2 }, conditions: 'Contract conditions' } });
  const policyId = pol.body.data && (pol.body.data.id || pol.body.data.policyId);
  if (policyId) await biz('policies: delete', { method: 'DELETE', path: `/api/admin/business/cancellation-policies/${policyId}` });

  // ---- verification requirements and ride settings
  await biz('requirements: read', { path: '/api/admin/business/requirements', expectStatus: 200 });
  await biz('requirements: unknown type', { method: 'PUT', path: '/api/admin/business/requirements', body: { driver: { NOPE: true } }, expectStatus: 400 });
  await biz('requirements: locked item cannot be optional', { method: 'PUT', path: '/api/admin/business/requirements', body: { driver: { DRIVING_LICENCE: false } }, expectStatus: 400 });
  await biz('requirements: update', { method: 'PUT', path: '/api/admin/business/requirements', body: { driver: { ADDRESS_PROOF: true } } });
  await biz('ride settings: read', { path: '/api/admin/business/ride-settings', expectStatus: 200 });
  await biz('ride settings: invalid', { method: 'PUT', path: '/api/admin/business/ride-settings', body: { requireEligibleDrivers: 'yes' }, expectStatus: 400 });
  await biz('ride settings: update', { method: 'PUT', path: '/api/admin/business/ride-settings', body: { requireEligibleDrivers: true } });
  await fresh('before availability');
  await biz('availability', { path: '/api/admin/business/availability', expectStatus: 200 });

  // ---- drivers
  await fresh('before the driver screens');
  await biz('drivers: list', { path: '/api/admin/business/drivers', expectStatus: 200 });
  await biz('drivers: list filtered', { path: '/api/admin/business/drivers?status=ACTIVE&q=Dee' });
  await biz('drivers: one', { path: `/api/admin/business/drivers/${driverId}`, expectStatus: 200 });
  await biz('drivers: unknown', { path: '/api/admin/business/drivers/drv_missing' });
  await biz('drivers: create, invalid', { method: 'POST', path: '/api/admin/business/drivers', body: {}, expectStatus: 400 });
  await biz('drivers: update', { method: 'PATCH', path: `/api/admin/business/drivers/${driverId}`, body: { fullName: 'Dee Driver Jr', address: { country: 'IN', state: 'Maharashtra', city: 'Pune', line: '2 Main Road' } } });
  await biz('drivers: suspend without a reason', { method: 'POST', path: `/api/admin/business/drivers/${driverId}/status`, body: { status: 'SUSPENDED' }, expectStatus: 400 });
  await biz('drivers: suspend', { method: 'POST', path: `/api/admin/business/drivers/${driverId}/status`, body: { status: 'SUSPENDED', reason: 'Documents under review' } });
  await biz('drivers: reactivate', { method: 'POST', path: `/api/admin/business/drivers/${driverId}/status`, body: { status: 'ACTIVE' } });
  await biz('drivers: history', { path: `/api/admin/business/drivers/${driverId}/history`, expectStatus: 200 });
  await biz('drivers: documents', { path: `/api/admin/business/drivers/${driverId}/documents`, expectStatus: 200 });
  await biz('drivers: unassign the vehicle', { method: 'POST', path: `/api/admin/business/drivers/${driverId}/unassign-vehicle`, body: {} });
  await biz('drivers: assign the vehicle again', { method: 'POST', path: `/api/admin/business/drivers/${driverId}/assign-vehicle`, body: { vehicleId } });

  // ---- vehicles
  await biz('vehicles: list', { path: '/api/admin/business/vehicles', expectStatus: 200 });
  await biz('vehicles: one', { path: `/api/admin/business/vehicles/${vehicleId}`, expectStatus: 200 });
  await biz('vehicles: create, invalid', { method: 'POST', path: '/api/admin/business/vehicles', body: {}, expectStatus: 400 });
  const v2 = await biz('vehicles: create a second', { method: 'POST', path: '/api/admin/business/vehicles', body: { registrationNumber: 'MH14CD5678', make: 'Hyundai', model: 'Aura', year: 2022, colour: 'Grey', categoryId, passengerCapacity: 4, luggageCapacity: 2, operatingRegionId: regionId, status: 'ACTIVE' }, expectStatus: 201 });
  const vehicle2 = v2.body.data.id;
  await biz('vehicles: duplicate registration', { method: 'POST', path: '/api/admin/business/vehicles', body: { registrationNumber: 'MH14CD5678', make: 'Hyundai', model: 'Aura', year: 2022, colour: 'Grey', categoryId, passengerCapacity: 4, luggageCapacity: 2, operatingRegionId: regionId, status: 'ACTIVE' } });
  await biz('vehicles: update', { method: 'PATCH', path: `/api/admin/business/vehicles/${vehicle2}`, body: { colour: 'Silver' } });
  await biz('vehicles: deactivate', { method: 'POST', path: `/api/admin/business/vehicles/${vehicle2}/status`, body: { status: 'INACTIVE' } });
  await biz('vehicles: history', { path: `/api/admin/business/vehicles/${vehicle2}/history`, expectStatus: 200 });
  await biz('vehicles: documents', { path: `/api/admin/business/vehicles/${vehicle2}/documents`, expectStatus: 200 });
  await biz('vehicles: assign a driver who already has a vehicle', { method: 'POST', path: `/api/admin/business/vehicles/${vehicle2}/assign-driver`, body: { driverId } });
  await biz('vehicles: free the driver first', { method: 'POST', path: `/api/admin/business/drivers/${driverId}/unassign-vehicle`, body: {} });
  await biz('vehicles: assign a driver', { method: 'POST', path: `/api/admin/business/vehicles/${vehicle2}/assign-driver`, body: { driverId } });
  await biz('vehicles: unassign the driver', { method: 'POST', path: `/api/admin/business/vehicles/${vehicle2}/unassign-driver`, body: {} });
  await biz('vehicles: list after changes', { path: '/api/admin/business/vehicles' });

  // ---- riders and trips
  await biz('riders: list', { path: '/api/admin/business/riders', expectStatus: 200 });
  await biz('riders: one', { path: `/api/admin/business/riders/${userId}`, expectStatus: 200 });
  await biz('riders: unknown', { path: '/api/admin/business/riders/9999999999' });
  await biz('riders: suspend without a reason', { method: 'POST', path: `/api/admin/business/riders/${userId}/status`, body: { status: 'SUSPENDED' }, expectStatus: 400 });
  await biz('riders: suspend', { method: 'POST', path: `/api/admin/business/riders/${userId}/status`, body: { status: 'SUSPENDED', reason: 'Abusive behaviour' } });
  await biz('riders: activate', { method: 'POST', path: `/api/admin/business/riders/${userId}/status`, body: { status: 'ACTIVE' } });
  await biz('trips: list', { path: '/api/admin/business/trips', expectStatus: 200 });
  await biz('trips: list filtered', { path: '/api/admin/business/trips?status=COMPLETED' });
  await biz('trips: one', { path: `/api/admin/business/trips/${trip1}`, expectStatus: 200 });
  await biz('trips: unknown', { path: '/api/admin/business/trips/amt_id_999999' });
  await biz('trips: cancel without a reason', { method: 'POST', path: `/api/admin/business/trips/${trip2}/cancel`, body: {}, expectStatus: 400 });
  await biz('trips: cancel an open request', { method: 'POST', path: `/api/admin/business/trips/${trip2}/cancel`, body: { reason: 'Cancelled by support' } });
  await biz('trips: cancel a completed trip', { method: 'POST', path: `/api/admin/business/trips/${trip1}/cancel`, body: { reason: 'Cancelled by support' } });

  // ---- reports, exports, live reads
  await fresh('before stats, alerts and the live map');
  await biz('stats', { path: '/api/admin/business/stats', expectStatus: 200 });
  await biz('alerts', { path: '/api/admin/business/alerts', expectStatus: 200 });
  await biz('live map', { path: '/api/admin/business/live-map' });
  await biz('reports: summary', { path: '/api/admin/business/reports/summary', expectStatus: 200 });
  await biz('export: trips csv', { path: '/api/admin/business/export/trips.csv' });
  await biz('export: riders csv', { path: '/api/admin/business/export/riders.csv' });
  await biz('export: drivers csv', { path: '/api/admin/business/export/drivers.csv' });

  // ---- support issues and audit
  const issues = await biz('support: list', { path: '/api/admin/business/support/issues', expectStatus: 200 });
  const list = (issues.body.data && (issues.body.data.items || issues.body.data)) || [];
  const issueId = Array.isArray(list) && list[0] && (list[0].id || list[0].issueId);
  if (issueId) {
    await biz('support: one', { path: `/api/admin/business/support/issues/${issueId}` });
    await biz('support: update, invalid', { method: 'POST', path: `/api/admin/business/support/issues/${issueId}`, body: { status: 'FLYING' } });
    await biz('support: reply and resolve', { method: 'POST', path: `/api/admin/business/support/issues/${issueId}`, body: { status: 'complete', note: 'We have fixed the map speed' } });
  }
  await biz('support: unknown', { path: '/api/admin/business/support/issues/000000000000000000000000' });
  await biz('audit: business', { path: '/api/admin/business/audit', expectStatus: 200 });
  await biz('audit: csv', { path: '/api/admin/business/audit.csv' });
  await biz('permissions: no tenant selected', { path: '/api/admin/business' });
  await call('permissions: no session', { path: '/api/admin/business/drivers', headers: H, expectStatus: 401 });
};
