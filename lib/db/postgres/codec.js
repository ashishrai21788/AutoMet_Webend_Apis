/**
 * Free-form documents (the "__extra" column, and collections without a schema) keep what Mongo keeps and JSON cannot:
 * Dates and ObjectIds are written as { $date: ISO } and { $oid: hex } and revived on read, so a Date comes back a Date.
 */
const { Types: { ObjectId } } = require('mongoose');

function encode(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return { $date: v.toISOString() };
  if (v && v._bsontype === 'ObjectId') return { $oid: String(v) };
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === 'object') {
    if (typeof v.toObject === 'function') return encode(v.toObject());
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encode(x);
    return out;
  }
  return v;
}

function decode(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(decode);
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$date') return new Date(v.$date);
    if (keys.length === 1 && keys[0] === '$oid') return new ObjectId(v.$oid);
    const out = {};
    for (const k of keys) out[k] = decode(v[k]);
    return out;
  }
  return v;
}

const dump = (v) => JSON.stringify(encode(v));

module.exports = { encode, decode, dump };
