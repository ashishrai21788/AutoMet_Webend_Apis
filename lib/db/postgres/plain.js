/**
 * The raw-collection interface (what `mongoose.connection.db.collection(name)` returns on Mongo), over Postgres:
 * find / findOne / insertOne / updateOne / updateMany / deleteOne / deleteMany / countDocuments / aggregate.
 *
 * A collection that has a model uses that model's table (so the model layer and raw access see the same rows); any other
 * collection gets a free-form table: `_id` plus one jsonb column holding the whole document.
 */
const clientModule = require('./client');
const { tables, ensureTable } = require('./model');
const { build, locate } = require('./filter');
const { q } = require('./table');
const { rowFromObject, objectFromRow, columnsSql, insertRow, updateRow, getPath, setPath, deletePath } = require('./rows');
const { run: runPipeline } = require('./aggregate');
const { Types: { ObjectId } } = require('mongoose');

const generic = (name) => {
  const id = { path: '_id', type: 'text', instance: 'ObjectId', selectFalse: false, nullDefault: false, isId: true };
  return { table: name, columns: [id], byPath: new Map([['_id', id]]), timestamps: false, strictFalse: true, unique: [], plain: [], extra: '__extra' };
};

const projectionOf = (spec) => {
  if (!spec) return null;
  const include = Object.entries(spec).filter(([k, v]) => v && k !== '_id').map(([k]) => k);
  const noId = spec._id === 0 || spec._id === false;
  const exclude = Object.entries(spec).filter(([, v]) => !v).map(([k]) => k);
  return { include, exclude, noId };
};
const applyProjection = (obj, pr) => {
  if (!pr) return obj;
  if (pr.include.length) {
    const out = {};
    if (!pr.noId && obj._id !== undefined) out._id = obj._id;
    for (const p of pr.include) { const v = getPath(obj, p); if (v !== undefined) setPath(out, p, v); }
    return out;
  }
  for (const p of pr.exclude) deletePath(obj, p);
  return obj;
};

