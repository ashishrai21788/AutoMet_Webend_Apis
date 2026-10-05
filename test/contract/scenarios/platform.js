/**
 * The platform owner's dashboard: sign-in and session, businesses (tenants), admin users and the platform team,
 * plans, subscriptions, invoices (issue, pay, refund, void, credit notes), settings, overview and audit reads.
 * PDFs are not captured (binary); the invoice list and CSV are.
 */
const { OWNER } = require('./common');

module.exports = async function platform(t) {
  const { call, alias } = t;

  // ---- sign-in
  await call('login: missing fields', { method: 'POST', path: '/api/admin/auth/login', body: {}, expectStatus: 400 });
  await call('login: wrong password', { method: 'POST', path: '/api/admin/auth/login', body: { email: OWNER.email, password: 'nope-nope-1' }, expectStatus: 401 });
  await call('login: unknown email', { method: 'POST', path: '/api/admin/auth/login', body: { email: 'nobody@contract.test', password: 'nope-nope-1' }, expectStatus: 401 });
  const login = await call('login: owner', { method: 'POST', path: '/api/admin/auth/login', body: OWNER, expectStatus: 200 });
  const owner = login.body.data.token;
  await call('session: me', { path: '/api/admin/auth/me', token: owner, expectStatus: 200 });
  await call('session: no token', { path: '/api/admin/auth/me', expectStatus: 401 });
  await call('session: garbage token', { path: '/api/admin/auth/me', token: 'abc.def.ghi', expectStatus: 401 });
  await call('forgot password: unknown email', { method: 'POST', path: '/api/admin/auth/forgot-password', body: { email: 'nobody@contract.test' } });
  await call('reset password: bad token', { method: 'POST', path: '/api/admin/auth/reset-password', body: { token: 'x', newPassword: 'Whatever-Pass-1' } });

  // ---- businesses
  await call('tenants: list', { path: '/api/admin/tenants', token: owner, expectStatus: 200 });
  await call('tenants: create, missing fields', { method: 'POST', path: '/api/admin/tenants', body: {}, token: owner, expectStatus: 400 });
  await call('tenants: create, bad package name', { method: 'POST', path: '/api/admin/tenants', body: { name: 'Zed Cabs', appName: 'Zed', adminName: 'Zed Admin', adminEmail: 'zed@contract.test', packageName: 'nope' }, token: owner, expectStatus: 400 });
  const made = await call('tenants: create', { method: 'POST', path: '/api/admin/tenants', body: { name: 'Zed Cabs', appName: 'Zed Rides', packageName: 'com.zed.rider', city: 'Pune', plan: 'trial', adminName: 'Zed Admin', adminEmail: 'zed@contract.test' }, token: owner, expectStatus: 201 });
  const tenant = made.body.data.tenant || made.body.data;
  const tid = tenant.appId || tenant.tenantId || tenant.id;
  alias(tid, 'zedAppId');
  const pw = (made.body.data.initialAdmin && made.body.data.initialAdmin.temporaryPassword) || made.body.data.temporaryPassword || (made.body.data.admin && made.body.data.admin.temporaryPassword);
  if (pw) alias(pw, 'zedTempPassword');
  await call('tenants: create again (duplicate email)', { method: 'POST', path: '/api/admin/tenants', body: { name: 'Zed Two', appName: 'Zed Two', packageName: 'com.zed.two', plan: 'trial', adminName: 'Zed Admin', adminEmail: 'zed@contract.test' }, token: owner, expectStatus: 409 });
  await call('tenants: update', { method: 'PATCH', path: `/api/admin/tenants/${tid}`, body: { appName: 'Zed Rides Pune', city: 'Mumbai' }, token: owner });
  await call('tenants: bad status', { method: 'PATCH', path: `/api/admin/tenants/${tid}/status`, body: { status: 'flying' }, token: owner });
  await call('tenants: suspend', { method: 'PATCH', path: `/api/admin/tenants/${tid}/status`, body: { status: 'suspended' }, token: owner });
  await call('tenants: reactivate', { method: 'PATCH', path: `/api/admin/tenants/${tid}/status`, body: { status: 'active' }, token: owner });
  await call('tenants: unknown id', { method: 'PATCH', path: '/api/admin/tenants/app_0000000000/status', body: { status: 'active' }, token: owner });
  await call('tenants: export', { path: `/api/admin/tenants/${tid}/export`, token: owner });
  await call('tenants: list after changes', { path: '/api/admin/tenants', token: owner, expectStatus: 200 });

  // ---- admin users
  await call('users: list', { path: '/api/admin/users', token: owner, expectStatus: 200 });
  await call('users: create, missing fields', { method: 'POST', path: '/api/admin/users', body: {}, token: owner, expectStatus: 400 });
  const ops = await call('users: create the business admin', { method: 'POST', path: '/api/admin/users', body: { name: 'Olly Ops', email: 'ops@contract.test', role: 'client_admin', tenantId: tid }, token: owner, expectStatus: 201 });
  alias(ops.body.data.temporaryPassword, 'opsTempPassword');
  const opsId = ops.body.data.adminId || ops.body.data.id || (ops.body.data.user && (ops.body.data.user.adminId || ops.body.data.user.id));
  alias(opsId, 'opsAdminId');
  await call('users: create duplicate', { method: 'POST', path: '/api/admin/users', body: { name: 'Olly Ops', email: 'ops@contract.test', role: 'client_admin', tenantId: tid }, token: owner, expectStatus: 409 });
  await call('users: update', { method: 'PATCH', path: `/api/admin/users/${opsId}`, body: { name: 'Olly Operations' }, token: owner });
  await call('users: deactivate', { method: 'PATCH', path: `/api/admin/users/${opsId}/active`, body: { active: false }, token: owner });
  await call('users: sign in while deactivated', { method: 'POST', path: '/api/admin/auth/login', body: { email: 'ops@contract.test', password: ops.body.data.temporaryPassword } });
  await call('users: reactivate', { method: 'PATCH', path: `/api/admin/users/${opsId}/active`, body: { active: true }, token: owner });
  const reset = await call('users: reset password', { method: 'POST', path: `/api/admin/users/${opsId}/reset-password`, body: {}, token: owner });
  if (reset.body && reset.body.data && reset.body.data.temporaryPassword) alias(reset.body.data.temporaryPassword, 'opsResetPassword');
  await call('users: reset two-factor', { method: 'POST', path: `/api/admin/users/${opsId}/reset-2fa`, body: {}, token: owner });
  await call('users: list after changes', { path: '/api/admin/users', token: owner, expectStatus: 200 });
  const opsLogin = await call('users: the new user signs in', { method: 'POST', path: '/api/admin/auth/login', body: { email: 'ops@contract.test', password: reset.body.data && reset.body.data.temporaryPassword } });
  const opsToken = opsLogin.body && opsLogin.body.data && opsLogin.body.data.token;
  await call('permissions: a business user may not manage businesses', { path: '/api/admin/tenants', token: opsToken });
  await call('permissions: a business user may not read platform billing', { path: '/api/admin/platform/plans', token: opsToken });

  // ---- platform team
  await call('team: list', { path: '/api/admin/platform/team', token: owner, expectStatus: 200 });
  const mem = await call('team: add a member', { method: 'POST', path: '/api/admin/platform/team', body: { name: 'Fin Finance', email: 'fin@contract.test', role: 'finance' }, token: owner });
  const memId = mem.body && mem.body.data && (mem.body.data.adminId || mem.body.data.id || (mem.body.data.user && mem.body.data.user.adminId));
  if (mem.body && mem.body.data && mem.body.data.temporaryPassword) alias(mem.body.data.temporaryPassword, 'finTempPassword');
  if (memId) {
    alias(memId, 'finAdminId');
    await call('team: rename', { method: 'PATCH', path: `/api/admin/platform/team/${memId}`, body: { name: 'Fin Accounts' }, token: owner });
    await call('team: deactivate', { method: 'PATCH', path: `/api/admin/platform/team/${memId}/active`, body: { active: false }, token: owner });
    await call('team: reset password', { method: 'POST', path: `/api/admin/platform/team/${memId}/reset-password`, body: {}, token: owner });
    await call('team: reset two-factor', { method: 'POST', path: `/api/admin/platform/team/${memId}/reset-2fa`, body: {}, token: owner });
  }
  await call('team: list after changes', { path: '/api/admin/platform/team', token: owner });

  // ---- settings
  await call('settings: read', { path: '/api/admin/platform/settings', token: owner, expectStatus: 200 });
  await call('settings: nothing to update', { method: 'PUT', path: '/api/admin/platform/settings', body: {}, token: owner, expectStatus: 400 });
  await call('settings: bad GSTIN', { method: 'PUT', path: '/api/admin/platform/settings', body: { gstin: 'bad' }, token: owner, expectStatus: 400 });
  await call('settings: update', { method: 'PUT', path: '/api/admin/platform/settings', body: { companyName: 'Contract Platform Pvt Ltd', legalName: 'Contract Platform Private Limited', billingEmail: 'billing@contract.test', address: '1 Platform Road, Pune', stateCode: '27', gstRate: 18, invoiceDueDays: 10, graceDays: 5, lapseAction: 'none', reminderOffsets: [-3, 0, 5] }, token: owner, expectStatus: 200 });
  await call('settings: read after update', { path: '/api/admin/platform/settings', token: owner, expectStatus: 200 });

  // ---- plans
  await call('plans: list (none yet)', { path: '/api/admin/platform/plans', token: owner, expectStatus: 200 });
  await call('plans: create, invalid', { method: 'POST', path: '/api/admin/platform/plans', body: { name: 'x' }, token: owner, expectStatus: 400 });
  const plan = await call('plans: create', { method: 'POST', path: '/api/admin/platform/plans', body: { name: 'Growth', description: 'For growing fleets', price: 10000, cycle: 'monthly', setupFee: 5000, trialDays: 14 }, token: owner, expectStatus: 201 });
  const planId = plan.body.data.planId || plan.body.data.id;
  alias(planId, 'planId');
  await call('plans: update', { method: 'PATCH', path: `/api/admin/platform/plans/${planId}`, body: { price: 12000 }, token: owner });
  await call('plans: update nothing', { method: 'PATCH', path: `/api/admin/platform/plans/${planId}`, body: {}, token: owner, expectStatus: 400 });
  await call('plans: unknown plan', { method: 'PATCH', path: '/api/admin/platform/plans/plan_0000', body: { price: 1 }, token: owner });
  await call('plans: list', { path: '/api/admin/platform/plans', token: owner, expectStatus: 200 });

  // ---- billing details, subscription
  await call('billing: read (nothing yet)', { path: `/api/admin/tenants/${tid}/billing`, token: owner });
  await call('billing details: bad GSTIN', { method: 'PUT', path: `/api/admin/tenants/${tid}/billing-details`, body: { gstin: 'bad' }, token: owner, expectStatus: 400 });
  await call('billing details: save', { method: 'PUT', path: `/api/admin/tenants/${tid}/billing-details`, body: { legalName: 'Zed Cabs Private Limited', address: '9 Zed Street, Mumbai', email: 'accounts@zed.test', stateCode: '27' }, token: owner });
  await call('subscription: choose a plan', { method: 'PUT', path: `/api/admin/tenants/${tid}/subscription`, body: {}, token: owner, expectStatus: 400 });
  await call('subscription: assign', { method: 'PUT', path: `/api/admin/tenants/${tid}/subscription`, body: { planId, startDate: '2026-01-01', notes: 'Contract subscription' }, token: owner });
  await call('subscription: renew', { method: 'POST', path: `/api/admin/tenants/${tid}/subscription/renew`, body: {}, token: owner });
  await call('billing: read', { path: `/api/admin/tenants/${tid}/billing`, token: owner });

  // ---- invoices
  await call('invoice: create, invalid', { method: 'POST', path: `/api/admin/tenants/${tid}/invoices`, body: { type: 'subscription' }, token: owner, expectStatus: 400 });
  const inv1 = await call('invoice: create 1', { method: 'POST', path: `/api/admin/tenants/${tid}/invoices`, body: { type: 'subscription', amount: 12000, periodStart: '2026-02-01', periodEnd: '2026-02-28' }, token: owner });
  const id1 = inv1.body.data && (inv1.body.data.invoiceId || inv1.body.data.id || (inv1.body.data.invoice && inv1.body.data.invoice.invoiceId));
  const inv2 = await call('invoice: create 2', { method: 'POST', path: `/api/admin/tenants/${tid}/invoices`, body: { type: 'other', amount: 3000, description: 'Custom work' }, token: owner });
  const id2 = inv2.body.data && (inv2.body.data.invoiceId || inv2.body.data.id || (inv2.body.data.invoice && inv2.body.data.invoice.invoiceId));
  if (id1) alias(id1, 'invoice1');
  if (id2) alias(id2, 'invoice2');
  if (id1) {
    await call('invoice: pay, no method', { method: 'POST', path: `/api/admin/invoices/${id1}/pay`, body: {}, token: owner, expectStatus: 400 });
    await call('invoice: pay', { method: 'POST', path: `/api/admin/invoices/${id1}/pay`, body: { paymentMethod: 'upi', reference: 'UPI-REF-1' }, token: owner });
    await call('invoice: pay again', { method: 'POST', path: `/api/admin/invoices/${id1}/pay`, body: { paymentMethod: 'upi' }, token: owner });
    await call('invoice: refund too much', { method: 'POST', path: `/api/admin/invoices/${id1}/refund`, body: { amount: 99999999, reason: 'Too much for contract' }, token: owner, expectStatus: 400 });
    await call('invoice: refund', { method: 'POST', path: `/api/admin/invoices/${id1}/refund`, body: { amount: 1000, reason: 'Goodwill credit' }, token: owner });
    await call('invoice: refund again', { method: 'POST', path: `/api/admin/invoices/${id1}/refund`, body: { amount: 500, reason: 'Second credit' }, token: owner });
  }
  if (id2) {
    await call('invoice: void', { method: 'POST', path: `/api/admin/invoices/${id2}/void`, body: { reason: 'Raised by mistake' }, token: owner });
    await call('invoice: void again', { method: 'POST', path: `/api/admin/invoices/${id2}/void`, body: { reason: 'Raised by mistake' }, token: owner });
    await call('invoice: pay a voided invoice', { method: 'POST', path: `/api/admin/invoices/${id2}/pay`, body: { paymentMethod: 'cash' }, token: owner });
  }
  await call('invoice: unknown', { method: 'POST', path: '/api/admin/invoices/inv_missing/pay', body: { paymentMethod: 'cash' }, token: owner });
  await call('invoices: list', { path: '/api/admin/platform/invoices', token: owner, expectStatus: 200 });
  await call('invoices: list filtered', { path: '/api/admin/platform/invoices?status=paid', token: owner });
  await call('invoices: csv', { path: '/api/admin/platform/invoices.csv', token: owner });
  await call('revenue: summary', { path: '/api/admin/platform/revenue/summary', token: owner, expectStatus: 200 });
  await call('billing: read after invoices', { path: `/api/admin/tenants/${tid}/billing`, token: owner });
  await call('subscription: cancel', { method: 'POST', path: `/api/admin/tenants/${tid}/subscription/cancel`, body: { reason: 'Contract cancel' }, token: owner });
  await call('billing run', { method: 'POST', path: '/api/admin/platform/billing/run', body: {}, token: owner });

  // ---- reads
  await call('overview', { path: '/api/admin/platform/overview', token: owner, expectStatus: 200 });
  await call('dashboard', { path: '/api/admin/dashboard', token: owner });
  await call('audit (platform)', { path: '/api/admin/platform/audit', token: owner, expectStatus: 200 });
  await call('audit (all)', { path: '/api/admin/audit', token: owner });
  await call('public: health', { path: '/health' });
  await call('tenants: delete without confirmation', { method: 'DELETE', path: `/api/admin/tenants/${tid}`, token: owner, expectStatus: 400 });
  await call('tenants: delete while active', { method: 'DELETE', path: `/api/admin/tenants/${tid}`, body: { confirm: tid }, token: owner, expectStatus: 409 });
  await call('tenants: suspend before delete', { method: 'PATCH', path: `/api/admin/tenants/${tid}/status`, body: { status: 'suspended' }, token: owner });
  await call('tenants: delete', { method: 'DELETE', path: `/api/admin/tenants/${tid}`, body: { confirm: tid }, token: owner });
  await call('tenants: list at the end', { path: '/api/admin/tenants', token: owner, expectStatus: 200 });
};
