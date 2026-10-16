/**
 * LOCAL LAB. The real backend (index.js) on an embedded Postgres, on this PC only, with a Noida business set up through the
 * real admin API: a region, a "VIP" category, a fare rule, a cancellation policy with real fees, an approved test driver with a
 * vehicle. Nothing here touches production. Writes lab.json (port, appId) and then stays alive.
 *
 * Test sign-in numbers come from the project's own test-login list (lib/testLogin): 9876500001 (driver), 9876543210 (rider);
 * their fixed code is the project's built-in test code. They exist only inside this throw-away database.
 */
const fs = require('node:fs');
const path = require('node:path');
const backend = path.join(__dirname, '..', '..');
const { start } = require(path.join(backend, 'test/contract/harness.js'));

(async () => {
  const s = await start({ engine: 'postgres', env: { TEST_LOGIN_DISABLED: '' } });
  const api = async (method, p, body, token, appId) => {
    const r = await fetch(s.base + p, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(appId ? { 'X-App-Id': appId } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (r.status >= 400) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  };
  const owner = (await api('POST', '/api/admin/auth/login', { email: 'owner@contract.test', password: 'Contract-Owner-Pass-1' })).data.token;
  const appId = (await api('GET', '/api/admin/tenants', null, owner)).data[0].appId;
  const ca = await api('POST', '/api/admin/users', { name: 'Lab Admin', email: 'admin@lab.test', role: 'client_admin', tenantId: appId }, owner);
  const first = await api('POST', '/api/admin/auth/login', { email: 'admin@lab.test', password: ca.data.temporaryPassword });
  const admin = (await api('POST', '/api/admin/auth/change-password', { currentPassword: ca.data.temporaryPassword, newPassword: 'Lab-Admin-Pass-1' }, first.data.token)).data.token;
  const biz = (m, p, b) => api(m, p, b, admin, appId);

  await biz('PUT', '/api/admin/business/market', { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' });
  const reg = await biz('POST', '/api/admin/business/regions', { state: 'Uttar Pradesh', cities: [{ name: 'Noida', lat: 28.5746, lng: 77.4858 }], zoneName: 'All areas', radiusKm: 80 });
  const regionId = reg.data.created[0].id;
  const cat = await biz('POST', '/api/admin/business/categories', { name: 'VIP', passengerCapacity: 4, rideType: 'economy', regionIds: [regionId] });
  const categoryId = cat.data.id;
  await biz('PUT', '/api/admin/business/fare-rules', { categoryId, regionId, baseFare: 10, perKm: 10, perMinute: 10, minimumFare: 50, bookingFee: 0, waitingFreeMinutes: 3, waitingPerMinute: 1.5 });
  // a real cancellation policy: free for 1 minute after accepting, then 30; 50 once the driver has arrived
  await biz('PUT', '/api/admin/business/cancellation-policies', { categoryId, regionId, rider: { freeCancellationMinutes: 1, feeAfterWindow: 30, feeAfterDriverArrived: 50, noShowFee: 60 }, driver: { penaltyFee: 0, graceCancellations: 3 }, conditions: '' });
  const drv = await biz('POST', '/api/admin/business/drivers', { fullName: 'Test Onboarding', phone: '+919876500001', email: 'driver@lab.test', dateOfBirth: '1990-04-02', address: { country: 'IN', state: 'Uttar Pradesh', city: 'Noida', line: '1 Main Road' }, operatingRegionId: regionId, eligibleCategoryId: categoryId });
  const driverId = drv.data.id;
  const veh = await biz('POST', '/api/admin/business/vehicles', { registrationNumber: 'UP16TS4321', make: 'Maruti', model: 'Dzire', year: 2021, colour: 'White', categoryId, passengerCapacity: 4, luggageCapacity: 2, operatingRegionId: regionId, status: 'ACTIVE' });
  await biz('POST', `/api/admin/business/drivers/${driverId}/assign-vehicle`, { vehicleId: veh.data.id });
  await s.patch('drivers', { driverId }, { driverVerificationStatus: 'APPROVED', accountStatus: 'ACTIVE' });
  await s.patch('vehicles', { vehicleId: veh.data.id }, { verificationStatus: 'APPROVED' });

  const port = new URL(s.base).port;
  fs.writeFileSync(path.join(__dirname, process.env.LAB_OUT || 'lab.json'), JSON.stringify({ port, base: s.base, appId, regionId, categoryId, driverId, vehicleId: veh.data.id, admin, owner }));
  console.log('LAB READY port', port, 'appId', appId, 'driverId', driverId);
  setInterval(() => {}, 1 << 30);
  process.on('SIGTERM', async () => { await s.stop(); process.exit(0); });
})().catch((e) => { console.error('LAB FAILED:', e.message); process.exit(1); });
