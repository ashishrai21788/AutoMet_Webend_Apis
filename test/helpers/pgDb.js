/**
 * The same object createFakeDb() returns (db.Tenant, db.AdminUser, ... plus install()), but backed by the REAL Mongoose
 * models running on the Postgres engine (PGlite in-process) instead of the hand-written in-memory stand-ins.
 * Selected with TEST_DB=postgres, so every existing test file runs unchanged:  TEST_DB=postgres npm test
 *
 * Many tests read `db.Model.rows` (the stand-in's array) synchronously after an API call. To keep them unchanged, each
 * model's `rows` is a mirror reloaded from Postgres after every write.
 */
process.env.DB_ENGINE = 'postgres';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'pglite:memory';
process.env.REQUIRE_PLATFORM_2FA = process.env.REQUIRE_PLATFORM_2FA || '0';

function createPgDb() {
  const clientModule = require('../../lib/db/postgres/client');
  const { createModel } = require('../../models/dynamicModel');
  const admin = require('../../models/adminModels');
  const business = require('../../models/businessModels');
  const fleet = require('../../models/fleetModels');
  const { TripDetails } = require('../../models/tripDetailsModel');
  const TripEvent = require('../../models/tripEventModel');
  const { DriverIssue } = require('../../models/supportModels');
  const billing = require('../../models/platformBilling');

  const db = {
    Tenant: admin.Tenant, AdminUser: admin.AdminUser, AdminAudit: admin.AdminAudit,
    ServiceRegion: business.ServiceRegion, VehicleCategory: business.VehicleCategory, FareRule: business.FareRule,
    CancellationPolicy: business.CancellationPolicy, SetupProgress: business.SetupProgress,
    Driver: createModel('drivers'), User: createModel('users'),
    DriverDocument: fleet.DriverDocument, Vehicle: fleet.Vehicle, VehicleDocument: fleet.VehicleDocument,
    DriverVehicleAssignment: fleet.DriverVehicleAssignment, EntityHistory: fleet.EntityHistory,
    TripDetails, TripEvent, DriverIssue,
    PlatformInvoice: billing.PlatformInvoice, PlatformCounter: billing.PlatformCounter, PlatformPlan: billing.PlatformPlan, PlatformSettings: billing.PlatformSettings
  };
  const models = Object.values(db);
  for (const m of models) m.rows = [];

  let refreshing = false;
  // like the stand-in, the mirror shows every field (including select:false ones such as hashes)
  const everything = (m) => { const hidden = []; m.schema.eachPath((p, t) => { if (t.options && t.options.select === false) hidden.push(`+${p}`); }); return hidden.join(' '); };

  // A test may edit a mirrored row directly (row.status = 'X') as it could with the stand-in. The edit is written to the
  // database before the next database operation of the server under test.
  const edits = [];
  const watched = (m, doc) => new Proxy(doc, {
    set(target, key, value) { target[key] = value; edits.push({ m, id: target._id, set: { [key]: value } }); return true; },
    deleteProperty(target, key) { delete target[key]; edits.push({ m, id: target._id, unset: key }); return true; }
  });
  let flushing = false;
  const flushEdits = async () => {
    if (flushing || !edits.length) return;
    flushing = true;
    try {
      const mongoose = require('../../lib/db/mongoose');
      while (edits.length) {
        const e = edits.shift();
        const col = mongoose.connection.db.collection(e.m.collection.name);
        await col.updateOne({ _id: e.id }, e.unset ? { $unset: { [e.unset]: 1 } } : { $set: e.set });
      }
    } finally { flushing = false; }
  };

  // the table a write statement changes: INSERT INTO "t", UPDATE "t", DELETE FROM "t"
  const WRITE = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"([^"]+)"/i;
  const noteWrite = (text, into) => { const m = WRITE.exec(text); if (m) into.add(m[1]); };

  // refreshes only the models whose table was written (over a network every query counts)
  const refreshAll = async (only) => {
    if (refreshing) return;
    refreshing = true;
    try {
      for (const m of models) {
        if (only && !only.has(m.collection.name)) continue;
        const docs = await m.find({}).select(everything(m)).lean();
        m.rows.length = 0;
        // ids as strings, like the stand-in's rows (an ObjectId would not compare equal to the hex string a test holds)
        m.rows.push(...docs.map((d) => watched(m, { ...d, _id: String(d._id) })));
      }
    } finally { refreshing = false; }
  };

  /** Connects, creates the tables, and mirrors rows after every write. The real models are already what the routes load. */
  db.install = () => {
    const c = clientModule.connect();
    const tx = c.transaction.bind(c);
    const query = c.query.bind(c);
    // TEST_DB_RESET=1 (real database): start each test file from empty tables; everything else waits for the reset
    let ready = Promise.resolve();
    if (process.env.TEST_DB_RESET === '1' && c.kind === 'pg') {
      const { resetOwnTables } = require('./realDbReset');
      ready = resetOwnTables(query, models.map((m) => m.collection.name));
    }
    // refresh only after a transaction that wrote rows (table creation, which every first query waits for, must not wait on a refresh)
    c.transaction = async (fn) => {
      await ready;
      if (!refreshing) await flushEdits();
      const written = new Set();
      const out = await tx((t) => fn({ query: (text, params) => { noteWrite(text, written); return t.query(text, params); }, exec: (text) => t.exec(text) }));
      if (written.size && !refreshing) await refreshAll(written);
      return out;
    };
    c.query = async (text, params) => {
      await ready;
      if (!refreshing && !flushing) await flushEdits();
      const out = await query(text, params);
      const written = new Set();
      noteWrite(text, written);
      if (written.size && !refreshing) await refreshAll(written);
      return out;
    };
  };
  return db;
}

module.exports = { createPgDb };
