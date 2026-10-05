// GST invoices, PDFs, emailing, and overdue handling (reminders and lapse), over HTTP with in-memory stand-ins.
process.env.JWT_SECRET = 'test-secret-for-gst-tests';
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
const mailer = require('../lib/mailer');
const adminRoutes = require('../routes/adminRoutes');

const outbox = [];
const ctx = {};
let server;
let base;
const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

test.before(async () => {
  for (const [id, name] of [['app_mh', 'Mumbai Cabs'], ['app_ka', 'Bengaluru Rides'], ['app_x', 'No State Ltd'], ['app_late', 'Late Payers'], ['app_def', 'Default']]) {
    await db.Tenant.create({ tenantId: id, name, slug: id, appName: name, packageName: `com.${id}`, status: 'active', plan: 'standard', isDefault: id === 'app_def' });
  }
  await db.AdminUser.create({ adminId: 's1', name: 'Owner', email: 'super@x.test', role: 'super_admin', tenantId: null, passwordHash: bcrypt.hashSync('password-super-1', 4) });
  await db.AdminUser.create({ adminId: 'l1', name: 'Late Admin', email: 'admin@late.test', role: 'client_admin', tenantId: 'app_late', passwordHash: bcrypt.hashSync('password-late-1', 4) });
  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
  ctx.token = (await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'super@x.test', password: 'password-super-1' }) })).json()).data.token;
});
test.after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : null, res };
};
const tenant = (id) => db.Tenant.rows.find((t) => t.tenantId === id);
const invoiceRow = (id) => db.PlatformInvoice.rows.find((i) => i.invoiceId === id);

test('with no GSTIN of its own the platform charges no tax, as before', async () => {
  const r = await call('POST', '/tenants/app_x/invoices', { type: 'other', amount: 1000, description: 'Custom work' });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.data.amount, r.body.data.taxAmount, r.body.data.total], [1000, 0, 1000]);
  await call('POST', `/invoices/${r.body.data.id}/void`, { reason: 'Setup of the GST tests' });
});

test('settings: GSTIN is validated and fixes the state; rate, reminders and the lapse rule are validated', async () => {
  assert.equal((await call('PUT', '/platform/settings', { gstin: '27AAPFU0939F1Z' })).status, 400);
  assert.equal((await call('PUT', '/platform/settings', { gstRate: 90 })).status, 400);
  assert.equal((await call('PUT', '/platform/settings', { lapseAction: 'delete' })).status, 400);
  assert.equal((await call('PUT', '/platform/settings', { reminderOffsets: '-3, x' })).status, 400);
  assert.equal((await call('PUT', '/platform/settings', { graceDays: -1 })).status, 400);
  const ok = await call('PUT', '/platform/settings', { legalName: 'AutoMet Technologies Pvt Ltd', gstin: '27aapfu0939f1zv', address: '1 Main Road, Mumbai', gstRate: 18, sac: '998314', invoiceNotes: 'Pay by bank transfer to account 1234.', reminderOffsets: '-3, 1, 7', graceDays: 15, lapseAction: 'none' });
  assert.equal(ok.status, 200);
  const s = (await call('GET', '/platform/settings')).body.data;
  assert.deepEqual([s.gstin, s.stateCode, s.gstEnabled, s.gstRate, s.reminderOffsets, s.lapseAction], ['27AAPFU0939F1ZV', '27', true, 18, [-3, 1, 7], 'none']);
});

test('GST invoicing needs the place of supply: a business without a state cannot be invoiced yet, and a subscription is not saved half-way', async () => {
  const blocked = await call('POST', '/tenants/app_x/invoices', { type: 'other', amount: 1000 });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.message, /state in its billing details/);
  const plan = (await call('POST', '/platform/plans', { name: 'Starter', price: 1000, cycle: 'monthly', setupFee: 2500 })).body.data;
  ctx.plan = plan;
  const sub = await call('PUT', '/tenants/app_x/subscription', { planId: plan.id, issueSetupInvoice: true });
  assert.equal(sub.status, 400);
  assert.ok(!tenant('app_x').subscription, 'nothing was saved');
});

