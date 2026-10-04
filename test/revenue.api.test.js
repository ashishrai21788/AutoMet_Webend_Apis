// AutoMet's own revenue (what businesses pay the platform): the maths checked by hand, plans, subscriptions, invoices,
// manual payments, refunds, settings, who may see it, and that none of it touches a business's own audit log or ride money.
// In-memory stand-ins. Run with: npm test
process.env.JWT_SECRET = 'test-secret-for-revenue-tests';
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
const adminRoutes = require('../routes/adminRoutes');
const rev = require('../lib/revenue');

const D = (iso) => new Date(iso);

// ---------- pure: dates, recurring revenue, the summary ----------

test('adding a billing cycle keeps the day, and clamps to the end of a short month', () => {
  assert.equal(rev.addCycle(D('2026-01-15T00:00:00Z'), 'monthly').toISOString(), '2026-02-15T00:00:00.000Z');
  assert.equal(rev.addCycle(D('2026-01-31T00:00:00Z'), 'monthly').toISOString(), '2026-02-28T00:00:00.000Z', 'not 3 March');
  assert.equal(rev.addCycle(D('2028-02-29T00:00:00Z'), 'yearly').toISOString(), '2029-02-28T00:00:00.000Z');
  assert.equal(rev.addCycle(D('2026-12-10T00:00:00Z'), 'monthly').toISOString(), '2027-01-10T00:00:00.000Z');
});

const sub = (planId, status, price, cycle, renewalDate, extra = {}) => ({ planId, planName: planId === 'p1' ? 'Starter' : 'Pro', status, price, cycle, renewalDate: D(renewalDate), ...extra });
const TENANTS = [
  { tenantId: 'A', name: 'Alpha', status: 'active', createdAt: D('2026-10-03T00:00:00Z'), subscription: sub('p1', 'active', 1000, 'monthly', '2026-11-01T00:00:00Z') },
  { tenantId: 'B', name: 'Beta', status: 'active', createdAt: D('2026-10-04T00:00:00Z'), subscription: sub('p2', 'active', 12000, 'yearly', '2027-03-01T00:00:00Z') },
  { tenantId: 'C', name: 'Gamma', status: 'trial', createdAt: D('2026-09-20T00:00:00Z'), subscription: sub('p1', 'trialing', 500, 'monthly', '2026-10-20T00:00:00Z') },
  { tenantId: 'D', name: 'Delta', status: 'suspended', createdAt: D('2026-08-01T00:00:00Z'), subscription: sub('p2', 'active', 700, 'monthly', '2026-10-01T00:00:00Z') },
  { tenantId: 'E', name: 'Epsilon', status: 'active', createdAt: D('2026-08-02T00:00:00Z'), subscription: sub('p2', 'cancelled', 900, 'monthly', '2026-12-01T00:00:00Z') },
  { tenantId: 'F', name: 'Phi', status: 'active', createdAt: D('2026-08-03T00:00:00Z'), subscription: null }
];
const PLANS = [{ planId: 'p1', name: 'Starter', price: 1000, cycle: 'monthly' }, { planId: 'p2', name: 'Pro', price: 12000, cycle: 'yearly' }];
const NOW = D('2026-10-15T12:00:00Z');
const INVOICES = [
  { invoiceId: 'i1', tenantId: 'A', type: 'subscription', amount: 1000, status: 'paid', issuedAt: D('2026-10-02T09:00:00Z'), paidAt: D('2026-10-05T09:00:00Z'), dueDate: D('2026-10-16T00:00:00Z'), refundedAmount: 400, refunds: [{ at: D('2026-10-08T09:00:00Z'), amount: 400, reason: 'x', by: 'o' }] },
  { invoiceId: 'i2', tenantId: 'B', type: 'subscription', amount: 12000, status: 'issued', issuedAt: D('2026-09-10T09:00:00Z'), dueDate: D('2026-09-24T00:00:00Z') },
  { invoiceId: 'i3', tenantId: 'A', type: 'subscription', amount: 1000, status: 'issued', issuedAt: D('2026-10-10T09:00:00Z'), dueDate: D('2026-10-25T00:00:00Z') },
  { invoiceId: 'i4', tenantId: 'C', type: 'subscription', amount: 500, status: 'void', issuedAt: D('2026-10-01T09:00:00Z'), dueDate: D('2026-10-10T00:00:00Z') },
  { invoiceId: 'i5', tenantId: 'A', type: 'subscription', amount: 1000, status: 'paid', issuedAt: D('2026-09-02T09:00:00Z'), paidAt: D('2026-09-06T09:00:00Z'), dueDate: D('2026-09-16T00:00:00Z') },
  { invoiceId: 'i6', tenantId: 'A', type: 'setup_fee', amount: 5000, status: 'paid', issuedAt: D('2026-08-20T09:00:00Z'), paidAt: D('2026-08-22T09:00:00Z'), dueDate: D('2026-09-03T00:00:00Z') }
];
const FROM = D('2025-11-01T00:00:00Z');

