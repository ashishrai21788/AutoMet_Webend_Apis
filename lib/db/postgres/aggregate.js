/**
 * Aggregation pipelines for the Postgres engine.
 *
 * Only the stages and operators the backend uses exist here, and anything else raises an error:
 *   stages     $match $unwind $addFields $project $group $facet $count
 *   operators  $ifNull $toLower $replaceAll $subtract  /  accumulators $sum $min $max
 *
 * A leading $match is run in SQL (see plain.js); the remaining stages run on the rows it returns. The semantics follow
 * MongoDB: dotted paths look inside arrays, equality on an array field matches any element, and a $count of nothing
 * produces no row at all.
 */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isOid = (v) => v && v._bsontype === 'ObjectId';

/** A comparable form: Dates and ISO strings (JSON loses the type) compare by time, ObjectIds by hex. */
const comparable = (v) => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && ISO.test(v)) return Date.parse(v);
  if (isOid(v)) return String(v);
  return v;
};
const same = (a, b) => {
  const x = comparable(a); const y = comparable(b);
  if (x === null || x === undefined) return y === null || y === undefined;
  return x === y;
};

/** Every value a dotted path reaches in a document (arrays are walked, so "events.x" over an array gives one per element). */
function valuesAt(doc, path) {
  let current = [doc];
  for (const key of path.split('.')) {
    const next = [];
    for (const c of current) {
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) { for (const e of c) if (e !== null && typeof e === 'object' && key in e) next.push(e[key]); } else if (typeof c === 'object' && key in c) next.push(c[key]);
    }
    current = next;
  }
  return current;
}
// an array value also stands for its elements (equality and $in match any element)
const candidates = (doc, path) => valuesAt(doc, path).flatMap((v) => (Array.isArray(v) ? [v, ...v] : [v]));

function matchOps(values, ops) {
  const present = values.length > 0;
  return Object.entries(ops).every(([op, arg]) => {
    switch (op) {
      case '$eq': return arg === null ? (!present || values.some((v) => v === null)) : values.some((v) => same(v, arg));
      case '$ne': return arg === null ? (present && values.some((v) => v !== null && v !== undefined)) : !values.some((v) => same(v, arg));
      case '$in': return arg.some((a) => (a === null ? (!present || values.some((v) => v === null)) : values.some((v) => same(v, a))));
      case '$nin': return !arg.some((a) => (a === null ? (!present || values.some((v) => v === null)) : values.some((v) => same(v, a))));
      case '$gt': return values.some((v) => comparable(v) !== null && comparable(v) > comparable(arg));
      case '$gte': return values.some((v) => comparable(v) !== null && comparable(v) >= comparable(arg));
      case '$lt': return values.some((v) => comparable(v) !== null && comparable(v) < comparable(arg));
      case '$lte': return values.some((v) => comparable(v) !== null && comparable(v) <= comparable(arg));
      case '$exists': return arg ? present : !present;
      default: throw new Error(`Postgres engine: aggregation $match operator ${op} is not supported`);
    }
  });
}

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, cond]) => {
    if (key === '$or') return cond.some((f) => matches(doc, f));
    if (key === '$and') return cond.every((f) => matches(doc, f));
    if (key.startsWith('$')) throw new Error(`Postgres engine: aggregation $match operator ${key} is not supported`);
    const values = candidates(doc, key);
    const isOps = cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond) && !isOid(cond) && Object.keys(cond).length && Object.keys(cond).every((k) => k.startsWith('$'));
    if (isOps) return matchOps(values, cond);
    return matchOps(values, { $eq: cond });
  });
}

function evalExpr(expr, doc) {
  if (typeof expr === 'string' && expr.startsWith('$')) { const v = valuesAt(doc, expr.slice(1)); return v.length ? v[0] : undefined; }
  if (Array.isArray(expr)) return expr.map((e) => evalExpr(e, doc));
  if (expr !== null && typeof expr === 'object' && !(expr instanceof Date) && !isOid(expr)) {
    const keys = Object.keys(expr);
    if (keys.length === 1 && keys[0].startsWith('$')) {
      const op = keys[0]; const arg = expr[op];
      switch (op) {
        case '$ifNull': { const [a, b] = arg.map((e) => evalExpr(e, doc)); return a === null || a === undefined ? b : a; }
        case '$toLower': { const v = evalExpr(arg, doc); return v === null || v === undefined ? '' : String(v).toLowerCase(); }
        case '$replaceAll': {
          const input = evalExpr(arg.input, doc);
          if (input === null || input === undefined) return null;
          return String(input).split(String(evalExpr(arg.find, doc))).join(String(evalExpr(arg.replacement, doc)));
        }
        case '$subtract': {
          const [a, b] = arg.map((e) => comparable(evalExpr(e, doc)));
          return typeof a === 'number' && typeof b === 'number' ? a - b : null;
        }
        default: throw new Error(`Postgres engine: aggregation expression ${op} is not supported`);
      }
    }
    return Object.fromEntries(keys.map((k) => [k, evalExpr(expr[k], doc)]));
  }
  return expr;
}

function run(docs, pipeline) {
  let rows = docs;
  for (const stage of pipeline) {
    const [name] = Object.keys(stage);
    const arg = stage[name];
    switch (name) {
      case '$match': rows = rows.filter((d) => matches(d, arg)); break;
      case '$unwind': {
        const path = (typeof arg === 'string' ? arg : arg.path).replace(/^\$/, '');
        rows = rows.flatMap((d) => (Array.isArray(d[path]) ? d[path].map((e) => ({ ...d, [path]: e })) : []));
        break;
      }
      case '$addFields': rows = rows.map((d) => ({ ...d, ...Object.fromEntries(Object.entries(arg).map(([k, e]) => [k, evalExpr(e, d)])) })); break;
      case '$project': rows = rows.map((d) => ({ _id: d._id, ...Object.fromEntries(Object.entries(arg).filter(([, v]) => v !== 0).map(([k, v]) => [k, v === 1 ? d[k] : evalExpr(v, d)])) })); break;
      case '$count': rows = rows.length ? [{ [arg]: rows.length }] : []; break;
      case '$facet': rows = [Object.fromEntries(Object.entries(arg).map(([k, sub]) => [k, run(rows, sub)]))]; break;
      case '$group': {
        const groups = new Map();
        for (const d of rows) {
          const id = evalExpr(arg._id, d);
          const key = JSON.stringify(id === undefined ? null : comparable(id));
          if (!groups.has(key)) groups.set(key, { id: id === undefined ? null : id, items: [] });
          groups.get(key).items.push(d);
        }
        rows = [...groups.values()].map(({ id, items }) => {
          const out = { _id: id };
          for (const [field, acc] of Object.entries(arg)) {
            if (field === '_id') continue;
            const [op] = Object.keys(acc);
            const vals = items.map((d) => evalExpr(acc[op], d));
            if (op === '$sum') out[field] = vals.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
            else if (op === '$min' || op === '$max') {
              const usable = vals.filter((v) => v !== null && v !== undefined);
              out[field] = usable.length ? usable.reduce((best, v) => ((op === '$min' ? comparable(v) < comparable(best) : comparable(v) > comparable(best)) ? v : best)) : null;
            } else throw new Error(`Postgres engine: accumulator ${op} is not supported`);
          }
          return out;
        });
        break;
      }
      default: throw new Error(`Postgres engine: aggregation stage ${name} is not supported`);
    }
  }
  return rows;
}

module.exports = { run, matches };
