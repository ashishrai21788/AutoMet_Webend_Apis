/**
 * Mongo-style filter -> SQL WHERE, for the operators the backend actually uses. Anything else raises an error instead of
 * silently matching the wrong rows:
 *
 *   equality (including null and "array contains"), $in $nin $ne $gt $gte $lt $lte $exists $regex/$options $not $or $and $nor.
 *
 * Values are cast with the Mongoose schema type of the path (exactly as Mongoose casts a query), then bound as parameters.
 */
const { q, EXTRA } = require('./table');

const CASTABLE = new Set(['String', 'Number', 'Boolean', 'Date', 'ObjectId']);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp) && Object.getPrototypeOf(v) === Object.prototype;
const isOperatorObject = (v) => isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));
const jsonText = (v) => JSON.stringify(v, (k, x) => (x instanceof Date ? x.toISOString() : x && x._bsontype === 'ObjectId' ? String(x) : x));

/** How a path is stored: a real column, a key inside a json column, or a key inside the "extra" column. */
function locate(d, path) {
  if (d.byPath.has(path)) { const col = d.byPath.get(path); return { kind: 'column', col, expr: col.type === 'json' ? `(${q(path)}::jsonb)` : q(path) }; }
  const parts = path.split('.');
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const head = parts.slice(0, i).join('.');
    const c = d.byPath.get(head);
    if (c && c.type === 'json') return { kind: 'json', col: c, expr: `(${q(head)}::jsonb #> '{${parts.slice(i).map((p) => `"${p.replace(/"/g, '')}"`).join(',')}}')` };
  }
  return { kind: 'json', col: null, expr: `(${q(d.extra || EXTRA)}::jsonb #> '{${parts.map((p) => `"${p.replace(/"/g, '')}"`).join(',')}}')` };
}

function build(d, Model, filter, startAt = 1) {
  const params = [];
  const bind = (v) => { params.push(v); return `$${startAt + params.length - 1}`; };

  const castFor = (loc, v, path) => {
    if (v === null || v === undefined) return null;
    if (loc.kind !== 'column') return v;
    const inst = loc.col.instance;
    if (!CASTABLE.has(inst)) return v;
    if (path === '_id' || inst === 'ObjectId') return String(v);
    if (!Model) return v; // raw-collection access: no schema to cast with, the value is used as given
    const st = Model.schema.path(path);
    if (!st) return v; // a column another model on this table declared
    try { return st.cast(v); } catch (e) { throw Object.assign(new Error(`Cast to ${inst} failed for value ${JSON.stringify(v)} at path "${path}"`), { name: 'CastError' }); }
  };
  // a bound value as it must appear next to the expression
  const val = (loc, v) => (loc.kind === 'column' && loc.col.type !== 'json' ? bind(v instanceof Date ? v : v) : `${bind(jsonText(v))}::jsonb`);

  // a Date inside a free-form document is stored as { $date: ISO }: compare its ISO string
  const asDate = (loc, v) => (v instanceof Date && loc.kind === 'json' ? { loc: { ...loc, expr: `(${loc.expr} -> '$date')` }, v: v.toISOString() } : { loc, v });

  function equal(loc, v, path) {
    ({ loc, v } = asDate(loc, v));
    if (v === null || v === undefined) return loc.kind === 'column' ? `${loc.expr} IS NULL` : `(${loc.expr} IS NULL OR ${loc.expr} = 'null'::jsonb)`;
    if (v instanceof RegExp) return regex(loc, { $regex: v.source, $options: v.flags });
    const c = castFor(loc, v, path);
    if (loc.kind === 'column' && loc.col.type !== 'json') return `${loc.expr} = ${val(loc, c)}`;
    // jsonb: equal to the value, or (for a scalar) an array that contains it
    return Array.isArray(c) ? `${loc.expr} = ${val(loc, c)}` : `(${loc.expr} = ${val(loc, c)} OR ${loc.expr} @> ${bind(jsonText([c]))}::jsonb)`;
  }

  function regex(loc, spec) {
    const src = spec.$regex instanceof RegExp ? spec.$regex.source : String(spec.$regex);
    const flags = spec.$options || (spec.$regex instanceof RegExp ? spec.$regex.flags : '');
    const op = flags.includes('i') ? '~*' : '~';
    const target = loc.kind === 'column' && loc.col.type === 'text' ? loc.expr : `(${loc.expr} #>> '{}')`;
    return `${target} ${op} ${bind(src)}`;
  }

  function operators(loc, ops, path) {
    const out = [];
    for (const [op, raw] of Object.entries(ops)) {
      if (op === '$options') continue;
      switch (op) {
        case '$eq': out.push(equal(loc, raw, path)); break;
        case '$ne':
          if (raw === null) out.push(loc.kind === 'column' ? `${loc.expr} IS NOT NULL` : `(${loc.expr} IS NOT NULL AND ${loc.expr} <> 'null'::jsonb)`);
          else out.push(`NOT COALESCE(${equal(loc, raw, path)}, false)`);
          break;
        case '$in': case '$nin': {
          if (!Array.isArray(raw)) throw new Error(`${op} needs an array`);
          const hasNull = raw.some((x) => x === null || x === undefined);
          const rest = raw.filter((x) => x !== null && x !== undefined);
          const parts = rest.map((x) => equal(loc, x, path));
          if (hasNull) parts.push(equal(loc, null, path));
          const any = parts.length ? `(${parts.join(' OR ')})` : 'false';
          out.push(op === '$in' ? any : `NOT COALESCE(${any}, false)`);
          break;
        }
        case '$gt': case '$gte': case '$lt': case '$lte': {
          const sym = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[op];
          const t = asDate(loc, raw);
          const c = castFor(t.loc, t.v, path);
          out.push(`${t.loc.expr} ${sym} ${val(t.loc, c)}`);
          break;
        }
        case '$exists': out.push(raw ? `${loc.expr} IS NOT NULL` : `${loc.expr} IS NULL`); break;
        case '$regex': out.push(regex(loc, { $regex: raw, $options: ops.$options })); break;
        case '$not': out.push(`NOT COALESCE((${operators(loc, isOperatorObject(raw) ? raw : { $eq: raw }, path)}), false)`); break;
        default: throw new Error(`Postgres engine: query operator ${op} is not supported (path "${path}")`);
      }
    }
    return out.length ? out.join(' AND ') : 'true';
  }

  function walk(f) {
    if (!f || Object.keys(f).length === 0) return 'true';
    const parts = [];
    for (const [key, value] of Object.entries(f)) {
      if (key === '$or' || key === '$and' || key === '$nor') {
        if (!Array.isArray(value)) throw new Error(`${key} needs an array`);
        const subs = value.map((x) => `(${walk(x)})`);
        if (!subs.length) { parts.push(key === '$or' ? 'false' : 'true'); continue; }
        parts.push(key === '$or' ? `(${subs.join(' OR ')})` : key === '$and' ? `(${subs.join(' AND ')})` : `NOT (${subs.join(' OR ')})`);
      } else if (key.startsWith('$')) {
        throw new Error(`Postgres engine: query operator ${key} is not supported`);
      } else {
        const loc = locate(d, key);
        parts.push(isOperatorObject(value) ? `(${operators(loc, value, key)})` : `(${equal(loc, value, key)})`);
      }
    }
    return parts.join(' AND ');
  }

  const sql = walk(filter);
  return { sql, params };
}

module.exports = { build, locate };
