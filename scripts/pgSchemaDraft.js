/**
 * Draft Postgres table definitions generated from the Mongoose schemas (the single source of truth).
 * Prints a human-readable review document; touches no database.
 *
 *   node scripts/pgSchemaDraft.js > docs/POSTGRES_SCHEMA_DRAFT.md
 */
process.env.DB_ENGINE = 'mongo';
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('../lib/db/mongoose');

const modelsDir = path.join(__dirname, '..', 'models');
for (const f of fs.readdirSync(modelsDir)) {
  if (f.endsWith('.js')) require(path.join(modelsDir, f));
}
const { createModel } = require('../models/dynamicModel');
createModel('drivers');
createModel('users');

const TYPE = {
  String: 'text', Number: 'double precision', Boolean: 'boolean', Date: 'timestamptz',
  ObjectId: 'text', Mixed: 'jsonb', Array: 'jsonb', Map: 'jsonb', Buffer: 'bytea', Decimal128: 'numeric'
};

function column(p) {
  const kind = p.instance || 'Mixed';
  const type = TYPE[kind] || 'jsonb';
  const o = p.options || {};
  const flags = [];
  if (o.required) flags.push('required');
  if (o.unique) flags.push('unique');
  if (o.select === false) flags.push('select:false');
  if (o.enum) flags.push(`enum(${(Array.isArray(o.enum) ? o.enum : o.enum.values || []).join('|')})`);
  if (o.default !== undefined && typeof o.default !== 'function') flags.push(`default ${JSON.stringify(o.default)}`);
  return { type, flags };
}

const out = [];
const names = Object.keys(mongoose.models).sort();
out.push('# Postgres schema draft (generated)\n');
out.push(`${names.length} models. Every table also has \`_id text primary key\` (24-hex), \`__v integer\`, and \`createdAt/updatedAt timestamptz\` where the schema has timestamps.\n`);
for (const name of names) {
  const m = mongoose.models[name];
  const s = m.schema;
  out.push(`## ${name}  (collection \`${m.collection.name}\`)`);
  out.push(`timestamps: ${s.options.timestamps ? 'yes' : 'no'}; strict: ${s.options.strict === false ? 'false (free extra fields -> jsonb "extra")' : 'default'}\n`);
  out.push('| column | type | notes |\n|---|---|---|');
  for (const [p, def] of Object.entries(s.paths)) {
    if (p === '_id' || p === '__v') continue;
    const c = column(def);
    out.push(`| ${p} | ${c.type} | ${c.flags.join(', ')} |`);
  }
  const idx = s.indexes();
  if (idx.length) {
    out.push('\nIndexes:');
    for (const [fields, opts] of idx) out.push(`- ${JSON.stringify(fields)}${opts && opts.unique ? ' unique' : ''}${opts && opts.sparse ? ' sparse' : ''}${opts && opts.partialFilterExpression ? ' partial ' + JSON.stringify(opts.partialFilterExpression) : ''}`);
  }
  out.push('');
}
process.stdout.write(out.join('\n'));
