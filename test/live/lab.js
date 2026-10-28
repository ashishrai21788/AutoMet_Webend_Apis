/**
 * A local lab for trying the apps on real phones. The real backend on an in-process Postgres, on this PC only, with one business set
 * up through the real admin API (a region, a "VIP" category, a fare rule, a cancellation policy, an approved driver with a vehicle)
 * and fixed sign-in codes so a phone can log in without a real SMS.
 *
 *   node test/live/lab.js            writes test/live/lab.json (port, app id, ids) and stays alive; Ctrl+C stops it
 *
 * Optional switches (all development-only, off by default):
 *   LAB_PAYMENTS=1                      the mock payment gateway, with online payment switched on for the business
 *   LAB_WEATHER=1                       fixed heavy rain (WEATHER_FIXED_CODE / _PRECIP to change it) and a business rule that charges x1.3 for it
 *   LAB_CROWD="28.5746,77.4858"         eight rider phones that keep reporting they are near this spot, so the driver's demand map shows an area
 *
 * Test numbers (they exist only inside this throw-away database): driver 9876500001, rider 9876543210 and riders 9000000001-9000000008.
 * The code for all of them is 123456. Nothing here touches production.
 */
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('../contract/harness');

(async () => {
  const riders = ['9876543210', ...Array.from({ length: 8 }, (_, i) => `900000000${i + 1}`)];
  const dev = process.env.LAB_PAYMENTS === '1' || process.env.LAB_WEATHER === '1';
  const extraEnv = {
    ...(process.env.LAB_PAYMENTS === '1' ? { PAYMENTS_MOCK_ENABLED: '1', PAYMENTS_MOCK_SECRET: 'lab-mock-secret-not-a-real-one' } : {}),
    ...(process.env.LAB_WEATHER === '1' ? { WEATHER_PROVIDER: 'fixed', WEATHER_FIXED_CODE: process.env.WEATHER_FIXED_CODE || '65', WEATHER_FIXED_PRECIP: process.env.WEATHER_FIXED_PRECIP || '9' } : {}),
    ...(dev ? { NODE_ENV: 'development' } : {}) // the mock gateway and the fixed weather refuse to exist in production
  };
  const s = await start({ engine: 'postgres', env: { TEST_LOGIN_DISABLED: '', TEST_LOGIN_OTP: '123456', TEST_LOGIN_NUMBERS: ['9876500001', ...riders].join(','), ...extraEnv } });
  const api = async (method, p, body, token, appId) => {
    const r = await fetch(s.base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(appId ? { 'X-App-Id': appId } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status >= 400) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  };
  const owner = (await api('POST', '/api/admin/auth/login', { email: 'owner@contract.test', password: 'Contract-Owner-Pass-1' })).data.token;
  let appId = (await api('GET', '/api/admin/tenants', null, owner)).data[0].appId;
  // The apps are built for one app id; LAB_APP_ID keeps that id across lab restarts so they need no rebuild (a fresh database, nothing refers to it yet).
  if (process.env.LAB_APP_ID && process.env.LAB_APP_ID !== appId) {
    await s.patch('tenants', { tenantId: appId }, { tenantId: process.env.LAB_APP_ID });
    appId = process.env.LAB_APP_ID;
  }
  const ca = await api('POST', '/api/admin/users', { name: 'Lab Admin', email: 'admin@lab.test', role: 'client_admin', tenantId: appId }, owner);
  const first = await api('POST', '/api/admin/auth/login', { email: 'admin@lab.test', password: ca.data.temporaryPassword });
  const admin = (await api('POST', '/api/admin/auth/change-password', { currentPassword: ca.data.temporaryPassword, newPassword: 'Lab-Admin-Pass-1' }, first.data.token)).data.token;
  const biz = (m, p, b) => api(m, p, b, admin, appId);

  await biz('PUT', '/api/admin/business/market', { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' });
  const regionId = (await biz('POST', '/api/admin/business/regions', { state: 'Uttar Pradesh', cities: [{ name: 'Noida', lat: 28.5746, lng: 77.4858 }], zoneName: 'All areas', radiusKm: 80 })).data.created[0].id;
  const categoryId = (await biz('POST', '/api/admin/business/categories', { name: 'VIP', passengerCapacity: 4, rideType: 'economy', regionIds: [regionId] })).data.id;
  await biz('PUT', '/api/admin/business/fare-rules', { categoryId, regionId, baseFare: 10, perKm: 10, perMinute: 10, minimumFare: 50, bookingFee: 0, waitingFreeMinutes: 3, waitingPerMinute: 1.5, additionalCharges: [], taxes: [], surge: process.env.LAB_WEATHER === '1' ? { enabled: true, maxMultiplier: 2 } : { enabled: false, maxMultiplier: 1 } });
  await biz('PUT', '/api/admin/business/cancellation-policies', { categoryId, regionId, rider: { freeCancellationMinutes: 1, feeAfterWindow: 30, feeAfterDriverArrived: 50, noShowFee: 40 }, driver: { penaltyFee: 25, graceCancellations: 1 }, conditions: '' });
  const drv = (await biz('POST', '/api/admin/business/drivers', { fullName: 'Test Onboarding', phone: '+919876500001', email: 'driver@lab.test', dateOfBirth: '1990-04-02', address: { country: 'IN', state: 'Uttar Pradesh', city: 'Noida', line: '1 Main Road' }, operatingRegionId: regionId, eligibleCategoryId: categoryId })).data;
  const veh = (await biz('POST', '/api/admin/business/vehicles', { registrationNumber: 'UP16TS4321', make: 'Maruti', model: 'Dzire', year: 2021, colour: 'White', categoryId, passengerCapacity: 4, luggageCapacity: 2, operatingRegionId: regionId, status: 'ACTIVE' })).data;
  await biz('POST', `/api/admin/business/drivers/${drv.id}/assign-vehicle`, { vehicleId: veh.id });
  await s.patch('drivers', { driverId: drv.id }, { driverVerificationStatus: 'APPROVED', accountStatus: 'ACTIVE' });
  await s.patch('vehicles', { vehicleId: veh.id }, { verificationStatus: 'APPROVED' });

  if (process.env.LAB_PAYMENTS === '1') await biz('PUT', '/api/admin/business/payment-settings', { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', commissionRecovery: 'DEDUCT_FROM_PAYABLE' });
  if (process.env.LAB_WEATHER === '1') await biz('PUT', '/api/admin/business/weather-pricing', { enabled: true, multipliers: { LIGHT_RAIN: 1.1, HEAVY_RAIN: 1.3, STORM: 1.5 }, maxMultiplier: 1.5 });

  // a crowd of riders with their app open near one spot (they report again every minute: a rider counts for five minutes after their last report)
  if (process.env.LAB_CROWD) {
    const [lat, lng] = process.env.LAB_CROWD.split(',').map(Number);
    const crowd = [];
    for (const [i, phone] of riders.slice(1).entries()) {
      try {
        await api('POST', '/api/users/register', { name: `Crowd ${i + 1}`, phone: `+91${phone}` }, null, appId);
        const lg = await api('POST', '/api/users/login', { phoneNumber: phone }, null, appId);
        const userId = lg.data.user.userId;
        const v = await api('POST', '/api/users/verify-otp', { userId, otp: '123456', device_id: `crowd-${i}`, fcm_id: `crowd-${i}` }, null, appId);
        crowd.push({ token: v.data.accessToken || (v.data.user || {}).accessToken, i });
      } catch (e) { console.warn('crowd rider', phone, e.message); }
    }
    const report = () => Promise.all(crowd.map((c) => api('POST', '/api/v1/rider/presence', { lat: lat + 0.0006 * (c.i % 4), lng: lng + 0.0006 * Math.floor(c.i / 4), area: 'Lab crowd' }, c.token, appId).catch(() => {})));
    await report();
    setInterval(report, 60000);
    console.log(`CROWD of ${crowd.length} riders near ${lat},${lng}`);
  }

  const out = { port: new URL(s.base).port, base: s.base, appId, admin, regionId, categoryId, driverId: drv.id, vehicleId: veh.id, adminLogin: { email: 'admin@lab.test', password: 'Lab-Admin-Pass-1' } };
  fs.writeFileSync(path.join(__dirname, 'lab.json'), JSON.stringify(out, null, 2));
  console.log(`LAB READY port ${out.port} appId ${appId} driverId ${drv.id}`);
  setInterval(() => {}, 1 << 30);
  process.on('SIGTERM', async () => { await s.stop(); process.exit(0); });
})().catch((e) => { console.error(e); process.exit(1); });
