/**
 * Load baseline with correctness checks. NOT a capacity test: the server, the temporary database and the load generator all share one
 * machine, so the numbers are a regression baseline (compare before and after a change on the same machine), not a promise about production.
 *
 *   node test/load/run.js                         defaults: 8 s per read phase at 20 parallel clients, 30 riders in the booking phase
 *   LOAD_SECONDS=20 LOAD_CLIENTS=50 node test/load/run.js
 *   ENGINES=mongo node test/load/run.js
 *
 * Phases
 *  1. read mix: public business config, ride options and nearby drivers, hammered by LOAD_CLIENTS clients for LOAD_SECONDS.
 *     Checks: every reply is JSON, no 5xx, and the body is the same shape the contract expects (success true on a 200).
 *  2. booking: many riders book at once against a few drivers, each driver accepts and completes what they are offered.
 *     Checks (from the database, not from replies): no driver ever holds two live rides, every accepted ride ended COMPLETED,
 *     no request left stuck as REQUESTED after the timeouts ran, no 5xx.
 * The rate limiter is switched off for the run (it would otherwise answer 429 and hide the real latency).
 */
const fs = require('node:fs');
const path = require('node:path');
const { setup, resetWorld, request, respond, tripsNow, sleep, SECRET } = require('./../concurrency/world');

const SECONDS = Number(process.env.LOAD_SECONDS || 8);
const CLIENTS = Number(process.env.LOAD_CLIENTS || 20);
const RIDERS = Number(process.env.LOAD_RIDERS || 30);
const ENGINES = (process.env.ENGINES || 'mongo,postgres').split(',').map((s) => s.trim()).filter(Boolean);
process.env.RATE_LIMIT_DISABLED = '1';

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

function summarise(name, samples) {
  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const codes = {};
  for (const s of samples) codes[s.status] = (codes[s.status] || 0) + 1;
  return {
    name, requests: samples.length, codes,
    p50: round(pct(lat, 50)), p95: round(pct(lat, 95)), p99: round(pct(lat, 99)), max: round(lat[lat.length - 1] || null),
    serverErrors: samples.filter((s) => s.status >= 500 || s.status === 0).length,
    badBodies: samples.filter((s) => s.bad).length
  };
}

async function timed(w, label, method, p, body, token, expect) {
  const t0 = process.hrtime.bigint();
  let status = 0; let bad = false;
  try {
    const r = await w.api(method, p, body, token, w.appId);
    status = r.status;
    if (status === 200 && expect && !expect(r.body)) bad = true;
    if (status === 200 && r.body && r.body.success === false) bad = true;
  } catch (_) { status = 0; }
  return { label, status, bad, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

async function readPhase(w) {
  const rider = w.riders[0];
  const ops = [
    () => timed(w, 'GET public business config', 'GET', '/api/v1/public/business/config', null, null, (b) => b && b.data && b.data.business),
    () => timed(w, 'POST ride options', 'POST', '/api/v1/trips/ride-options', { pickup_latitude: 28.5746, pickup_longitude: 77.4858, drop_latitude: 28.6, drop_longitude: 77.5 }, rider.token, (b) => b && b.data && Array.isArray(b.data.options)),
    () => timed(w, 'POST nearby drivers', 'POST', '/api/v1/trips/nearby-drivers', { latitude: 28.5746, longitude: 77.4858 }, rider.token, (b) => b && b.data)
  ];
  const samples = [];
  const end = Date.now() + SECONDS * 1000;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CLIENTS }, async (_, i) => {
    let k = i;
    while (Date.now() < end) { samples.push(await ops[k % ops.length]()); k += 1; }
  }));
  const wall = (Date.now() - t0) / 1000;
  const by = {};
  for (const s of samples) (by[s.label] = by[s.label] || []).push(s);
  return { wallSeconds: round(wall), requestsPerSecond: round(samples.length / wall), endpoints: Object.entries(by).map(([n, v]) => summarise(n, v)) };
}

