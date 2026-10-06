/**
 * Contract harness: runs the REAL server (index.js) against a REAL temporary database and records what it answers.
 *
 *   engine 'mongo'     a temporary single-node MongoDB replica set (mongodb-memory-server)
 *   engine 'postgres'  added in a later phase; the same scenarios are replayed and compared with the Mongo snapshots
 *
 * Safety: the server is started from an empty temporary folder with an explicit, minimal environment. The project's own
 * .env (which holds real credentials) is never read, and no real service (Atlas, Cloudinary, Firebase) is reachable.
 *
 * Responses are normalised before they are stored: ids, dates, tokens and other values that change on every run are
 * replaced by stable placeholders (the same id keeps the same placeholder within a scenario), so a snapshot records the
 * shape, field names, types, messages and relationships, not accidents of timing.
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const SNAP_DIR = path.join(__dirname, 'snapshots');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- normalising

const HEX24 = /^[0-9a-f]{24}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const LONGHEX = /^[0-9a-f]{32,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VOLATILE_KEYS = new Set(['timestamp', 'serverTime', 'generatedAt', 'uptime', 'requestId', 'responseTime', 'latencyMs', 'temporaryPassword', 'memoryUsage', 'locationAgeSeconds', 'totalRequests', 'durationMs', 'ageSeconds', 'avgResponseMinutes', 'avgTripMinutes']); // the last three are measured elapsed time

function makeNormaliser() {
  const ids = new Map();
  const tokens = new Map();
  const aliases = []; // [value, placeholder]: runtime-generated values the scenario knows about (user ids, phone-derived ids)
  const label = (map, prefix, value) => { if (!map.has(value)) map.set(value, `<${prefix}${map.size + 1}>`); return map.get(value); };
  const text = (s) => {
    for (const [value, placeholder] of aliases) if (s.includes(value)) s = s.split(value).join(placeholder);
    if (HEX24.test(s)) return label(ids, 'id', s.toLowerCase());
    if (ISO.test(s)) return '<date>';
    if (JWT.test(s)) return '<jwt>';
    if (UUID.test(s) || LONGHEX.test(s)) return label(tokens, 'token', s);
    // content hashes such as the public config "version" (16 hex characters) change with the random App ID
    if (/^[0-9a-f]{16}$/i.test(s)) return '<hash16>';
    // generated ids of the dashboard entities: a short prefix, an underscore and 16 hex characters (a_, rg_, vc_, fr_, veh_, as_ ...)
    if (/^[a-z]{1,5}_[0-9a-f]{16}$/.test(s)) return label(ids, s.split('_')[0] + '_', s);
    // business App IDs are random per run ("app_" + 10 hex)
    if (/^app_[0-9a-f]{10}$/.test(s)) return label(tokens, 'appId', s);
    // ids embedded in longer text (urls, messages): replace each 24-hex run
    return s.replace(/\b[0-9a-f]{24}\b/gi, (m) => label(ids, 'id', m.toLowerCase())).replace(/\b([a-z]{1,5}_)[0-9a-f]{16}\b/g, (m, p) => label(ids, p, m)).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<date>');
  };
  const walk = (v, key) => {
    if (v === null || v === undefined) return v === undefined ? '<undefined>' : null;
    // a date-only createdAt is the calendar day the data was made: it changes every day
    if (typeof v === 'string' && key === 'createdAt' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return '<day>';
    if (typeof v === 'string') return text(v);
    if (typeof v === 'number') return VOLATILE_KEYS.has(key) ? '<number>' : v;
    if (typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = VOLATILE_KEYS.has(k) ? '<volatile>' : walk(v[k], k);
    return out;
  };
  return { walk: (v) => walk(v, ''), text, alias: (value, name) => { if (value !== undefined && value !== null && String(value).length >= 4) aliases.push([String(value), `<${name}>`]); } };
}

// ---------------------------------------------------------------- the server under test

/** PGlite (Postgres in WebAssembly) behind a real socket, so the server under test uses the real `pg` driver against it. */
/**
 * A REAL Postgres server (CONTRACT_DATABASE_URL), e.g. a Supabase test project. It must hold no other application's data:
 * before each scenario only AutoMet's own tables are dropped, and if the public schema holds any other table nothing is changed
 * and the run stops.
 */