test('billing details are validated; a GSTIN fixes the state', async () => {
  assert.equal((await call('PUT', '/tenants/app_mh/billing-details', { legalName: 'Mumbai Cabs LLP', gstin: 'NOTAGSTIN' })).status, 400);
  assert.equal((await call('PUT', '/tenants/app_mh/billing-details', { legalName: 'Mumbai Cabs LLP', stateCode: '25' })).status, 400);
  assert.equal((await call('PUT', '/tenants/app_mh/billing-details', { email: 'nope' })).status, 400);
  assert.equal((await call('PUT', '/tenants/nope/billing-details', {})).status, 404);
  const mh = await call('PUT', '/tenants/app_mh/billing-details', { legalName: 'Mumbai Cabs LLP', gstin: '27BBBBB1111B1Z5', address: '9 Lake Street, Pune', email: 'accounts@mumbaicabs.test' });
  assert.equal(mh.status, 200);
  assert.equal(mh.body.data.details.stateCode, '27');
  const ka = await call('PUT', '/tenants/app_ka/billing-details', { legalName: 'Bengaluru Rides Pvt Ltd', stateCode: '29', address: '5 MG Road, Bengaluru', email: 'fin@ka.test' });
  assert.equal(ka.status, 200, 'unregistered buyers choose their state');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'tenant.billing_details_updated' && a.tenantId === null));
});

test('same state: CGST + SGST; another state: IGST; the invoice is a snapshot and the figures reconcile', async () => {
  await call('PUT', '/tenants/app_mh/subscription', { planId: ctx.plan.id });
  const a = await call('POST', '/tenants/app_mh/invoices', { periodStart: iso(0), periodEnd: iso(30) });
  assert.equal(a.status, 201);
  assert.deepEqual([a.body.data.amount, a.body.data.taxRate, a.body.data.taxAmount, a.body.data.cgst, a.body.data.sgst, a.body.data.igst, a.body.data.total, a.body.data.sac], [1000, 18, 180, 90, 90, 0, 1180, '998314']);
  ctx.mh = a.body.data;
  await call('PUT', '/tenants/app_ka/subscription', { planId: ctx.plan.id });
  const b = await call('POST', '/tenants/app_ka/invoices', { periodStart: iso(0), periodEnd: iso(30) });
  assert.deepEqual([b.body.data.cgst, b.body.data.sgst, b.body.data.igst, b.body.data.total], [0, 0, 180, 1180]);
  ctx.ka = b.body.data;
  // the snapshot: editing company or business details later never changes an issued invoice
  await call('PUT', '/tenants/app_mh/billing-details', { legalName: 'Renamed LLP', gstin: '27BBBBB1111B1Z5', address: 'New address', email: 'accounts@mumbaicabs.test' });
  await call('PUT', '/platform/settings', { legalName: 'Another Name Pvt Ltd' });
  const row = invoiceRow(ctx.mh.id);
  assert.equal(row.buyer.legalName, 'Mumbai Cabs LLP');
  assert.equal(row.seller.legalName, 'AutoMet Technologies Pvt Ltd');
  await call('PUT', '/platform/settings', { legalName: 'AutoMet Technologies Pvt Ltd' });
  // a setup fee and a one-off charge are taxed the same way
  const setup = await call('PUT', '/tenants/app_ka/subscription', { planId: ctx.plan.id, issueSetupInvoice: true });
  assert.deepEqual([setup.body.data.setupInvoice.amount, setup.body.data.setupInvoice.igst, setup.body.data.setupInvoice.total], [2500, 450, 2950]);
});

test('payments are for the total; refunds are against the total, and revenue is counted before GST', async () => {
  await call('POST', `/invoices/${ctx.mh.id}/pay`, { paymentMethod: 'bank_transfer', reference: 'UTR-1' });
  const over = await call('POST', `/invoices/${ctx.mh.id}/refund`, { amount: 1181, reason: 'More than the total' });
  assert.equal(over.status, 400);
  assert.match(over.body.errors.amount, /At most 1180/);
  const r = await call('POST', `/invoices/${ctx.mh.id}/refund`, { amount: 118, reason: 'Goodwill credit' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.data.refundedAmount, r.body.data.netPaid], [118, 1062]);
  assert.deepEqual([r.body.data.refunds[0].amount], [118]);
  assert.deepEqual([invoiceRow(ctx.mh.id).refunds[0].exTax, invoiceRow(ctx.mh.id).refunds[0].tax], [100, 18]);
  const s = (await call('GET', '/platform/revenue/summary')).body.data;
  assert.equal(s.collected, 1000, 'collected revenue excludes the GST');
  assert.equal(s.refunded, 100, 'refunded revenue excludes the GST');
  assert.equal(s.netCollected, 900);
  assert.equal(s.gstCollected, 180);
  assert.equal(s.gstCharged, 180 + 180 + 450 + 0, 'GST on every invoice issued: two subscription invoices and the setup fee');
  const unpaid = ctx.ka.total + 2950;
  assert.equal(s.outstanding, unpaid, 'receivables are what clients owe, GST included');
  const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await (await fetch(`${base}/platform/invoices.csv`, { headers: { Authorization: `Bearer ${ctx.token}` } })).arrayBuffer());
  assert.ok(csv.includes('Taxable value,GST,Total,Buyer GSTIN') && csv.includes('27BBBBB1111B1Z5'));
});

