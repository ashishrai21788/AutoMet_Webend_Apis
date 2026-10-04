/**
 * Tenant-bound data access. `forTenant(appId)` returns helpers whose every query is filtered by that appId and whose
 * every created document is stamped with it. Business controllers use only these helpers, so a query that forgets the
 * tenant filter cannot be written by accident, and a client-supplied `tenantId` in a body is overwritten.
 */
function forTenant(appId) {
  if (!appId || typeof appId !== 'string') throw new Error('forTenant requires an appId');
  const scope = (filter = {}) => ({ ...filter, tenantId: appId });

  return {
    appId,
    find: (Model, filter) => Model.find(scope(filter)),
    findOne: (Model, filter) => Model.findOne(scope(filter)),
    count: (Model, filter) => Model.countDocuments(scope(filter)),
    exists: (Model, filter) => Model.exists(scope(filter)),
    create: (Model, doc) => Model.create({ ...doc, tenantId: appId }),
    /** $set cannot move a record to another tenant; upsert inserts into this tenant only. */
    update: (Model, filter, set, options = {}) => {
      const { tenantId: _ignored, ...safeSet } = set;
      const update = { $set: safeSet };
      if (options.setOnInsert) update.$setOnInsert = { ...options.setOnInsert }; // tenantId comes from the (scoped) filter on insert
      return Model.findOneAndUpdate(scope(filter), update, { new: true, upsert: !!options.upsert });
    },
    remove: (Model, filter) => Model.deleteOne(scope(filter))
  };
}

module.exports = { forTenant };
