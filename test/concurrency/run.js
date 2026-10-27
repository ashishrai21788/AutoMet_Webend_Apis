/**
 * Concurrency harness: many real HTTP requests at the real server at the same moment, over and over, against a real temporary
 * database, with the rules of the platform checked in the DATABASE afterwards (an API reply is never accepted as proof).
 *
 *   node test/concurrency/run.js                       both engines
 *   ENGINES=mongo node test/concurrency/run.js         one engine
 *   CONC_TRIALS=100 CONC_LEVEL=8 node test/concurrency/run.js
 *
 * What it proves and what it does not (read this before quoting a result):
 *  - Mongo is a real multi-connection MongoDB (mongodb-memory-server): the races are real database races.
 *  - The Postgres engine here is an in-process PGlite with ONE connection, so the database serialises its statements. Races between a
 *    handler's read and its later write still happen (they are in the server's code), but two transactions never overlap inside Postgres.
 *    A pass on this engine does not prove behaviour on a multi-connection Postgres server.
 *  - A fixed number of passing trials does not prove there is no race. Every run prints how many trials ran and how each race went, so a
 *    scenario in which only one side ever won (the race was not really exercised) is visible.
 *
 * Dispatch is one driver at a time (lib/dispatch.js), so the invariants are about: one driver never holding two offers or rides, an accept
 * racing a cancel, a late accept after the offer moved on, a double tap, and completing a ride twice.
 */
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('../contract/harness');

