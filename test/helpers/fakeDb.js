/**
 * In-memory stand-ins for the Mongoose models the admin API uses, so the real routes and controllers can run without
 * MongoDB (tests, and scripts/devServer.js). It implements only what those controllers call: equality and $in
 * filters, find/findOne/exists/create/findOneAndUpdate($set, $setOnInsert, upsert)/updateMany($inc)/deleteOne/count,
 * and unique indexes (single and compound) that throw the same duplicate-key error code (11000) as MongoDB.
 * It does NOT reproduce Mongoose schema defaults or validation, so controllers must not rely on them.
 */
const path = require('path');

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, cond]) => {
    const actual = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if (Array.isArray(cond.$in)) return cond.$in.some((x) => (x === null ? actual == null : actual === x));
      throw new Error(`fakeDb: unsupported filter operator on "${key}": ${JSON.stringify(cond)}`);
    }
    return cond === null ? actual == null : actual === cond;
  });
}

function fakeModel({ uniques = [], defaults = () => ({}) }) {
  const rows = [];
  const attach = (doc) => {
    Object.defineProperty(doc, 'save', {
      value: async function save() { checkUnique(doc); return doc; }, enumerable: false, configurable: true
    });
    return doc;
  };
  const checkUnique = (candidate) => {
    for (const fields of uniques) {
      const list = Array.isArray(fields) ? fields : [fields];
      const clash = rows.find((r) => r !== candidate && list.every((f) => (r[f] ?? null) === (candidate[f] ?? null)));
      if (clash) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
  };
  const query = (value) => {
    const p = Promise.resolve(value);
    p.select = () => p; p.sort = () => p; p.limit = () => p; p.lean = () => p;
    return p;
  };

  return {
    rows,
    findOne: (f) => query(rows.find((d) => matches(d, f)) || null),
    find: (f) => query(rows.filter((d) => matches(d, f))),
    exists: async (f) => (rows.find((d) => matches(d, f)) ? { _id: 1 } : null),
    countDocuments: async (f) => rows.filter((d) => matches(d, f)).length,
    create: async (data) => {
      const doc = attach({ ...defaults(), ...data });
      checkUnique(doc);
      rows.push(doc);
      return doc;
    },
    findOneAndUpdate: async (filter, update, options = {}) => {
      let doc = rows.find((d) => matches(d, filter));
      if (!doc) {
        if (!options.upsert) return null;
        const seed = Object.fromEntries(Object.entries(filter).filter(([, v]) => !(v && typeof v === 'object')));
        doc = attach({ ...defaults(), ...seed, ...(update.$setOnInsert || {}) });
        Object.assign(doc, update.$set || {});
        checkUnique(doc);
        rows.push(doc);
        return doc;
      }
      const before = { ...doc };
      Object.assign(doc, update.$set || {});
      try { checkUnique(doc); } catch (e) { Object.assign(doc, before); throw e; }
      return doc;
    },
    updateMany: async (f, update) => {
      for (const d of rows.filter((r) => matches(r, f))) {
        for (const [k, n] of Object.entries(update.$inc || {})) d[k] = (d[k] || 0) + n;
      }
    },
    deleteOne: async (f) => {
      const i = rows.findIndex((d) => matches(d, f));
      if (i >= 0) rows.splice(i, 1);
    },
    aggregate: async () => []
  };
}

function createFakeDb() {
  const adminDefaults = () => ({ createdAt: new Date(), updatedAt: new Date() });
  const db = {
    Tenant: fakeModel({ uniques: ['tenantId', 'slug', 'packageName'], defaults: () => ({ ...adminDefaults(), supportEmail: '', supportPhone: '', market: null, brandColor: '#f5a300', isDefault: false }) }),
    AdminUser: fakeModel({ uniques: ['adminId', 'email'], defaults: () => ({ ...adminDefaults(), active: true, tokenVersion: 0, failedLogins: 0, lockUntil: null, mustChangePassword: false }) }),
    AdminAudit: fakeModel({ defaults: () => ({ at: new Date() }) }),
    ServiceRegion: fakeModel({ uniques: ['regionId', ['tenantId', 'key']] }),
    VehicleCategory: fakeModel({ uniques: ['categoryId', ['tenantId', 'nameKey']] }),
    FareRule: fakeModel({ uniques: ['ruleId', ['tenantId', 'categoryId', 'regionKey']] }),
    CancellationPolicy: fakeModel({ uniques: ['policyId', ['tenantId', 'categoryId', 'regionKey']] }),
    SetupProgress: fakeModel({ uniques: ['tenantId'] })
  };

  /** Replaces the real model modules in require.cache. Call before requiring routes or controllers. */
  db.install = () => {
    const root = path.join(__dirname, '..', '..');
    const stub = (relative, exports) => {
      const file = require.resolve(path.join(root, relative));
      require.cache[file] = { id: file, filename: file, loaded: true, exports };
    };
    stub('models/adminModels.js', { Tenant: db.Tenant, AdminUser: db.AdminUser, AdminAudit: db.AdminAudit });
    stub('models/businessModels.js', {
      ServiceRegion: db.ServiceRegion, VehicleCategory: db.VehicleCategory, FareRule: db.FareRule,
      CancellationPolicy: db.CancellationPolicy, SetupProgress: db.SetupProgress
    });
    stub('models/tripDetailsModel.js', { TripDetails: fakeModel({}) });
    stub('models/dynamicModel.js', { createModel: () => fakeModel({}) });
  };
  return db;
}

module.exports = { createFakeDb };
