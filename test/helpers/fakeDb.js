/**
 * In-memory stand-ins for the Mongoose models the admin API uses, so the real routes and controllers can run without
 * MongoDB (tests, and scripts/devServer.js). It implements the query features those controllers call:
 *   filters: equality (null matches missing), $in, $nin, $ne, $lt/$lte/$gt/$gte, $regex(+$options), $or, $and
 *   queries: find / findOne / exists / countDocuments, with .select() .lean() .sort({a:1,b:-1}) .skip() .limit()
 *   writes:  create, findOneAndUpdate($set, $setOnInsert, upsert), updateMany($inc), deleteOne
 *   unique indexes (single and compound) throwing MongoDB's duplicate-key error (code 11000); an index may be
 *   partial (`only: {active: true}`) so it only applies to matching documents.
 * It does NOT reproduce Mongoose schema defaults or validation, so controllers must not rely on them.
 */
const path = require('path');

const isPlainOperatorObject = (v) => v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof RegExp) && !Array.isArray(v);
const asComparable = (v) => (v instanceof Date ? v.getTime() : v);

function matchesValue(actual, cond) {
  if (cond instanceof RegExp) return typeof actual === 'string' && cond.test(actual);
  if (!isPlainOperatorObject(cond)) {
    if (cond === null) return actual == null;
    if (Array.isArray(actual)) return actual.includes(cond);
    return asComparable(actual) === asComparable(cond);
  }
  return Object.entries(cond).every(([op, arg]) => {
    switch (op) {
      case '$in': return arg.some((x) => (x === null ? actual == null : Array.isArray(actual) ? actual.includes(x) : asComparable(actual) === asComparable(x)));
      case '$nin': return !arg.some((x) => (x === null ? actual == null : asComparable(actual) === asComparable(x)));
      case '$ne': return !matchesValue(actual, arg);
      case '$lt': return actual != null && asComparable(actual) < asComparable(arg);
      case '$lte': return actual != null && asComparable(actual) <= asComparable(arg);
      case '$gt': return actual != null && asComparable(actual) > asComparable(arg);
      case '$gte': return actual != null && asComparable(actual) >= asComparable(arg);
      case '$regex': return typeof actual === 'string' && new RegExp(arg, cond.$options || '').test(actual);
      case '$options': return true;
      default: throw new Error(`fakeDb: unsupported filter operator ${op}`);
    }
  });
}

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, cond]) => {
    if (key === '$or') return cond.some((f) => matches(doc, f));
    if (key === '$and') return cond.every((f) => matches(doc, f));
    return matchesValue(doc[key], cond);
  });
}

