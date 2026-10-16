/**
 * The generic collection routes (/api/:collectionName). Only public reference data is readable here (driver_faqs, read-only);
 * people's records, reports and notifications are closed and have their own signed-in routes.
 */
module.exports = async function legacy(t) {
  const { call } = t;

  // ---- what is closed: every method, so nothing is readable, creatable, changeable or deletable without a dedicated route
  for (const name of ['admins', 'users', 'drivers', 'driver_issues', 'drivers_notification']) {
    await call(`closed: ${name} list`, { path: `/api/${name}`, expectStatus: 403 });
    if (name !== 'drivers') await call(`closed: ${name} create`, { method: 'POST', path: `/api/${name}`, body: { name: 'x' }, expectStatus: 403 });
    await call(`closed: ${name} one`, { path: `/api/${name}/123`, expectStatus: 403 });
    await call(`closed: ${name} update`, { method: 'PUT', path: `/api/${name}/123`, body: { name: 'x' }, expectStatus: 403 });
    await call(`closed: ${name} delete`, { method: 'DELETE', path: `/api/${name}/123`, expectStatus: 403 });
  }
  await call('unknown collection: list', { path: '/api/widgets', expectStatus: 403 });
  await call('unknown collection: create', { method: 'POST', path: '/api/widgets', body: { a: 1 }, expectStatus: 403 });
  await call('unknown collection: one', { path: '/api/widgets/abc', expectStatus: 403 });

  // ---- public reference data: readable, never writable from here
  await call('faqs: list', { path: '/api/driver_faqs', expectStatus: 200 });
  await call('faqs: names with a different case reach the same collection', { path: '/api/Driver_Faqs', expectStatus: 200 });
  await call('faqs: read one that does not exist', { path: '/api/driver_faqs/650000000000000000000099' });
  await call('faqs: create is refused', { method: 'POST', path: '/api/driver_faqs', body: { name: 'x', phone: '+910000000001' }, expectStatus: 403 });
  await call('faqs: update is refused', { method: 'PUT', path: '/api/driver_faqs/650000000000000000000099', body: { a: 1 }, expectStatus: 403 });
  await call('faqs: delete is refused', { method: 'DELETE', path: '/api/driver_faqs/650000000000000000000099', expectStatus: 403 });
};
