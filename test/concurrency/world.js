/**
 * The world the concurrency harness and the load baseline both run in: a real server on a temporary database, one business with a region,
 * a category and fare rules, N approved drivers with vehicles, and M signed-in riders. Everything goes through the real HTTP API
 * except approving the drivers and vehicles (a staff review step the API does not expose to the test) and reading the database back.
 */
const { start } = require('../contract/harness');

const SECRET = 'contract-scheduler-secret';
const OTP = '123456';
const ACTIVE = ['REQUESTED', 'ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];
const PICKUP = { lat: 28.5746, lng: 77.4858 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hist = (arr) => arr.reduce((m, k) => { m[k] = (m[k] || 0) + 1; return m; }, {});

async function setup(engine, { drivers = 4, riders = 8 } = {}) {
  const driverPhones = Array.from({ length: drivers }, (_, i) => `98765001${String(i).padStart(2, '0')}`);
  const riderPhones = Array.from({ length: riders }, (_, i) => `90000100${String(i).padStart(2, '0')}`);
  const s = await start({ engine, env: { TEST_LOGIN_DISABLED: '', TEST_LOGIN_OTP: OTP, TEST_LOGIN_NUMBERS: [...driverPhones, ...riderPhones].join(','), TRIP_START_OTP: 'off', DISPATCH_OFFER_SECONDS: '30' } });
  const api = async (method, p, body, token, appId, extra = {}) => {
    const r = await fetch(s.base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(appId ? { 'X-App-Id': appId } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    let j = {}; try { j = await r.json(); } catch { /* not json */ }
    return { status: r.status, body: j };
  };
  const must = async (label, p) => { const r = await p; if (r.status >= 400) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body; };

  const owner = (await must('owner login', api('POST', '/api/admin/auth/login', { email: 'owner@contract.test', password: 'Contract-Owner-Pass-1' }))).data.token;
  const appId = (await must('tenants', api('GET', '/api/admin/tenants', null, owner))).data[0].appId;
  const ca = await must('client admin', api('POST', '/api/admin/users', { name: 'Conc Admin', email: 'admin@conc.test', role: 'client_admin', tenantId: appId }, owner));
  const first = await must('admin login', api('POST', '/api/admin/auth/login', { email: 'admin@conc.test', password: ca.data.temporaryPassword }));
  const admin = (await must('admin password', api('POST', '/api/admin/auth/change-password', { currentPassword: ca.data.temporaryPassword, newPassword: 'Conc-Admin-Pass-1' }, first.data.token))).data.token;
  const biz = (m, p, b) => must(`${m} ${p}`, api(m, p, b, admin, appId));
  await biz('PUT', '/api/admin/business/market', { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' });
  const regionId = (await biz('POST', '/api/admin/business/regions', { state: 'Uttar Pradesh', cities: [{ name: 'Noida', lat: PICKUP.lat, lng: PICKUP.lng }], zoneName: 'All areas', radiusKm: 80 })).data.created[0].id;
  const categoryId = (await biz('POST', '/api/admin/business/categories', { name: 'VIP', passengerCapacity: 4, rideType: 'economy', regionIds: [regionId] })).data.id;
  await biz('PUT', '/api/admin/business/fare-rules', { categoryId, regionId, baseFare: 10, perKm: 10, perMinute: 10, minimumFare: 50, bookingFee: 0, waitingFreeMinutes: 3, waitingPerMinute: 1.5, additionalCharges: [], taxes: [], surge: { enabled: false, maxMultiplier: 1 } });

  const D = [];
  for (let i = 0; i < drivers; i += 1) {
    const d = (await biz('POST', '/api/admin/business/drivers', { fullName: `Conc Driver ${i}`, phone: `+91${driverPhones[i]}`, email: `d${i}@conc.test`, dateOfBirth: '1990-04-02', address: { country: 'IN', state: 'Uttar Pradesh', city: 'Noida', line: '1 Main Road' }, operatingRegionId: regionId, eligibleCategoryId: categoryId })).data;
    const v = (await biz('POST', '/api/admin/business/vehicles', { registrationNumber: `UP16CC${1000 + i}`, make: 'Maruti', model: 'Dzire', year: 2021, colour: 'White', categoryId, passengerCapacity: 4, luggageCapacity: 2, operatingRegionId: regionId, status: 'ACTIVE' })).data;
    await biz('POST', `/api/admin/business/drivers/${d.id}/assign-vehicle`, { vehicleId: v.id });
    await s.patch('drivers', { driverId: d.id }, { driverVerificationStatus: 'APPROVED', accountStatus: 'ACTIVE' });
    await s.patch('vehicles', { vehicleId: v.id }, { verificationStatus: 'APPROVED' });
    await api('POST', '/api/drivers/login', { phoneNumber: `+91${driverPhones[i]}`, device_id: `conc-d${i}`, fcm_id: `conc-d${i}` }, null, appId);
    const ver = await must('driver otp', api('POST', '/api/otp/verify', { driverId: d.id, otp: OTP, device_id: `conc-d${i}`, fcm_id: `conc-d${i}` }, null, appId));
    D.push({ id: d.id, token: (ver.data || {}).accessToken || ((ver.data || {}).driver || {}).accessToken, index: i });
  }
  const R = [];
  for (let i = 0; i < riders; i += 1) {
    await api('POST', '/api/users/register', { name: `Conc Rider ${i}`, phone: `+91${riderPhones[i]}` }, null, appId);
    const lg = await must('rider login', api('POST', '/api/users/login', { phoneNumber: riderPhones[i] }, null, appId));
    const userId = lg.data.user.userId;
    const ver = await must('rider otp', api('POST', '/api/users/verify-otp', { userId, otp: OTP, device_id: `conc-r${i}`, fcm_id: `conc-r${i}` }, null, appId));
    R.push({ id: userId, token: ver.data.accessToken || (ver.data.user || {}).accessToken, index: i });
  }
  return { s, api, appId, categoryId, drivers: D, riders: R };
}

/** Puts every driver online, with a fresh location a little further from the pickup the higher the index, so dispatch order is known. */
async function resetWorld(w, onlyDrivers = null) {
  const trips = await w.s.all('trip_details', {});
  for (const t of trips) if (ACTIVE.includes(t.status)) await w.s.patch('trip_details', { trip_id: t.trip_id }, { status: 'CANCELLED_BY_USER' });
  for (const d of w.drivers) {
    const on = !onlyDrivers || onlyDrivers.includes(d.index);
    await w.api('PUT', '/api/drivers/online-status', { driverId: d.id, isOnline: on, onlineAs: 0 }, d.token, w.appId);
    if (on) await w.api('POST', '/api/drivers/location', { driverId: d.id, lat: PICKUP.lat + d.index * 0.002, lng: PICKUP.lng, accuracy: 10 }, d.token, w.appId);
  }
}

let seq = 0;
const request = (w, rider) => w.api('POST', '/api/v1/trips/create-request', {
  request_id: `conc-${Date.now()}-${seq += 1}`, user_id: rider.id, pickup_address: 'Sector 62, Noida', pickup_latitude: PICKUP.lat, pickup_longitude: PICKUP.lng,
  drop_address: 'Connaught Place', drop_latitude: 28.6, drop_longitude: 77.5, category_id: w.categoryId
}, rider.token, w.appId);
const respond = (w, driver, tripId, response) => w.api('POST', '/api/v1/trips/driver-response', { trip_id: tripId, driver_id: driver.id, response }, driver.token, w.appId);
const tripsNow = (w) => w.s.all('trip_details', {});
const heldBy = (trips, driverId) => trips.filter((t) => t.driver_id === driverId && ACTIVE.includes(t.status));

module.exports = { setup, resetWorld, request, respond, tripsNow, heldBy, sleep, hist, SECRET, OTP, ACTIVE, PICKUP };
