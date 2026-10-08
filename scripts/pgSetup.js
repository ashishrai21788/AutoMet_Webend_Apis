/**
 * Creates (or updates) AutoMet's tables and indexes in the PostgreSQL database named by DATABASE_URL.
 *
 *   npm run db:setup              create what is missing; safe to repeat (existing tables and rows are left alone)
 *   npm run db:setup -- --reset   FIRST drop AutoMet's own tables, then create them empty (for a throw-away test database)
 *
 * The tables are generated from the Mongoose schemas in models/, exactly as the server creates them when it starts with
 * DB_ENGINE=postgres, so running this beforehand changes nothing about how the server behaves; it only means the schema
 * is in place (and can be looked at) before the first request.
 *
 * Safety: --reset only ever drops tables that AutoMet's own models and generic collections create, and REFUSES (changing
 * nothing) if the public schema holds any other table. The connection string is never printed.
 */
process.env.DB_ENGINE = 'postgres';
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });

const root = path.join(__dirname, '..');
const reset = process.argv.includes('--reset');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (put it in .env, or in the environment).');
  process.exit(2);
}

// the generic collections the API reaches without a model of their own
const RAW_COLLECTIONS = ['driver_notification', 'users_notification', 'driver_faq', 'driver_faqs', 'driver_issues', 'drivers_notification'];

(async () => {
  const mongoose = require('../lib/db/mongoose'); // the Postgres facade
  const modelsDir = path.join(root, 'models');
  for (const f of fs.readdirSync(modelsDir)) if (f.endsWith('.js')) require(path.join(modelsDir, f));
  const { createModel } = require('../models/dynamicModel');
  createModel('drivers'); createModel('users');
  const own = Object.values(mongoose.models).map((m) => m.collection.name);

  const client = require('../lib/db/postgres/client').connect();
  if (reset) {
    const { resetOwnTables } = require('../test/helpers/realDbReset');
    await resetOwnTables((t, p) => client.query(t, p), own);
    console.log('AutoMet tables dropped (--reset)');
  }

  await mongoose.connect();                       // creates the table of every model
  for (const name of RAW_COLLECTIONS) await mongoose.connection.db.collection(name).countDocuments({}); // and the generic ones

  const { rows } = await client.query(
    `select t.table_name as name,
            (select count(*)::int from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.table_name) as columns
       from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE' order by 1`
  );
  console.log(`\n${rows.length} tables in the public schema:`);
  for (const r of rows) {
    const n = (await client.query(`select count(*)::int as n from "${r.name.replace(/"/g, '""')}"`)).rows[0].n;
    console.log(`  ${r.name.padEnd(30)} ${String(r.columns).padStart(3)} columns  ${String(n).padStart(6)} rows`);
  }
  const idx = (await client.query("select count(*)::int as n from pg_indexes where schemaname = 'public'")).rows[0].n;
  console.log(`\n${idx} indexes (primary keys, unique constraints and the schema's own indexes)`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('Setup failed:', e.message); process.exit(1); });