test('recurring revenue: only an active, priced subscription of a business that is not suspended', () => {
  assert.equal(rev.isRecurring(TENANTS[0]), true);
  assert.equal(rev.isRecurring(TENANTS[2]), false, 'a trial is not recurring revenue');
  assert.equal(rev.isRecurring(TENANTS[3]), false, 'a suspended business');
  assert.equal(rev.isRecurring(TENANTS[4]), false, 'a cancelled subscription');
  assert.equal(rev.isRecurring(TENANTS[5]), false, 'no subscription: nothing is assumed');
  assert.equal(rev.mrrOf(TENANTS), 2000, '1000 + 12000 / 12');
  assert.equal(rev.mrrOf([{ status: 'active', subscription: { status: 'active', price: 100, cycle: 'yearly' } }]), 8.33);
});

test('summary: billed, collected, refunded, net, outstanding and overdue are kept apart', () => {
  const s = rev.summarize({ tenants: TENANTS, invoices: INVOICES, plans: PLANS, now: NOW, from: FROM, to: NOW });
  assert.equal(s.billed, 20000, '1000 + 12000 + 1000 + 1000 + 5000; the void 500 is left out');
  assert.equal(s.collected, 7000, '1000 + 1000 + 5000');
  assert.equal(s.refunded, 400);
  assert.equal(s.netCollected, 6600);
  assert.equal(s.outstanding, 13000);
  assert.equal(s.overdue, 12000);
  assert.equal(s.mrr, 2000);
  assert.equal(s.arr, 24000);
});

test('summary: subscription counts, renewals, plans and growth come from the actual subscriptions', () => {
  const s = rev.summarize({ tenants: TENANTS, invoices: INVOICES, plans: PLANS, now: NOW, from: FROM, to: NOW });
  assert.deepEqual(s.counts, { businesses: 6, suspended: 1, activeSubscriptions: 3, trialing: 1, cancelled: 1, withoutSubscription: 1, recurring: 2, renewalsDue: 2, renewalsOverdue: 1, overdueInvoices: 1, outstandingInvoices: 2 });
  assert.deepEqual(s.upcomingRenewals.map((r) => [r.name, r.status]), [['Gamma', 'trialing'], ['Alpha', 'active']], 'next 30 days, soonest first');
  assert.deepEqual(s.byPlan.map((p) => [p.name, p.subscribers, p.mrr]), [['Pro', 2, 1000], ['Starter', 2, 1000]], 'equal MRR sorts by name; Gamma (trial) and suspended Delta earn nothing');
  const alpha = s.byBusiness.find((b) => b.appId === 'A');
  assert.deepEqual([alpha.mrr, alpha.billed, alpha.collected, alpha.refunded, alpha.outstanding, alpha.overdue], [1000, 8000, 7000, 400, 1000, 0]);
  assert.equal(s.byBusiness.find((b) => b.appId === 'F').subscriptionStatus, 'none');
});

