/**
 * Payments over the real HTTP API, on both database engines: who may call each endpoint (no session, the wrong role, a staff role without
 * payment permissions), what a business that has not switched online payment on gets, the provider webhook route (no sign-in; refused
 * unless the provider is available and the signature is right), the development simulator being absent when the mock gateway is off, and
 * the dashboard endpoints on an empty business. The money flows themselves (UPI, cash, commission, refunds, reconciliation) are covered
 * in depth, against stored state, by test/payments*.test.js.
 */
const { configuredBusiness, driverSignIn } = require('./common');

module.exports = async function payments(t) {
  const { call, peek, alias } = t;
  const ctx = await configuredBusiness(t);
  const { admin, H } = ctx;
  const biz = (name, opts) => call(name, { token: admin, headers: H, ...opts });

  // a rider and a driver, signed in the way the apps do
  const reg = await call('payments: register a rider', { method: 'POST', path: '/api/users/register', headers: H, body: { name: 'Pia Payer', phone: '+919822222222' }, expectStatus: 201 });
  const userId = reg.body.data.user.userId;
  alias(userId, 'payerId');
  const otp = (await peek('users_otp', { userId, isUsed: false })).otp;
  alias(otp, 'payerOtp');
  const ver = await call('payments: verify the rider', { method: 'POST', path: '/api/users/verify-otp', headers: H, body: { userId, otp, device_id: 'payer-device', fcm_id: 'payer-fcm' }, expectStatus: 200 });
  const riderToken = ver.body.data.accessToken || (ver.body.data.user && ver.body.data.user.accessToken);
  const driverToken = await driverSignIn(t, { driverId: ctx.driverId, phone: ctx.driverPhone, tag: 'payments driver' });
  const R = { token: riderToken, headers: H };
  const D = { token: driverToken, headers: H };
  const P = '/api/v1/payments';

  // --- nobody signed in
  for (const [label, method, path] of [
    ['methods', 'GET', `${P}/methods`], ['create', 'POST', `${P}/create`], ['read a ride\'s payment', 'GET', `${P}/trip/T_x`], ['confirm cash', 'POST', `${P}/cash/confirm`],
    ['dispute cash', 'POST', `${P}/cash/dispute`], ['commission', 'GET', `${P}/commission`], ['pay commission', 'POST', `${P}/commission/pay`], ['simulate', 'POST', `${P}/mock/simulate`], ['refresh', 'POST', `${P}/pay_x/refresh`]
  ]) await call(`payments: ${label} needs a session`, { method, path, headers: H, body: method === 'POST' ? {} : undefined, expectStatus: 401 });

  // --- the wrong role
  await call('payments: a driver cannot open a rider payment', { method: 'POST', path: `${P}/create`, body: { trip_id: 'T_x' }, ...D, expectStatus: 403 });
  await call('payments: a rider cannot confirm cash', { method: 'POST', path: `${P}/cash/confirm`, body: { trip_id: 'T_x' }, ...R, expectStatus: 403 });
  await call('payments: a rider has no commission', { path: `${P}/commission`, ...R, expectStatus: 403 });
  await call('payments: a rider cannot pay commission', { method: 'POST', path: `${P}/commission/pay`, body: { amount_minor: 100 }, ...R, expectStatus: 403 });
  await call('payments: a driver cannot refresh a rider payment', { method: 'POST', path: `${P}/pay_x/refresh`, ...D, expectStatus: 403 });

  // --- a business that has not switched online payment on
  const methods = await call('payments: methods (cash only by default)', { path: `${P}/methods`, ...R, expectStatus: 200 });
  if (JSON.stringify(methods.body.data.methods) !== '["CASH"]' || methods.body.data.mock !== false) throw new Error('expected cash only and no mock');
  await call('payments: create without a ride', { method: 'POST', path: `${P}/create`, body: {}, ...R, expectStatus: 400 });
  await call('payments: online payment is not enabled', { method: 'POST', path: `${P}/create`, body: { trip_id: 'T_x' }, ...R, expectStatus: 403 });
  await call('payments: an unknown ride', { path: `${P}/trip/T_missing`, ...R, expectStatus: 404 });
  await call('payments: confirm cash needs a ride', { method: 'POST', path: `${P}/cash/confirm`, body: {}, ...D, expectStatus: 400 });
  await call('payments: confirm cash with a bad amount', { method: 'POST', path: `${P}/cash/confirm`, body: { trip_id: 'T_x', collected_minor: 'lots' }, ...D, expectStatus: 400 });
  await call('payments: confirm cash for an unknown ride', { method: 'POST', path: `${P}/cash/confirm`, body: { trip_id: 'T_missing' }, ...D, expectStatus: 404 });
  await call('payments: dispute for an unknown ride', { method: 'POST', path: `${P}/cash/dispute`, body: { trip_id: 'T_missing', reason: 'x y z' }, ...R, expectStatus: 404 });
  const summary = await call('payments: the driver\'s commission is nil', { path: `${P}/commission`, ...D, expectStatus: 200 });
  if (summary.body.data.outstanding_minor !== 0) throw new Error('expected nothing outstanding');
  await call('payments: pay commission needs a whole amount', { method: 'POST', path: `${P}/commission/pay`, body: { amount_minor: 10.5 }, ...D, expectStatus: 400 });
  await call('payments: pay commission when online payment is off', { method: 'POST', path: `${P}/commission/pay`, body: { amount_minor: 100 }, ...D, expectStatus: 403 });
  await call('payments: refresh an unknown payment', { method: 'POST', path: `${P}/pay_missing/refresh`, ...R, expectStatus: 404 });
  await call('payments: the simulator does not exist when the mock gateway is off', { method: 'POST', path: `${P}/mock/simulate`, body: { payment_id: 'pay_x', scenario: 'SUCCESS' }, ...R, expectStatus: 404 });

  // --- the provider's webhook: no sign-in, so the signature is everything
  await call('payments webhook: the mock gateway is off', { method: 'POST', path: `${P}/webhook/mock`, headers: { 'x-mock-signature': 'forged' }, body: { id: 'e1' }, expectStatus: 503 });
  await call('payments webhook: an unknown provider', { method: 'POST', path: `${P}/webhook/nope`, body: { id: 'e1' }, expectStatus: 404 });
  await call('payments webhook: a real provider that is not configured', { method: 'POST', path: `${P}/webhook/razorpay`, body: { id: 'e1' }, expectStatus: 503 });

  // --- the dashboard
  const A = '/api/admin/business';
  await call('payments admin: no session', { path: `${A}/payments`, headers: H, expectStatus: 401 });
  const list = await biz('payments admin: list (empty)', { path: `${A}/payments`, expectStatus: 200 });
  if (list.body.data.total !== 0) throw new Error('expected no payments');
  await biz('payments admin: an unknown payment', { path: `${A}/payments/pay_missing`, expectStatus: 404 });
  await biz('payments admin: refund an unknown payment', { method: 'POST', path: `${A}/payments/pay_missing/refund`, body: { amount_minor: 100, reason: 'test', idempotency_key: 'k1' }, expectStatus: 404 });
  await biz('payments admin: refund with a bad amount', { method: 'POST', path: `${A}/payments/pay_missing/refund`, body: { amount_minor: 1.5, reason: 'test', idempotency_key: 'k1' }, expectStatus: 400 });
  await biz('payments admin: resolve cash for an unknown payment', { method: 'POST', path: `${A}/payments/pay_missing/cash/resolve`, body: { action: 'CONFIRM', reason: 'test' }, expectStatus: 404 });
  const commission = await biz('payments admin: commission report (empty)', { path: `${A}/commission`, expectStatus: 200 });
  if (commission.body.data.drivers.length !== 0) throw new Error('expected no drivers');
  await biz('payments admin: recover commission (nothing to recover)', { method: 'POST', path: `${A}/commission/drivers/${ctx.driverId}/recover`, expectStatus: 200 });
  await biz('payments admin: reconciliation run (nothing to find)', { method: 'POST', path: `${A}/reconciliation/run`, expectStatus: 200 });
  await biz('payments admin: reconciliation findings', { path: `${A}/reconciliation?status=open`, expectStatus: 200 });
  await biz('payments admin: resolve an unknown finding', { method: 'POST', path: `${A}/reconciliation/dis_missing/resolve`, body: { note: 'test' }, expectStatus: 404 });

  // --- the settings forms (payment methods, weather pricing) and the driver's demand map
  const ps = await biz('payment settings: defaults are cash only', { path: `${A}/payment-settings`, expectStatus: 200 });
  if (JSON.stringify(ps.body.data.enabledMethods) !== '["CASH"]') throw new Error('expected cash only');
  await biz('payment settings: UPI needs a provider', { method: 'PUT', path: `${A}/payment-settings`, body: { enabledMethods: ['CASH', 'UPI'] }, expectStatus: 400 });
  await biz('payment settings: a real provider is not available yet', { method: 'PUT', path: `${A}/payment-settings`, body: { enabledMethods: ['CASH', 'UPI'], provider: 'RAZORPAY' }, expectStatus: 400 });
  await biz('payment settings: cash must stay', { method: 'PUT', path: `${A}/payment-settings`, body: { enabledMethods: ['UPI'], provider: 'MOCK' }, expectStatus: 400 });
  await biz('payment settings: save cash only', { method: 'PUT', path: `${A}/payment-settings`, body: { enabledMethods: ['CASH'], commissionRecovery: 'MANUAL_ONLY', paymentWindowMinutes: 20 }, expectStatus: 200 });
  await call('weather pricing: no session', { path: `${A}/weather-pricing`, headers: H, expectStatus: 401 });
  const wp = await biz('weather pricing: off by default', { path: `${A}/weather-pricing`, expectStatus: 200 });
  if (wp.body.data.enabled !== false || wp.body.data.maxMultiplier !== 1.5) throw new Error('expected off with a 1.5 cap');
  await biz('weather pricing: wrong values are refused', { method: 'PUT', path: `${A}/weather-pricing`, body: { enabled: true, multipliers: { HEAVY_RAIN: 3, SOMETHING: 1.2 }, maxMultiplier: 9 }, expectStatus: 400 });
  await biz('weather pricing: save', { method: 'PUT', path: `${A}/weather-pricing`, body: { enabled: true, multipliers: { LIGHT_RAIN: 1.1, HEAVY_RAIN: 1.3 }, maxMultiplier: 1.4 }, expectStatus: 200 });
  await call('demand map: needs a session', { path: '/api/v1/driver/summary/demand-map', headers: H, expectStatus: 401 });
  await call('demand map: a rider cannot read it', { path: '/api/v1/driver/summary/demand-map', ...R, expectStatus: 403 });
  await call('demand map: a bad position', { path: '/api/v1/driver/summary/demand-map?lat=abc&lng=77', ...D, expectStatus: 400 });
  const dm = await call('demand map: nothing around yet', { path: '/api/v1/driver/summary/demand-map?lat=18.5204&lng=73.8567&radius_km=5', ...D, expectStatus: 200 });
  if (dm.body.data.cells.length !== 0 || dm.body.data.radiusKm !== 5) throw new Error('expected an empty map within 5 km');

  // a support agent has no business with the money
  const sup = await call('payments admin: create a support user', { method: 'POST', path: '/api/admin/users', body: { name: 'Support', email: 'support-pay@contract.test', role: 'support' }, token: admin, headers: H, expectStatus: 201 });
  alias(sup.body.data.temporaryPassword, 'supportTempPassword');
  const first = await call('payments admin: support signs in', { method: 'POST', path: '/api/admin/auth/login', body: { email: 'support-pay@contract.test', password: sup.body.data.temporaryPassword }, expectStatus: 200 });
  const changed = await call('payments admin: support chooses a password', { method: 'POST', path: '/api/admin/auth/change-password', body: { currentPassword: sup.body.data.temporaryPassword, newPassword: 'Support-Pass-12345' }, token: first.body.data.token, expectStatus: 200 });
  const supportToken = changed.body.data.token;
  await call('payments admin: support cannot list payments', { path: `${A}/payments`, token: supportToken, headers: H, expectStatus: 403 });
  await call('payments admin: support cannot refund', { method: 'POST', path: `${A}/payments/pay_missing/refund`, body: { amount_minor: 100, reason: 'test', idempotency_key: 'k1' }, token: supportToken, headers: H, expectStatus: 403 });
  await call('payments admin: support cannot see commission', { path: `${A}/commission`, token: supportToken, headers: H, expectStatus: 403 });
  // a rider's or a driver's token is not a staff session
  await call('payments admin: a rider token is not a staff session', { path: `${A}/payments`, ...R, expectStatus: 401 });
};
