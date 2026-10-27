/**
 * Emergencies (SOS) over the real HTTP API, from the staff side: who may see them, and the refusals. Raising one needs a ride in progress
 * and is covered end to end by test/sos.test.js and on real phones; this records the dashboard contract on both database engines.
 */
const { configuredBusiness } = require('./common');

module.exports = async function sos(t) {
  const { call, alias } = t;
  const ctx = await configuredBusiness(t);
  const { admin, H } = ctx;
  const biz = (name, opts) => call(name, { token: admin, headers: H, ...opts });
  const D = '/api/admin/business/sos';

  await call('sos: no session', { path: D, headers: H, expectStatus: 401 });
  const empty = await biz('sos: nothing open yet', { path: D, expectStatus: 200 });
  if (empty.body.data.open !== 0 || empty.body.data.items.length !== 0) throw new Error('expected no emergencies');
  await biz('sos: resolved list is empty too', { path: `${D}?status=resolved`, expectStatus: 200 });
  await biz('sos: an unknown status falls back to open', { path: `${D}?status=whatever`, expectStatus: 200 });
  await biz('sos: acknowledge an unknown emergency', { method: 'POST', path: `${D}/sos_missing/acknowledge`, expectStatus: 404 });
  await biz('sos: resolve an unknown emergency', { method: 'POST', path: `${D}/sos_missing/resolve`, body: { note: 'x' }, expectStatus: 404 });
  await biz('sos: a note that is too long', { method: 'POST', path: `${D}/sos_missing/resolve`, body: { note: 'x'.repeat(400) }, expectStatus: 400 });

  // a finance user may not see emergencies (they carry phone numbers and locations)
  const fin = await call('sos: create a finance user', { method: 'POST', path: '/api/admin/users', body: { name: 'Finance', email: 'finance@contract.test', role: 'finance' }, token: admin, headers: H, expectStatus: 201 });
  alias(fin.body.data.temporaryPassword, 'financeTempPassword');
  const first = await call('sos: finance signs in (temporary password)', { method: 'POST', path: '/api/admin/auth/login', body: { email: 'finance@contract.test', password: fin.body.data.temporaryPassword }, expectStatus: 200 });
  const changed = await call('sos: finance chooses a password', { method: 'POST', path: '/api/admin/auth/change-password', body: { currentPassword: fin.body.data.temporaryPassword, newPassword: 'Finance-Pass-12345' }, token: first.body.data.token, expectStatus: 200 });
  const financeToken = changed.body.data.token;
  await call('sos: finance cannot list emergencies', { path: D, token: financeToken, headers: H, expectStatus: 403 });
  await call('sos: finance cannot acknowledge one', { method: 'POST', path: `${D}/sos_missing/acknowledge`, token: financeToken, headers: H, expectStatus: 403 });
};