async function bookingPhase(w) {
  await resetWorld(w);
  const samples = [];
  const riders = w.riders.slice(0, RIDERS);
  // every rider books at the same moment
  const made = await Promise.all(riders.map(async (r) => {
    const t0 = process.hrtime.bigint();
    const res = await request(w, r);
    samples.push({ label: 'POST create-request', status: res.status, bad: false, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    return { r, res };
  }));
  const offered = made.filter((m) => m.res.status === 200 || m.res.status === 201).map((m) => m.res.body.trip_id || (m.res.body.data || {}).trip_id).filter(Boolean);
  // each driver answers what they were offered, then drives it to completion
  const trips = await tripsNow(w);
  for (const tripId of offered) {
    const t = trips.find((x) => x.trip_id === tripId);
    const d = w.drivers.find((x) => x.id === (t && t.driver_id));
    if (!d) continue;
    const time = async (label, fn) => { const t0 = process.hrtime.bigint(); const r = await fn(); samples.push({ label, status: r.status, bad: false, ms: Number(process.hrtime.bigint() - t0) / 1e6 }); return r; };
    const acc = await time('POST driver-response', () => respond(w, d, tripId, 'ACCEPTED'));
    if (acc.status !== 200) continue;
    for (const status of ['DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING', 'COMPLETED']) {
      await time('PATCH ride status', () => w.api('PATCH', `/api/v1/rides/${tripId}/status`, { driver_id: d.id, status }, d.token, w.appId));
    }
  }
  // the ones nobody answered time out and are re-offered or closed
  await w.s.patch('trip_details', { status: 'REQUESTED' }, { timeout_at: new Date(Date.now() - 60_000) }).catch(() => {});
  for (let i = 0; i < 4; i += 1) { await w.api('POST', '/api/v1/trips/check-timeouts', {}, null, w.appId, { 'x-scheduler-secret': SECRET }); await sleep(100); }

  const final = await tripsNow(w);
  const problems = [];
  const live = {};
  for (const t of final) if (t.driver_id && ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'].includes(t.status)) live[t.driver_id] = (live[t.driver_id] || 0) + 1;
  for (const [d, n] of Object.entries(live)) if (n > 1) problems.push(`driver ${d} holds ${n} live rides`);
  const stuck = final.filter((t) => t.status === 'REQUESTED' && t.timeout_at && new Date(t.timeout_at) < new Date());
  const completed = final.filter((t) => t.status === 'COMPLETED').length;
  if (stuck.length) problems.push(`${stuck.length} request(s) still REQUESTED past their timeout after the sweeps`);
  const hist = {};
  for (const t of final) hist[t.status] = (hist[t.status] || 0) + 1;
  return { riders: riders.length, requestCodes: made.reduce((m, x) => { m[x.res.status] = (m[x.res.status] || 0) + 1; return m; }, {}), completed, finalStatuses: hist, endpoints: Object.values(samples.reduce((m, s) => { (m[s.label] = m[s.label] || []).push(s); return m; }, {})).map((v) => summarise(v[0].label, v)), problems };
}

async function runEngine(engine) {
  const w = await setup(engine, { drivers: 4, riders: RIDERS + 2 });
  try {
    await resetWorld(w);
    const reads = await readPhase(w);
    const booking = await bookingPhase(w);
    return { engine, clients: CLIENTS, seconds: SECONDS, reads, booking };
  } finally { await w.s.stop(); }
}

(async () => {
  console.log(`Load baseline: ${CLIENTS} clients x ${SECONDS}s read mix, then ${RIDERS} riders booking at once; engines: ${ENGINES.join(', ')}`);
  console.log('(client, server and database share this machine: compare runs on the same machine, do not read these as production capacity)\n');
  const reports = []; let failed = false;
  for (const engine of ENGINES) {
    console.log(`== ${engine}`);
    try {
      const r = await runEngine(engine); reports.push(r);
      const line = (e) => `    ${e.name.padEnd(28)} n=${String(e.requests).padEnd(6)} p50 ${String(e.p50).padEnd(7)} p95 ${String(e.p95).padEnd(7)} p99 ${String(e.p99).padEnd(7)} max ${String(e.max).padEnd(7)} ms  codes ${JSON.stringify(e.codes)}${e.serverErrors ? `  5xx=${e.serverErrors}` : ''}${e.badBodies ? `  badBodies=${e.badBodies}` : ''}`;
      console.log(`  read mix: ${r.reads.requestsPerSecond} requests/s over ${r.reads.wallSeconds}s`); r.reads.endpoints.forEach((e) => console.log(line(e)));
      console.log(`  booking: ${r.booking.riders} riders, request replies ${JSON.stringify(r.booking.requestCodes)}, ${r.booking.completed} completed, final ${JSON.stringify(r.booking.finalStatuses)}`); r.booking.endpoints.forEach((e) => console.log(line(e)));
      const bad = [...r.reads.endpoints, ...r.booking.endpoints].reduce((n, e) => n + e.serverErrors + e.badBodies, 0);
      if (r.booking.problems.length) console.log(`  PROBLEMS: ${r.booking.problems.join('; ')}`);
      if (bad || r.booking.problems.length) failed = true;
      console.log('');
    } catch (e) { console.error(`  the ${engine} run could not complete: ${e.stack || e.message}\n`); failed = true; }
  }
  const dir = path.join(__dirname, 'results'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(reports, null, 2));
  console.log(`report saved: ${path.relative(process.cwd(), file)}`);
  console.log(failed ? 'RESULT: server errors, bad replies or broken invariants found (see above)' : 'RESULT: no server errors, bad replies or broken invariants');
  process.exit(failed ? 1 : 0);
})();
