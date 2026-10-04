// Admin API rules that do not need a database. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-admin-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { can, isSuperAdmin, ROLE_PERMISSIONS } = require('../lib/adminPermissions');
const { resolveTenantScope, tenantMatch, ForbiddenError } = require('../lib/tenantScope');
const { signAdminToken, createRequireAdmin, adminSecret } = require('../lib/adminAuth');
const { computeRates, startOfTodayIST } = require('../lib/adminDashboard');

const superAdmin = { adminId: 'a1', role: 'super_admin', tenantId: null, active: true, tokenVersion: 0 };
const clientA = { adminId: 'a2', role: 'client_admin', tenantId: 't_a', active: true, tokenVersion: 0 };
const supportA = { adminId: 'a3', role: 'support', tenantId: 't_a', active: true, tokenVersion: 0 };

test('permissions: only the super admin manages clients', () => {
  assert.equal(can(superAdmin, 'clients.manage'), true);
  assert.equal(can(clientA, 'clients.manage'), false);
  assert.equal(can(supportA, 'pricing.manage'), false);
  assert.equal(can(supportA, 'trips.view'), true);
  assert.equal(can(null, 'dashboard.view'), false);
  assert.equal(isSuperAdmin(clientA), false);
  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    if (role !== 'super_admin') assert.equal(ROLE_PERMISSIONS[role].includes('clients.manage'), false, role);
  }
});

test('scope: super admin may pick any client or all clients', () => {
  assert.equal(resolveTenantScope(superAdmin, null), null);
  assert.equal(resolveTenantScope(superAdmin, 't_b'), 't_b');
});

test('scope: client users are pinned to their own client', () => {
  assert.equal(resolveTenantScope(clientA, null), 't_a');
  assert.equal(resolveTenantScope(clientA, 't_a'), 't_a');
  assert.throws(() => resolveTenantScope(clientA, 't_b'), ForbiddenError);
  assert.throws(() => resolveTenantScope({ ...clientA, tenantId: null }, null), ForbiddenError);
});

test('tenantMatch: default client also owns untagged records', () => {
  assert.deepEqual(tenantMatch(null, 'tenant_id'), {});
  assert.deepEqual(tenantMatch({ tenantId: 't_a', isDefault: false }, 'tenant_id'), { tenant_id: 't_a' });
  assert.deepEqual(tenantMatch({ tenantId: 't_d', isDefault: true }, 'tenant_id'), { tenant_id: { $in: ['t_d', null] } });
});

test('rates: acceptance and cancellation', () => {
  assert.deepEqual(computeRates({}), { acceptanceRate: 0, cancellationRate: 0 });
  // 10 requests: 1 still waiting, 5 completed, 1 accepted then cancelled, 1 cancelled early, 1 declined, 1 no response
  const r = computeRates({
    REQUESTED: 1, COMPLETED: 5, CANCELLED_BY_USER_AFTER_ACCEPTANCE: 1, CANCELLED_BY_USER: 1, REJECTED: 1, NO_RESPONSE: 1
  });
  assert.equal(r.acceptanceRate, Math.round((6 / 9) * 100));
  assert.equal(r.cancellationRate, 20);
});

test('startOfTodayIST: midnight in India expressed in UTC', () => {
  // 2026-10-04 02:00 UTC is 07:30 IST on the 4th -> IST midnight is 2026-10-03 18:30 UTC
  assert.equal(startOfTodayIST(new Date('2026-10-04T02:00:00Z')).toISOString(), '2026-10-03T18:30:00.000Z');
  // 2026-10-04 20:00 UTC is 01:30 IST on the 5th -> IST midnight is 2026-10-04 18:30 UTC
  assert.equal(startOfTodayIST(new Date('2026-10-04T20:00:00Z')).toISOString(), '2026-10-04T18:30:00.000Z');
});

// ---- middleware ----

function run(middleware, headers = {}) {
  return new Promise((resolve) => {
    const req = { headers };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, req }); }
    };
    middleware(req, res, () => resolve({ status: 'next', req }));
  });
}

