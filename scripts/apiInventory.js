/**
 * Generates docs/API_INVENTORY.md from the code itself, so it cannot drift:
 *  - the route table comes from the loaded Express routers (method, full path, middleware names on the route),
 *  - the mount prefixes come from the app.use(...) lines in index.js,
 *  - "covered by" is every test or contract scenario file that mentions the path (parameters match any segment).
 * An endpoint no test file mentions is listed as UNREFERENCED: a lead for a gap, not proof of one (a test can reach a route through a helper).
 *
 *   node scripts/apiInventory.js          writes docs/API_INVENTORY.md
 *   node scripts/apiInventory.js --check  exits 1 when the file on disk is stale (for CI)
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'inventory-only-not-a-secret'; // routers refuse to load without one; nothing signs or verifies here

const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const mounts = [];
for (const m of indexSrc.matchAll(/app\.use\(\s*'(\/api[^']*)'\s*,\s*(?:require\('\.\/routes\/([A-Za-z]+)'\)|([A-Za-z]+))\s*\)/g)) {
  const file = m[2] || m[3];
  if (/Routes$/.test(file)) mounts.push({ prefix: m[1], file });
}

function walk(layerStack, base, out, inherited = []) {
  for (const layer of layerStack) {
    if (layer.route) {
      const names = layer.route.stack.map((l) => l.name).filter((n) => n && n !== '<anonymous>' && n !== 'bound dispatch');
      for (const method of Object.keys(layer.route.methods)) {
        if (layer.route.methods[method]) out.push({ method: method.toUpperCase(), path: base + (layer.route.path === '/' ? '' : layer.route.path), guards: [...inherited, ...names] });
      }
    }
  }
}

const handlerOf = {}; // "<file>|METHOD|/relative/path" -> controller method name, read from the router source (the live handlers are wrapped and anonymous)
for (const { file } of mounts) {
  const src = fs.readFileSync(path.join(root, 'routes', file + '.js'), 'utf8');
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'([^;]*?)\);/g)) {
    const last = [...m[3].matchAll(/[A-Za-z_]+\.([A-Za-z_]+)\s*(?:,|$)/g)].pop();
    if (last) handlerOf[file + '|' + m[1].toUpperCase() + '|' + m[2]] = last[1];
  }
}
const endpoints = [];
for (const { prefix, file } of mounts) {
  let router;
  try { router = require(path.join(root, 'routes', file)); } catch (e) { console.error(`cannot load routes/${file}: ${e.message}`); continue; }
  if (!router || !router.stack) continue;
  const inherited = router.stack.filter((l) => !l.route && l.name && !['query', 'expressInit', 'router', 'bound dispatch'].includes(l.name)).map((l) => l.name);
  const before = endpoints.length;
  walk(router.stack, prefix, endpoints, inherited);
  for (let i = before; i < endpoints.length; i += 1) { const e = endpoints[i]; e.mount = prefix; e.handler = handlerOf[file + '|' + e.method + '|' + (e.path.slice(prefix.length) || '/')] || ''; }
}
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0); // plain code-point order: localeCompare and directory order differ between machines
endpoints.sort((a, b) => cmp(a.path, b.path) || cmp(a.method, b.method));

// ---- coverage by text search of the tests
const files = [];
(function collect(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (!['node_modules', 'results', 'snapshots'].includes(f.name)) collect(p); } else if (f.name.endsWith('.js')) files.push(p);
  }
})(path.join(root, 'test'));
const sources = files.map((f) => ({ name: path.relative(root, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function patternFor(p) {
  // /api/x/:id/y -> /api/x/<anything but a slash or quote>/y
  return new RegExp(p.split('/').map((seg) => (seg.startsWith(':') ? "[^/'\"`?\\s]+" : esc(seg))).join('/') + "(?=['\"`?/\\s)]|$)");
}
for (const e of endpoints) {
  const re = patternFor(e.path);
  const hit = sources.filter((s) => re.test(s.text)).map((s) => s.name);
  // a template literal with ${...} stands for a parameter: also try with ${...} replaced by a segment
  e.tests = hit;
  e.weak = false;
  if (!hit.length) {
    // tests often go through a helper that adds the base (e.g. biz('/sos/x')): try the path relative to its mount, when that is specific enough
    const rel = e.path.slice(e.mount.length);
    if (rel.split('/').filter(Boolean).length >= 2 || /[a-z]{5,}/.test(rel.replace(/:[a-zA-Z]+/g, ''))) {
      const reRel = patternFor(rel);
      const w = sources.filter((x) => reRel.test(x.text)).map((x) => x.name);
      if (w.length) { e.tests = w; e.weak = true; }
    }
  }
  if (!e.tests.length && e.handler && e.handler.length >= 5) {
    // controller-level tests call the handler directly and never name the path
    const reH = new RegExp('\\b' + esc(e.handler) + '\\b');
    const w = sources.filter((x) => reH.test(x.text)).map((x) => x.name);
    if (w.length) { e.tests = w; e.weak = true; e.byHandler = true; }
  }
}

const guardLabel = (g) => g.filter((n) => /auth|admin|require|verify|limit|secret|token|guard|scheduler/i.test(n)).map((n) => n.replace(/^bound /, '')).join(', ') || '—';
const lines = [];
lines.push('# API inventory');
lines.push('');
lines.push('> Generated by `node scripts/apiInventory.js` from the loaded Express routers and the mounts in `index.js`. Do not edit by hand; CI fails when this file is stale (`--check`).');
lines.push('> "Tests" lists the test files that mention the path. **UNREFERENCED** means no test file names the path: a lead for a gap, not proof of one.');
lines.push('');
const unref = endpoints.filter((e) => !e.tests.length);
const weak = endpoints.filter((e) => e.weak);
lines.push(`${endpoints.length} endpoints, ${endpoints.length - unref.length} referenced by at least one test file (${weak.length} of those only by a weaker match: ~ the path relative to its mount, ≈ the handler's name called directly), ${unref.length} unreferenced.`);
lines.push('');
let group = '';
for (const e of endpoints) {
  const g = e.path.split('/').slice(0, 4).join('/');
  if (g !== group) { group = g; lines.push('', `## ${g}`, '', '| Method | Path | Guards | Tests |', '|---|---|---|---|'); }
  const t = e.tests.length ? e.tests.slice(0, 3).map((x) => x.replace(/^test\//, '')).join(', ') + (e.tests.length > 3 ? ` (+${e.tests.length - 3})` : '') : '**UNREFERENCED**';
  lines.push(`| ${e.method} | \`${e.path}\` | ${guardLabel(e.guards)} | ${t} |`);
}
lines.push('');
if (unref.length) {
  lines.push('## Unreferenced endpoints', '');
  for (const e of unref) lines.push(`- ${e.method} \`${e.path}\``);
  lines.push('');
}
const out = lines.join('\n');
const target = path.join(root, 'docs', 'API_INVENTORY.md');
if (process.argv.includes('--check')) {
  const have = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
  if (have !== out) { console.error('docs/API_INVENTORY.md is stale: run `node scripts/apiInventory.js`'); process.exit(1); }
  console.log('API inventory is up to date');
  process.exit(0);
}
fs.writeFileSync(target, out);
console.log(`wrote docs/API_INVENTORY.md: ${endpoints.length} endpoints, ${unref.length} unreferenced`);
process.exit(0);
