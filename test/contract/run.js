/**
 * Runs every contract scenario, each against its own fresh temporary server and database, and prints the result.
 *
 *   node test/contract/run.js                     compare with the stored snapshots
 *   UPDATE_CONTRACT=1 node test/contract/run.js   (re)record the snapshots from the reference (Mongo) engine
 *   CONTRACT_ONLY=rider,ride node test/contract/run.js   run only some scenarios
 *
 * Snapshots are recorded only from DB_ENGINE=mongo, the reference. Other engines are compared against them.
 */
const { start, runScenario } = require('./harness');
const scenarios = require('./scenarios');

(async () => {
  const engine = process.env.DB_ENGINE || 'mongo';
  if (process.env.UPDATE_CONTRACT === '1' && engine !== 'mongo') {
    console.error('Snapshots are recorded from the reference engine only (DB_ENGINE=mongo).');
    process.exit(2);
  }
  const only = process.env.CONTRACT_ONLY ? process.env.CONTRACT_ONLY.split(',') : null;
  let failed = 0;
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue;
    const server = await start({ engine });
    try {
      const r = await runScenario(server, name, fn);
      if (r.recorded) console.log(`recorded  ${name} (${r.steps} steps)`);
      else if (r.diff) { failed += 1; console.log(`DIFFERS   ${name}: ${r.diff}`); }
      else console.log(`matches   ${name} (${r.steps} steps)`);
    } catch (e) {
      failed += 1;
      console.log(`ERROR     ${name}: ${e.message}`);
    } finally {
      await server.stop();
    }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
