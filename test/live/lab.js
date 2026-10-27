/**
 * A local lab for trying the apps on real phones. The real backend on an in-process Postgres, on this PC only, with one business set
 * up through the real admin API (a region, a "VIP" category, a fare rule, a cancellation policy, an approved driver with a vehicle)
 * and fixed sign-in codes so a phone can log in without a real SMS.
 *
 *   node test/live/lab.js            writes test/live/lab.json (port, app id, ids) and stays alive; Ctrl+C stops it
 *
 * Test numbers (they exist only inside this throw-away database): driver 9876500001, rider 9876543210 and riders 9000000001-9000000008.
 * The code for all of them is 123456. Nothing here touches production.
 */
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('../contract/harness');

(async () => {
  const riders = ['9876543210', ...Array.from({ length: 8 }, (_, i) => `900000000${i + 1}`)];
  const s = await start({ engine: 'postgres', env: { TEST_LOGIN_DISABLED: '', TEST_LOGIN_OTP: '123456', TEST_LOGIN_NUMBERS: ['9876500001', ...riders].join(',') } });
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
  await biz('PUT', '/api/admin/business/fare-rules', { categoryId, regionId, baseFare: 10, perKm: 10, perMinute: 10, minimumFare: 50, bookingFee: 0, waitingFreeMinutes: 3, waitingPerMinute: 1.5, additionalCharges: [], taxes: [], surge: { enabled: false, maxMultiplier: 1 } });
  await biz('PUT', '/api/admin/business/cancellation-policies', { categoryId, regionId, rider: { freeCancellationMinutes: 1, feeAfterWindow: 30, feeAfterDriverArrived: 50, noShowFee: 40 }, driver: { penaltyFee: 25, graceCancellations: 1 }, conditions: '' });
  const drv = (await biz('POST', '/api/admin/business/drivers', { fullName: 'Test Onboarding', phone: '+919876500001', email: 'driver@lab.test', dateOfBirth: '1990-04-02', address: { country: 'IN', state: 'Uttar Pradesh', city: 'Noida', line: '1 Main Road' }, operatingRegionId: regionId, eligibleCategoryId: categoryId })).data;
  const veh = (await biz('POST', '/api/admin/business/vehicles', { registrationNumber: 'UP16TS4321', make: 'Maruti', model: 'Dzire', year: 2021, colour: 'White', categoryId, passengerCapacity: 4, luggageCapacity: 2, operatingRegionId: regionId, status: 'ACTIVE' })).data;
  await biz('POST', `/api/admin/business/drivers/${drv.id}/assign-vehicle`, { vehicleId: veh.id });
  await s.patch('drivers', { driverId: drv.id }, { driverVerificationStatus: 'APPROVED', accountStatus: 'ACTIVE' });
  await s.patch('vehicles', { vehicleId: veh.id }, { verificationStatus: 'APPROVED' });

  const out = { port: new URL(s.base).port, base: s.base, appId, admin, regionId, categoryId, driverId: drv.id, vehicleId: veh.id, adminLogin: { email: 'admin@lab.test', password: 'Lab-Admin-Pass-1' } };
  fs.writeFileSync(path.join(__dirname, 'lab.json'), JSON.stringify(out, null, 2));
  console.log(`LAB READY port ${out.port} appId ${appId} driverId ${drv.id}`);
  setInterval(() => {}, 1 << 30);
  process.on('SIGTERM', async () => { await s.stop(); process.exit(0); });
})().catch((e) => { console.error(e); process.exit(1); });
