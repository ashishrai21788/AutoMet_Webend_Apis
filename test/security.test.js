// Security baseline: rate limits on sign-in and OTP routes, and the CORS allow-list. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-security-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { jsonBodyParser } = require('../lib/jsonBody');
const { createLimiter, otpSendLimiters, otpVerifyLimiters, adminLoginLimiters, resetAllLimiters, subjectOf } = require('../lib/rateLimit');
const { corsMiddleware, allowedOrigins } = require('../lib/cors');

let server;
let base;

test.before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(corsMiddleware({ CORS_ALLOWED_ORIGINS: 'https://other-dashboard.example/' }));
  app.use(jsonBodyParser());
  const ok = (req, res) => res.json({ success: true });
  app.post('/send', ...otpSendLimiters('t'), ok);
  app.post('/verify', ...otpVerifyLimiters('t'), ok);
  app.post('/admin-login', ...adminLoginLimiters(), ok);
  app.get('/ping', ok);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => resetAllLimiters());

const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('OTP guessing is stopped after 8 tries for one person, whatever the formatting of the phone number', async () => {
  const variants = ['+91 98765 43210', '+91-98765-43210', '+919876543210'];
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await post('/verify', { phone: variants[i % 3], otp: String(100000 + i) })).status);
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(200));
  assert.deepEqual(statuses.slice(8), [429, 429]);
  const blocked = await post('/verify', { phone: '+919876543210', otp: '123456' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  const body = await blocked.json();
  assert.equal(body.error, 'RATE_LIMITED');
  assert.equal(body.success, false);
});

test('a different person from the same address is not blocked by someone else\'s guesses', async () => {
  for (let i = 0; i < 9; i++) await post('/verify', { driverId: 'D1', otp: '000000' });
  assert.equal((await post('/verify', { driverId: 'D1', otp: '000000' })).status, 429);
  assert.equal((await post('/verify', { driverId: 'D2', otp: '000000' })).status, 200);
});

test('asking for a code is limited to 5 per person, and the limit is separate from checking codes', async () => {
  const s = [];
  for (let i = 0; i < 6; i++) s.push((await post('/send', { phoneNumber: '9000000001' })).status);
  assert.deepEqual(s, [200, 200, 200, 200, 200, 429]);
  assert.equal((await post('/verify', { phoneNumber: '9000000001', otp: '111111' })).status, 200);
});

test('a request with no person named is still counted by address and not rejected for it', async () => {
  assert.equal((await post('/send', {})).status, 200);
});

test('admin sign-in: 10 tries per email, then refused even with the right password later', async () => {
  const s = [];
  for (let i = 0; i < 11; i++) s.push((await post('/admin-login', { email: 'Boss@Example.com', password: 'x' + i })).status);
  assert.equal(s.filter((x) => x === 200).length, 10);
  assert.equal(s[10], 429);
  // another account is not affected
  assert.equal((await post('/admin-login', { email: 'someone@else.test', password: 'x' })).status, 200);
});

test('the address comes from the proxy header, so two clients behind the proxy are counted separately', async () => {
  const lim = createLimiter({ name: 'ip', windowMs: 60000, max: 2, key: (r) => `ip:${r.ip}` });
  const app = express();
  app.set('trust proxy', 1);
  app.get('/', lim, (req, res) => res.json({ ip: req.ip }));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/`;
  try {
    const get = (ip) => fetch(url, { headers: { 'X-Forwarded-For': ip } }).then((r) => r.status);
    assert.deepEqual([await get('1.1.1.1'), await get('1.1.1.1'), await get('1.1.1.1')], [200, 200, 429]);
    assert.equal(await get('2.2.2.2'), 200);
  } finally { srv.close(); }
});

test('the window resets after it ends', async () => {
  const lim = createLimiter({ name: 'short', windowMs: 150, max: 1, key: () => 'k' });
  const run = () => new Promise((resolve) => {
    const res = { set() {}, status(c) { this.code = c; return this; }, json() { resolve(this.code); } };
    lim({}, res, () => resolve(200));
  });
  assert.equal(await run(), 200);
  assert.equal(await run(), 429);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await run(), 200);
});

test('subjectOf prefers driverId or userId and normalises spacing and case', () => {
  assert.equal(subjectOf({ body: { driverId: ' D-1 ', phone: '5' } }), 'd1');
  assert.equal(subjectOf({ body: { email: 'A@B.com' } }), 'a@b.com');
  assert.equal(subjectOf({ body: {} }), null);
  assert.equal(subjectOf({}), null);
});

test('CORS: an allowed dashboard origin is echoed back, others get no Allow-Origin, apps with no Origin are unaffected', async () => {
  const get = (origin) => fetch(base + '/ping', { headers: origin ? { Origin: origin } : {} });

  const dash = await get('https://auto-met-admin.vercel.app');
  assert.equal(dash.headers.get('access-control-allow-origin'), 'https://auto-met-admin.vercel.app');
  assert.equal(dash.headers.get('access-control-allow-credentials'), 'true');

  const extra = await get('https://other-dashboard.example');
  assert.equal(extra.headers.get('access-control-allow-origin'), 'https://other-dashboard.example', 'trailing slash in the env value is ignored');

  const evil = await get('https://evil.example');
  assert.equal(evil.status, 200);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal(evil.headers.get('access-control-allow-credentials'), null);
  assert.match(evil.headers.get('vary') || '', /Origin/);

  const app = await get(null);
  assert.equal(app.status, 200);
  assert.equal(app.headers.get('access-control-allow-origin'), null);
  assert.equal((await app.json()).success, true);
});

test('CORS preflight: allowed headers include X-App-Id and only allowed origins are granted', async () => {
  const pre = (origin) => fetch(base + '/ping', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' } });
  const good = await pre('http://localhost:5173');
  assert.equal(good.status, 204);
  assert.equal(good.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.match(good.headers.get('access-control-allow-headers'), /X-App-Id/);
  assert.match(good.headers.get('access-control-allow-methods'), /PUT/);
  const bad = await pre('https://evil.example');
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('the default allow-list holds the production dashboard and local development only', () => {
  const set = allowedOrigins({});
  assert.deepEqual([...set].sort(), ['http://127.0.0.1:5173', 'http://localhost:5173', 'https://auto-met-admin.vercel.app']);
});

// The real routers: every code-sending, code-checking and sign-in route must carry its limiters.
const limited = (router, method, path) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `route ${method} ${path} exists`);
  return layer.route.stack.map((s) => s.handle.limiterName).filter(Boolean);
};

test('real routes carry their rate limiters', () => {
  const user = require('../routes/userRoutes');
  const otp = require('../routes/otpRoutes');
  const dyn = require('../routes/dynamicRoutes');
  const admin = require('../routes/adminRoutes');
  for (const p of ['/register', '/login', '/resend-otp']) assert.deepEqual(limited(user, 'post', p), ['user-send-ip', 'user-send-subject'], 'user ' + p);
  assert.deepEqual(limited(user, 'post', '/verify-otp'), ['user-verify-ip', 'user-verify-subject']);
  for (const p of ['/send', '/generate', '/resend']) assert.deepEqual(limited(otp, 'post', p), ['driver-send-ip', 'driver-send-subject'], 'driver ' + p);
  assert.deepEqual(limited(otp, 'post', '/verify'), ['driver-verify-ip', 'driver-verify-subject']);
  assert.deepEqual(limited(dyn, 'post', '/drivers/login'), ['driver-login-send-ip', 'driver-login-send-subject']);
  assert.deepEqual(limited(admin, 'post', '/auth/login'), ['admin-login-ip', 'admin-login-subject']);
});
