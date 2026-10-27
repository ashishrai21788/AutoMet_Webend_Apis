// A database that is briefly unreachable must never look like "your session ended": the apps sign the person out on a 401.
// Real token problems stay 401; anything unexpected is a 503 the apps can retry, and never leaks the internal message.
process.env.JWT_SECRET = 'test-secret-for-auth-outage';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.AUTH_ENFORCEMENT = 'strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const { requireAuth } = require('../lib/authMiddleware');
const { clearAppTenantCache } = require('../lib/appTenant');

const tok = (payload, opts = { expiresIn: '1h' }) => jwt.sign(payload, process.env.JWT_SECRET, opts);

const run = async (token, role = 'any') => {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body: {}, path: '/x', appTenant: { tenantId: 'app_default' } };
  let out = null; let passed = false;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await requireAuth({ roles: [role] })(req, res, () => { passed = true; });
  return { passed, out };
};

const seed = async () => {
  for (const m of ['Tenant', 'User', 'Driver']) db[m].rows.length = 0;
  clearAppTenantCache();
  await db.Tenant.create({ tenantId: 'app_default', name: 'Default', slug: 'default', appName: 'Default', packageName: 'com.default', isDefault: true });
  const t = tok({ userId: 'U1' });
  await db.User.create({ userId: 'U1', firstName: 'A', lastName: 'Rider', phone: '+919800000001', accessToken: t });
  return t;
};

test('real token problems stay 401: no token, a bad signature, an expired token, a replaced token', async () => {
  const good = await seed();
  assert.equal((await run(null)).out.code, 401);
  assert.equal((await run('not.a.token')).out.code, 401);
  assert.equal((await run(jwt.sign({ userId: 'U1' }, 'another-secret'))).out.code, 401);
  assert.equal((await run(tok({ userId: 'U1' }, { expiresIn: '-1h' }))).out.code, 401);
  assert.equal((await run(tok({ userId: 'U1', again: 1 }))).out.code, 401, 'a token that is not the stored one');
  assert.equal((await run(good)).passed, true, 'and the real one passes');
});

test('a database failure while checking the token is a 503, not a 401', async () => {
  const good = await seed();
  const original = db.User.findOne;
  db.User.findOne = () => { throw new Error('read ECONNRESET'); };
  try {
    const r = await run(good);
    assert.equal(r.passed, false);
    assert.equal(r.out.code, 503, 'the apps retry a 503 and sign out on a 401');
    assert.equal(r.out.body.success, false);
  } finally { db.User.findOne = original; }
});

test('the internal error is not sent to the app', async () => {
  const good = await seed();
  const original = db.User.findOne;
  db.User.findOne = () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password authentication failed'); };
  try {
    const r = await run(good);
    assert.doesNotMatch(JSON.stringify(r.out.body), /ECONNREFUSED|10\.0\.0\.5|password/);
    assert.match(r.out.body.message, /try again/i);
  } finally { db.User.findOne = original; }
});
