/**
 * One-time copy of the live MongoDB (Atlas) data into the PostgreSQL database named by DATABASE_URL.
 *
 *   node scripts/migrateMongoToPostgres.js            DRY RUN: reads Atlas, reads Postgres, prints what would happen, writes nothing
 *   node scripts/migrateMongoToPostgres.js --apply    does it
 *
 * - MongoDB is only ever read (listCollections / find). Nothing there is written, updated or deleted.
 * - Documents go in through the engine's own raw-collection layer, the same one the server and verifyPostgresVsMongo.js use,
 *   so the rows are exactly what the server would have written. Every _id is kept.
 * - Safe to repeat: a document whose _id is already in Postgres is skipped, never overwritten (except the two cases below).
 * - A fresh Postgres database already holds what the server creates on first start. Those rows are reconciled:
 *     tenants          the empty default client the server made is removed when MongoDB has its own default client (the
 *                      apps and every record refer to MongoDB's App ID), then MongoDB's clients are copied.
 *     admin_users      an account whose e-mail already exists in Postgres is kept as it is (its password and 2-step setup
 *                      are not replaced by the old ones); the others are copied.
 *     platform_settings  the server's untouched defaults are replaced by MongoDB's saved settings.
 * - Before --apply changes anything, the rows it would remove are saved to migrate-backup-<time>.json (git-ignored).
 * - Prints names and counts only, never field values.
 */
process.env.DB_ENGINE = 'postgres';
require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const mongoose = require('../lib/db/mongoose'); // the Postgres facade (DB_ENGINE=postgres)

const apply = process.argv.includes('--apply');
for (const f of fs.readdirSync(path.join(__dirname, '..', 'models'))) if (f.endsWith('.js')) require(path.join(__dirname, '..', 'models', f));
const { createModel } = require('../models/dynamicModel');
createModel('drivers'); createModel('users');

const { MONGODB_USERNAME: u, MONGODB_PASSWORD: p, MONGODB_CLUSTER: c, DB_NAME: dbName } = process.env;
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if (!u || !p || !c || !dbName) { console.error('The Atlas variables are not set (MONGODB_USERNAME, MONGODB_PASSWORD, MONGODB_CLUSTER, DB_NAME).'); process.exit(2); }
const uri = `mongodb+srv://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${c}/${dbName}?retryWrites=false&appName=AutoMetMigration`;

(async () => {
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 20000, readPreference: 'secondaryPreferred' });
  const mdb = client.db(dbName);
  await mongoose.connect();
  const names = (await mdb.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).filter((n) => !n.startsWith('system.')).sort();
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${names.length} MongoDB collections -> PostgreSQL\n`);

  const pgc = (n) => mongoose.connection.db.collection(n);
  const mongoDocs = {};
  for (const n of names) mongoDocs[n] = await mdb.collection(n).find({}).toArray(); // read only

  // ---- reconcile what a fresh Postgres already holds
  const backup = {};
  const plan = [];
  const mongoDefault = (mongoDocs.tenants || []).find((t) => t.isDefault);
  const pgTenants = await pgc('tenants').find({}).toArray();
  const removeTenants = mongoDefault ? pgTenants.filter((t) => t.isDefault && t.tenantId !== mongoDefault.tenantId) : [];
  const referenced = async (tenantId) => {
    for (const n of names) {
      if (n === 'tenants') continue;
      if (await pgc(n).countDocuments({ tenantId }) || await pgc(n).countDocuments({ appId: tenantId })) return n;
    }
    return null;
  };
  for (const t of removeTenants) {
    const where = await referenced(t.tenantId);
    if (where) { console.error(`STOP: the default client already in Postgres is used by "${where}"; not removing it.`); process.exit(3); }
    plan.push(`remove the empty default client the server created in Postgres (${t.tenantId})`);
  }
  const pgAdmins = await pgc('admin_users').find({}).toArray();
  const pgEmails = new Set(pgAdmins.map((a) => String(a.email).toLowerCase()));
  const skipAdmin = (d) => pgEmails.has(String(d.email).toLowerCase());
  const adminSkips = (mongoDocs.admin_users || []).filter(skipAdmin).length;
  if (adminSkips) plan.push(`keep ${adminSkips} admin account(s) already in Postgres (same e-mail), copy the rest`);
  const mongoSettingIds = new Set((mongoDocs.platform_settings || []).map((s) => String(s._id)));
  const pgSettings = (await pgc('platform_settings').find({}).toArray()).filter((s) => !mongoSettingIds.has(String(s._id))); // not already MongoDB's
  const replaceSettings = (mongoDocs.platform_settings || []).length > 0 && pgSettings.length > 0;
  if (replaceSettings) plan.push(`replace the server's default platform_settings (${pgSettings.length}) with MongoDB's`);
  for (const l of plan) console.log(`  plan: ${l}`);
  if (!plan.length) console.log('  plan: nothing to reconcile');
  console.log('');

  if (apply && (removeTenants.length || replaceSettings)) {
    backup.tenants = removeTenants;
    if (replaceSettings) backup.platform_settings = pgSettings;
    const file = path.join(__dirname, '..', `migrate-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`  saved the rows about to be removed to ${path.basename(file)}\n`);
    for (const t of removeTenants) await pgc('tenants').deleteOne({ _id: t._id });
    if (replaceSettings) for (const s of pgSettings) await pgc('platform_settings').deleteOne({ _id: s._id });
  }

  // ---- copy
  let problems = 0;
  for (const n of names) {
    const docs = mongoDocs[n];
    const col = pgc(n);
    const have = new Set((apply ? await col.find({}, { projection: { _id: 1 } }).toArray() : await col.find({}).toArray()).map((x) => String(x._id)));
    let copied = 0; let existed = 0; let kept = 0; let failed = 0;
    const todo = [];
    for (const d of docs) {
      if (have.has(String(d._id))) { existed += 1; continue; }
      if (n === 'admin_users' && skipAdmin(d)) { kept += 1; continue; }
      if (!apply) { copied += 1; continue; }
      todo.push(d);
    }
    // a few at a time: over a network each insert waits for the round trip (the pool holds PG_POOL_MAX connections)
    const lanes = Math.max(1, Math.min(Number(process.env.PG_POOL_MAX) || 5, 8));
    for (let i = 0; i < todo.length; i += lanes) {
      await Promise.all(todo.slice(i, i + lanes).map(async (d) => {
        try { await col.insertOne({ ...d }); copied += 1; } catch (e) { failed += 1; console.log(`   ! ${n}: one document was not copied (${e.code || e.name}: ${String(e.message).slice(0, 90)})`); }
      }));
    }
    const after = apply ? await col.countDocuments({}) : null;
    const ok = !failed;
    if (!ok) problems += 1;
    console.log(`${ok ? 'OK    ' : 'FAILED'} ${n.padEnd(28)} mongo ${String(docs.length).padStart(5)}  ${apply ? 'copied' : 'to copy'} ${String(copied).padStart(5)}${existed ? `  already there ${existed}` : ''}${kept ? `  kept existing ${kept}` : ''}${failed ? `  FAILED ${failed}` : ''}${apply ? `  -> postgres now ${after}` : ''}`);
  }
  await client.close();
  await mongoose.disconnect();
  console.log(apply ? (problems ? `\nDone with ${problems} collection(s) that need a look.` : '\nDone. Every document was copied.') : '\nDry run only: nothing was written. Run again with --apply.');
  process.exit(problems ? 1 : 0);
})().catch((e) => { console.error('Failed:', e.message); process.exit(2); });
