/**
 * Shared set-up used by several scenarios: a configured business (market, region, category, fare rule), a client admin,
 * a driver created from the dashboard with a vehicle assigned, and (through `patch`, because real verification needs
 * uploaded document files) that driver and vehicle marked APPROVED so the driver may go online.
 *
 * Everything goes through the real HTTP API, so the dashboard's own contract is recorded as part of the set-up.
 */
const OWNER = { email: 'owner@contract.test', password: 'Contract-Owner-Pass-1' };
const ADMIN_NEW_PASSWORD = 'Client-Admin-Pass-1';

async function configuredBusiness({ call, alias, patch }) {
  const owner = (await call('setup: platform owner signs in', { method: 'POST', path: '/api/admin/auth/login', body: OWNER, expectStatus: 200 })).body.data.token;
  const tenants = (await call('setup: list businesses', { path: '/api/admin/tenants', token: owner, expectStatus: 200 })).body.data;
  const appId = tenants[0].appId;
  alias(appId, 'defaultAppId');
  const ca = await call('setup: create the business admin', { method: 'POST', path: '/api/admin/users', body: { name: 'Client Admin', email: 'admin@contract.test', role: 'client_admin', tenantId: appId }, token: owner, expectStatus: 201 });
  alias(ca.body.data.temporaryPassword, 'tempPassword');
  const first = await call('setup: business admin signs in (temporary password)', { method: 'POST', path: '/api/admin/auth/login', body: { email: 'admin@contract.test', password: ca.body.data.temporaryPassword }, expectStatus: 200 });
  const changed = await call('setup: business admin chooses a password', { method: 'POST', path: '/api/admin/auth/change-password', body: { currentPassword: ca.body.data.temporaryPassword, newPassword: ADMIN_NEW_PASSWORD }, token: first.body.data.token, expectStatus: 200 });
  const admin = changed.body.data.token;
  const H = { 'X-App-Id': appId };
  const biz = (name, opts) => call(name, { token: admin, headers: H, ...opts });

  await biz('setup: market', { method: 'PUT', path: '/api/admin/business/market', body: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }, expectStatus: 200 });
  const reg = await biz('setup: region', { method: 'POST', path: '/api/admin/business/regions', body: { state: 'Maharashtra', cities: [{ name: 'Pune', lat: 18.5204, lng: 73.8567 }], zoneName: 'All areas', radiusKm: 30 }, expectStatus: 201 });
  const regionId = reg.body.data.created[0].id;
  const cat = await biz('setup: vehicle category', { method: 'POST', path: '/api/admin/business/categories', body: { name: 'Sedan', passengerCapacity: 4, rideType: 'economy', regionIds: [regionId] }, expectStatus: 201 });
  const categoryId = cat.body.data.id;
  await biz('setup: fare rule', { method: 'PUT', path: '/api/admin/business/fare-rules', body: { categoryId, regionId, baseFare: 40, perKm: 12, perMinute: 1, minimumFare: 70, bookingFee: 5, waitingFreeMinutes: 3, waitingPerMinute: 1.5 }, expectStatus: 200 });

  const drv = await biz('setup: create the driver', { method: 'POST', path: '/api/admin/business/drivers', body: { fullName: 'Dee Driver', phone: '+919811111111', email: 'dee@contract.test', dateOfBirth: '1990-04-02', address: { country: 'IN', state: 'Maharashtra', city: 'Pune', line: '1 Main Road' }, operatingRegionId: regionId, eligibleCategoryId: categoryId }, expectStatus: 201 });
  const driverId = drv.body.data.id;
  alias(driverId, 'driverId');
  const veh = await biz('setup: create the vehicle', { method: 'POST', path: '/api/admin/business/vehicles', body: { registrationNumber: 'MH12AB1234', make: 'Maruti', model: 'Dzire', year: 2021, colour: 'White', categoryId, passengerCapacity: 4, luggageCapacity: 2, operatingRegionId: regionId, status: 'ACTIVE' }, expectStatus: 201 });
  const vehicleId = veh.body.data.id;
  await biz('setup: assign the vehicle', { method: 'POST', path: `/api/admin/business/drivers/${driverId}/assign-vehicle`, body: { vehicleId }, expectStatus: 200 });
  // real verification needs uploaded documents; here the two statuses are set directly
  await patch('drivers', { driverId }, { driverVerificationStatus: 'APPROVED', accountStatus: 'ACTIVE' });
  await patch('vehicles', { vehicleId }, { verificationStatus: 'APPROVED' });
  await biz('setup: the driver is now eligible', { path: `/api/admin/business/drivers/${driverId}`, expectStatus: 200 });

  return { owner, admin, appId, H, regionId, categoryId, driverId, vehicleId, driverPhone: '+919811111111' };
}

/** The driver app's own sign-in: login -> OTP -> verify, returning the session token. */
async function driverSignIn({ call, peek, alias }, { driverId, phone, tag = 'driver' }) {
  await call(`${tag}: login`, { method: 'POST', path: '/api/drivers/login', body: { phoneNumber: phone, device_id: 'driver-device-1', fcm_id: 'driver-fcm-1' }, expectStatus: 200 });
  const otp = (await peek('drivers_otp', { driverId, isUsed: false })).otp;
  alias(otp, `${tag}Otp`);
  const ver = await call(`${tag}: verify OTP`, { method: 'POST', path: '/api/otp/verify', body: { driverId, otp, device_id: 'driver-device-1', fcm_id: 'driver-fcm-1' }, expectStatus: 200 });
  const d = ver.body.data || {};
  return d.accessToken || (d.driver && d.driver.accessToken) || d.token;
}

module.exports = { configuredBusiness, driverSignIn, OWNER, ADMIN_NEW_PASSWORD };
