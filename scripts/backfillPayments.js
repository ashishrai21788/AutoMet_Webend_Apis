#!/usr/bin/env node
/**
 * Give completed cash trips from before payments were recorded a payment record and the commission the driver owes on them
 * (see lib/payments/backfill.js for exactly what it does and what it never touches).
 *
 *   node scripts/backfillPayments.js                         dry run, every business: reports what it would do, changes nothing
 *   node scripts/backfillPayments.js --tenant <tenantId>     dry run for one business
 *   node scripts/backfillPayments.js --tenant <id> --apply   do it for that business
 *   node scripts/backfillPayments.js --apply                 do it for every business
 *
 * It uses the database named in your environment (.env or the host's variables), the same as the server. Run it from a machine you trust,
 * first as a dry run. Running it again is harmless: it posts nothing for a trip that already has a payment.
 */
const path = require('path');

/** { apply, tenantId } from the command line. A dry run unless --apply is given. */
function parseArgs(argv) {
  let apply = false; let dry = false; let tenantId = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') dry = true;
    else if (a === '--tenant') { tenantId = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; if (!tenantId) throw new Error('--tenant needs a business id'); i += 1; }
    else if (a.startsWith('--tenant=')) { tenantId = a.slice('--tenant='.length) || null; if (!tenantId) throw new Error('--tenant needs a business id'); }
    else throw new Error(`unknown option ${a}`);
  }
  if (apply && dry) throw new Error('give either --apply or --dry-run, not both');
  return { apply, tenantId };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const connectDB = require('../config/db');
  await connectDB();
  const reports = await require('../lib/payments/backfill').runAll(opts);
  for (const r of reports) {
    console.log(`${r.tenantId}: ${r.scanned} completed trips scanned, ${r.candidates} to backfill${r.dryRun ? '' : `, ${r.created} created, ${r.posted} commission postings, ${r.failedToPost} could not be posted`}`);
    console.log(`   commission owed by drivers on them: ${r.commissionMinor} (minor units), drivers: ${r.driversAffected}`);
    console.log(`   skipped: already have a payment ${r.skipped.hasPayment}, no usable earnings snapshot ${r.skipped.noSnapshot}, split does not add up ${r.skipped.splitInconsistent}, paid online ${r.skipped.notCash}, no driver ${r.skipped.noDriver}`);
    if (r.sample.length) console.log(`   first trips: ${r.sample.join(', ')}`);
  }
  console.log(opts.apply ? 'Done.' : 'This was a dry run: nothing was changed. Add --apply to do it.');
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { parseArgs };
