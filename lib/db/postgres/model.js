/**
 * Table-backed models with the Mongoose surface the backend uses.
 *
 * Each model is a real Mongoose model built on a private, never-connected Mongoose instance. That keeps everything that is
 * pure schema behaviour exactly as it is on Mongo: defaults, casting, trim/lowercase, enum/required/min/max messages,
 * ValidationError, virtuals, toObject/toJSON. Only storage is replaced: the static query methods and `save` are
 * overridden here to read and write Postgres rows.
 *
 * Updates read the row under a row lock (SELECT ... FOR UPDATE), apply the Mongo update operators to a Mongoose document in
 * memory (so casting is identical), and write the row back in the same transaction. A filter such as { status: 'REQUESTED' }
 * is therefore re-checked after the lock is taken, which is what makes state transitions race-safe.
 */
const clientModule = require('./client');
const { describe, ddl, q, EXTRA } = require('./table');
const { build, locate } = require('./filter');

const rows = require('./rows');
const { getPath, setPath, deletePath, rowFromObject, objectFromRow, explicitNulls, NULLS, columnsSql: columnsFor, insertRow: insertRowSql, updateRow: updateRowSql, wrapPg } = rows;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && Object.getPrototypeOf(v) === Object.prototype;
const OBJ_OPTS = { virtuals: false, getters: false, minimize: false, flattenMaps: true, depopulate: true };

const tables = new Map(); // table name -> { d, ensure }, shared with the raw-collection layer
let ddlChain = Promise.resolve(); // table creation is serialised so two models on one table never race

const ensured = new Map();
/** Creates the table (and any column another model on the same table needs) once per shape. */
function ensureTable(d) {
  const key = `${d.table}|${d.columns.map((c) => c.path).join(',')}`;
  if (!ensured.has(key)) {
    const run = () => {
      const c = clientModule.current() || clientModule.connect();
      return c.transaction(async (tx) => { for (const stmt of ddl(d)) await tx.query(stmt); });
    };
    const p = (ddlChain = ddlChain.then(run, run));
    ensured.set(key, p);
    p.catch(() => ensured.delete(key));
  }
  return ensured.get(key);
}