test('every refund gets a credit note: sequential numbers, the invoice tax split, a real PDF, and nothing for a number that does not exist', async () => {
  const row = invoiceRow(ctx.mh.id);
  assert.equal(row.refunds[0].number, 'CN-000001');
  assert.deepEqual([row.refunds[0].cgst, row.refunds[0].sgst, row.refunds[0].igst], [9, 9, 0]);
  const second = await call('POST', `/invoices/${ctx.mh.id}/refund`, { amount: 59, reason: 'Second credit' });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.refunds[1].number, 'CN-000002');
  assert.deepEqual([invoiceRow(ctx.mh.id).refunds[1].exTax, invoiceRow(ctx.mh.id).refunds[1].tax], [50, 9]);
  const pdf = await fetch(`${base}/invoices/${ctx.mh.id}/credit-notes/CN-000001/pdf`, { headers: { Authorization: `Bearer ${ctx.token}` } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /CN-000001\.pdf/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call('GET', `/invoices/${ctx.mh.id}/credit-notes/CN-999999/pdf`)).status, 404);
  assert.equal((await call('GET', '/invoices/nope/credit-notes/CN-000001/pdf')).status, 404);
  assert.equal((await fetch(`${base}/invoices/${ctx.mh.id}/credit-notes/CN-000001/pdf`)).status, 401);
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'invoice.refunded' && a.meta.creditNote === 'CN-000002'));
});

