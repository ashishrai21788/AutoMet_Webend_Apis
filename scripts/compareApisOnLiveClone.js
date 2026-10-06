/**
 * Runs the same API calls against two LOCAL copies of the live data, one on MongoDB and one on Postgres, and compares them.
 *
 *   node scripts/compareApisOnLiveClone.js
 *
 * Safety:
 *  - The live database is only READ (listCollections / find) once at the start. Nothing is ever written to it.
 *  - Both servers run locally on throw-away copies; the live data is held in memory only and nothing is saved to disk.
 *  - To sign in to the copies, a known password is set on a super-admin of the COPY (never on the live database).
 *  - Output is step names, HTTP statuses and field PATHS that differ. Field values are never printed.
 */
process.env.DB_ENGINE = 'postgres'; // this process hosts the Postgres copy; the Mongo copy is a separate server process
process.env.DATABASE_URL = 'pglite:memory';
require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');
const clientModule = require('../lib/db/postgres/client');
const mongoose = require('../lib/db/mongoose');
const { start, makeNormaliser } = require('../test/contract/harness');

for (const f of fs.readdirSync(path.join(__dirname, '..', 'models'))) if (f.endsWith('.js')) require(path.join(__dirname, '..', 'models', f));
const { createModel } = require('../models/dynamicModel');
createModel('drivers'); createModel('users');

const { MONGODB_USERNAME: u, MONGODB_PASSWORD: p, MONGODB_CLUSTER: c, DB_NAME: dbName } = process.env;
if (!u || !p || !c || !dbName) { console.error('The Atlas variables are not set in .env.'); process.exit(2); }
const LIVE = `mongodb+srv://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${c}/?retryWrites=false&appName=AutoMetReadOnlyCheck`;
const KNOWN_PASSWORD = 'Clone-Check-Pass-1';

async function readLive() {
  const client = await MongoClient.connect(LIVE, { serverSelectionTimeoutMS: 20000, readPreference: 'secondaryPreferred' });
  const db = client.db(dbName);
  const data = {};
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    data[name] = await db.collection(name).find({}).toArray(); // read only
  }
  await client.close();
  return data;
}

async function patchedAdmins(data) {
  const hash = await bcrypt.hash(KNOWN_PASSWORD, 10);
  const owner = (data.admin_users || []).find((a) => a.role === 'super_admin');
  if (!owner) throw new Error('no super_admin in the live data');
  // only the COPY gets a known password; 2FA and lock state are cleared there so the checker can sign in
  // every admin of the COPY gets the known password (so each business admin can be signed in); live is untouched
  for (const a of data.admin_users) Object.assign(a, { passwordHash: hash, mustChangePassword: false, active: true, failedLogins: 0, lockUntil: null, totpEnabled: false, totpSecret: null, totpPending: null });
  // a business with no business admin gets one on the COPY, so that business's screens can be exercised
  const template = data.admin_users.find((x) => x.role === 'client_admin');
  if (template) {
    for (const [i, t] of (data.tenants || []).entries()) {
      if (data.admin_users.some((x) => x.role === 'client_admin' && x.tenantId === t.tenantId)) continue;
      const { _id, ...rest } = template;
      data.admin_users.push({ ...rest, adminId: `adm_clone_${i}`, email: `clone${i}@clone.test`, name: 'Clone Admin', tenantId: t.tenantId, createdAt: new Date(new Date(template.createdAt).getTime() + (i + 1) * 60000) }); // a distinct time: Mongo does not order ties
    }
  }
  return { owner: owner.email, admins: data.admin_users.filter((a) => a.role === 'client_admin').map((a) => ({ email: a.email, tenantId: a.tenantId })) };
}

