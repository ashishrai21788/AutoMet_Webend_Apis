// The dashboard's weather-pricing and payment-method settings: validated, saved for one business only, audited, and recorded in the history.
process.env.JWT_SECRET = 'test-secret-for-settings';
process.env.PAYMENTS_MOCK_ENABLED = '1';
process.env.PAYMENTS_MOCK_SECRET = 'test-mock-secret-0123456789';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const W = require('../controllers/weatherAdminController');
const P = require('../controllers/paymentsController');
const { clearAppTenantCache } = require('../lib/appTenant');

const MODELS = ['Tenant', 'AdminAudit', 'ConfigVersion'];
const flush = async () => { for (const m of MODELS) await db[m].find({}); };
const reset = async () => {
  for (const m of MODELS) db[m].rows.length = 0;
  await flush();
  clearAppTenantCache();
  for (const id of ['t1', 't2']) await db.Tenant.create({ tenantId: id, name: id, slug: id, appName: id, packageName: `in.${id}`, isDefault: id === 't1' });
};

const call = async (handler, { tenant = 't1', body = {} } = {}) => {
  const business = JSON.parse(JSON.stringify(await db.Tenant.findOne({ tenantId: tenant }).lean())); // a copy, as a real request has: saving must not change what it started with
  const scope = (f = {}) => ({ ...f, tenantId: tenant });
  const req = {
    body, params: {}, query: {}, headers: {}, ip: '1.1.1.1', business, admin: { adminId: 'A1', email: 'owner@t.test', role: 'client_admin' },
    data: { find: (M, f) => M.find(scope(f)), findOne: (M, f) => M.findOne(scope(f)), update: (M, f, set) => M.findOneAndUpdate(scope(f), { $set: set }, { new: true }) },
    get: () => undefined
  };
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await handler(req, res);
  return out;
};
const stored = async (tenantId, field) => (await db.Tenant.findOne({ tenantId }).lean())[field];
const unset = (v) => v == null || (typeof v === 'object' && Object.keys(v).length === 0); // the real engine stores the model's empty default
const audits = (action) => db.AdminAudit.find({ action });

// ---------------------------------------------------------------- weather

test('weather pricing starts off, with every condition at 1 and the cap ready', async () => {
  await reset();
  const r = await call(W.get);
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.data.enabled, r.body.data.maxMultiplier], [false, 1.5]);
  assert.ok(Object.values(r.body.data.multipliers).every((m) => m === 1));
  assert.deepEqual(r.body.data.conditions.map((c) => c.key), ['LIGHT_RAIN', 'HEAVY_RAIN', 'STORM', 'FOG', 'SNOW', 'EXTREME_HEAT']);
  assert.ok(r.body.data.notes.length >= 3, 'the rider protections are stated in the dashboard');
});

test('saving weather pricing stores it for this business only, audits it and records it in the settings history', async () => {
  await reset();
  const r = await call(W.update, { body: { enabled: true, multipliers: { LIGHT_RAIN: 1.1, HEAVY_RAIN: '1.3' }, maxMultiplier: 1.4 } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.multipliers.HEAVY_RAIN, 1.3);
  assert.deepEqual(await stored('t1', 'weatherPricing'), { enabled: true, multipliers: { LIGHT_RAIN: 1.1, HEAVY_RAIN: 1.3 }, maxMultiplier: 1.4 });
  assert.ok(unset(await stored('t2', 'weatherPricing')), 'another business is untouched');
  const a = await audits('weather_pricing.updated');
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].tenantId, a[0].actorId, a[0].meta.enabled, a[0].meta.maxMultiplier], ['t1', 'A1', true, 1.4]);
  const history = (await db.ConfigVersion.find({ tenantId: 't1' })).sort((x, y) => x.version - y.version);
  assert.deepEqual(history.map((h) => h.source), ['baseline', 'business.weather_pricing_updated'], 'the settings before, then the change');
  assert.deepEqual(history[1].changed, ['weather']);
  const again = await call(W.get);
  assert.deepEqual([again.body.data.enabled, again.body.data.multipliers.LIGHT_RAIN], [true, 1.1]);
});