const TRIALS = Number(process.env.CONC_TRIALS || 25);
const LEVEL = Math.max(2, Number(process.env.CONC_LEVEL || 6));
const ENGINES = (process.env.ENGINES || 'mongo,postgres').split(',').map((s) => s.trim()).filter(Boolean);
const SECRET = 'contract-scheduler-secret';
const OTP = '123456';
const ACTIVE = ['REQUESTED', 'ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];
const PICKUP = { lat: 28.5746, lng: 77.4858 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hist = (arr) => arr.reduce((m, k) => { m[k] = (m[k] || 0) + 1; return m; }, {});

async function setup(engine) {
  const drivers = 4;
  const riders = LEVEL + 2;
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

// ---------------------------------------------------------------- scenarios: each returns { violations: [], outcome: label }

const scenarios = {
  /** Several riders ask for the same only-free driver at the same moment: that driver may hold at most one offer. */
  async 'one free driver, many riders at once'(w) {
    await resetWorld(w, [0]);
    const made = await Promise.all(w.riders.slice(0, LEVEL).map((r) => request(w, r)));
    await sleep(300);
    const trips = await tripsNow(w);
    const violations = [];
    const held = heldBy(trips, w.drivers[0].id);
    if (held.length > 1) violations.push(`driver 0 holds ${held.length} offers or rides at once: ${held.map((t) => t.trip_id).join(', ')}`);
    const fiveXX = made.filter((m) => m.status >= 500);
    if (fiveXX.length) violations.push(`${fiveXX.length} request(s) answered with a server error`);
    return { violations, outcome: `offers held by the driver: ${held.length}`, statuses: made.map((m) => m.status) };
  },

  /** One driver taps Accept many times at once: one acceptance, the rest harmless. */
  async 'double tap: one driver accepts the same offer many times'(w) {
    await resetWorld(w, [0]);
    const made = await request(w, w.riders[0]);
    const tripId = made.body.trip_id || (made.body.data || {}).trip_id;
    if (!tripId) return { violations: [`no trip was created: ${made.status} ${JSON.stringify(made.body).slice(0, 120)}`], outcome: 'setup failed' };
    const replies = await Promise.all(Array.from({ length: LEVEL }, () => respond(w, w.drivers[0], tripId, 'ACCEPTED')));
    const trips = await tripsNow(w);
    const t = trips.find((x) => x.trip_id === tripId);
    const violations = [];
    if (!t || t.status !== 'ACCEPTED' || t.driver_id !== w.drivers[0].id) violations.push(`the trip ended as ${t && t.status} for ${t && t.driver_id}, expected ACCEPTED for driver 0`);
    if (replies.some((r) => r.status >= 500)) violations.push('an accept answered with a server error');
    if (heldBy(trips, w.drivers[0].id).length > 1) violations.push('the driver holds more than one ride');
    return { violations, outcome: `accept answers: ${JSON.stringify(hist(replies.map((r) => r.status)))}` };
  },

  /** The rider cancels while the driver accepts: exactly one wins, and what each caller was told matches the database. */
  async 'accept versus cancel at the same moment'(w) {
    await resetWorld(w, [0]);
    const made = await request(w, w.riders[0]);
    const tripId = made.body.trip_id || (made.body.data || {}).trip_id;
    if (!tripId) return { violations: ['no trip was created'], outcome: 'setup failed' };
    const [accept, cancel] = await Promise.all([
      respond(w, w.drivers[0], tripId, 'ACCEPTED'),
      w.api('POST', '/api/v1/trips/cancel-request', { trip_id: tripId, cancelled_by: 'USER' }, w.riders[0].token, w.appId)
    ]);
    const t = (await tripsNow(w)).find((x) => x.trip_id === tripId);
    const violations = [];
    const acceptOk = accept.status === 200 && ((accept.body.data || {}).status === 'ACCEPTED' || accept.body.success === true);
    const cancelOk = cancel.status === 200;
    if (!t) violations.push('the trip vanished');
    else if (t.status === 'ACCEPTED' && cancelOk) violations.push('the rider was told the cancel worked, but the trip is ACCEPTED');
    else if (/^CANCELLED/.test(t.status) && acceptOk) violations.push('the driver was told the accept worked, but the trip is cancelled');
    else if (!['ACCEPTED'].includes(t.status) && !/^CANCELLED/.test(t.status)) violations.push(`unexpected final status ${t.status}`);
    if (accept.status >= 500 || cancel.status >= 500) violations.push('a server error');
    return { violations, outcome: t ? (t.status === 'ACCEPTED' ? 'accept won' : 'cancel won') : 'lost' };
  },

  /** The offer times out and moves to the next driver; the first driver then accepts late while the second accepts too. */
  async 'late accept after the offer moved to the next driver'(w) {
    await resetWorld(w, [0, 1]);
    const made = await request(w, w.riders[0]);
    const tripId = made.body.trip_id || (made.body.data || {}).trip_id;
    if (!tripId) return { violations: ['no trip was created'], outcome: 'setup failed' };
    const before = (await tripsNow(w)).find((x) => x.trip_id === tripId);
    await w.s.patch('trip_details', { trip_id: tripId }, { timeout_at: new Date(Date.now() - 60_000) });
    await w.api('POST', '/api/v1/trips/check-timeouts', {}, null, w.appId, { 'x-scheduler-secret': SECRET });
    await sleep(200);
    const mid = (await tripsNow(w)).find((x) => x.trip_id === tripId);
    const [a, b] = await Promise.all([respond(w, w.drivers[0], tripId, 'ACCEPTED'), respond(w, w.drivers[1], tripId, 'ACCEPTED')]);
    const trips = await tripsNow(w);
    const t = trips.find((x) => x.trip_id === tripId);
    const violations = [];
    const winners = [[w.drivers[0], a], [w.drivers[1], b]].filter(([, r]) => r.status === 200 && ((r.body.data || {}).status === 'ACCEPTED' || r.body.success === true));
    if (t && t.status === 'ACCEPTED') {
      if (!winners.some(([d]) => d.id === t.driver_id)) violations.push(`the trip is ACCEPTED by ${t.driver_id}, but that driver was not told it won`);
      if (winners.length > 1) violations.push(`both drivers were told they won (${winners.map(([d]) => d.id).join(', ')})`);
    } else if (winners.length) violations.push(`a driver was told they won, but the trip is ${t && t.status}`);
    for (const d of w.drivers) if (heldBy(trips, d.id).length > 1) violations.push(`driver ${d.index} holds more than one ride`);
    if (a.status >= 500 || b.status >= 500) violations.push('a server error');
    return { violations, outcome: `offered to ${before && before.driver_id === w.drivers[0].id ? 'driver 0' : 'another'} first; after the timeout: ${mid && mid.status}; final ${t && t.status} for ${t && t.driver_id === w.drivers[0].id ? 'driver 0' : t && t.driver_id === w.drivers[1].id ? 'driver 1' : 'nobody'}` };
  },

  /** A driver already on a ride is handed a second offer by a stale or forced state: accepting it must be refused. */
  async 'a driver on a ride cannot accept a second one'(w) {
    await resetWorld(w, [0]);
    const one = await request(w, w.riders[0]);
    const t1 = one.body.trip_id || (one.body.data || {}).trip_id;
    if (!t1) return { violations: ['no first trip'], outcome: 'setup failed' };
    await respond(w, w.drivers[0], t1, 'ACCEPTED');
    const two = await request(w, w.riders[1]);
    const t2 = two.body.trip_id || (two.body.data || {}).trip_id;
    const violations = [];
    if (t2) {
      await w.s.patch('trip_details', { trip_id: t2 }, { driver_id: w.drivers[0].id, status: 'REQUESTED', timeout_at: new Date(Date.now() + 60_000) });
      const replies = await Promise.all(Array.from({ length: 3 }, () => respond(w, w.drivers[0], t2, 'ACCEPTED')));
      const trips = await tripsNow(w);
      if (replies.some((r) => r.status === 200 && (r.body.data || {}).status === 'ACCEPTED')) violations.push('the driver was allowed to accept a second ride');
      if (heldBy(trips, w.drivers[0].id).filter((t) => t.status !== 'REQUESTED').length > 1) violations.push('the driver holds two accepted rides');
    }
    return { violations, outcome: t2 ? 'second offer forced and refused' : 'second request was not offered to the busy driver' };
  },

  /** Two completions of the same ride at once: one completion. */
  async 'completing a ride twice at once'(w) {
    await resetWorld(w, [0]);
    const made = await request(w, w.riders[0]);
    const tripId = made.body.trip_id || (made.body.data || {}).trip_id;
    if (!tripId) return { violations: ['no trip was created'], outcome: 'setup failed' };
    await respond(w, w.drivers[0], tripId, 'ACCEPTED');
    const step = (status) => w.api('PATCH', `/api/v1/rides/${tripId}/status`, { driver_id: w.drivers[0].id, status }, w.drivers[0].token, w.appId);
    for (const status of ['DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING']) await step(status);
    const done = await Promise.all(Array.from({ length: 3 }, () => step('COMPLETED')));
    const t = (await tripsNow(w)).find((x) => x.trip_id === tripId);
    const violations = [];
    if (!t || t.status !== 'COMPLETED') violations.push(`the ride ended as ${t && t.status}`);
    if (done.some((r) => r.status >= 500)) violations.push('a completion answered with a server error');
    return { violations, outcome: `completion answers: ${JSON.stringify(hist(done.map((r) => r.status)))}` };
  }
};

async function runEngine(engine) {
  const started = Date.now();
  const w = await setup(engine);
  const report = { engine, trials: TRIALS, level: LEVEL, startedAt: new Date().toISOString(), scenarios: {} };
  try {
    for (const [name, fn] of Object.entries(scenarios)) {
      const outcomes = []; const failures = [];
      for (let i = 0; i < TRIALS; i += 1) {
        let r;
        try { r = await fn(w); } catch (e) { r = { violations: [`the trial threw: ${e.message}`], outcome: 'error' }; }
        outcomes.push(r.outcome);
        if (r.violations.length) failures.push({ trial: i + 1, violations: r.violations, outcome: r.outcome });
      }
      report.scenarios[name] = { trials: TRIALS, violations: failures.length, outcomes: hist(outcomes), firstFailures: failures.slice(0, 3) };
      const flag = failures.length ? 'FAIL' : 'ok  ';
      console.log(`  ${flag} ${name.padEnd(62)} ${TRIALS - failures.length}/${TRIALS} clean   ${Object.entries(hist(outcomes)).slice(0, 3).map(([k, v]) => `${v}x ${k}`).join(' | ').slice(0, 150)}`);
      for (const f of failures.slice(0, 2)) console.log(`       trial ${f.trial}: ${f.violations.join('; ')}`);
    }
    report.finalCheck = await finalDatabaseCheck(w);
  } finally {
    report.seconds = Math.round((Date.now() - started) / 1000);
    await w.s.stop();
  }
  return report;
}

/** After everything: no driver holds two rides, no ride has two drivers' worth of acceptances, no ride is in an impossible state. */
async function finalDatabaseCheck(w) {
  const trips = await tripsNow(w);
  const problems = [];
  const byDriver = {};
  for (const t of trips) if (t.driver_id && ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'].includes(t.status)) byDriver[t.driver_id] = (byDriver[t.driver_id] || 0) + 1;
  for (const [d, n] of Object.entries(byDriver)) if (n > 1) problems.push(`driver ${d} has ${n} rides in progress`);
  const ids = trips.map((t) => t.trip_id);
  if (new Set(ids).size !== ids.length) problems.push('a trip id appears twice');
  for (const t of trips) if (t.status === 'ACCEPTED' && !t.driver_id) problems.push(`trip ${t.trip_id} is ACCEPTED with no driver`);
  return { trips: trips.length, problems };
}

(async () => {
  console.log(`Concurrency harness: ${TRIALS} trials per scenario, ${LEVEL} parallel actors, engines: ${ENGINES.join(', ')}\n`);
  const reports = [];
  let failed = false;
  for (const engine of ENGINES) {
    console.log(`== ${engine}`);
    try {
      const r = await runEngine(engine);
      reports.push(r);
      const bad = Object.values(r.scenarios).reduce((n, s) => n + s.violations, 0);
      console.log(`  final database check: ${r.finalCheck.trips} trips, ${r.finalCheck.problems.length ? 'PROBLEMS: ' + r.finalCheck.problems.join('; ') : 'no problems'}   (${r.seconds}s)\n`);
      if (bad || r.finalCheck.problems.length) failed = true;
    } catch (e) {
      console.error(`  the ${engine} run could not complete: ${e.message}\n`);
      failed = true;
    }
  }
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(reports, null, 2));
  console.log(`report saved: ${path.relative(process.cwd(), file)}`);
  console.log(failed ? 'RESULT: violations or errors found (see above)' : 'RESULT: no violations in the trials that ran (this is not a proof that no race exists)');
  process.exit(failed ? 1 : 0);
})();