function factory(m) {
  const { Types: { ObjectId } } = m;

  function register(name, schema, collection) {
    const Model = collection ? m.model(name, schema, collection) : m.model(name, schema);
    // two models can share one table with different columns (Driver / Drivers): they then share ONE description holding all columns
    let d = describe(Model);
    const known = tables.get(d.table);
    if (known) {
      for (const c of d.columns) if (!known.d.byPath.has(c.path)) { known.d.columns.push(c); known.d.byPath.set(c.path, c); }
      const sig = (u) => `${u.fields.join(',')}|${JSON.stringify(u.partial || null)}`;
      for (const kind of ['unique', 'plain']) for (const u of d[kind]) if (!known.d[kind].some((x) => sig(x) === sig(u))) known.d[kind].push(u);
      known.d.timestamps = known.d.timestamps || d.timestamps;
      d = known.d;
    }
    let ready = null;

    const db = () => clientModule.current() || clientModule.connect(); // connects on first use from DATABASE_URL
    const ensure = () => ensureTable(d);
    tables.set(d.table, tables.get(d.table) || { d, ensure });

    // ---- row <-> document
    const toRow = (doc) => rowFromObject(d, doc.toObject(OBJ_OPTS));
    const fromRow = (row, opts) => objectFromRow(d, row, opts);
    const columnsSql = () => columnsFor(d);
    const insertRow = (tx, doc) => insertRowSql(tx, d, toRow(doc));
    const updateRow = (tx, doc, only) => updateRowSql(tx, d, toRow(doc), doc._id, only);
    // the columns a save must write: those whose path (or a path inside them) was modified; EXTRA when an undeclared field was
    const changedColumns = (doc) => {
      const modified = doc.modifiedPaths();
      const hit = (path) => modified.some((m) => m === path || m.startsWith(`${path}.`) || path.startsWith(`${m}.`));
      const cols = d.columns.filter((c) => !c.isId && hit(c.path)).map((c) => c.path);
      const declared = (m) => d.columns.some((c) => m === c.path || m.startsWith(`${c.path}.`) || c.path.startsWith(`${m}.`));
      if (modified.some((m) => m !== '__v' && !declared(m))) cols.push(EXTRA);
      return cols;
    };

    // ---- timestamps (Mongoose applies them in its own save/update pipeline, which this layer replaces)
    const stampNew = (doc, now) => {
      // Mongoose writes the version key (0) on every insert
      const vk = schema.options.versionKey;
      if (vk !== false && doc.get(vk || '__v') === undefined) doc.set(vk || '__v', 0);
      if (!d.timestamps) return;
      if (!doc.createdAt) doc.createdAt = now;
      if (!doc.updatedAt) doc.updatedAt = now;
    };
    const stampChange = (doc, now) => { if (d.timestamps) doc.updatedAt = now; };

    // ---- documents
    Model.prototype.save = async function save() {
      await this.validate();
      await ensure();
      const now = new Date();
      if (this.isNew) {
        stampNew(this, now);
        await db().transaction((tx) => insertRow(tx, this));
        this.isNew = false;
        this.$locals.pgNulls = explicitNulls(d, this.toObject(OBJ_OPTS));
      } else {
        stampChange(this, now);
        const only = changedColumns(this);
        if (only.length) {
          // which columns are explicitly null: what was read, changed only for the columns written now
          const obj = this.toObject(OBJ_OPTS);
          const base = this.$locals.pgNulls || [];
          let nulls = base.filter((p) => !only.includes(p));
          for (const p of only) if (p !== EXTRA && getPath(obj, p) === null) nulls.push(p);
          const nullsChanged = nulls.slice().sort().join() !== base.slice().sort().join();
          await db().transaction(async (tx) => {
            if (only.includes(EXTRA)) await updateRowSql(tx, d, rowFromObject(d, obj, { nulls }), this._id, only);
            else {
              await updateRowSql(tx, d, rowFromObject(d, obj, { nulls }), this._id, only);
              if (nullsChanged) {
                // adjust only the "$nulls" entry, leaving the free-form fields as they are
                const sql = nulls.length
                  ? `UPDATE ${q(d.table)} SET ${q(EXTRA)} = jsonb_set(coalesce(${q(EXTRA)}::jsonb, '{}'::jsonb), '{${NULLS}}', $1::jsonb)::json WHERE "_id" = $2`
                  : `UPDATE ${q(d.table)} SET ${q(EXTRA)} = (coalesce(${q(EXTRA)}::jsonb, '{}'::jsonb) - '${NULLS}')::json WHERE "_id" = $1`;
                await tx.query(sql, nulls.length ? [JSON.stringify(nulls), String(this._id)] : [String(this._id)]);
              }
            }
          });
          this.$locals.pgNulls = nulls;
        }
      }
      this.$__reset();
      return this;
    };
    Model.prototype.deleteOne = function deleteOne() {
      return Model.deleteOne({ _id: this._id }).then(() => this);
    };

    // ---- projection
    const parseSelect = (spec) => {
      const include = new Set(); const exclude = new Set(); const keep = new Set();
      const words = typeof spec === 'string' ? spec.split(/\s+/).filter(Boolean) : Object.entries(spec || {}).map(([k, v]) => (v ? k : `-${k}`));
      for (const w of words) {
        if (w.startsWith('+')) keep.add(w.slice(1));
        else if (w.startsWith('-')) exclude.add(w.slice(1));
        else include.add(w);
      }
      return { include, exclude, keep };
    };
    const project = (obj, sel) => {
      if (!sel) return obj;
      if (sel.include.size) {
        const out = {};
        if (!sel.exclude.has('_id') && obj._id !== undefined) out._id = obj._id;
        for (const p of sel.include) { const v = getPath(obj, p); if (v !== undefined) setPath(out, p, v); }
        return out;
      }
      for (const p of sel.exclude) deletePath(obj, p);
      return obj;
    };

    // ---- sort
    const orderBy = (sort) => {
      let pairs = [];
      if (typeof sort === 'string') pairs = sort.split(/\s+/).filter(Boolean).map((s) => (s.startsWith('-') ? [s.slice(1), -1] : [s, 1]));
      else if (sort instanceof Map) pairs = [...sort.entries()];
      else if (sort) pairs = Object.entries(sort);
      const parts = pairs.map(([p, dir]) => {
        const asc = dir === 1 || dir === 'asc' || dir === 'ascending';
        return `${locate(d, p).expr} ${asc ? 'ASC NULLS FIRST' : 'DESC NULLS LAST'}`;
      });
      parts.push('"_id" ASC'); // insertion order (an ObjectId rises over time), like a Mongo natural order
      return ` ORDER BY ${parts.join(', ')}`;
    };

    // the document as stored: Mongoose fills in defaults for fields an older document lacks, but an update stores (and a lean
    // result returns) only what the update itself changed
    const withoutDefaults = (doc, touched) => {
      const obj = doc.toObject(OBJ_OPTS);
      const named = (p) => [...touched].some((t) => t === p || t.startsWith(`${p}.`) || p.startsWith(`${t}.`));
      for (const c of d.columns) if (!c.isId && doc.$isDefault(c.path) && !named(c.path)) deletePath(obj, c.path);
      return obj;
    };

    // ---- read-modify-write under a row lock
    function applyUpdate(doc, update, { inserting, now }) {
      const ops = {};
      for (const [k, v] of Object.entries(update || {})) {
        if (k.startsWith('$')) ops[k] = { ...(ops[k] || {}), ...v };
        else ops.$set = { ...(ops.$set || {}), [k]: v };
      }
      for (const k of Object.keys(ops)) {
        if (!['$set', '$setOnInsert', '$inc', '$push'].includes(k)) throw new Error(`Postgres engine: update operator ${k} is not supported`);
      }
      if (inserting && ops.$setOnInsert) for (const [p, v] of Object.entries(ops.$setOnInsert)) doc.set(p, v);
      if (ops.$set) for (const [p, v] of Object.entries(ops.$set)) doc.set(p, v);
      if (ops.$inc) for (const [p, v] of Object.entries(ops.$inc)) doc.set(p, (Number(doc.get(p)) || 0) + Number(v));
      if (ops.$push) {
        for (const [p, v] of Object.entries(ops.$push)) {
          const items = isPlain(v) && Array.isArray(v.$each) ? v.$each : [v];
          const current = (doc.get(p) || []).map((x) => (x && typeof x.toObject === 'function' ? x.toObject() : x));
          doc.set(p, [...current, ...items]);
        }
      }
      if (inserting) stampNew(doc, now);
      else if (!(ops.$set && 'updatedAt' in ops.$set)) stampChange(doc, now);
      // the paths the update named (a value equal to its default must still be stored)
      return new Set(['$set', '$setOnInsert', '$inc', '$push'].flatMap((k) => Object.keys(ops[k] || {})).concat(d.timestamps ? ['updatedAt', 'createdAt'] : []));
    }

    const isOperatorValue = (v) => v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && !v._bsontype;

    async function modify(filter, update, { limit, upsert, sort, runValidators }) {
      await ensure();
      const run = () => db().transaction(async (tx) => {
        const w = build(d, Model, filter || {});
        const params = [...w.params];
        let sql = `SELECT ${columnsSql()} FROM ${q(d.table)} WHERE ${w.sql}${orderBy(sort)}`;
        if (limit) { params.push(limit); sql += ` LIMIT $${params.length}`; }
        sql += ' FOR UPDATE';
        const { rows } = await tx.query(sql, params);
        const now = new Date();
        const items = [];
        for (const row of rows) {
          const before = fromRow(row, { all: true });
          const doc = Model.hydrate(fromRow(row, { all: true }));
          const beforeRow = JSON.stringify(toRow(doc));
          const touched = applyUpdate(doc, update, { inserting: false, now });
          if (runValidators) await doc.validate({ validateModifiedOnly: true });
          const after = withoutDefaults(doc, touched);
          await updateRowSql(tx, d, rowFromObject(d, after), doc._id);
          items.push({ before, after, changed: d.timestamps || JSON.stringify(toRow(doc)) !== beforeRow });
        }
        if (!rows.length && upsert) {
          const base = {};
          for (const [k, v] of Object.entries(filter || {})) if (!k.startsWith('$') && !isOperatorValue(v)) setPath(base, k, v);
          const doc = new Model(base);
          applyUpdate(doc, update, { inserting: true, now });
          if (runValidators) await doc.validate();
          await insertRow(tx, doc);
          items.push({ upserted: true, before: null, after: doc.toObject(OBJ_OPTS), changed: true });
        }
        return { items };
      });
      try { return await run(); } catch (e) {
        // two upserts racing on the same key: the loser retries once and then finds the row the winner inserted
        if (upsert && e && e.code === 11000) return run();
        throw e;
      }
    }

    // ---- queries
    class Query {
      constructor(op, args) { this.op = op; this.args = args; this.opts = {}; this._lean = false; }
      sort(s) { this.opts.sort = s; return this; }
      skip(n) { this.opts.skip = n; return this; }
      limit(n) { this.opts.limit = n; return this; }
      select(s) {
        const words = typeof s === 'string' ? s : Object.entries(s).map(([k, v]) => (v ? k : `-${k}`)).join(' ');
        this.opts.selectSpec = this.opts.selectSpec ? `${this.opts.selectSpec} ${words}` : words;
        return this;
      }
      lean() { this._lean = true; return this; }
      setOptions(o) { Object.assign(this.opts, o || {}); return this; }
      exec() { return this._run(); }
      then(a, b) { return this._run().then(a, b); }
      catch(b) { return this._run().catch(b); }
      finally(f) { return this._run().finally(f); }

      async _run() {
        await ensure();
        const [filter] = this.args;
        const sel = this.opts.selectSpec ? parseSelect(this.opts.selectSpec) : null;
        const keep = sel ? sel.keep : new Set();
        const view = sel && { include: sel.include, exclude: sel.exclude };
        // the projection Mongoose would have used, so an unselected (select:false) path is neither validated nor written by save()
        const projection = {};
        if (sel && sel.include.size) for (const p of sel.include) projection[p] = 1;
        else {
          for (const c of d.columns) if (c.selectFalse && !keep.has(c.path)) projection[c.path] = 0;
          if (sel) for (const p of sel.exclude) projection[p] = 0;
        }
        const hasProjection = Object.keys(projection).length > 0;
        const finish = (obj) => {
          const nulls = obj.__nulls;
          const out = project(obj, view);
          if (this._lean) return out;
          const doc = Model.hydrate(out, hasProjection ? projection : undefined);
          doc.$locals.pgNulls = nulls || [];
          return doc;
        };
        const fromTableRow = (row) => finish(fromRow(row, { keep }));
        // an already built object (the result of an update): hide select:false fields unless asked for
        const fromObject = (obj) => {
          const copy = { ...obj };
          for (const c of d.columns) if (c.selectFalse && !keep.has(c.path)) deletePath(copy, c.path);
          return finish(copy);
        };

        if (this.op === 'find' || this.op === 'findOne') {
          const w = build(d, Model, filter || {});
          const limit = this.op === 'findOne' ? 1 : this.opts.limit;
          let sql = `SELECT ${columnsSql()} FROM ${q(d.table)} WHERE ${w.sql}${orderBy(this.opts.sort)}`;
          const params = [...w.params];
          if (limit) { params.push(Number(limit)); sql += ` LIMIT $${params.length}`; }
          if (this.opts.skip) { params.push(Number(this.opts.skip)); sql += ` OFFSET $${params.length}`; }
          const { rows } = await db().query(sql, params);
          const docs = rows.map(fromTableRow);
          return this.op === 'findOne' ? (docs[0] || null) : docs;
        }
        if (this.op === 'countDocuments') {
          const w = build(d, Model, filter || {});
          const { rows } = await db().query(`SELECT count(*)::int AS n FROM ${q(d.table)} WHERE ${w.sql}`, w.params);
          return rows[0].n;
        }
        if (this.op === 'exists') {
          const w = build(d, Model, filter || {});
          const { rows } = await db().query(`SELECT "_id" FROM ${q(d.table)} WHERE ${w.sql} LIMIT 1`, w.params);
          return rows[0] ? { _id: new ObjectId(rows[0]._id) } : null;
        }
        if (this.op === 'findOneAndUpdate') {
          const [f, update, options = {}] = this.args;
          const res = await modify(f, update, { limit: 1, upsert: !!options.upsert, sort: this.opts.sort || options.sort, runValidators: !!options.runValidators });
          const hit = res.items[0];
          if (!hit) return null;
          const wantNew = options.new === true || options.returnDocument === 'after';
          return fromObject(wantNew ? hit.after : hit.before);
        }
        if (this.op === 'updateOne' || this.op === 'updateMany') {
          const [f, update, options = {}] = this.args;
          const res = await modify(f, update, { limit: this.op === 'updateOne' ? 1 : 0, upsert: !!options.upsert, runValidators: !!options.runValidators });
          const matched = res.items.filter((i) => !i.upserted);
          const upserted = res.items.find((i) => i.upserted);
          return {
            acknowledged: true,
            matchedCount: matched.length,
            modifiedCount: matched.filter((i) => i.changed).length,
            upsertedCount: upserted ? 1 : 0,
            upsertedId: upserted ? upserted.after._id : null
          };
        }
        if (this.op === 'deleteOne' || this.op === 'deleteMany') {
          const w = build(d, Model, filter || {});
          const sql = this.op === 'deleteOne'
            ? `DELETE FROM ${q(d.table)} WHERE "_id" = (SELECT "_id" FROM ${q(d.table)} WHERE ${w.sql} ORDER BY "_id" LIMIT 1)`
            : `DELETE FROM ${q(d.table)} WHERE ${w.sql}`;
          const r = await db().query(sql, w.params);
          return { acknowledged: true, deletedCount: r.rowCount };
        }
        if (this.op === 'findOneAndDelete') {
          const w = build(d, Model, filter || {});
          const sql = `DELETE FROM ${q(d.table)} WHERE "_id" = (SELECT "_id" FROM ${q(d.table)} WHERE ${w.sql} ORDER BY "_id" LIMIT 1) RETURNING ${columnsSql()}`;
          const r = await db().query(sql, w.params);
          return r.rows[0] ? fromTableRow(r.rows[0]) : null;
        }
        throw new Error(`Postgres engine: query ${this.op} is not supported`);
      }
    }

    Model.find = (filter) => new Query('find', [filter]);
    Model.findOne = (filter) => new Query('findOne', [filter]);
    Model.findById = (id) => new Query('findOne', [{ _id: id }]);
    Model.countDocuments = (filter) => new Query('countDocuments', [filter]);
    Model.exists = (filter) => new Query('exists', [filter]);
    Model.findOneAndUpdate = (filter, update, options) => new Query('findOneAndUpdate', [filter, update, options]);
    Model.findByIdAndUpdate = (id, update, options) => new Query('findOneAndUpdate', [{ _id: id }, update, options]);
    Model.updateOne = (filter, update, options) => new Query('updateOne', [filter, update, options]);
    Model.updateMany = (filter, update, options) => new Query('updateMany', [filter, update, options]);
    Model.deleteOne = (filter) => new Query('deleteOne', [filter]);
    Model.deleteMany = (filter) => new Query('deleteMany', [filter]);
    Model.findOneAndDelete = (filter) => new Query('findOneAndDelete', [filter]);
    Model.findByIdAndDelete = (id) => new Query('findOneAndDelete', [{ _id: id }]);
    Model.aggregate = (pipeline) => require('./plain').collection(d.table).aggregate(pipeline);
    Model.create = async (docs, opts) => {
      const list = Array.isArray(docs) ? docs : [docs];
      const out = [];
      for (const x of list) { const doc = new Model(x); await doc.save(opts); out.push(doc); }
      return Array.isArray(docs) ? out : out[0];
    };

    return { Model, d, ensure, toRow, fromRow, db };
  }

  return { register };
}

module.exports = { factory, tables, ensureTable, isPlain };
