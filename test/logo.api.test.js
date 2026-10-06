// Business logo upload: type checked by the file's own bytes, size limit, replace and remove, who may, isolation, and
// that the apps' public config shows the new logo. In-memory stand-ins. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-logo-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');
const { createFakeDb } = require('./helpers/fakeDb');
const { createMemoryStorage } = require('./helpers/memoryStorage');
const { jsonBodyParser } = require('../lib/jsonBody');

const db = createFakeDb();
db.install();
require('../lib/privateStorage').setBackend(createMemoryStorage());
const images = require('../lib/publicImages');
const memory = images.createMemoryImages({ baseUrl: 'https://cdn.test' });
images.setBackend(memory);
const adminRoutes = require('../routes/adminRoutes');
const publicRoutes = require('../routes/publicRoutes');
const { appTenantMiddleware, clearAppTenantCache } = require('../lib/appTenant');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(64, ' '));
const PDF = Buffer.from('%PDF-1.7\n'.padEnd(64, ' '));

let server;
let base;
const ctx = {};

test.before(async () => {
  await db.Tenant.create({ tenantId: 'app_a', name: 'Alpha', slug: 'a', appName: 'A', packageName: 'com.a', status: 'active' });
  await db.Tenant.create({ tenantId: 'app_b', name: 'Beta', slug: 'b', appName: 'B', packageName: 'com.b', status: 'active' });
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: bcrypt.hashSync(pw, 4) });
  await mk('u_a', 'admin@a.test', 'client_admin', 'app_a', 'password-a-admin');
  await mk('u_sup', 'support@a.test', 'support', 'app_a', 'password-a-supp');
  await mk('u_b', 'admin@b.test', 'client_admin', 'app_b', 'password-b-admin');
  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  app.use('/api', appTenantMiddleware);
  app.use('/api/v1/public', publicRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => (await (await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  ctx.admin = await login('admin@a.test', 'password-a-admin');
  ctx.support = await login('support@a.test', 'password-a-supp');
  ctx.b = await login('admin@b.test', 'password-b-admin');
});
test.after(() => server.close());
test.beforeEach(() => clearAppTenantCache());

const send = async (buffer, { token = ctx.admin, appId = 'app_a', name = 'logo.png', type = 'image/png', method = 'POST' } = {}) => {
  const headers = { Authorization: `Bearer ${token}`, 'X-App-Id': appId };
  let body;
  if (buffer) { body = new FormData(); body.append('file', new Blob([buffer], { type }), name); }
  const res = await fetch(base + '/api/admin/business/logo', { method, headers, body });
  return { status: res.status, body: await res.json() };
};
const tenant = (id) => db.Tenant.rows.find((t) => t.tenantId === id);

test('upload: a PNG is stored, the business gets its link, it is audited, and the apps see it', async () => {
  const r = await send(PNG);
  assert.equal(r.status, 200);
  assert.match(r.body.data.logoUrl, /^https:\/\/cdn\.test\/logo\/app_a-\d+$/);
  assert.equal(tenant('app_a').logoUrl, r.body.data.logoUrl);
  assert.ok(!tenant('app_b').logoUrl, 'the other business is untouched');
  const a = db.AdminAudit.rows.find((x) => x.action === 'business.logo_updated');
  assert.deepEqual([a.tenantId, a.actorEmail, a.meta.type], ['app_a', 'admin@a.test', 'image/png']);
  const cfg = await (await fetch(base + '/api/v1/public/business/config', { headers: { 'X-App-Id': 'app_a' } })).json();
  assert.equal(cfg.data.business.logoUrl, r.body.data.logoUrl);
});

test('upload again replaces the logo with a new link', async () => {
  const first = tenant('app_a').logoUrl;
  const r = await send(JPEG, { name: 'new.jpg', type: 'image/jpeg' });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.data.logoUrl, first);
});

test('the file\'s own bytes decide: renamed or mislabelled files, SVG and PDF are refused', async () => {
  const before = tenant('app_a').logoUrl;
  assert.equal((await send(SVG, { name: 'logo.png', type: 'image/png' })).status, 400, 'SVG renamed to .png');
  assert.equal((await send(PDF, { name: 'logo.jpg', type: 'image/jpeg' })).status, 400);
  assert.equal((await send(Buffer.from('plain text pretending to be an image, long enough to be read'), { name: 'a.png' })).status, 400);
  const r = await send(SVG);
  assert.ok(r.body.errors.file);
  assert.equal(tenant('app_a').logoUrl, before, 'nothing changed');
});

test('size limit and missing file', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024, 3)]);
  const r = await send(big);
  assert.equal(r.status, 413);
  assert.ok(r.body.errors.file);
  const none = await fetch(base + '/api/admin/business/logo', { method: 'POST', headers: { Authorization: `Bearer ${ctx.admin}`, 'X-App-Id': 'app_a' } });
  assert.equal(none.status, 400);
});

test('only people who manage settings, only for their own business', async () => {
  assert.equal((await send(PNG, { token: ctx.support })).status, 403);
  assert.equal((await send(PNG, { token: ctx.b, appId: 'app_a' })).status, 403);
  assert.equal((await fetch(base + '/api/admin/business/logo', { method: 'POST' })).status, 401);
  assert.equal((await send(PNG, { token: ctx.b, appId: 'app_b' })).status, 200, 'Beta can set its own');
  assert.notEqual(tenant('app_b').logoUrl, tenant('app_a').logoUrl);
});

test('remove clears the link and the stored file', async () => {
  const id = tenant('app_a').logoUrl.split('/').pop();
  assert.ok(memory.read(id));
  const r = await send(null, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(tenant('app_a').logoUrl, '');
  assert.equal(memory.read(id), null);
  assert.ok(db.AdminAudit.rows.some((x) => x.action === 'business.logo_removed' && x.tenantId === 'app_a'));
  assert.ok(tenant('app_b').logoUrl, "Beta's logo stays");
});

test('without image storage the upload says so instead of failing oddly', async () => {
  images.setBackend(null);
  const saved = { a: process.env.CLOUDINARY_CLOUD_NAME, b: process.env.CLOUDINARY_API_KEY, c: process.env.CLOUDINARY_API_SECRET };
  delete process.env.CLOUDINARY_CLOUD_NAME; delete process.env.CLOUDINARY_API_KEY; delete process.env.CLOUDINARY_API_SECRET;
  try {
    const r = await send(PNG);
    assert.equal(r.status, 503);
    assert.match(r.body.message, /not set up/);
  } finally {
    images.setBackend(memory);
    if (saved.a) process.env.CLOUDINARY_CLOUD_NAME = saved.a;
    if (saved.b) process.env.CLOUDINARY_API_KEY = saved.b;
    if (saved.c) process.env.CLOUDINARY_API_SECRET = saved.c;
  }
});