function makeRequireAdmin(admins, tenants) {
  return createRequireAdmin({
    loadAdmin: async (id) => admins[id] || null,
    loadTenant: async (id) => tenants[id] || null
  });
}

const tenants = { t_a: { tenantId: 't_a', status: 'active' }, t_s: { tenantId: 't_s', status: 'suspended' } };
const bearer = (token) => ({ authorization: `Bearer ${token}` });

test('middleware: valid token passes and loads the admin', async () => {
  const requireAdmin = makeRequireAdmin({ a2: clientA }, tenants);
  const out = await run(requireAdmin('dashboard.view'), bearer(signAdminToken(clientA)));
  assert.equal(out.status, 'next');
  assert.equal(out.req.admin.adminId, 'a2');
});

test('middleware: rejects missing, garbage and non-admin tokens', async () => {
  const requireAdmin = makeRequireAdmin({ a2: clientA }, tenants);
  assert.equal((await run(requireAdmin(), {})).status, 401);
  assert.equal((await run(requireAdmin(), bearer('nope'))).status, 401);
  // a driver or rider token signed with the plain JWT secret must not work as an admin token
  const driverToken = jwt.sign({ driverId: 'd1' }, process.env.JWT_SECRET);
  assert.equal((await run(requireAdmin(), bearer(driverToken))).status, 401);
  // an admin-typed payload signed with the plain secret is rejected as well
  const forged = jwt.sign({ typ: 'admin', adminId: 'a1', role: 'super_admin' }, process.env.JWT_SECRET);
  assert.equal((await run(requireAdmin(), bearer(forged))).status, 401);
});

test('middleware: an admin token is useless as a driver or rider token', () => {
  assert.throws(() => jwt.verify(signAdminToken(clientA), process.env.JWT_SECRET));
  assert.doesNotThrow(() => jwt.verify(signAdminToken(clientA), adminSecret()));
});

test('middleware: expired token, stale token version, deactivated and unknown users', async () => {
  const requireAdmin = makeRequireAdmin({ a2: clientA, a9: { ...clientA, adminId: 'a9', active: false }, a7: { ...clientA, adminId: 'a7', tokenVersion: 3 } }, tenants);
  const expired = jwt.sign({ typ: 'admin', adminId: 'a2', tv: 0 }, adminSecret(), { expiresIn: -10 });
  assert.equal((await run(requireAdmin(), bearer(expired))).status, 401);
  assert.equal((await run(requireAdmin(), bearer(signAdminToken({ ...clientA, adminId: 'a7', tokenVersion: 2 })))).status, 401);
  assert.equal((await run(requireAdmin(), bearer(signAdminToken({ ...clientA, adminId: 'a9' })))).status, 401);
  assert.equal((await run(requireAdmin(), bearer(signAdminToken({ ...clientA, adminId: 'ghost' })))).status, 401);
});

test('middleware: suspended client is locked out; permission is enforced', async () => {
  const suspendedUser = { ...clientA, adminId: 'a5', tenantId: 't_s' };
  const requireAdmin = makeRequireAdmin({ a5: suspendedUser, a2: clientA, a3: supportA, a1: superAdmin }, tenants);
  assert.equal((await run(requireAdmin(), bearer(signAdminToken(suspendedUser)))).status, 403);
  assert.equal((await run(requireAdmin('clients.manage'), bearer(signAdminToken(clientA)))).status, 403);
  assert.equal((await run(requireAdmin('pricing.manage'), bearer(signAdminToken(supportA)))).status, 403);
  assert.equal((await run(requireAdmin('clients.manage'), bearer(signAdminToken(superAdmin)))).status, 'next');
});

test('admin routes load and expose the contract the dashboard uses', () => {
  const router = require('../routes/adminRoutes');
  const seen = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  for (const expected of [
    'POST /auth/login', 'GET /auth/me', 'POST /auth/change-password', 'GET /tenants', 'POST /tenants',
    'PATCH /tenants/:id/status', 'GET /users', 'POST /users', 'PATCH /users/:id/active', 'GET /dashboard', 'GET /audit'
  ]) assert.ok(seen.includes(expected), `missing ${expected}`);
});