test('summary: twelve months of billed, collected, refunded and net, and new businesses per month', () => {
  const s = rev.summarize({ tenants: TENANTS, invoices: INVOICES, plans: PLANS, now: NOW, from: FROM, to: NOW });
  assert.equal(s.series.length, 12);
  const m = Object.fromEntries(s.series.map((x) => [x.month, x]));
  assert.deepEqual(m['2026-10'], { month: '2026-10', billed: 2000, collected: 1000, refunded: 400, net: 600 });
  assert.deepEqual(m['2026-09'], { month: '2026-09', billed: 13000, collected: 1000, refunded: 0, net: 1000 });
  assert.deepEqual(m['2026-08'], { month: '2026-08', billed: 5000, collected: 5000, refunded: 0, net: 5000 });
  const a = Object.fromEntries(s.acquisition.map((x) => [x.month, x.newBusinesses]));
  assert.deepEqual([a['2026-10'], a['2026-09'], a['2026-08']], [2, 1, 3]);
  const oct = rev.summarize({ tenants: TENANTS, invoices: INVOICES, plans: PLANS, now: NOW, from: D('2026-10-01T00:00:00Z'), to: D('2026-10-31T23:59:59Z') });
  assert.deepEqual([oct.billed, oct.collected, oct.refunded, oct.netCollected], [2000, 1000, 400, 600], 'a range limits what is billed, collected and refunded, not what is outstanding');
  assert.equal(oct.outstanding, 13000);
});

test('revenue never contains ride money: the maths reads only subscriptions and platform invoices', () => {
  const s = rev.summarize({ tenants: [{ tenantId: 'X', name: 'X', status: 'active', subscription: null, rideFares: 999999, fare: 5000 }], invoices: [], plans: [], now: NOW, from: FROM, to: NOW });
  assert.deepEqual([s.mrr, s.billed, s.collected, s.netCollected, s.outstanding], [0, 0, 0, 0, 0]);
});

test('validation: plans, subscriptions, invoices, payments, refunds and settings', () => {
  assert.deepEqual(rev.validatePlan({ name: 'Starter', price: '1500', cycle: 'monthly', setupFee: '5000', trialDays: '14' }).value, { name: 'Starter', price: 1500, cycle: 'monthly', setupFee: 5000, trialDays: 14 });
  assert.ok(rev.validatePlan({ name: 'S', price: 1, cycle: 'monthly' }).errors.name);
  assert.ok(rev.validatePlan({ name: 'Starter', price: -1, cycle: 'monthly' }).errors.price);
  assert.ok(rev.validatePlan({ name: 'Starter', price: 1, cycle: 'weekly' }).errors.cycle);
  assert.ok(rev.validatePlan({ name: 'Starter', price: 1, cycle: 'monthly', trialDays: 400 }).errors.trialDays);
  assert.ok(rev.validatePlan({}, { partial: true }).errors.name, 'nothing to update');

  const plan = { planId: 'p1', name: 'Starter', price: 1000, cycle: 'monthly', setupFee: 2500, trialDays: null, active: true };
  const paid = rev.validateSubscription({ startDate: '2026-10-01' }, plan, {}, NOW);
  assert.deepEqual([paid.value.status, paid.value.price, paid.value.renewalDate.toISOString().slice(0, 10), paid.value.setupFee], ['active', 1000, '2026-11-01', 2500]);
  const trial = rev.validateSubscription({ startDate: '2026-10-01', trial: true }, plan, { defaultTrialDays: 10 }, NOW);
  assert.deepEqual([trial.value.status, trial.value.trialEndsAt.toISOString().slice(0, 10), trial.value.renewalDate.toISOString().slice(0, 10)], ['trialing', '2026-10-11', '2026-10-11'], 'the platform default trial length');
  assert.equal(rev.validateSubscription({ startDate: '2026-10-01', trial: true }, { ...plan, trialDays: 30 }, { defaultTrialDays: 10 }, NOW).value.trialEndsAt.toISOString().slice(0, 10), '2026-10-31', 'a plan can set its own');
  assert.equal(rev.validateSubscription({ price: 750 }, plan, {}, NOW).value.price, 750, 'an agreed price can differ from the list price');
  assert.ok(rev.validateSubscription({}, null, {}, NOW).errors.planId);
  assert.ok(rev.validateSubscription({}, { ...plan, active: false }, {}, NOW).errors.planId);
  assert.ok(rev.validateSubscription({ price: -3 }, plan, {}, NOW).errors.price);

  const inv = rev.validateInvoice({ periodStart: '2026-10-01', periodEnd: '2026-10-31' }, { subscription: { price: 1000, setupFee: 2500 }, settings: { invoiceDueDays: 7 }, now: NOW });
  assert.deepEqual([inv.value.amount, inv.value.dueDate.toISOString().slice(0, 10), inv.value.type], [1000, '2026-10-22', 'subscription'], 'the amount and due date have sensible defaults');
  assert.equal(rev.validateInvoice({ type: 'setup_fee' }, { subscription: { price: 1000, setupFee: 2500 }, now: NOW }).value.amount, 2500);
  assert.ok(rev.validateInvoice({ type: 'subscription' }, { subscription: null, now: NOW }).errors.amount);
  assert.ok(rev.validateInvoice({ amount: 5 }, { now: NOW }).errors.periodStart, 'a subscription invoice names its period');
  assert.equal(rev.validateInvoice({ type: 'other', amount: 5 }, { now: NOW }).errors.periodStart, undefined, 'other charges need no period');
  assert.ok(rev.validateInvoice({ type: 'nope', amount: 5 }, { now: NOW }).errors.type);

  assert.ok(rev.validatePayment({}).errors.paymentMethod);
  assert.ok(rev.validatePayment({ paymentMethod: 'upi', paidAt: new Date(Date.now() + 5 * 86400000).toISOString() }).errors.paidAt);

  const invoice = { amount: 1000, refundedAmount: 400 };
  assert.deepEqual([rev.validateRefund({ amount: 600, reason: 'Service credit' }, invoice).errors], [{}]);
  assert.match(rev.validateRefund({ amount: 601, reason: 'Service credit' }, invoice).errors.amount, /At most 600/);
  assert.ok(rev.validateRefund({ amount: 100, reason: 'no' }, invoice).errors.reason);
  assert.ok(rev.validateRefund({ amount: 0, reason: 'Service credit' }, invoice).errors.amount);

  assert.deepEqual(rev.validateSettings({ companyName: ' AutoMet ', invoiceDueDays: '30', defaultTrialDays: 14 }).value, { companyName: 'AutoMet', invoiceDueDays: 30, defaultTrialDays: 14 });
  assert.ok(rev.validateSettings({ billingEmail: 'nope' }).errors.billingEmail);
  assert.ok(rev.validateSettings({ invoiceDueDays: 200 }).errors.invoiceDueDays);
  assert.ok(rev.validateSettings({}).errors.companyName);
});