test('PDF download: a real PDF named after the invoice; unknown invoice is 404', async () => {
  const r = await fetch(`${base}/invoices/${ctx.ka.id}/pdf`, { headers: { Authorization: `Bearer ${ctx.token}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), new RegExp(`${ctx.ka.number}\\.pdf`));
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call('GET', '/invoices/nope/pdf')).status, 404);
  assert.equal((await fetch(`${base}/invoices/${ctx.ka.id}/pdf`)).status, 401);
});

test('emailing an invoice: needs a provider, attaches the PDF, goes to the billing email, is recorded; never for a void invoice', async () => {
  mailer.setTransport(null);
  assert.equal((await call('POST', `/invoices/${ctx.ka.id}/send`, {})).status, 409, 'no provider yet');
  mailer.setTransport({ async send(m) { outbox.push(m); } });
  assert.equal((await call('POST', `/invoices/${ctx.ka.id}/send`, { to: 'not-an-email' })).status, 400);
  const sent = await call('POST', `/invoices/${ctx.ka.id}/send`, {});
  assert.equal(sent.status, 200);
  assert.ok(sent.body.data.emailedAt);
  assert.equal(outbox.at(-1).to, 'fin@ka.test');
  assert.match(outbox.at(-1).subject, new RegExp(ctx.ka.number));
  assert.equal(outbox.at(-1).attachments[0].filename, `${ctx.ka.number}.pdf`);
  assert.equal(Buffer.from(outbox.at(-1).attachments[0].content).subarray(0, 5).toString(), '%PDF-');
  const other = await call('POST', '/tenants/app_ka/invoices', { type: 'other', amount: 100 });
  await call('POST', `/invoices/${other.body.data.id}/void`, { reason: 'Raised by mistake' });
  assert.equal((await call('POST', `/invoices/${other.body.data.id}/send`, {})).status, 409);
  assert.ok(!JSON.stringify(db.AdminAudit.rows.filter((a) => a.action === 'invoice.emailed')).includes('fin@ka.test'), 'the address is not written to the audit log');
});

test('overdue: a reminder goes out once per reached offset, only the latest, to the right address, and never when nothing is configured', async () => {
  mailer.setTransport(null);
  // Late Payers has no billing email: the reminder goes to its first admin
  await call('PUT', '/tenants/app_late/billing-details', { legalName: 'Late Payers Pvt Ltd', stateCode: '27' });
  const inv = (await call('POST', '/tenants/app_late/invoices', { type: 'other', amount: 500, description: 'Custom domain', dueDate: iso(-8) })).body.data;
  ctx.late = inv;
  const none = await call('POST', '/platform/billing/run');
  assert.equal(none.status, 200);
  assert.equal(none.body.data.reminded, 0, 'no email provider: nothing is sent');
  assert.equal(none.body.data.emailConfigured, false);
  assert.deepEqual(invoiceRow(inv.id).remindersSent || [], [], 'and nothing is marked as sent');
  outbox.length = 0;
  mailer.setTransport({ async send(m) { outbox.push(m); } });
  const first = await call('POST', '/platform/billing/run');
  assert.equal(first.body.data.reminded, 1);
  const lateMail = outbox.find((m) => m.to === 'admin@late.test');
  assert.ok(lateMail, 'sent to its first admin');
  assert.match(lateMail.subject, /^Overdue: invoice /);
  assert.deepEqual(invoiceRow(inv.id).remindersSent, [-3, 1, 7], 'the offsets already passed are covered, so one email, not three');
  const again = await call('POST', '/platform/billing/run');
  assert.equal(again.body.data.reminded, 0, 'once');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'invoice.reminder_sent' && a.actorEmail === 'billing-job' && a.tenantId === null));
});

test('lapse: past the grace period an invoice lapses once; the action follows the setting; the default business is never suspended', async () => {
  // flag only (default)
  await db.PlatformInvoice.findOneAndUpdate({ invoiceId: ctx.late.id }, { $set: { dueDate: new Date(Date.now() - 20 * DAY) } });
  const flagged = await call('POST', '/platform/billing/run');
  assert.equal(flagged.body.data.lapsed, 1);
  assert.deepEqual(flagged.body.data.actions, [{ invoice: ctx.late.number, business: 'app_late', result: 'flagged' }]);
  assert.equal(tenant('app_late').status, 'active');
  assert.equal((await call('POST', '/platform/billing/run')).body.data.lapsed, 0, 'once per invoice');

  // cancel the subscription
  await call('PUT', '/tenants/app_late/subscription', { planId: ctx.plan.id });
  await call('PUT', '/platform/settings', { lapseAction: 'cancel' });
  const inv2 = (await call('POST', '/tenants/app_late/invoices', { type: 'other', amount: 100, dueDate: iso(-30) })).body.data;
  const cancel = await call('POST', '/platform/billing/run');
  assert.deepEqual(cancel.body.data.actions, [{ invoice: inv2.number, business: 'app_late', result: 'subscription-cancelled' }]);
  assert.equal(tenant('app_late').subscription.status, 'cancelled');
  assert.match(tenant('app_late').subscription.cancelReason, new RegExp(inv2.number));
  assert.equal(tenant('app_late').status, 'active', 'cancelling a subscription does not suspend the business');

  // suspend the business: sessions end
  await call('PUT', '/platform/settings', { lapseAction: 'suspend' });
  const version = db.AdminUser.rows.find((u) => u.adminId === 'l1').tokenVersion;
  const inv3 = (await call('POST', '/tenants/app_late/invoices', { type: 'other', amount: 100, dueDate: iso(-40) })).body.data;
  const suspend = await call('POST', '/platform/billing/run');
  assert.deepEqual(suspend.body.data.actions, [{ invoice: inv3.number, business: 'app_late', result: 'business-suspended' }]);
  assert.equal(tenant('app_late').status, 'suspended');
  assert.equal(db.AdminUser.rows.find((u) => u.adminId === 'l1').tokenVersion, version + 1);

  // the default business is only flagged
  await call('PUT', '/tenants/app_def/billing-details', { legalName: 'Default Ltd', stateCode: '27' });
  const inv4 = (await call('POST', '/tenants/app_def/invoices', { type: 'other', amount: 100, dueDate: iso(-40) })).body.data;
  const def = await call('POST', '/platform/billing/run');
  assert.deepEqual(def.body.data.actions, [{ invoice: inv4.number, business: 'app_def', result: 'flagged' }]);
  assert.equal(tenant('app_def').status, 'active');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'invoice.lapsed' && a.meta.result === 'business-suspended'));
});

test('a paid or voided invoice is never reminded or lapsed', async () => {
  const inv = (await call('POST', '/tenants/app_ka/invoices', { type: 'other', amount: 100, dueDate: iso(-40) })).body.data;
  await call('POST', `/invoices/${inv.id}/pay`, { paymentMethod: 'cash' });
  const n = outbox.length;
  const r = await call('POST', '/platform/billing/run');
  assert.equal(r.body.data.lapsed, 0);
  assert.equal(outbox.length, n);
});

test('only the platform owner may use any of this', async () => {
  const biz = await db.AdminUser.create({ adminId: 'b9', name: 'B', email: 'b9@ka.test', role: 'client_admin', tenantId: 'app_ka', passwordHash: bcrypt.hashSync('password-ka-1', 4) });
  void biz;
  const token = (await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'b9@ka.test', password: 'password-ka-1' }) })).json()).data.token;
  for (const [m, p] of [['GET', `/invoices/${ctx.ka.id}/pdf`], ['POST', `/invoices/${ctx.ka.id}/send`], ['PUT', '/tenants/app_ka/billing-details'], ['POST', '/platform/billing/run']]) {
    const r = await fetch(base + p, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : '{}' });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
});
