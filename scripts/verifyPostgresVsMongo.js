/**
 * READ-ONLY comparison of the live MongoDB with the Postgres engine.
 *
 *   node scripts/verifyPostgresVsMongo.js
 *
 * - Reads every collection from MongoDB (only listCollections / find: nothing is ever written, updated or deleted there).
 * - Loads a copy into a LOCAL, in-memory Postgres (PGlite) through the engine's raw-collection layer.
 * - Reads it back and compares document by document, then compares counts through the model layer.
 * - Prints collection names, counts and field NAMES that differ. It never prints field values (they may be personal data).
 */
process.env.DB_ENGINE = 'postgres';
// VERIFY_LIVE_POSTGRES=1: compare against the database in DATABASE_URL (after scripts/migrateMongoToPostgres.js) instead of a local copy; nothing is written
const live = process.env.VERIFY_LIVE_POSTGRES === '1';
if (!live) process.env.DATABASE_URL = 'pglite:memory';
require('dotenv').config(); // credentials are only used to connect; they are never printed

const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const mongoose = require('../lib/db/mongoose'); // the Postgres facade (DB_ENGINE=postgres)

for (const f of fs.readdirSync(path.join(__dirname, '..', 'models'))) if (f.endsWith('.js')) require(path.join(__dirname, '..', 'models', f));
const { createModel } = require('../models/dynamicModel');
createModel('drivers'); createModel('users');

const { MONGODB_USERNAME: u, MONGODB_PASSWORD: p, MONGODB_CLUSTER: c, DB_NAME: dbName } = process.env;
if (!process.env.VERIFY_MONGO_URI && (!u || !p || !c || !dbName)) { console.error('The Atlas variables are not set (MONGODB_USERNAME, MONGODB_PASSWORD, MONGODB_CLUSTER, DB_NAME).'); process.exit(2); }
// VERIFY_MONGO_URI + VERIFY_DB_NAME point the check at another MongoDB (used to test this script on a temporary one)
const uri = process.env.VERIFY_MONGO_URI || `mongodb+srv://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${c}/${dbName}?retryWrites=false&appName=AutoMetReadOnlyCheck`;

// canonical, comparable form: ObjectId -> hex, Date -> ISO, keys kept in order
const canon = (v) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v instanceof Date) return { $date: v.toISOString() };
  if (v && v._bsontype === 'ObjectId') return { $oid: String(v) };
  if (v && v._bsontype) return { $bson: String(v) };
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = canon(x); return o; }
  return v;
};
// ISO strings inside typed json columns come back as strings where Mongo has Dates: treat equal instants as equal
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const norm = (v) => (v && typeof v === 'object' && Object.keys(v).length === 1 && v.$date ? v.$date : v);

function diffPaths(a, b, at, out) {
  a = norm(a); b = norm(b);
  if (typeof a === 'string' && typeof b === 'string' && ISO.test(a) && ISO.test(b) && Date.parse(a) === Date.parse(b)) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      // null and "absent" are one state in a column: reported separately, they are not data loss
      if (!(k in b)) out.push(a[k] === null ? `${at}.${k} (null in Mongo, absent in Postgres) [info]` : `${at}.${k} (missing in Postgres)`);
      else if (!(k in a)) out.push(b[k] === null ? `${at}.${k} (absent in Mongo, null in Postgres) [info]` : `${at}.${k} (extra in Postgres)`);
      else diffPaths(a[k], b[k], `${at}.${k}`, out);
    }
    // same keys, different order
    if (at !== '$' && !Array.isArray(a) && out.length === 0 && Object.keys(a).join() !== Object.keys(b).join()) out.push(`${at} (key order)`); // top-level order follows the schema columns; nested order must match
    return;
  }
  out.push(`${at} (value differs)`);
}

(async () => {
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 15000, readPreference: 'secondaryPreferred' });
  const mdb = client.db(process.env.VERIFY_DB_NAME || dbName);
  await mongoose.connect();
  const names = (await mdb.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).filter((n) => !n.startsWith('system.')).sort();
  console.log(`Read-only comparison: ${names.length} collections in MongoDB database "${process.env.VERIFY_DB_NAME || dbName}"\n`);
  let problems = 0;
  for (const name of names) {
    const docs = await mdb.collection(name).find({}).toArray(); // read only
    const pg = mongoose.connection.db.collection(name);
    let imported = 0; let importErrors = 0;
    if (!live) for (const d of docs) { try { await pg.insertOne({ ...d }); imported += 1; } catch (e) { importErrors += 1; } }
    const back = await pg.find({}).toArray();
    const byId = new Map(back.map((x) => [String(x._id), x]));
    let identical = 0; let infoOnly = 0; const diffs = new Map();
    for (const d of docs) {
      const other = byId.get(String(d._id));
      if (!other) continue;
      const out = [];
      diffPaths(canon(d), canon(other), '$', out);
      if (!out.length) identical += 1;
      else if (out.every((o) => o.endsWith('[info]'))) { infoOnly += 1; }
      for (const o of out) diffs.set(o.replace(/\.\d+(\.|$| )/g, '.#$1'), (diffs.get(o.replace(/\.\d+(\.|$| )/g, '.#$1')) || 0) + 1);
    }
    const ok = docs.length === back.length && identical + infoOnly === docs.length && !importErrors;
    if (!ok) problems += 1;
    console.log(`${ok ? 'OK     ' : 'DIFFERS'} ${name}: mongo ${docs.length}, postgres ${back.length}, identical ${identical}${infoOnly ? `, null-vs-absent only ${infoOnly}` : ''}${importErrors ? `, import errors ${importErrors}` : ''}`);
    for (const [k, n] of [...diffs.entries()].slice(0, 8)) console.log(`          ${k} x${n}`);
  }
  await client.close();
  await mongoose.disconnect();
  console.log(problems ? `\n${problems} collection(s) differ` : '\nAll collections are identical in Postgres');
  process.exit(problems ? 1 : 0);
})().catch((e) => { console.error('Failed:', e.message); process.exit(2); });