// ---------- over HTTP ----------

let server;
let base;
const ctx = {};
test.before(async () => {
  const mkT = (tenantId, name, status) => db.Tenant.create({ tenantId, name, slug: name.toLowerCase(), appName: name, packageName: `com.${name.toLowerCase()}`, status, plan: 'trial' });
  await mkT('app_a', 'Alpha', 'trial');
  await mkT('app_b', 'Beta', 'trial');
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: bcrypt.hashSync(pw, 4) });
  await mk('s1', 'super@x.test', 'super_admin', null, 'password-super-1');
  await mk('a1', 'owner@a.test', 'client_admin', 'app_a', 'password-a-owner');
  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const login = async (email, password) => (await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  ctx.super = await login('super@x.test', 'password-super-1');
  ctx.owner = await login('owner@a.test', 'password-a-owner');
});
test.after(() => server.close());

const call = async (method, path, { token = ctx.super, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : null, res };
};
const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const tenant = (id) => db.Tenant.rows.find((t) => t.tenantId === id);

test('only the platform owner may see or change any platform billing', async () => {
  const routes = [['GET', '/platform/revenue/summary'], ['GET', '/platform/invoices'], ['GET', '/platform/invoices.csv'], ['GET', '/platform/plans'], ['POST', '/platform/plans'], ['PATCH', '/platform/plans/x'], ['GET', '/platform/settings'], ['PUT', '/platform/settings'],
    ['GET', '/tenants/app_a/billing'], ['PUT', '/tenants/app_a/subscription'], ['POST', '/tenants/app_a/subscription/renew'], ['POST', '/tenants/app_a/subscription/cancel'], ['POST', '/tenants/app_a/invoices'], ['POST', '/invoices/x/pay'], ['POST', '/invoices/x/void'], ['POST', '/invoices/x/refund']];
  for (const [m, p] of routes) {
    assert.equal((await call(m, p, { token: ctx.owner, body: {} })).status, 403, `${m} ${p} for a business admin`);
    assert.equal((await fetch(base + p, { method: m })).status, 401, `${m} ${p} without sign-in`);
  }
});