function collection(name) {
  const entry = () => {
    let t = tables.get(name);
    if (!t) { t = { d: generic(name) }; tables.set(name, t); }
    return t;
  };
  const d = () => entry().d;
  const ready = () => ensureTable(d());
  const db = () => clientModule.current() || clientModule.connect();
  const where = (filter) => build(d(), null, filter || {});
  const order = (sort) => {
    const pairs = sort ? Object.entries(sort) : [];
    const parts = pairs.map(([p, dir]) => `${locate(d(), p).expr} ${dir === -1 || dir === 'desc' ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`);
    parts.push('"_id" ASC');
    return ` ORDER BY ${parts.join(', ')}`;
  };

  async function select(filter, { sort, skip, limit, projection } = {}) {
    await ready();
    const w = where(filter);
    const params = [...w.params];
    let sql = `SELECT ${columnsSql(d())} FROM ${q(d().table)} WHERE ${w.sql}${order(sort)}`;
    if (limit) { params.push(Number(limit)); sql += ` LIMIT $${params.length}`; }
    if (skip) { params.push(Number(skip)); sql += ` OFFSET $${params.length}`; }
    const { rows } = await db().query(sql, params);
    const pr = projectionOf(projection);
    return rows.map((r) => applyProjection(objectFromRow(d(), r, { all: true }), pr));
  }

  function cursor(filter, options = {}) {
    const state = { ...options };
    const c = {
      sort(s) { state.sort = s; return c; },
      skip(n) { state.skip = n; return c; },
      limit(n) { state.limit = n; return c; },
      project(p) { state.projection = p; return c; },
      toArray: () => select(filter, state),
      next: async () => (await select(filter, { ...state, limit: 1 }))[0] || null,
      then(a, b) { return c.toArray().then(a, b); }
    };
    return c;
  }

  function applyOps(obj, update, inserting) {
    const ops = {};
    for (const [k, v] of Object.entries(update || {})) {
      if (k.startsWith('$')) ops[k] = { ...(ops[k] || {}), ...v };
      else throw new Error('Postgres engine: a raw update needs update operators');
    }
    for (const k of Object.keys(ops)) {
      if (!['$set', '$setOnInsert', '$inc', '$unset', '$push'].includes(k)) throw new Error(`Postgres engine: update operator ${k} is not supported`);
    }
    if (inserting && ops.$setOnInsert) for (const [p, v] of Object.entries(ops.$setOnInsert)) setPath(obj, p, v);
    if (ops.$set) for (const [p, v] of Object.entries(ops.$set)) setPath(obj, p, v);
    if (ops.$inc) for (const [p, v] of Object.entries(ops.$inc)) setPath(obj, p, (Number(getPath(obj, p)) || 0) + Number(v));
    if (ops.$unset) for (const p of Object.keys(ops.$unset)) deletePath(obj, p);
    if (ops.$push) {
      for (const [p, v] of Object.entries(ops.$push)) {
        const items = v && typeof v === 'object' && Array.isArray(v.$each) ? v.$each : [v];
        setPath(obj, p, [...(getPath(obj, p) || []), ...items]);
      }
    }
  }

  async function update(filter, upd, { many, upsert } = {}) {
    await ready();
    return db().transaction(async (tx) => {
      const w = where(filter);
      const { rows } = await tx.query(`SELECT ${columnsSql(d())} FROM ${q(d().table)} WHERE ${w.sql}${order()}${many ? '' : ' LIMIT 1'} FOR UPDATE`, w.params);
      for (const row of rows) {
        const obj = objectFromRow(d(), row, { all: true });
        applyOps(obj, upd, false);
        await updateRow(tx, d(), rowFromObject(d(), obj), row._id);
      }
      if (!rows.length && upsert) {
        const obj = {};
        for (const [k, v] of Object.entries(filter || {})) if (!k.startsWith('$') && (v === null || typeof v !== 'object' || v instanceof Date || v._bsontype)) setPath(obj, k, v);
        applyOps(obj, upd, true);
        const id = obj._id ? (/^[0-9a-f]{24}$/i.test(String(obj._id)) ? new ObjectId(String(obj._id)) : obj._id) : new ObjectId();
        obj._id = id;
        await insertRow(tx, d(), rowFromObject(d(), obj));
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: id };
      }
      return { acknowledged: true, matchedCount: rows.length, modifiedCount: rows.length, upsertedCount: 0, upsertedId: null };
    });
  }

  return {
    find: (filter, options) => cursor(filter, options),
    findOne: async (filter, options) => (await select(filter, { ...options, limit: 1 }))[0] || null,
    async insertOne(doc) {
      await ready();
      const id = doc._id ? (/^[0-9a-f]{24}$/i.test(String(doc._id)) ? new ObjectId(String(doc._id)) : doc._id) : new ObjectId(); // a string _id is allowed
      doc._id = id; // the Mongo driver sets the generated _id on the document it was given
      await insertRow(db(), d(), rowFromObject(d(), { ...doc, _id: id }));
      return { acknowledged: true, insertedId: id };
    },
    async insertMany(docs) {
      const insertedIds = {};
      for (let i = 0; i < docs.length; i += 1) insertedIds[i] = (await this.insertOne(docs[i])).insertedId;
      return { acknowledged: true, insertedCount: docs.length, insertedIds };
    },
    updateOne: (filter, upd, options) => update(filter, upd, { ...options, many: false }),
    updateMany: (filter, upd, options) => update(filter, upd, { ...options, many: true }),
    async deleteOne(filter) {
      await ready();
      const w = where(filter);
      const r = await db().query(`DELETE FROM ${q(d().table)} WHERE "_id" = (SELECT "_id" FROM ${q(d().table)} WHERE ${w.sql} ORDER BY "_id" LIMIT 1)`, w.params);
      return { acknowledged: true, deletedCount: r.rowCount };
    },
    async deleteMany(filter) {
      await ready();
      const w = where(filter);
      const r = await db().query(`DELETE FROM ${q(d().table)} WHERE ${w.sql}`, w.params);
      return { acknowledged: true, deletedCount: r.rowCount };
    },
    async countDocuments(filter) {
      await ready();
      const w = where(filter);
      const { rows } = await db().query(`SELECT count(*)::int AS n FROM ${q(d().table)} WHERE ${w.sql}`, w.params);
      return rows[0].n;
    },
    // a leading $match runs in SQL; the other stages run on the rows it returns (see aggregate.js)
    aggregate(pipeline) {
      const stages = [...pipeline];
      const first = stages[0] && stages[0].$match ? stages.shift().$match : {};
      const exec = async () => runPipeline(await select(first), stages);
      return { toArray: exec, exec, then: (a, b) => exec().then(a, b) };
    }
  };
}

module.exports = { collection };
