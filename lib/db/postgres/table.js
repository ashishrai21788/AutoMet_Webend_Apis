/**
 * Table description derived from a Mongoose schema (the schema stays the single source of truth), and the SQL that creates it.
 *
 *  - every schema path becomes a column named exactly like the path ("address.city" is a column), typed from the path;
 *  - `_id` is a 24-hex text primary key, `__v` an integer;
 *  - fields the schema does not declare (strict:false collections) live in one jsonb column, "__extra";
 *  - unique schema indexes become unique constraints, other indexes plain indexes.
 */
const TYPES = {
  String: 'text', Number: 'double precision', Boolean: 'boolean', Date: 'timestamptz', ObjectId: 'text',
  Decimal128: 'numeric', Buffer: 'bytea'
};
const EXTRA = '__extra';

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const sqlType = (instance) => TYPES[instance] || 'jsonb';

function describe(Model) {
  const schema = Model.schema;
  const table = Model.collection.name;
  const columns = [];
  for (const [path, type] of Object.entries(schema.paths)) {
    if (path === '__v') continue;
    const o = type.options || {};
    columns.push({
      path,
      type: sqlType(type.instance),
      instance: type.instance,
      selectFalse: o.select === false,
      nullDefault: o.default === null,
      isId: path === '_id'
    });
  }
  const timestamps = !!schema.options.timestamps;
  const byPath = new Map(columns.map((c) => [c.path, c]));
  const strictFalse = schema.options.strict === false;

  // indexes: schema.indexes() holds the compound/explicit ones; field-level `unique: true` is on the path options
  const unique = [];
  const plain = [];
  for (const c of columns) {
    const o = schema.paths[c.path].options || {};
    if (c.isId) continue;
    if (o.unique) unique.push({ fields: [c.path], sparse: !!o.sparse });
    else if (o.index) plain.push({ fields: [c.path] });
  }
  for (const [fields, opts] of schema.indexes()) {
    const list = Object.keys(fields);
    if (!list.every((f) => byPath.has(f))) continue; // an index into a jsonb sub-path or a field the schema does not declare
    if (opts && opts.unique) unique.push({ fields: list, sparse: !!opts.sparse, partial: opts.partialFilterExpression });
    else plain.push({ fields: list });
  }
  return { table, columns, byPath, timestamps, strictFalse, unique, plain, extra: EXTRA };
}

const indexName = (table, kind, fields) => `${kind}_${table}__${fields.join('_').replace(/[^a-zA-Z0-9_]/g, '_')}`.slice(0, 62);

/** Statements that create the table (if missing), add any column a second model on the same table needs, and the indexes. */
function ddl(d) {
  const cols = d.columns.map((c) => `${q(c.path)} ${c.type}${c.isId ? ' PRIMARY KEY' : ''}`);
  cols.push(`"__v" integer NOT NULL DEFAULT 0`, `${q(EXTRA)} jsonb`);
  const out = [`CREATE TABLE IF NOT EXISTS ${q(d.table)} (${cols.join(', ')})`];
  for (const c of d.columns) if (!c.isId) out.push(`ALTER TABLE ${q(d.table)} ADD COLUMN IF NOT EXISTS ${q(c.path)} ${c.type}`);
  for (const u of d.unique) {
    // a Mongo unique index never rejects documents that lack the field: NULLs are not equal in Postgres uniqueness either
    const where = u.sparse ? ` WHERE ${u.fields.map((f) => `${q(f)} IS NOT NULL`).join(' AND ')}` : '';
    out.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(indexName(d.table, 'uq', u.fields))} ON ${q(d.table)} (${u.fields.map(q).join(', ')})${where}`);
  }
  for (const i of d.plain) {
    const jsonb = i.fields.some((f) => d.byPath.get(f).type === 'jsonb');
    if (jsonb) continue; // jsonb columns are not b-tree indexable; query-plan driven indexes come in a later phase
    out.push(`CREATE INDEX IF NOT EXISTS ${q(indexName(d.table, 'ix', i.fields))} ON ${q(d.table)} (${i.fields.map(q).join(', ')})`);
  }
  return out;
}

/** The key pattern a unique index guards, by index name: Mongo reports it as error.keyPattern ({ email: 1 }). */
function uniqueKeyPatterns(d) {
  const map = new Map();
  for (const u of d.unique) map.set(indexName(d.table, 'uq', u.fields), Object.fromEntries(u.fields.map((f) => [f, 1])));
  return map;
}

module.exports = { describe, ddl, q, uniqueKeyPatterns, indexName, EXTRA };