test('plans: created, validated, unique, edited; a plan can be retired', async () => {
  assert.equal((await call('POST', '/platform/plans', { body: { name: 'S', price: 1, cycle: 'monthly' } })).status, 400);
  const starter = await call('POST', '/platform/plans', { body: { name: 'Starter', description: 'For one city', price: 1000, cycle: 'monthly', setupFee: 2500, trialDays: 14 } });
  assert.equal(starter.status, 201);
  assert.deepEqual([starter.body.data.name, starter.body.data.price, starter.body.data.setupFee, starter.body.data.subscribers, starter.body.data.currency], ['Starter', 1000, 2500, 0, 'INR']);
  assert.equal((await call('POST', '/platform/plans', { body: { name: 'Starter', price: 5, cycle: 'monthly' } })).status, 409, 'plan names are unique');
  const pro = await call('POST', '/platform/plans', { body: { name: 'Pro', price: 12000, cycle: 'yearly' } });
  ctx.plan = { starter: starter.body.data.id, pro: pro.body.data.id };
  const patched = await call('PATCH', `/platform/plans/${ctx.plan.pro}`, { body: { description: 'Many cities' } });
  assert.equal(patched.body.data.description, 'Many cities');
  assert.equal((await call('PATCH', '/platform/plans/nope', { body: { price: 5 } })).status, 404);
  assert.equal((await call('PATCH', `/platform/plans/${ctx.plan.pro}`, { body: {} })).status, 400);
  assert.deepEqual((await call('GET', '/platform/plans')).body.data.map((p) => p.name), ['Starter', 'Pro'], 'cheapest first');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'plan.created' && a.tenantId === null));
});

test('assign a plan: a trial makes the business a trial, a paid plan makes it active; the agreed price sticks', async () => {
  assert.equal((await call('PUT', '/tenants/app_a/subscription', { body: {} })).status, 400, 'a plan is required');
  assert.equal((await call('PUT', '/tenants/app_a/subscription', { body: { planId: 'nope' } })).status, 400);
  assert.equal((await call('PUT', '/tenants/nope/subscription', { body: { planId: ctx.plan.starter } })).status, 404);

  const trial = await call('PUT', '/tenants/app_a/subscription', { body: { planId: ctx.plan.starter, trial: true, startDate: iso(0) } });
  assert.equal(trial.status, 200);
  assert.deepEqual([trial.body.data.subscription.status, trial.body.data.subscription.recurring, tenant('app_a').status], ['trialing', false, 'trial']);
  assert.equal((await call('GET', '/platform/revenue/summary')).body.data.mrr, 0, 'a trial is not recurring revenue');

  const paid = await call('PUT', '/tenants/app_a/subscription', { body: { planId: ctx.plan.starter, price: 900, startDate: iso(-1), issueSetupInvoice: true, notes: 'Launch discount' } });
  assert.deepEqual([paid.body.data.subscription.status, paid.body.data.subscription.price, paid.body.data.subscription.recurring, paid.body.data.subscription.notes], ['active', 900, true, 'Launch discount']);
  assert.deepEqual([tenant('app_a').status, tenant('app_a').plan], ['active', 'standard']);
  assert.equal(paid.body.data.setupInvoice.type, 'setup_fee');
  assert.equal(paid.body.data.setupInvoice.amount, 2500, 'the plan\'s setup fee');
  assert.equal(paid.body.data.setupInvoice.number, 'INV-000001');
  ctx.setup = paid.body.data.setupInvoice.id;

  await call('PATCH', `/platform/plans/${ctx.plan.starter}`, { body: { price: 1500 } });
  assert.equal(tenant('app_a').subscription.price, 900, 'changing the list price does not change what a business agreed');
  assert.equal((await call('GET', '/platform/plans')).body.data.find((p) => p.name === 'Starter').subscribers, 1);

  const b = await call('PUT', '/tenants/app_b/subscription', { body: { planId: ctx.plan.pro, startDate: iso(0) } });
  assert.deepEqual([b.body.data.subscription.price, b.body.data.subscription.cycle], [12000, 'yearly']);
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'subscription.assigned' && a.targetId === 'app_b'));
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'subscription.changed' && a.targetId === 'app_a'), 'moving from trial to paid is a change');
});

