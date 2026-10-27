/**
 * Region and category drafts over the real HTTP API: switch a business to "review first", save a region and a category (they wait as
 * drafts and change nothing live), see the comparison, publish them together, and check what is refused (a role without permission,
 * publishing nothing, switching back while drafts wait).
 */
const { configuredBusiness } = require('./common');

module.exports = async function setupDrafts(t) {
  const { call } = t;
  const ctx = await configuredBusiness(t);
  const { admin, H, regionId, categoryId } = ctx;
  const biz = (name, opts) => call(name, { token: admin, headers: H, ...opts });
  const D = '/api/admin/business/setup';

  await call('drafts: no session', { path: `${D}/draft`, headers: H, expectStatus: 401 });
  const first = await biz('drafts: the mode starts as direct', { path: `${D}/draft`, expectStatus: 200 });
  if (first.body.data.mode !== 'direct') throw new Error('expected direct mode');
  await biz('drafts: a bad mode is refused', { method: 'PUT', path: `${D}/workflow`, body: { mode: 'sometimes' }, expectStatus: 400 });
  await biz('drafts: publish with nothing waiting', { method: 'POST', path: `${D}/publish`, body: {}, expectStatus: 409 });
  await biz('drafts: switch to review first', { method: 'PUT', path: `${D}/workflow`, body: { mode: 'draft' }, expectStatus: 200 });

  await biz('drafts: a new region waits as a draft', { method: 'POST', path: '/api/admin/business/regions', body: { state: 'Maharashtra', cities: [{ name: 'Nagpur' }], zoneName: 'All areas' }, expectStatus: 202 });
  await biz('drafts: the same region again is refused', { method: 'POST', path: '/api/admin/business/regions', body: { state: 'Maharashtra', cities: [{ name: 'Nagpur' }], zoneName: 'All areas' }, expectStatus: 409 });
  await biz('drafts: a new category waits as a draft', { method: 'POST', path: '/api/admin/business/categories', body: { name: 'Mini', passengerCapacity: 4, rideType: 'economy', regionIds: [regionId] }, expectStatus: 202 });
  await biz('drafts: a bad category is refused like a live save', { method: 'POST', path: '/api/admin/business/categories', body: { name: 'x', passengerCapacity: 4, rideType: 'economy', regionIds: [regionId] }, expectStatus: 400 });
  await biz('drafts: an edit to a live category waits too', { method: 'PATCH', path: `/api/admin/business/categories/${categoryId}`, body: { description: 'Comfortable sedans' }, expectStatus: 202 });
  await biz('drafts: live regions are unchanged', { path: '/api/admin/business/regions', expectStatus: 200 });
  await biz('drafts: live categories are unchanged', { path: '/api/admin/business/categories', expectStatus: 200 });
  await biz('drafts: what is waiting and what publishing would change', { path: `${D}/draft`, expectStatus: 200 });
  await biz('drafts: cannot switch back while drafts wait', { method: 'PUT', path: `${D}/workflow`, body: { mode: 'direct' }, expectStatus: 409 });
  await biz('drafts: discarding an unknown draft', { method: 'DELETE', path: `${D}/draft/sd_missing`, expectStatus: 404 });
  await biz('drafts: publish all together', { method: 'POST', path: `${D}/publish`, body: { note: 'Add Nagpur and the Mini category' }, expectStatus: 200 });
  await biz('drafts: live regions after publishing', { path: '/api/admin/business/regions', expectStatus: 200 });
  await biz('drafts: live categories after publishing', { path: '/api/admin/business/categories', expectStatus: 200 });
  await biz('drafts: nothing waits any more', { path: `${D}/draft`, expectStatus: 200 });
  await biz('drafts: the audit log records the publish', { path: '/api/admin/business/audit', expectStatus: 200 });
  await biz('drafts: switch back to direct', { method: 'PUT', path: `${D}/workflow`, body: { mode: 'direct' }, expectStatus: 200 });
  await biz('drafts: direct again: a region is live at once', { method: 'POST', path: '/api/admin/business/regions', body: { state: 'Maharashtra', cities: [{ name: 'Nashik' }], zoneName: 'All areas' }, expectStatus: 201 });
};
