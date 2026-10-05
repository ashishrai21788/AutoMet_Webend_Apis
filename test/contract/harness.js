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
const VOLATILE_KEYS = new Set(['timestamp', 'serverTime', 'generatedAt', 'uptime', 'requestId', 'responseTime', 'latencyMs', 'durationMs']);

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
    return s.replace(/\b[0-9a-f]{24}\b/gi, (m) => label(ids, 'id', m.toLowerCase()));
  };
  const walk = (v, key) => {
    if (v === null || v === undefined) return v === undefined ? '<undefined>' : null;
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

async function start({ engine = 'mongo', env: extra = {} } = {}) {
  if (engine !== 'mongo') throw new Error(`engine "${engine}" is not available in the harness yet`);
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = repl.getUri('contract');
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'automet-contract-'));

  // a clean, explicit environment: nothing from the developer's shell or from the project's .env
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: cwd,
    PORT: String(port), HOST: '127.0.0.1',
    // production behaviour, as Render runs it (the project's .env, which the test server never reads, sets AUTH_ENFORCEMENT=strict)
    NODE_ENV: 'production', AUTH_ENFORCEMENT: 'strict', SCHEDULER_SECRET: 'contract-scheduler-secret', JWT_SECRET: 'contract-test-secret-not-for-real-use',
    DB_ENGINE: engine, DB_USE_URI: '1', MONGODB_URI: uri, DB_NAME: 'contract', RATE_LIMIT_DISABLED: '1',
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
  // the default business and the first super admin are created in the background at start-up
  await sleep(1500);

  const mongo = require('mongodb');
  let client = null;
  const database = async () => { if (!client) client = await mongo.MongoClient.connect(uri); return client.db('contract'); };

  return {
    base, engine, log: () => log.join(''),
    /** The pushes the server tried to send since the last call (read from the recorder in preload.js). */
    pushes: () => { try { return fs.readFileSync(pushLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    clearPushes: () => { try { fs.writeFileSync(pushLog, ''); } catch { /* none yet */ } },
    /** Direct, read-only peeks at the database, for the few values the API never returns (for example an OTP). */
    peek: async (collection, filter = {}, sort = { _id: -1 }) => (await database()).collection(collection).findOne(filter, { sort }),
    /** Puts a document straight into a collection, for data the API itself never creates without an outside event. */
    seed: async (collection, doc) => (await database()).collection(collection).insertOne(doc),
    /** Sets fields on the matching documents (for example verification statuses, which need uploaded documents in real life). */
    patch: async (collection, filter, set) => (await database()).collection(collection).updateMany(filter, { $set: set }),
    async stop() {
      if (client) await client.close();
      child.kill();
      await repl.stop();
      fs.rmSync(cwd, { recursive: true, force: true });
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
    const res = await fetch(`${server.base}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
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