test('a retired plan cannot be assigned, but existing subscriptions keep it', async () => {
  const extra = await call('POST', '/platform/plans', { body: { name: 'Legacy', price: 100, cycle: 'monthly' } });
  await call('PATCH', `/platform/plans/${extra.body.data.id}`, { body: { active: false } });
  assert.equal((await call('PUT', '/tenants/app_b/subscription', { body: { planId: extra.body.data.id } })).status, 400);
  assert.equal(tenant('app_b').subscription.planName, 'Pro');
});

test('invoices: sequential numbers, defaults from settings, validation; pay once; void only unpaid', async () => {
  assert.equal((await call('GET', '/platform/settings')).body.data.invoiceDueDays, 14, 'defaults before any are saved');
  assert.equal((await call('PUT', '/platform/settings', { body: { invoiceDueDays: 7, companyName: 'AutoMet Technologies', billingEmail: 'billing@automet.test' } })).status, 200);

  assert.equal((await call('POST', '/tenants/app_a/invoices', { body: { type: 'subscription' } })).status, 400, 'a period is required');
  const first = await call('POST', '/tenants/app_a/invoices', { body: { periodStart: iso(-30), periodEnd: iso(-1), dueDate: iso(-5) } });
  assert.equal(first.status, 201);
  assert.deepEqual([first.body.data.number, first.body.data.amount, first.body.data.type, first.body.data.overdue], ['INV-000002', 900, 'subscription', true], 'the agreed price, already overdue');
  const second = await call('POST', '/tenants/app_a/invoices', { body: { periodStart: iso(0), periodEnd: iso(30) } });
  assert.equal(new Date(second.body.data.dueDate).toISOString().slice(0, 10), iso(7), 'due date from the platform setting');
  const other = await call('POST', '/tenants/app_b/invoices', { body: { type: 'other', amount: 300, description: 'Custom domain' } });
  assert.deepEqual([other.body.data.type, other.body.data.description, other.body.data.number], ['other', 'Custom domain', 'INV-000004']);
  ctx.inv = { first: first.body.data.id, second: second.body.data.id, other: other.body.data.id };

  assert.equal((await call('POST', `/invoices/${ctx.inv.first}/pay`, { body: {} })).status, 400);
  const paid = await call('POST', `/invoices/${ctx.inv.first}/pay`, { body: { paymentMethod: 'bank_transfer', reference: 'UTR-9988' } });
  assert.deepEqual([paid.status, paid.body.data.status, paid.body.data.overdue, paid.body.data.businessName], [200, 'paid', false, 'Alpha']);
  assert.equal((await call('POST', `/invoices/${ctx.inv.first}/pay`, { body: { paymentMethod: 'cash' } })).status, 409);
  await call('POST', `/invoices/${ctx.setup}/pay`, { body: { paymentMethod: 'upi', reference: 'UPI-1' } });

  assert.equal((await call('POST', `/invoices/${ctx.inv.other}/void`, { body: {} })).status, 400);
  assert.equal((await call('POST', `/invoices/${ctx.inv.first}/void`, { body: { reason: 'Trying to void a paid one' } })).status, 409);
  assert.equal((await call('POST', `/invoices/${ctx.inv.other}/void`, { body: { reason: 'Issued by mistake' } })).body.data.status, 'void');
  assert.equal((await call('POST', `/invoices/${ctx.inv.other}/pay`, { body: { paymentMethod: 'cash' } })).status, 409, 'a void invoice cannot be paid');
});