// ---- the calls (reads on every screen of the dashboard and the apps, plus a rider and a driver sign-in on the copy)
async function scenario(t, who) {
  const { call, peek } = t;
  const ownerEmail = who.owner;
  const login = await call('admin: login', { method: 'POST', path: '/api/admin/auth/login', body: { email: ownerEmail, password: KNOWN_PASSWORD } });
  const owner = login.body && login.body.data && login.body.data.token;
  if (!owner) throw new Error(`could not sign in to the copy (HTTP ${login.status}; fields: ${Object.keys((login.body && login.body.data) || {}).join(',')})`);
  await call('admin: me', { path: '/api/admin/auth/me', token: owner });
  const tenants = (await call('platform: tenants', { path: '/api/admin/tenants', token: owner })).body.data || [];
  for (const [pth, name] of [['/api/admin/dashboard', 'platform dashboard'], ['/api/admin/platform/overview', 'platform overview'], ['/api/admin/platform/audit', 'platform audit'],
    ['/api/admin/audit', 'audit'], ['/api/admin/users', 'admin users'], ['/api/admin/platform/team', 'platform team'], ['/api/admin/platform/plans', 'plans'],
    ['/api/admin/platform/settings', 'platform settings'], ['/api/admin/platform/revenue/summary', 'revenue summary'], ['/api/admin/platform/invoices', 'invoices'],
    ['/api/admin/platform/invoices.csv', 'invoices csv']]) await call(`platform: ${name}`, { path: pth, token: owner });

  for (const [i, tn] of tenants.entries()) {
    const id = tn.appId || tn.tenantId;
    const tag = `business ${i + 1}`;
    await call(`${tag}: billing`, { path: `/api/admin/tenants/${id}/billing`, token: owner });
    await call(`${tag}: export`, { path: `/api/admin/tenants/${id}/export`, token: owner });
    const H = { 'X-App-Id': id };
    // business screens are used by that business's admin, not by the platform owner
    const ca = who.admins.find((a) => a.tenantId === id);
    let bizToken = owner;
    if (ca) {
      const l = await call(`${tag}: business admin login`, { method: 'POST', path: '/api/admin/auth/login', body: { email: ca.email, password: KNOWN_PASSWORD } });
      bizToken = (l.body && l.body.data && l.body.data.token) || owner;
    }
    const get = (name, pth) => call(`${tag}: ${name}`, { path: pth, token: bizToken, headers: H });
    for (const [name, pth] of [['profile', '/api/admin/business'], ['overview', '/api/admin/business/overview'], ['regions', '/api/admin/business/regions'], ['categories', '/api/admin/business/categories'],
      ['fare rules', '/api/admin/business/fare-rules'], ['policies', '/api/admin/business/cancellation-policies'], ['requirements', '/api/admin/business/requirements'],
      ['ride settings', '/api/admin/business/ride-settings'], ['availability', '/api/admin/business/availability'], ['stats', '/api/admin/business/stats'], ['alerts', '/api/admin/business/alerts'],
      ['live map', '/api/admin/business/live-map'], ['reports', '/api/admin/business/reports/summary'], ['audit', '/api/admin/business/audit'], ['audit csv', '/api/admin/business/audit.csv'],
      ['trips csv', '/api/admin/business/export/trips.csv'], ['riders csv', '/api/admin/business/export/riders.csv'], ['drivers csv', '/api/admin/business/export/drivers.csv'],
      ['support issues', '/api/admin/business/support/issues'], ['team', '/api/admin/users']]) await get(name, pth);
    const lists = {};
    for (const [key, pth] of [['drivers', '/api/admin/business/drivers'], ['vehicles', '/api/admin/business/vehicles'], ['riders', '/api/admin/business/riders'], ['trips', '/api/admin/business/trips']]) {
      const r = await get(`${key} list`, pth);
      lists[key] = (r.body && r.body.data && (r.body.data.items || r.body.data)) || [];
    }
    await get('trips filtered', '/api/admin/business/trips?status=COMPLETED');
    await get('drivers filtered', '/api/admin/business/drivers?status=ACTIVE');
    const idOf = (x) => x && (x.id || x.tripId || x.trip_id || x.userId || x.driverId || x.vehicleId);
    for (const [key, base] of [['drivers', '/api/admin/business/drivers/'], ['vehicles', '/api/admin/business/vehicles/'], ['riders', '/api/admin/business/riders/'], ['trips', '/api/admin/business/trips/']]) {
      for (const [n, item] of (Array.isArray(lists[key]) ? lists[key] : []).slice(0, 4).entries()) {
        const rid = idOf(item);
        if (!rid) continue;
        await get(`${key.slice(0, -1)} ${n + 1}`, `${base}${rid}`);
        if (key === 'drivers' || key === 'vehicles') { await get(`${key.slice(0, -1)} ${n + 1} history`, `${base}${rid}/history`); await get(`${key.slice(0, -1)} ${n + 1} documents`, `${base}${rid}/documents`); }
      }
    }
    const issues = (await get('support list again', '/api/admin/business/support/issues')).body;
    const list = (issues && issues.data && (issues.data.items || issues.data)) || [];
    if (Array.isArray(list) && list[0] && (list[0].id || list[0].issueId)) await get('support issue 1', `/api/admin/business/support/issues/${list[0].id || list[0].issueId}`);
  }

  // ---- the rider app, signed in on the copy (the code is read from the copy's own database)
  const rider = await peek('users', {});
  if (rider && rider.phone) {
    await call('rider: login', { method: 'POST', path: '/api/users/login', body: { phoneNumber: rider.phone } });
    const otp = await peek('users_otp', { userId: rider.userId, isUsed: false });
    if (otp) {
      const v = await call('rider: verify', { method: 'POST', path: '/api/users/verify-otp', body: { userId: rider.userId, otp: otp.otp, device_id: 'check-device', fcm_id: 'check-fcm' } });
      const tok = v.body && v.body.data && (v.body.data.accessToken || (v.body.data.user && v.body.data.user.accessToken));
      await call('rider: detail', { path: `/api/users/detail/${rider.userId}` });
      if (tok) { await call('rider: notifications', { path: `/api/users/notifications?userId=${rider.userId}`, token: tok }); await call('rider: active ride', { path: `/api/v1/rides/active?user_id=${rider.userId}`, token: tok }); }
    }
  }
  // ---- the driver app
  const driver = await peek('drivers', {});
  if (driver && driver.phone) {
    await call('driver: login', { method: 'POST', path: '/api/drivers/login', body: { phoneNumber: driver.phone, device_id: 'check-device', fcm_id: 'check-fcm' } });
    const otp = await peek('drivers_otp', { driverId: driver.driverId, isUsed: false });
    if (otp) {
      const v = await call('driver: verify', { method: 'POST', path: '/api/otp/verify', body: { driverId: driver.driverId, otp: otp.otp, device_id: 'check-device', fcm_id: 'check-fcm' } });
      const d = (v.body && v.body.data) || {};
      const tok = d.accessToken || (d.driver && d.driver.accessToken) || d.token;
      if (tok) { await call('driver: profile', { path: `/api/drivers/profile?driverId=${driver.driverId}`, token: tok }); await call('driver: active ride', { path: `/api/v1/rides/active?driver_id=${driver.driverId}`, token: tok }); await call('driver: notifications', { path: `/api/drivers/notifications?driverId=${driver.driverId}`, token: tok }); }
    }
  }
  await call('public: health', { path: '/health' });
}

