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
const { describe, ddl, q, uniqueKeyPatterns, EXTRA } = require('./table');
const { build, locate } = require('./filter');

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
const setPath = (obj, path, value) => {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (o[parts[i]] === null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
};
const deletePath = (obj, path) => {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1 && o; i += 1) o = o[parts[i]];
  if (o) delete o[parts[parts.length - 1]];
};
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && Object.getPrototypeOf(v) === Object.prototype;
const jsonText = (v) => JSON.stringify(v, (k, x) => (x && x._bsontype === 'ObjectId' ? String(x) : x));
const OBJ_OPTS = { virtuals: false, getters: false, minimize: false, flattenMaps: true, depopulate: true };

let ddlChain = Promise.resolve(); // table creation is serialised so two models on one table never race

function factory(m) {
  const { Types: { ObjectId } } = m;

  function register(name, schema, collection) {
    const Model = collection ? m.model(name, schema, collection) : m.model(name, schema);
    const d = describe(Model);
    const patterns = uniqueKeyPatterns(d);
    let ready = null;

    const db = () => {
      const c = clientModule.current();
      if (!c) throw new Error('Postgres is not connected (call connect first).');
      return c;
    };
    const ensure = () => {
      if (!ready) {
        ready = (ddlChain = ddlChain.then(() => db().transaction(async (tx) => { for (const s of ddl(d)) await tx.query(s); })));
        ready.catch(() => { ready = null; });
      }
      return ready;
    };

    // ---- row <-> document
    const toRow = (doc) => {
      const obj = doc.toObject(OBJ_OPTS);
      const row = {};
      const covered = new Set(['__v']);
      for (const c of d.columns) {
        covered.add(c.path.split('.')[0]);
        let v = getPath(obj, c.path);
        if (v === undefined || v === null) { row[c.path] = null; continue; }
        if (c.type === 'jsonb') v = jsonText(v);
        else if (c.instance === 'ObjectId') v = String(v);
        row[c.path] = v;
      }
      const extra = {};
      for (const k of Object.keys(obj)) if (!covered.has(k)) extra[k] = obj[k];
      row[EXTRA] = Object.keys(extra).length ? jsonText(extra) : null;
      row.__v = typeof obj.__v === 'number' ? obj.__v : 0;
      return row;
    };

    // `all` includes select:false fields (needed when a row is read in order to be written back whole)
    const fromRow = (row, { keep = new Set(), all = false } = {}) => {
      const out = {};
      for (const c of d.columns) {
        let v = row[c.path];
        if (v === null || v === undefined) { if (c.nullDefault) setPath(out, c.path, null); continue; }
        if (c.selectFalse && !all && !keep.has(c.path)) continue;
        if (c.isId || c.instance === 'ObjectId') v = new ObjectId(v);
        setPath(out, c.path, v);
      }
      if (row[EXTRA]) Object.assign(out, typeof row[EXTRA] === 'string' ? JSON.parse(row[EXTRA]) : row[EXTRA]);
      out.__v = row.__v;
      return out;
    };

    const columnsSql = () => d.columns.map((c) => q(c.path)).concat(['"__v"', q(EXTRA)]).join(', ');
    const placeholder = (c, i) => (c.type === 'jsonb' ? `$${i}::jsonb` : `$${i}`);

    const dupError = (e) => {
      const detail = String(e.detail || '');
      const match = /Key \((.+)\)=\((.*)\) already exists/.exec(detail);
      const keyPattern = patterns.get(e.constraint) || (match ? Object.fromEntries(match[1].split(', ').map((f) => [f.replace(/"/g, ''), 1])) : {});
      const keyValue = match ? Object.fromEntries(match[1].split(', ').map((f, i) => [f.replace(/"/g, ''), match[2].split(', ')[i]])) : {};
      const err = new Error(`E11000 duplicate key error collection: ${d.table} index: ${e.constraint} dup key: ${JSON.stringify(keyValue)}`);
      err.name = 'MongoServerError';
      err.code = 11000;
      err.keyPattern = keyPattern;
      err.keyValue = keyValue;
      return err;
    };
    const wrapPg = (e) => (e && e.code === '23505' ? dupError(e) : e);

    async function insertRow(tx, doc) {
      const row = toRow(doc);
      const cols = d.columns.map((c) => c.path).concat(['__v', EXTRA]);
      const meta = [...d.columns, { type: 'integer' }, { type: 'jsonb' }];
      const sql = `INSERT INTO ${q(d.table)} (${cols.map(q).join(', ')}) VALUES (${cols.map((c, i) => placeholder(meta[i], i + 1)).join(', ')})`;
      try { await tx.query(sql, cols.map((c) => row[c])); } catch (e) { throw wrapPg(e); }
    }
    async function updateRow(tx, doc) {
      const row = toRow(doc);
      const body = d.columns.filter((c) => !c.isId);
      const cols = body.map((c) => c.path).concat(['__v', EXTRA]);
      const meta = [...body, { type: 'integer' }, { type: 'jsonb' }];
      const sql = `UPDATE ${q(d.table)} SET ${cols.map((c, i) => `${q(c)} = ${placeholder(meta[i], i + 1)}`).join(', ')} WHERE "_id" = $${cols.length + 1}`;
      try { await tx.query(sql, [...cols.map((c) => row[c]), String(doc._id)]); } catch (e) { throw wrapPg(e); }
    }

    // ---- timestamps (Mongoose applies them in its own save/update pipeline, which this layer replaces)
    const stampNew = (doc, now) => {
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
      } else {
        stampChange(this, now);
        await db().transaction((tx) => updateRow(tx, this));
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
          applyUpdate(doc, update, { inserting: false, now });
          if (runValidators) await doc.validate({ validateModifiedOnly: true });
          await updateRow(tx, doc);
          items.push({ before, after: doc.toObject(OBJ_OPTS), changed: d.timestamps || JSON.stringify(toRow(doc)) !== beforeRow });
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
        const finish = (obj) => { const out = project(obj, view); return this._lean ? out : Model.hydrate(out); };
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

module.exports = { factory, getPath, setPath, isPlain };
