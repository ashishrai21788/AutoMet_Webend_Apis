/**
 * Shared row mapping used by the model layer (Mongoose documents) and the raw-collection layer (plain objects):
 * object <-> table row, and the INSERT / UPDATE statements.
 */
const { q, uniqueKeyPatterns, EXTRA } = require('./table');
const { encode, decode, dump } = require('./codec');
const { Types: { ObjectId } } = require('mongoose');

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
// values inside a typed jsonb column (a Mongoose Mixed / array / sub-document path): Mongoose casts them again when read
const jsonText = (v) => JSON.stringify(v, (k, x) => (x && x._bsontype === 'ObjectId' ? String(x) : x));

/** A plain object (a Mongoose toObject(), or a document written through the raw driver) as a row. */
function rowFromObject(d, obj) {
  const row = {};
  const covered = new Set(['__v', '_id']);
  for (const c of d.columns) {
    covered.add(c.path.split('.')[0]);
    let v = getPath(obj, c.path);
    if (v === undefined || v === null) { row[c.path] = null; continue; }
    if (c.type === 'json') v = jsonText(v);
    else if (c.instance === 'ObjectId' || (c.isId && c.type === 'text')) v = String(v);
    row[c.path] = v;
  }
  const extra = {};
  for (const k of Object.keys(obj)) if (!covered.has(k)) extra[k] = obj[k];
  row[EXTRA] = Object.keys(extra).length ? dump(extra) : null;
  row.__v = typeof obj.__v === 'number' ? obj.__v : null; // absent stays absent (a document written through the raw driver has no __v)
  return row;
}

/** A row as a plain object. `all` includes select:false fields; `keep` names the ones asked for with "+field". */
function objectFromRow(d, row, { keep = new Set(), all = false } = {}) {
  const out = {};
  for (const c of d.columns) {
    let v = row[c.path];
    if (v === null || v === undefined) { if (c.nullDefault) setPath(out, c.path, null); continue; }
    if (c.selectFalse && !all && !keep.has(c.path)) continue;
    if (c.instance === 'ObjectId') v = new ObjectId(v); // a custom string _id (a counter's key) stays a string
    setPath(out, c.path, v);
  }
  if (row[EXTRA]) Object.assign(out, decode(typeof row[EXTRA] === 'string' ? JSON.parse(row[EXTRA]) : row[EXTRA]));
  if (row.__v !== null && row.__v !== undefined) out.__v = row.__v;
  return out;
}

const columnsSql = (d) => d.columns.map((c) => q(c.path)).concat(['"__v"', q(EXTRA)]).join(', ');
const placeholder = (c, i) => (c.type === 'json' ? `$${i}::json` : `$${i}`);

function dupError(d, e) {
  const detail = String(e.detail || '');
  const match = /Key \((.+)\)=\((.*)\) already exists/.exec(detail);
  const patterns = uniqueKeyPatterns(d);
  const keyPattern = patterns.get(e.constraint) || (match ? Object.fromEntries(match[1].split(', ').map((f) => [f.replace(/"/g, ''), 1])) : {});
  const keyValue = match ? Object.fromEntries(match[1].split(', ').map((f, i) => [f.replace(/"/g, ''), match[2].split(', ')[i]])) : {};
  const err = new Error(`E11000 duplicate key error collection: ${d.table} index: ${e.constraint} dup key: ${JSON.stringify(keyValue)}`);
  err.name = 'MongoServerError';
  err.code = 11000;
  err.keyPattern = keyPattern;
  err.keyValue = keyValue;
  return err;
}
const wrapPg = (d, e) => (e && e.code === '23505' ? dupError(d, e) : e);

async function insertRow(tx, d, row) {
  const cols = d.columns.map((c) => c.path).concat(['__v', EXTRA]);
  const meta = [...d.columns, { type: 'integer' }, { type: 'json' }];
  const sql = `INSERT INTO ${q(d.table)} (${cols.map(q).join(', ')}) VALUES (${cols.map((c, i) => placeholder(meta[i], i + 1)).join(', ')})`;
  try { await tx.query(sql, cols.map((c) => row[c])); } catch (e) { throw wrapPg(d, e); }
}

/** Writes a row back. `only` (column paths, optionally EXTRA) limits it to those columns, like Mongoose saving modified paths. */
async function updateRow(tx, d, row, id, only) {
  const body = d.columns.filter((c) => !c.isId && (!only || only.includes(c.path)));
  const withExtra = !only || only.includes(EXTRA);
  const cols = body.map((c) => c.path).concat(only ? [] : ['__v']).concat(withExtra ? [EXTRA] : []);
  const meta = [...body, ...(only ? [] : [{ type: 'integer' }]), ...(withExtra ? [{ type: 'json' }] : [])];
  if (!cols.length) return;
  const sql = `UPDATE ${q(d.table)} SET ${cols.map((c, i) => `${q(c)} = ${placeholder(meta[i], i + 1)}`).join(', ')} WHERE "_id" = $${cols.length + 1}`;
  try { await tx.query(sql, [...cols.map((c) => row[c]), String(id)]); } catch (e) { throw wrapPg(d, e); }
}

module.exports = { getPath, setPath, deletePath, jsonText, rowFromObject, objectFromRow, columnsSql, insertRow, updateRow, wrapPg, encode, decode };