function fakeModel({ uniques = [], defaults = () => ({}) }) {
  const rows = [];
  const attach = (doc) => {
    Object.defineProperty(doc, 'save', {
      value: async function save() { checkUnique(doc); return doc; }, enumerable: false, configurable: true
    });
    // what a Mongoose document offers that the controllers use
    Object.defineProperty(doc, 'toObject', { value: () => ({ ...doc }), enumerable: false, configurable: true });
    return doc;
  };
  const checkUnique = (candidate) => {
    for (const spec of uniques) {
      const fields = Array.isArray(spec) ? spec : spec.fields ? spec.fields : [spec];
      const only = spec.only;
      if (only && !matches(candidate, only)) continue;
      const clash = rows.find((r) => r !== candidate && (!only || matches(r, only)) && fields.every((f) => (r[f] ?? null) === (candidate[f] ?? null)));
      if (clash) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
  };

  const query = (getRows) => {
    const state = { sort: null, skip: 0, limit: null };
    const run = () => {
      let out = [...getRows()];
      if (state.sort) {
        const keys = Object.entries(state.sort);
        out.sort((a, b) => {
          for (const [k, dir] of keys) {
            const x = asComparable(a[k]); const y = asComparable(b[k]);
            if (x === y) continue;
            if (x == null) return -dir;
            if (y == null) return dir;
            return (x < y ? -1 : 1) * dir;
          }
          return 0;
        });
      }
      out = out.slice(state.skip, state.limit == null ? undefined : state.skip + state.limit);
      return out;
    };
    const q = {
      select: () => q,
      lean: () => q,
      sort: (s) => { state.sort = s; return q; },
      skip: (n) => { state.skip = n; return q; },
      limit: (n) => { state.limit = n; return q; },
      then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
      catch: (reject) => Promise.resolve().then(run).catch(reject)
    };
    return q;
  };
  const one = (f) => {
    const q = query(() => { const hit = rows.find((d) => matches(d, f)); return hit ? [hit] : []; });
    const base = q.then;
    q.then = (resolve, reject) => base.call(q, (list) => resolve(list[0] || null), reject);
    q.catch = (reject) => q.then(undefined, reject);
    return q;
  };

  return {
    rows,
    findOne: (f) => one(f),
    find: (f) => query(() => rows.filter((d) => matches(d, f))),
    exists: async (f) => (rows.find((d) => matches(d, f)) ? { _id: 1 } : null),
    countDocuments: async (f) => rows.filter((d) => matches(d, f)).length,
    create: async (data) => {
      const doc = attach({ ...defaults(), ...data });
      checkUnique(doc);
      rows.push(doc);
      return doc;
    },
    findOneAndUpdate: async (filter, rawUpdate, options = {}) => {
      // Mongoose treats a plain object (no $operators) as a $set
      const update = Object.keys(rawUpdate).some((k) => k.startsWith('$')) ? rawUpdate : { $set: rawUpdate };
      let doc = rows.find((d) => matches(d, filter));
      if (!doc) {
        if (!options.upsert) return null;
        const seed = Object.fromEntries(Object.entries(filter).filter(([k, v]) => !k.startsWith('$') && !isPlainOperatorObject(v)));
        doc = attach({ ...defaults(), ...seed, ...(update.$setOnInsert || {}) });
        Object.assign(doc, update.$set || {});
        for (const [k, n] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + n;
        checkUnique(doc);
        rows.push(doc);
        return doc;
      }
      const before = { ...doc };
      Object.assign(doc, update.$set || {});
      for (const [k, v] of Object.entries(update.$push || {})) doc[k] = [...(doc[k] || []), v];
      for (const [k, n] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + n;
      try { checkUnique(doc); } catch (e) { Object.assign(doc, before); throw e; }
      return doc;
    },
    updateMany: async (f, update) => {
      for (const d of rows.filter((r) => matches(r, f))) {
        for (const [k, n] of Object.entries(update.$inc || {})) d[k] = (d[k] || 0) + n;
        Object.assign(d, update.$set || {});
      }
    },
    updateOne: async (f, update) => {
      const d = rows.find((r) => matches(r, f));
      if (!d) return { matchedCount: 0 };
      for (const [k, n] of Object.entries(update.$inc || {})) d[k] = (d[k] || 0) + n;
      Object.assign(d, update.$set || {});
      return { matchedCount: 1 };
    },
    deleteOne: async (f) => {
      const i = rows.findIndex((d) => matches(d, f));
      if (i >= 0) rows.splice(i, 1);
    },
    deleteMany: async (f) => {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], f)) { rows.splice(i, 1); n++; }
      return { deletedCount: n };
    },
    aggregate: async () => []
  };
}

// The platform owner must use two-step verification in production; the many tests that sign in as one turn that off here.
process.env.REQUIRE_PLATFORM_2FA = process.env.REQUIRE_PLATFORM_2FA || '0';

