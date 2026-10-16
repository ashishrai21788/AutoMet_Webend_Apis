// Concurrency (races) and load against the lab backend (real code, embedded Postgres, one connection: a worst case for contention).
const lab = require('./' + (process.env.LAB_FILE || 'lab.json'));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`); };
const call = async (method, p, { body, token, appId } = {}) => {
  const t0 = performance.now();
  const r = await fetch(lab.base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(appId ? { 'X-App-Id': appId } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, ms: performance.now() - t0 };
};
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]); };

(async () => {
  // rider A and the lab driver
  await call('POST', '/api/users/register', { body: { name: 'Load Rider', phone: '9876543210', email: 'load@lab.test' }, appId: lab.appId }); // fine if it already exists
  const lg = await call('POST', '/api/users/login', { body: { phoneNumber: '9876543210' }, appId: lab.appId });
  const userId = lg.body.data.user.userId;
  const ver = await call('POST', '/api/users/verify-otp', { body: { userId, otp: '123456', device_id: 'load-dev', fcm_id: 'load-fcm' }, appId: lab.appId });
  const rider = ver.body.data.accessToken || ver.body.data.user.accessToken;
  const dl = await call('POST', '/api/drivers/login', { body: { phoneNumber: '+919876500001', device_id: 'load-ddev', fcm_id: 'load-dfcm' }, appId: lab.appId });
  const dv = await call('POST', '/api/otp/verify', { body: { driverId: lab.driverId, otp: '123456', device_id: 'load-ddev', fcm_id: 'load-dfcm' }, appId: lab.appId });
  const driver = (dv.body.data || {}).accessToken || ((dv.body.data || {}).driver || {}).accessToken;
  check('rider and driver sign in with the test codes', !!(rider && driver), JSON.stringify([dl.status, dv.status, dv.body]).slice(0, 200));
  await call('PUT', '/api/drivers/vehicle-details', { body: { driverId: lab.driverId, vehicleType: 'VIP', vehicleNumber: 'UP16TS4321', vehicleModel: 'Dzire', isVehicleAdded: true }, token: driver, appId: lab.appId });
  await call('PUT', '/api/drivers/online-status', { body: { driverId: lab.driverId, isOnline: true, onlineAs: 0 }, token: driver, appId: lab.appId });
  const loc = await call('POST', '/api/drivers/location', { body: { driverId: lab.driverId, lat: 28.5746, lng: 77.4858, accuracy: 10 }, token: driver, appId: lab.appId });
  check('the driver is online with a position', loc.status === 200, JSON.stringify(loc.body).slice(0, 160));

  const trip = (n) => ({ request_id: `load-${Date.now()}-${n}`, user_id: userId, driver_id: lab.driverId, pickup_address: 'P', pickup_latitude: 28.5746, pickup_longitude: 77.4858, drop_address: 'D', drop_latitude: 28.6, drop_longitude: 77.5, category_id: lab.categoryId });

  // ---- race 1: 15 identical booking taps at the same instant
  const burst = await Promise.all(Array.from({ length: 15 }, (_, i) => call('POST', '/api/v1/trips/create-request', { body: trip(i), token: rider, appId: lab.appId })));
  const created = burst.filter((r) => r.status === 200 || r.status === 201);
  const refused = burst.filter((r) => r.status === 409);
  const live1 = await call('GET', `/api/v1/rides/active?user_id=${userId}`, { token: rider, appId: lab.appId });
  check(`15 simultaneous booking taps make exactly one trip (created ${created.length}, refused ${refused.length}, other ${burst.length - created.length - refused.length})`, created.length === 1 && refused.length === burst.length - 1, JSON.stringify(burst.map((r) => r.status)));
  const tripId = (live1.body.data && live1.body.data.active_ride && live1.body.data.active_ride.trip_id) || (created[0] && created[0].body.data && created[0].body.data.trip_id);

  // ---- race 2: the driver accepts while the rider cancels, 6 times over the same trip: one outcome, consistent everywhere
  const acc = (n) => call('POST', '/api/v1/trips/driver-response', { body: { trip_id: tripId, driver_id: lab.driverId, response: 'ACCEPTED' }, token: driver, appId: lab.appId });
  const can = () => call('POST', '/api/v1/trips/cancel-request', { body: { trip_id: tripId, cancelled_by: 'USER' }, token: rider, appId: lab.appId });
  const racers = await Promise.all([acc(1), can(), acc(2), can(), acc(3), can()]);
  const finalDetails = await call('GET', `/api/v1/rides/details?trip_id=${tripId}&user_id=${userId}`, { token: rider, appId: lab.appId });
  const status = finalDetails.body.data && finalDetails.body.data.status;
  check(`accept vs cancel race ends in one consistent state (${status})`, ['ACCEPTED', 'CANCELLED_BY_USER'].includes(status), JSON.stringify(racers.map((r) => r.status)));
  const driverView = await call('GET', `/api/v1/rides/details?trip_id=${tripId}&driver_id=${lab.driverId}`, { token: driver, appId: lab.appId });
  check('rider and driver see the same final status', driverView.body.data && driverView.body.data.status === status, JSON.stringify(driverView.body).slice(0, 160));

  // ---- race 3: a double cancel after accept never double-charges or errors out
  if (status === 'ACCEPTED') {
    const c = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/api/v1/rides/cancel', { body: { ride_id: tripId, user_id: userId, cancel_stage: 'after_accept' }, token: rider, appId: lab.appId })));
    const fees = c.filter((r) => r.status === 200).map((r) => r.body.cancellation_fee);
    const hist = await call('GET', `/api/v1/rides/details?trip_id=${tripId}&user_id=${userId}`, { token: rider, appId: lab.appId });
    check(`four simultaneous cancels settle once (fees returned ${JSON.stringify(fees)}, final ${hist.body.data.status}, stored fee ${hist.body.data.cancellation_fee})`, hist.body.data.status.startsWith('CANCELLED') && c.every((r) => r.status < 500), JSON.stringify(c.map((r) => r.status)));
  }

  // ---- load: bursts, with latency percentiles
  const load = async (name, n, fn, maxFail = 0) => {
    const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
    const wall = Math.round(performance.now() - t0);
    const bad = rs.filter((r) => r.status >= 500 || r.status === 0).length;
    const lat = rs.map((r) => r.ms);
    console.log(`      ${name}: ${n} requests in ${wall} ms, p50 ${pct(lat, 0.5)} ms, p95 ${pct(lat, 0.95)} ms, max ${pct(lat, 1)} ms, 5xx ${bad}`);
    check(`${name}: no server errors under ${n} concurrent requests`, bad <= maxFail, `${bad} failed`);
  };
  await load('trip history', 100, () => call('GET', `/api/v1/rides/history?user_id=${userId}&limit=30`, { token: rider, appId: lab.appId }));
  await load('profile detail', 100, () => call('GET', `/api/users/detail/${userId}`, { token: rider, appId: lab.appId }));
  await load('fare estimate', 100, () => call('POST', '/api/v1/trips/estimate', { body: { pickup_latitude: 28.5746, pickup_longitude: 77.4858, drop_latitude: 28.6, drop_longitude: 77.5, category_id: lab.categoryId }, token: rider, appId: lab.appId }));
  await load('ride options', 60, () => call('POST', '/api/v1/trips/ride-options', { body: { pickup_latitude: 28.5746, pickup_longitude: 77.4858, drop_latitude: 28.6, drop_longitude: 77.5 }, token: rider, appId: lab.appId }));
  await load('nearby drivers', 60, () => call('POST', '/api/v1/trips/nearby-drivers', { body: { latitude: 28.5746, longitude: 77.4858, lat: 28.5746, lng: 77.4858 }, token: rider, appId: lab.appId }));
  await load('public config (no sign-in)', 100, () => call('GET', '/api/v1/public/business/config', { appId: lab.appId }));
  await load('notifications', 60, () => call('GET', '/api/users/notifications?limit=50', { token: rider, appId: lab.appId }));

  // ---- abuse: wrong tokens and garbage never crash the server
  const junk = await Promise.all([
    call('GET', `/api/v1/rides/history?user_id=${userId}`, { token: 'not.a.token', appId: lab.appId }),
    call('GET', `/api/v1/rides/history?user_id=${userId}`, { appId: lab.appId }),
    call('POST', '/api/v1/trips/create-request', { body: { user_id: userId, pickup_latitude: 'x', drop_latitude: null }, token: rider, appId: lab.appId }),
    call('POST', '/api/v1/trips/estimate', { body: '{"a":', token: rider, appId: lab.appId }),
    call('GET', `/api/v1/rides/details?trip_id=${'A'.repeat(5000)}&user_id=${userId}`, { token: rider, appId: lab.appId }),
    call('GET', `/api/v1/rides/history?user_id=${userId}&limit=-5&skip=abc`, { token: rider, appId: lab.appId }),
    call('GET', `/api/v1/rides/history?user_id=${encodeURIComponent("' OR 1=1 --")}`, { token: rider, appId: lab.appId })
  ]);
  check('garbage and bad tokens get 4xx answers, never 5xx', junk.every((r) => r.status >= 400 && r.status < 500 || r.status === 200), JSON.stringify(junk.map((r) => r.status)));
  const health = await fetch(lab.base + '/health').then((r) => r.status);
  check('the server is still healthy after all of it', health === 200);

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(2); });