async function startRealPostgres(url) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await client.connect();
  // the table names AutoMet's own models use (the harness process only reads the schemas; nothing connects to MongoDB)
  const fsx = require('node:fs');
  const modelsDir = path.join(root, 'models');
  for (const f of fsx.readdirSync(modelsDir)) if (f.endsWith('.js')) require(path.join(modelsDir, f));
  const { createModel } = require(path.join(modelsDir, 'dynamicModel.js'));
  createModel('drivers'); createModel('users');
  // the models register in whichever registry the engine entry point uses (the real mongoose, or the Postgres facade)
  const own = Object.values(require(path.join(root, 'lib', 'db', 'mongoose')).models).map((m) => m.collection.name);
  if (own.length < 20) throw new Error('could not list the AutoMet table names (' + own.length + ' found); refusing to continue');
  await require('../helpers/realDbReset').resetOwnTables((t, params) => client.query(t, params).then((r) => ({ rows: r.rows })), own);
  return {
    url,
    db: null,
    query: (text, params) => client.query(text, params),
    stop: async () => { await client.end(); }
  };
}

async function startPostgres() {
  if (process.env.CONTRACT_DATABASE_URL) return startRealPostgres(process.env.CONTRACT_DATABASE_URL);
  const { PGlite } = require('@electric-sql/pglite');
  const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
  const db = new PGlite();
  await db.waitReady;
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  return {
    url,
    db,
    // the database lives in this process, so the harness reads and writes it directly (no second connection)
    query: (text, params) => db.query(text, params),
    stop: async () => { await server.stop(); await db.close(); }
  };
}

