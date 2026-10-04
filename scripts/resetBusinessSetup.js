#!/usr/bin/env node
/**
 * RESETS THE BUSINESS SETUP of the database named in your environment (.env or Render's variables).
 *
 *   node scripts/resetBusinessSetup.js                              dry run: prints what would be deleted, deletes nothing
 *   node scripts/resetBusinessSetup.js --execute --confirm=<DB_NAME> deletes (type the database name to confirm)
 *
 * Options:
 *   --no-default   do not recreate the default "AutoMet" business afterwards (see below)
 *
 * Deleted: businesses, regions, vehicle categories, fare rules, cancellation policies, setup progress, team accounts
 * (super admins are kept), the audit log, and each business's logo in Cloudinary.
 * Never touched: drivers, riders, trips, OTP records, support reports, vehicles, driver and vehicle documents.
 *
 * The default business owns every driver and rider created before businesses existed, so it is recreated (empty, with a
 * NEW App ID) straight away. Without it those records would belong to no business until the server restarts, because the
 * server recreates it at start-up anyway. Use --no-default only if you will restart the server before anyone uses the apps.
 *
 * THIS CANNOT BE UNDONE. Take a database backup first (MongoDB Atlas: Backup, or `mongodump`).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { plan, execute } = require('../lib/resetBusinessSetup');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const a = args.find((x) => x.startsWith(`${name}=`)); return a ? a.slice(name.length + 1) : null; };

function connectionString() {
  const { MONGODB_USERNAME, MONGODB_PASSWORD, MONGODB_CLUSTER, DB_NAME } = process.env;
  if (!MONGODB_USERNAME || !MONGODB_PASSWORD || !MONGODB_CLUSTER || !DB_NAME) {
    throw new Error('MONGODB_USERNAME, MONGODB_PASSWORD, MONGODB_CLUSTER and DB_NAME must be set (in .env or the environment).');
  }
  return `mongodb+srv://${encodeURIComponent(MONGODB_USERNAME)}:${encodeURIComponent(MONGODB_PASSWORD)}@${MONGODB_CLUSTER}/${DB_NAME}?retryWrites=true&w=majority&appName=AshishRai`;
}

function logoRemover() {
  const configured = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET;
  if (!configured) return null;
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
  return (tenantId) => cloudinary.uploader.destroy(`automet/logos/${tenantId}`, { resource_type: 'image', invalidate: true });
}

const pad = (n) => String(n).padStart(6);

async function main() {
  const dbName = process.env.DB_NAME;
  await mongoose.connect(connectionString(), { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  console.log(`\nDatabase: ${dbName}   Cluster: ${process.env.MONGODB_CLUSTER}\n`);

  const p = await plan(db);
  console.log('Would be deleted:');
  for (const t of p.targets) console.log(`  ${pad(t.count)}  ${t.label}`);
  console.log('\nBusinesses:');
  for (const t of p.tenants) console.log(`  ${t.tenantId}  ${t.name}${t.isDefault ? '  (default)' : ''}`);
  console.log('\nLeft alone (still tagged with the old business IDs, so they will no longer show in the dashboard):');
  for (const t of p.leftAlone) if (t.count) console.log(`  ${pad(t.count)}  ${t.label}`);
  console.log(`\nSuper admin accounts kept: ${p.superAdmins}`);

  if (!flag('--execute')) {
    console.log('\nDRY RUN: nothing was deleted. To delete, run again with:  --execute --confirm=' + dbName);
    return;
  }
  if (value('--confirm') !== dbName) {
    console.log(`\nNot executed: add --confirm=${dbName} (the exact database name) to confirm. Nothing was deleted.`);
    process.exitCode = 2;
    return;
  }

  console.log('\nDeleting...');
  const remove = logoRemover();
  if (!remove) console.log('  (Cloudinary is not configured here, so logos in image storage are not removed)');
  const result = await execute(db, { removeLogo: remove || (async () => {}) });
  for (const d of result.deleted) console.log(`  deleted ${pad(d.deleted)}  ${d.label}`);
  if (remove) console.log(`  logos removed from image storage: ${result.logosRemoved}`);
  for (const problem of result.logoProblems) console.log(`  could not remove a logo: ${problem}`);

  if (!flag('--no-default')) {
    require('../models/adminModels'); // registers the models bootstrap uses
    await require('../lib/adminBootstrap').bootstrapAdmin();
    console.log('  recreated the default business (empty, new App ID)');
  }
  console.log('\nDone. Sign in again as a super admin; create businesses from Businesses.');
}

main()
  .catch((e) => { console.error('\nFAILED:', e.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
