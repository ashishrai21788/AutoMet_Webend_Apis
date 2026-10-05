// The engine switch: Mongo mode must hand out the real mongoose module itself; bad or unfinished engines must fail loudly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const run = (env, code) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, ['-e', code], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { ok: false, err: String(e.stderr || e.message) };
  }
};

test('default and DB_ENGINE=mongo: the entry point IS the real mongoose module, so nothing changes', () => {
  for (const env of [{ DB_ENGINE: '' }, { DB_ENGINE: 'mongo' }, { DB_ENGINE: ' MONGO ' }]) {
    const r = run(env, "console.log(require('./lib/db/mongoose') === require('mongoose'), require('./lib/db/engine').ENGINE)");
    assert.equal(r.ok, true, JSON.stringify(env));
    assert.equal(r.out, 'true mongo');
  }
});

test('an unknown engine stops start-up with a clear message', () => {
  const r = run({ DB_ENGINE: 'oracle' }, "require('./lib/db/mongoose')");
  assert.equal(r.ok, false);
  assert.match(r.err, /DB_ENGINE must be one of mongo, postgres/);
});

test('postgres returns the Postgres facade (not the real mongoose module) with the same surface', () => {
  const r = run({ DB_ENGINE: 'postgres' }, "const m = require('./lib/db/mongoose'); const real = require('mongoose'); console.log([m !== real, typeof m.Schema, typeof m.model, typeof m.connect, typeof m.connection.readyState].join(','))");
  assert.equal(r.ok, true);
  assert.match(r.out, /true,function,function,function,number/);
});

test('no file outside the entry point and the two maintenance scripts requires mongoose directly', () => {
  const found = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`);
      return;
    }
    if (!rel.endsWith('.js')) return;
    if (/require\(['"]mongoose['"]\)/.test(fs.readFileSync(abs, 'utf8'))) found.push(rel);
  };
  for (const entry of ['models', 'controllers', 'lib', 'services', 'routes', 'config', 'scripts', 'index.js', 'monitor.js']) walk(entry);
  // the Postgres engine itself builds on Mongoose's schema classes and ObjectId; everything else goes through the entry point
  const outside = found.filter((f) => !f.startsWith('lib/db/postgres/'));
  assert.deepEqual(outside.sort(), ['lib/db/mongoose.js', 'scripts/resetAdminPassword.js', 'scripts/resetBusinessSetup.js']);
});