function createFakeDb() {
  const adminDefaults = () => ({ createdAt: new Date(), updatedAt: new Date() });
  const db = {
    Tenant: fakeModel({ uniques: ['tenantId', 'slug', 'packageName'], defaults: () => ({ ...adminDefaults(), supportEmail: '', supportPhone: '', market: null, brandColor: '#f5a300', isDefault: false }) }),
    AdminUser: fakeModel({ uniques: ['adminId', 'email'], defaults: () => ({ ...adminDefaults(), active: true, tokenVersion: 0, failedLogins: 0, lockUntil: null, mustChangePassword: false, totpEnabled: false, totpLastStep: -1, recoveryHashes: [] }) }),
    AdminAudit: fakeModel({ defaults: () => ({ at: new Date() }) }),
    ServiceRegion: fakeModel({ uniques: ['regionId', ['tenantId', 'key']] }),
    VehicleCategory: fakeModel({ uniques: ['categoryId', ['tenantId', 'nameKey']] }),
    FareRule: fakeModel({ uniques: ['ruleId', ['tenantId', 'categoryId', 'regionKey']] }),
    CancellationPolicy: fakeModel({ uniques: ['policyId', ['tenantId', 'categoryId', 'regionKey']] }),
    SetupProgress: fakeModel({ uniques: ['tenantId'] }),
    // drivers and riders (the existing collections)
    // timestamps: true on the real schema adds createdAt and updatedAt
    Driver: fakeModel({ uniques: ['driverId', 'email'], defaults: () => ({ createdAt: new Date(), updatedAt: new Date() }) }),
    User: fakeModel({ uniques: ['userId'] }),
    // fleet management
    DriverDocument: fakeModel({ uniques: ['docId', ['tenantId', 'driverId', 'type']] }),
    Vehicle: fakeModel({ uniques: ['vehicleId', ['tenantId', 'registrationKey']] }),
    VehicleDocument: fakeModel({ uniques: ['docId', ['tenantId', 'vehicleId', 'type']] }),
    DriverVehicleAssignment: fakeModel({
      uniques: ['assignmentId', { fields: ['tenantId', 'vehicleId'], only: { active: true } }, { fields: ['tenantId', 'driverId'], only: { active: true } }]
    }),
    EntityHistory: fakeModel({ defaults: () => ({ at: new Date() }) }),
    // trips
    TripDetails: fakeModel({ uniques: ['trip_id'] }),
    TripEvent: fakeModel({}),
    // support
    // platform billing
    PlatformInvoice: fakeModel({ uniques: ['invoiceId', 'number'], defaults: () => ({ issuedAt: new Date(), refundedAmount: 0, refunds: [] }) }),
    PlatformCounter: fakeModel({ uniques: ['key'] }),
    PlatformPlan: fakeModel({ uniques: ['planId', 'name'], defaults: () => ({ active: true, setupFee: 0, trialDays: null }) }),
    PlatformSettings: fakeModel({ uniques: ['key'] }),
    DriverIssue: fakeModel({ defaults: () => ({ _id: require('crypto').randomBytes(12).toString('hex') }) }) // ids like MongoDB's
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
    stub('models/fleetModels.js', {
      DriverDocument: db.DriverDocument, Vehicle: db.Vehicle, VehicleDocument: db.VehicleDocument,
      DriverVehicleAssignment: db.DriverVehicleAssignment, EntityHistory: db.EntityHistory
    });
    stub('models/tripDetailsModel.js', { TripDetails: db.TripDetails });
    stub('models/supportModels.js', { DriverIssue: db.DriverIssue });
    stub('models/platformBilling.js', { PlatformInvoice: db.PlatformInvoice, PlatformCounter: db.PlatformCounter, PlatformPlan: db.PlatformPlan, PlatformSettings: db.PlatformSettings });
    require.cache[require.resolve(path.join(root, 'models/tripEventModel.js'))] = { id: 'tripEvent', filename: require.resolve(path.join(root, 'models/tripEventModel.js')), loaded: true, exports: db.TripEvent };
    const other = fakeModel({});
    stub('models/dynamicModel.js', {
      createModel: (name) => (name === 'drivers' ? db.Driver : name === 'users' ? db.User : other),
      driverSchema: {}, userSchema: {}, genericSchema: {}
    });
  };
  return db;
}

module.exports = { createFakeDb };