async function start({ engine = 'mongo', env: extra = {}, prepare = null, waitOwner = true } = {}) {
  if (engine !== 'mongo' && engine !== 'postgres') throw new Error(`engine "${engine}" is not available in the harness`);
  let repl = null; let uri = ''; let pg = null;
  if (engine === 'mongo') {
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    uri = repl.getUri('contract');
  } else {
    pg = await startPostgres();
  }
  if (prepare) await prepare({ engine, uri, pg });
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'automet-contract-'));

  // a clean, explicit environment: nothing from the developer's shell or from the project's .env
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: cwd,
    PORT: String(port), HOST: '127.0.0.1',
    // production behaviour, as Render runs it (the project's .env, which the test server never reads, sets AUTH_ENFORCEMENT=strict)
    NODE_ENV: 'production', AUTH_ENFORCEMENT: 'strict', SCHEDULER_SECRET: 'contract-scheduler-secret', JWT_SECRET: 'contract-test-secret-not-for-real-use',
    DB_ENGINE: engine, DB_USE_URI: '1', MONGODB_URI: uri, DB_NAME: 'contract', RATE_LIMIT_DISABLED: '1',
    ...(pg ? { DATABASE_URL: pg.url, ...(pg.db ? { PG_POOL_MAX: '1' } : {}) } : {}),
    ADMIN_BOOTSTRAP_EMAIL: 'owner@contract.test', ADMIN_BOOTSTRAP_PASSWORD: 'Contract-Owner-Pass-1', REQUIRE_PLATFORM_2FA: '0',
    ...extra
  };
  const pushLog = path.join(cwd, 'pushes.jsonl');
  env.CONTRACT_PUSH_LOG = pushLog;
  // a syntactically valid but fake key: the test server replaces firebase-admin (see preload.js), so nothing is ever sent to Google
  env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'contract-project', client_email: 'contract@contract-project.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nQ09OVFJBQ1Q=\n-----END PRIVATE KEY-----\n' });
  const child = spawn(process.execPath, ['-r', path.join(__dirname, 'preload.js'), path.join(root, 'index.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i += 1) {
    if (exited !== null) throw new Error(`server exited early (${exited}):\n${log.join('').slice(-1500)}`);
    try {
      const r = await fetch(`${base}/health`);
      const j = await r.json();
      if (j && j.health && j.health.dbConnected) break;
    } catch { /* not up yet */ }
    await sleep(500);
    if (i === 119) throw new Error(`server did not become healthy:\n${log.join('').slice(-1500)}`);
  }
  // the default business and the first super admin are created in the background at start-up: wait until the owner can sign in
  let ready = !waitOwner;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try {
      const r = await fetch(`${base}/api/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: env.ADMIN_BOOTSTRAP_EMAIL, password: env.ADMIN_BOOTSTRAP_PASSWORD }) });
      ready = r.status === 200;
    } catch { /* not yet */ }
    if (!ready) await sleep(500);
  }
  if (!ready) throw new Error(`the bootstrap owner account was never created:\n${log.join('').slice(-1500)}`);

  const mongo = engine === 'mongo' ? require('mongodb') : null;
  let client = null;
  const database = async () => { if (!client) client = await mongo.MongoClient.connect(uri); return client.db('contract'); };
  const qi = (n) => `"${String(n).replace(/"/g, '""')}"`;

  return {
    base, engine, log: () => log.join(''),
    /** The pushes the server tried to send since the last call (read from the recorder in preload.js). */
    pushes: () => { try { return fs.readFileSync(pushLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    clearPushes: () => { try { fs.writeFileSync(pushLog, ''); } catch { /* none yet */ } },
    /** Direct, read-only peeks at the database, for the few values the API never returns (for example an OTP). */
    peek: async (collection, filter = {}, sort = { _id: -1 }) => {
      if (pg) {
        const keys = Object.keys(filter);
        const r = await pg.query(`SELECT * FROM ${qi(collection)}${keys.length ? ` WHERE ${keys.map((k, i) => `${qi(k)} = $${i + 1}`).join(' AND ')}` : ''} ORDER BY "_id" DESC LIMIT 1`, keys.map((k) => filter[k]));
        return r.rows[0] || null;
      }
      return (await database()).collection(collection).findOne(filter, { sort });
    },
    /** Puts a document straight into a collection, for data the API itself never creates without an outside event. */
    seed: async (collection, doc) => {
      if (pg) {
        // a free-form collection, in the shape the Postgres engine uses for collections without a model
        const { ObjectId } = require('mongodb');
        const { dump } = require('../../lib/db/postgres/codec');
        const id = new ObjectId();
        await pg.query(`CREATE TABLE IF NOT EXISTS ${qi(collection)} ("_id" text PRIMARY KEY, "__v" integer, "__extra" json)`);
        await pg.query(`INSERT INTO ${qi(collection)} ("_id", "__extra") VALUES ($1, $2::json)`, [String(id), dump(doc)]);
        return { acknowledged: true, insertedId: id };
      }
      return (await database()).collection(collection).insertOne(doc);
    },
    /** Sets fields on the matching documents (for example verification statuses, which need uploaded documents in real life). */
    patch: async (collection, filter, set) => {
      if (pg) {
        const sk = Object.keys(set); const fk = Object.keys(filter);
        return pg.query(`UPDATE ${qi(collection)} SET ${sk.map((k, i) => `${qi(k)} = $${i + 1}`).join(', ')} WHERE ${fk.map((k, i) => `${qi(k)} = $${sk.length + i + 1}`).join(' AND ')}`, [...sk.map((k) => set[k]), ...fk.map((k) => filter[k])]);
      }
      return (await database()).collection(collection).updateMany(filter, { $set: set });
    },
    async stop() {
      if (client) await client.close();
      if (exited === null) { child.kill(); await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); }); }
      if (repl) await repl.stop();
      if (pg) await pg.stop();
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (e) { /* a Windows handle may linger; the folder is in the temp directory */ }
    }
  };
}

// ---------------------------------------------------------------- scenarios and snapshots

/**
 * A scenario is `async (t) => { ... }` using t.call(name, { method, path, body, token, headers }) which performs the real
 * HTTP request and records the normalised result. `t.raw` gives the un-normalised parsed body (to read tokens and ids).
 */
function recorder(server) {
  const norm = makeNormaliser();
  const steps = [];
  /** Records the pushes the server attempted since the last record (message data, never tokens: tokens are masked as ids). */
  function recordPushes(name) {
    steps.push({ kind: 'push', name, items: server.pushes() });
    server.clearPushes();
  }
  async function call(name, { method = 'GET', path: p, body, token, headers = {}, expectStatus } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = `Bearer ${token}`;
    const res = await fetch(`${server.base}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) }).catch((e) => { throw new Error(`${name}: no answer (${e.message})`); });
    const type = res.headers.get('content-type') || '';
    const raw = type.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => null);
    if (expectStatus !== undefined && res.status !== expectStatus) {
      throw new Error(`${name}: expected HTTP ${expectStatus} but got ${res.status}: ${JSON.stringify(raw).slice(0, 300)}`);
    }
    // kept raw until the scenario ends: values the scenario names later (alias) must be replaced in the earlier steps too
    steps.push({ name, method, p, body, auth: !!token, status: res.status, type: type.split(';')[0], raw });
    return { status: res.status, body: raw, headers: res.headers };
  }
  const finish = () => steps.map((s) => s.kind === 'push' ? ({ step: s.name, pushes: norm.walk(s.items) }) : ({
    step: s.name,
    request: { method: s.method, path: norm.text(s.p), body: s.body === undefined ? undefined : norm.walk(s.body), auth: s.auth ? 'bearer' : undefined },
    response: { status: s.status, contentType: s.type, body: typeof s.raw === 'string' ? norm.text(s.raw).slice(0, 400) : norm.walk(s.raw) }
  }));
  return { call, steps, norm, finish, recordPushes, alias: (value, name) => norm.alias(value, name) };
}

const snapPath = (name) => path.join(SNAP_DIR, `${name}.json`);
const stable = (v) => JSON.stringify(v, null, 2);

function firstDifference(a, b, at = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${at}: expected ${JSON.stringify(a)} but got ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${at}: expected ${Array.isArray(a) ? 'an array' : 'an object'}`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) return `${at}.${k}: unexpected field`;
    if (!(k in b)) return `${at}.${k}: field is missing`;
    const d = firstDifference(a[k], b[k], `${at}.${k}`);
    if (d) return d;
  }
  return `${at}: differs`;
}

/** Runs a scenario against the server and compares with (or, with UPDATE_CONTRACT=1, writes) its snapshot. */
async function runScenario(server, name, scenario) {
  const rec = recorder(server);
  await scenario({ ...rec, server, peek: server.peek, seed: server.seed, patch: server.patch });
  const actual = { scenario: name, steps: rec.finish() };
  if (process.env.UPDATE_CONTRACT === '1') {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.writeFileSync(snapPath(name), `${stable(actual)}\n`);
    return { recorded: true, steps: actual.steps.length };
  }
  if (!fs.existsSync(snapPath(name))) throw new Error(`no snapshot for "${name}"; record it with UPDATE_CONTRACT=1`);
  const expected = JSON.parse(fs.readFileSync(snapPath(name), 'utf8'));
  const diff = firstDifference(expected, actual);
  return { recorded: false, steps: actual.steps.length, diff, expected, actual };
}

module.exports = { start, runScenario, makeNormaliser, firstDifference, SNAP_DIR };