test('refunds: only paid invoices, never more than was paid, partial refunds add up; the invoice stays paid', async () => {
  assert.equal((await call('POST', `/invoices/${ctx.inv.second}/refund`, { body: { amount: 10, reason: 'Not paid yet' } })).status, 409, 'an unpaid invoice is voided, not refunded');
  assert.equal((await call('POST', `/invoices/${ctx.inv.other}/refund`, { body: { amount: 10, reason: 'It is void' } })).status, 409);
  assert.equal((await call('POST', `/invoices/${ctx.inv.first}/refund`, { body: { amount: 100 } })).status, 400, 'a reason is required');
  assert.equal((await call('POST', `/invoices/${ctx.inv.first}/refund`, { body: { amount: 901, reason: 'More than paid' } })).status, 400);
  assert.equal((await call('POST', `/invoices/${ctx.inv.first}/refund`, { body: { amount: 0, reason: 'Nothing refunded' } })).status, 400);
  const r1 = await call('POST', `/invoices/${ctx.inv.first}/refund`, { body: { amount: 300, reason: 'Service outage credit' } });
  assert.equal(r1.status, 200);
  assert.deepEqual([r1.body.data.status, r1.body.data.refundedAmount, r1.body.data.netPaid, r1.body.data.refunds.length], ['paid', 300, 600, 1]);
  const r2 = await call('POST', `/invoices/${ctx.inv.first}/refund`, { body: { amount: 600, reason: 'Contract ended early' } });
  assert.deepEqual([r2.status, r2.body.data.netPaid], [200, 0]);
  const over = await call('POST', `/invoices/${ctx.inv.first}/refund`, { body: { amount: 1, reason: 'Nothing left to refund' } });
  assert.equal(over.status, 400);
  assert.match(over.body.errors.amount, /At most 0/);
  assert.equal(db.PlatformInvoice.rows.find((i) => i.invoiceId === ctx.inv.first).refundedAmount, 900);
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'invoice.refunded' && a.meta.amount === 600));
});

test('renew and convert: the next period starts, a trial becomes a paid subscription, an invoice can be raised', async () => {
  const trialBiz = await db.Tenant.create({ tenantId: 'app_c', name: 'Gamma', slug: 'gamma', appName: 'Gamma', packageName: 'com.gamma', status: 'trial', plan: 'trial' });
  await call('PUT', '/tenants/app_c/subscription', { body: { planId: ctx.plan.starter, trial: true, startDate: iso(-20) } });
  assert.equal(tenant('app_c').subscription.status, 'trialing');
  const converted = await call('POST', '/tenants/app_c/subscription/renew', { body: { invoice: true } });
  assert.equal(converted.status, 200);
  assert.deepEqual([converted.body.data.subscription.status, tenant('app_c').status, converted.body.data.invoice.type, converted.body.data.invoice.amount], ['active', 'active', 'subscription', 1500]);
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'subscription.converted' && a.targetId === 'app_c'));
  const again = await call('POST', '/tenants/app_c/subscription/renew', { body: {} });
  assert.equal(again.body.data.invoice, null, 'no invoice unless asked');
  assert.ok(new Date(again.body.data.subscription.renewalDate) > new Date(converted.body.data.subscription.renewalDate), 'another period');
  assert.equal((await call('POST', '/tenants/app_a/invoices', { body: { periodStart: iso(0), periodEnd: iso(1) } })).status, 201);
  void trialBiz;
});

test('cancel: needs a reason, stops counting as recurring revenue, does not suspend the business', async () => {
  assert.equal((await call('POST', '/tenants/app_c/subscription/cancel', { body: {} })).status, 400);
  const before = (await call('GET', '/platform/revenue/summary')).body.data.mrr;
  const r = await call('POST', '/tenants/app_c/subscription/cancel', { body: { reason: 'Client left the platform' } });
  assert.deepEqual([r.status, r.body.data.subscription.status, r.body.data.subscription.recurring, tenant('app_c').status], [200, 'cancelled', false, 'active']);
  assert.equal((await call('GET', '/platform/revenue/summary')).body.data.mrr, before - 1500);
  assert.equal((await call('POST', '/tenants/app_c/subscription/cancel', { body: { reason: 'Cancelling a second time' } })).status, 409);
  assert.equal((await call('POST', '/tenants/app_c/subscription/renew', { body: {} })).status, 409, 'a cancelled subscription is not renewed');
  assert.equal((await call('POST', '/tenants/app_zzz/subscription/cancel', { body: { reason: 'There is no such business' } })).status, 404);
});