test('wrong weather settings are refused with the reason for each field, and nothing is saved', async () => {
  await reset();
  const r = await call(W.update, { body: { enabled: true, multipliers: { HEAVY_RAIN: 2.6, STORM: 0.9, SOMETHING: 1.2 }, maxMultiplier: 5 } });
  assert.equal(r.code, 400);
  assert.deepEqual(Object.keys(r.body.errors).sort(), ['maxMultiplier', 'multipliers.HEAVY_RAIN', 'multipliers.SOMETHING', 'multipliers.STORM']);
  assert.ok(unset(await stored('t1', 'weatherPricing')));
  assert.equal((await audits('weather_pricing.updated')).length, 0);
});

test('switching weather pricing off keeps the amounts but stops charging them', async () => {
  await reset();
  await call(W.update, { body: { enabled: true, multipliers: { STORM: 1.5 } } });
  const r = await call(W.update, { body: { enabled: false, multipliers: { STORM: 1.5 } } });
  assert.deepEqual([r.body.data.enabled, r.body.data.multipliers.STORM], [false, 1.5]);
  assert.equal((await audits('weather_pricing.updated')).length, 2);
});

// ---------------------------------------------------------------- payment methods

test('payment methods start as cash only, with the usable providers listed', async () => {
  await reset();
  const r = await call(P.adminSettingsGet);
  assert.deepEqual([r.body.data.enabledMethods, r.body.data.provider, r.body.data.commissionRecovery, r.body.data.availableProviders], [['CASH'], null, 'DEDUCT_FROM_PAYABLE', ['MOCK']]);
});

test('UPI can be switched on only with a provider that can really be used, and cash always stays', async () => {
  await reset();
  const ok = await call(P.adminSettingsUpdate, { body: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', commissionRecovery: 'MANUAL_ONLY', paymentWindowMinutes: 20 } });
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.deepEqual(await stored('t1', 'payments'), { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK', merchantId: null, commissionRecovery: 'MANUAL_ONLY', paymentWindowMinutes: 20 });
  assert.ok(unset(await stored('t2', 'payments')));
  const a = await audits('payments.settings_updated');
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].tenantId, a[0].meta.provider], ['t1', 'MOCK']);

  const real = await call(P.adminSettingsUpdate, { body: { enabledMethods: ['CASH', 'UPI'], provider: 'RAZORPAY' } });
  assert.equal(real.code, 400);
  assert.match(real.body.errors.provider, /not available yet/);
  const none = await call(P.adminSettingsUpdate, { body: { enabledMethods: ['CASH', 'UPI'] } });
  assert.match(none.body.errors.provider, /Choose a provider/);
  assert.match((await call(P.adminSettingsUpdate, { body: { enabledMethods: ['UPI'], provider: 'MOCK' } })).body.errors.enabledMethods, /Cash must stay/);
  assert.match((await call(P.adminSettingsUpdate, { body: { enabledMethods: ['CASH', 'CARD'] } })).body.errors.enabledMethods, /Unknown payment method/);
  assert.ok((await call(P.adminSettingsUpdate, { body: { enabledMethods: ['CASH'], paymentWindowMinutes: 2 } })).body.errors.paymentWindowMinutes);
  assert.ok((await call(P.adminSettingsUpdate, { body: { enabledMethods: ['CASH'], commissionRecovery: 'WHENEVER' } })).body.errors.commissionRecovery);
  assert.equal((await audits('payments.settings_updated')).length, 1, 'refused changes are not audited as changes');
});

test('in production, with no real provider built, online payment cannot be switched on at all', async () => {
  await reset();
  process.env.NODE_ENV = 'production'; delete process.env.PAYMENTS_MOCK_ENABLED;
  try {
    const r = await call(P.adminSettingsUpdate, { body: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK' } });
    assert.equal(r.code, 400);
    assert.match(r.body.errors.provider, /not available yet/);
    assert.deepEqual((await call(P.adminSettingsGet)).body.data.availableProviders, []);
    const cash = await call(P.adminSettingsUpdate, { body: { enabledMethods: ['CASH'] } });
    assert.equal(cash.code, 200, 'cash-only settings still save');
  } finally { process.env.NODE_ENV = 'test'; process.env.PAYMENTS_MOCK_ENABLED = '1'; }
});

test('turning UPI off clears the provider, so nothing online is offered afterwards', async () => {
  await reset();
  await call(P.adminSettingsUpdate, { body: { enabledMethods: ['CASH', 'UPI'], provider: 'MOCK' } });
  await call(P.adminSettingsUpdate, { body: { enabledMethods: ['CASH'], provider: 'MOCK' } });
  assert.deepEqual([(await stored('t1', 'payments')).enabledMethods, (await stored('t1', 'payments')).provider], [['CASH'], null]);
});