// compare two recorded runs without ever printing a value
function compare(a, b) {
  const lines = [];
  const walk = (x, y, at) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (!(k in y)) lines.push(`${at}.${k}: missing in Postgres`);
        else if (!(k in x)) lines.push(`${at}.${k}: extra in Postgres`);
        else walk(x[k], y[k], `${at}.${k}`);
      }
      return;
    }
    lines.push(`${at}: value differs`);
  };
  const n = Math.max(a.length, b.length);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const sa = a[i]; const sb = b[i];
    if (!sa || !sb) { out.push({ step: (sa || sb).step, diffs: ['step only ran on one engine'] }); continue; }
    lines.length = 0;
    walk(sa.response, sb.response, 'response');
    if (lines.length) out.push({ step: sa.step, status: `${sa.response.status} / ${sb.response.status}`, diffs: [...lines] });
  }
  return out;
}

async function run(engine, data, who) {
  const server = await start({
    engine, waitOwner: false,
    prepare: async ({ uri, pg }) => {
      if (engine === 'mongo') {
        const client = await MongoClient.connect(uri);
        for (const [name, docs] of Object.entries(data)) if (docs.length) await client.db('contract').collection(name).insertMany(docs.map((d) => ({ ...d })), { ordered: false });
        await client.close();
      } else {
        clientModule.adopt(pg.db);
        await mongoose.connect();
        for (const [name, docs] of Object.entries(data)) { const col = mongoose.connection.db.collection(name); for (const d of docs) await col.insertOne({ ...d }); }
      }
    }
  });
  try {
    const norm = makeNormaliser();
    const steps = [];
    const call = async (name, { method = 'GET', path: pth, body, token, headers = {} } = {}) => {
      const h = { ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (token) h.Authorization = `Bearer ${token}`;
      let res; let raw;
      const began = Date.now();
      try {
        res = await fetch(`${server.base}${pth}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        const type = res.headers.get('content-type') || '';
        raw = type.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => null);
      } catch (e) { steps.push({ step: name, raw: { error: 'no answer' }, status: 0 }); return { status: 0, body: null }; }
      if (Date.now() - began > 5000) console.log(`  slow (${engine}): ${name} took ${Math.round((Date.now() - began) / 1000)}s`);
      steps.push({ step: name, status: res.status, raw });
      return { status: res.status, body: raw };
    };
    await scenario({ call, peek: server.peek }, who);
    return steps.map((s) => ({ step: s.step, response: { status: s.status, body: typeof s.raw === 'string' ? norm.text(s.raw).slice(0, 2000) : norm.walk(s.raw) } }));
  } finally { await server.stop(); }
}

(async () => {
  console.log('Reading the live database (read-only) ...');
  const data = await readLive();
  const counts = Object.entries(data).filter(([, d]) => d.length).map(([n, d]) => `${n} ${d.length}`).join(', ');
  console.log(`Copied into memory: ${counts}\n`);
  const who = await patchedAdmins(data);
  console.log('Running the calls on the MongoDB copy ...');
  const onMongo = await run('mongo', data, who);
  console.log('Running the same calls on the Postgres copy ...');
  const onPostgres = await run('postgres', data, who);
  const diffs = compare(onMongo, onPostgres);
  const statuses = onMongo.reduce((m, s) => { m[s.response.status] = (m[s.response.status] || 0) + 1; return m; }, {});
  console.log(`\n${onMongo.length} calls per engine; statuses on Mongo: ${JSON.stringify(statuses)}`);
  const refused = onMongo.filter((x) => x.response.status >= 400).map((x) => `${x.step} [${x.response.status}]`);
  if (refused.length) console.log(`Calls answered with an error (same on both engines): ${refused.join('; ')}`);
  if (!diffs.length) console.log('RESULT: every response is identical on Mongo and Postgres');
  else {
    console.log(`RESULT: ${diffs.length} call(s) differ`);
    for (const d of diffs) { console.log(`  - ${d.step} (HTTP ${d.status})`); for (const l of d.diffs.slice(0, 6)) console.log(`      ${l}`); }
  }
  process.exit(diffs.length ? 1 : 0);
})().catch((e) => { console.error('Failed:', e.message); process.exit(2); });