test('summary over HTTP separates billed, collected, refunded and outstanding, and only counts real subscriptions', async () => {
  const s = (await call('GET', '/platform/revenue/summary')).body.data;
  assert.equal(s.currency, 'INR');
  assert.equal(s.mrr, 1900, 'Alpha at the agreed 900 a month plus Beta at 12000 a year');
  assert.equal(s.arr, 22800);
  assert.equal(s.refunded, 900);
  assert.equal(s.collected, 3400, 'the 2500 setup fee and the 900 subscription invoice');
  assert.equal(s.netCollected, 2500);
  assert.ok(s.billed >= s.collected);
  assert.ok(s.outstanding > 0 && s.overdue === 0);
  assert.equal(s.counts.cancelled, 1);
  assert.equal(s.series.length, 12);
  assert.ok(s.byPlan.find((p) => p.name === 'Pro').subscribers >= 1);
  assert.equal((await call('GET', '/platform/revenue/summary?from=nope')).status, 400);
  assert.equal((await call('GET', `/platform/revenue/summary?from=${iso(1)}&to=${iso(-1)}`)).status, 400);
});

test('billing view of one business: its subscription, totals and invoices, and an invoice list with filters and CSV', async () => {
  const b = (await call('GET', '/tenants/app_a/billing')).body.data;
  assert.equal(b.subscription.planName, 'Starter');
  assert.deepEqual([b.totals.refunded, b.totals.collected], [900, 3400]);
  assert.ok(b.invoices.length >= 3);
  assert.equal((await call('GET', '/tenants/nope/billing')).status, 404);
  const all = (await call('GET', '/platform/invoices')).body.data;
  assert.ok(all.total >= 5);
  assert.deepEqual((await call('GET', '/platform/invoices?type=setup_fee')).body.data.items.map((i) => i.number), ['INV-000001']);
  assert.ok((await call('GET', '/platform/invoices?status=paid')).body.data.items.every((i) => i.status === 'paid'));
  assert.equal((await call('GET', '/platform/invoices?type=bogus')).status, 400);
  const csv = await call('GET', '/platform/invoices.csv');
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await csv.res.arrayBuffer());
  assert.ok(text.startsWith('﻿Invoice,Business,App ID,Type,'));
  assert.ok(text.includes('UTR-9988') && text.includes('Refunded') && text.includes('Net paid'));
  assert.ok(db.AdminAudit.rows.some((x) => x.action === 'export.invoices'));
});

test('platform settings: saved, validated, and audited', async () => {
  assert.equal((await call('PUT', '/platform/settings', { body: { billingEmail: 'not-an-email' } })).status, 400);
  assert.equal((await call('PUT', '/platform/settings', { body: { invoiceDueDays: 500 } })).status, 400);
  const s = (await call('GET', '/platform/settings')).body.data;
  assert.deepEqual([s.companyName, s.invoiceDueDays, s.currency], ['AutoMet Technologies', 7, 'INR']);
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'platform.settings_updated'));
});

test('billing events are in the platform audit log and never in a business\'s own log', async () => {
  const platformLog = (await call('GET', '/platform/audit?pageSize=100')).body.data.items.map((i) => i.action);
  for (const a of ['plan.created', 'subscription.assigned', 'invoice.issued', 'invoice.paid', 'invoice.voided', 'invoice.refunded', 'subscription.cancelled']) assert.ok(platformLog.includes(a), a);
  const businessScoped = db.AdminAudit.rows.filter((x) => x.tenantId === 'app_a' && /^(invoice|subscription|plan|platform)/.test(x.action));
  assert.equal(businessScoped.length, 0, 'nothing about what Alpha is charged is stored under Alpha');
  assert.ok(!JSON.stringify(db.AdminAudit.rows.filter((x) => x.action.startsWith('invoice'))).includes('UTR-9988'), 'payment references are never written to the audit log');
});
