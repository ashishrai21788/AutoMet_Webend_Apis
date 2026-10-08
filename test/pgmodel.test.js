/**
 * The Postgres model layer, on an in-process Postgres (PGlite). Each behaviour is checked against what Mongoose does on
 * Mongo; the same expectations are what the real Mongo documents give (see test/contract for whole-API parity).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// PARITY_ENGINE=mongo runs these same expectations against real MongoDB (an in-memory server): the reference behaviour
const ENGINE = process.env.PARITY_ENGINE || 'postgres';
process.env.DB_ENGINE = ENGINE;
process.env.DATABASE_URL = process.env.PARITY_DATABASE_URL || 'pglite:memory'; // a real server when PARITY_DATABASE_URL is set
const mongoose = require('../lib/db/mongoose');

const schema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },
  name: { type: String, required: true },
  secret: { type: String, select: false },
  email: { type: String, lowercase: true, unique: true, sparse: true },
  status: { type: String, enum: ['NEW', 'OPEN', 'DONE'], default: 'NEW' },
  score: { type: Number, default: 0, min: 0 },
  active: { type: Boolean, default: true },
  seenAt: { type: Date, default: null },
  address: { city: String, zip: String },
  tags: [String],
  meta: mongoose.Schema.Types.Mixed
}, { timestamps: true, collection: 'pg_things' });
const Thing = mongoose.model('Thing', schema);

let mongod;
test('connect creates the tables and reports connected', async () => {
  if (ENGINE === 'postgres' && process.env.PARITY_DATABASE_URL) {
    // a real server: start clean (only this file's pg_* tables are dropped; anything else in the database stops the run)
    const { resetOwnTables } = require('./helpers/realDbReset');
    const c = require('../lib/db/postgres/client').connect();
    await resetOwnTables((t, p) => c.query(t, p).then((r) => ({ rows: r.rows })), []);
  }
  if (ENGINE === 'mongo') {
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongod.getUri());
    await Thing.init();
  } else {
    await mongoose.connect();
  }
  assert.equal(mongoose.connection.readyState, 1);
});

test.after(async () => { await mongoose.disconnect(); if (mongod) await mongod.stop(); });

test('create: defaults, casting and timestamps like Mongoose; _id is a 24-hex ObjectId', async () => {
  const t = await Thing.create({ code: ' ab1 ', name: 'First', email: 'A@X.COM', address: { city: 'Pune' }, tags: ['x', 'y'], meta: { a: { b: 1 } } });
  assert.equal(t.code, 'AB1');
  assert.equal(t.email, 'a@x.com');
  assert.equal(t.status, 'NEW');
  assert.equal(t.score, 0);
  assert.match(String(t._id), /^[0-9a-f]{24}$/);
  assert.ok(t.createdAt instanceof Date && t.updatedAt instanceof Date);
  assert.equal(t.isNew, false);
});

test('validation errors are Mongoose ValidationErrors with the same messages', async () => {
  await assert.rejects(Thing.create({ name: 'No code' }), (e) => e.name === 'ValidationError' && /code: Path `code` is required/.test(e.message));
  await assert.rejects(Thing.create({ code: 'Z', name: 'n', status: 'WRONG' }), (e) => e.name === 'ValidationError' && /`WRONG` is not a valid enum value/.test(e.message));
  await assert.rejects(Thing.create({ code: 'Z', name: 'n', score: -1 }), (e) => e.name === 'ValidationError');
});

test('a duplicate raises code 11000 with keyPattern, like MongoServerError', async () => {
  await assert.rejects(Thing.create({ code: 'ab1', name: 'Dup' }), (e) => e.code === 11000 && e.keyPattern && e.keyPattern.code === 1);
  await assert.rejects(Thing.create({ code: 'OTHER', name: 'Dup', email: 'a@x.com' }), (e) => e.code === 11000 && e.keyPattern.email === 1);
});

test('find / findOne / findById / count / exists, lean and documents', async () => {
  await Thing.create({ code: 'B2', name: 'Second', score: 5, status: 'OPEN', address: { city: 'Mumbai' }, tags: ['y'] });
  await Thing.create({ code: 'C3', name: 'Third', score: 9, status: 'DONE', seenAt: new Date('2026-01-02T00:00:00Z') });
  assert.equal(await Thing.countDocuments({}), 3);
  assert.equal(await Thing.countDocuments({ status: { $in: ['OPEN', 'DONE'] } }), 2);
  const lean = await Thing.findOne({ code: 'B2' }).lean();
  assert.equal(lean.name, 'Second');
  assert.equal(lean.address.city, 'Mumbai');
  assert.equal(typeof lean.__v, 'number');
  assert.equal(lean.secret, undefined);
  const doc = await Thing.findById(lean._id);
  assert.equal(doc.name, 'Second');
  assert.equal(typeof doc.save, 'function');
  assert.equal(doc.isNew, false);
  assert.deepEqual((await Thing.find({ tags: 'y' }).sort({ code: 1 }).lean()).map((x) => x.code), ['AB1', 'B2']);
  assert.deepEqual((await Thing.find({}).sort('-score').limit(2).lean()).map((x) => x.code), ['C3', 'B2']);
  assert.deepEqual((await Thing.find({}).sort({ score: 1 }).skip(1).limit(1).lean()).map((x) => x.code), ['B2']);
  assert.ok(await Thing.exists({ code: 'C3' }));
  assert.equal(await Thing.exists({ code: 'NOPE' }), null);
  assert.equal(await Thing.findOne({ code: 'NOPE' }), null);
});

test('filters: comparison, regex, $or, $ne, $exists, $nin, null, dates, nested and Mixed paths', async () => {
  const codes = async (f) => (await Thing.find(f).sort({ code: 1 }).lean()).map((x) => x.code);
  assert.deepEqual(await codes({ score: { $gte: 5 } }), ['B2', 'C3']);
  assert.deepEqual(await codes({ score: { $gt: 0, $lt: 9 } }), ['B2']);
  assert.deepEqual(await codes({ name: { $regex: '^sec', $options: 'i' } }), ['B2']);
  assert.deepEqual(await codes({ $or: [{ code: 'AB1' }, { status: 'DONE' }] }), ['AB1', 'C3']);
  assert.deepEqual(await codes({ status: { $ne: 'NEW' } }), ['B2', 'C3']);
  assert.deepEqual(await codes({ status: { $nin: ['NEW', 'DONE'] } }), ['B2']);
  assert.deepEqual(await codes({ seenAt: null }), ['AB1', 'B2']);
  assert.deepEqual(await codes({ seenAt: { $gte: new Date('2026-01-01T00:00:00Z') } }), ['C3']);
  assert.deepEqual(await codes({ 'address.city': 'Pune' }), ['AB1']);
  assert.deepEqual(await codes({ 'meta.a.b': 1 }), ['AB1']);
  assert.deepEqual(await codes({ email: { $exists: true } }), ['AB1']);
  assert.deepEqual(await codes({ $and: [{ score: { $gte: 0 } }, { $nor: [{ code: 'C3' }] }] }), ['AB1', 'B2']);
  assert.deepEqual(await codes({ _id: (await Thing.findOne({ code: 'C3' }).lean())._id }), ['C3']);
  if (ENGINE === 'postgres') await assert.rejects(Thing.find({ tags: { $size: 2 } }), /not supported/); // a real Mongo operator this engine does not implement fails loudly instead of matching the wrong rows
});

test('select: select:false fields are hidden unless asked for with +, inclusion and exclusion lists work', async () => {
  const t = await Thing.findOne({ code: 'B2' });
  t.secret = 's3';
  await t.save();
  assert.equal((await Thing.findOne({ code: 'B2' }).lean()).secret, undefined);
  assert.equal((await Thing.findOne({ code: 'B2' }).select('+secret').lean()).secret, 's3');
  const only = await Thing.findOne({ code: 'B2' }).select('name score').lean();
  assert.deepEqual(Object.keys(only).sort(), ['_id', 'name', 'score']);
  const without = await Thing.findOne({ code: 'B2' }).select('-address -tags').lean();
  assert.equal(without.address, undefined);
  assert.equal(without.name, 'Second');
});

test('save on an existing document updates the row and the updatedAt stamp', async () => {
  const t = await Thing.findOne({ code: 'C3' });
  const before = t.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  t.name = 'Third renamed';
  t.address = { city: 'Delhi', zip: '110001' };
  await t.save();
  const again = await Thing.findOne({ code: 'C3' }).lean();
  assert.equal(again.name, 'Third renamed');
  assert.equal(again.address.zip, '110001');
  assert.ok(again.updatedAt > before);
});

test('findOneAndUpdate: new/old document, $set/$inc/$push/$setOnInsert, filter re-checked, select:false hidden', async () => {
  const a = await Thing.findOneAndUpdate({ code: 'B2' }, { $set: { status: 'DONE', 'address.zip': '411001' }, $inc: { score: 2 } }, { new: true }).lean();
  assert.equal(a.status, 'DONE');
  assert.equal(a.score, 7);
  assert.equal(a.address.zip, '411001');
  assert.equal(a.address.city, 'Mumbai');
  assert.equal(a.secret, undefined);
  const old = await Thing.findOneAndUpdate({ code: 'B2' }, { $set: { status: 'OPEN' } }).lean();
  assert.equal(old.status, 'DONE'); // the document as it was
  assert.equal((await Thing.findOne({ code: 'B2' }).lean()).status, 'OPEN');
  // the state check in the filter is what makes a transition race-safe: the second attempt finds nothing
  const first = await Thing.findOneAndUpdate({ code: 'B2', status: 'OPEN' }, { $set: { status: 'DONE' } }, { new: true });
  const second = await Thing.findOneAndUpdate({ code: 'B2', status: 'OPEN' }, { $set: { status: 'DONE' } }, { new: true });
  assert.equal(first.status, 'DONE');
  assert.equal(second, null);
  const pushed = await Thing.findOneAndUpdate({ code: 'B2' }, { $push: { tags: 'z' } }, { new: true }).lean();
  assert.deepEqual(pushed.tags, ['y', 'z']);
  const plain = await Thing.findOneAndUpdate({ code: 'B2' }, { name: 'Second again' }, { new: true }).lean(); // no operator = $set
  assert.equal(plain.name, 'Second again');
  assert.equal(await Thing.findOneAndUpdate({ code: 'NOPE' }, { $set: { name: 'x' } }, { new: true }), null);
});

test('findOneAndUpdate with upsert: inserts with defaults, filter fields and $setOnInsert; a second call updates', async () => {
  const one = await Thing.findOneAndUpdate({ code: 'U1' }, { $set: { name: 'Upserted' }, $setOnInsert: { score: 3 } }, { new: true, upsert: true }).lean();
  assert.equal(one.code, 'U1');
  assert.equal(one.score, 3);
  assert.equal(one.status, 'NEW');
  assert.ok(one.createdAt instanceof Date);
  const two = await Thing.findOneAndUpdate({ code: 'U1' }, { $set: { name: 'Upserted twice' }, $setOnInsert: { score: 99 } }, { new: true, upsert: true }).lean();
  assert.equal(two.name, 'Upserted twice');
  assert.equal(two.score, 3);
  assert.equal(String(two._id), String(one._id));
  assert.equal(await Thing.countDocuments({ code: 'U1' }), 1);
  // concurrent upserts on one key end with one row
  await Promise.all([1, 2, 3].map((n) => Thing.findOneAndUpdate({ code: 'RACE' }, { $inc: { score: 1 }, $set: { name: `r${n}` } }, { new: true, upsert: true })));
  assert.equal(await Thing.countDocuments({ code: 'RACE' }), 1);
  assert.equal((await Thing.findOne({ code: 'RACE' }).lean()).score, 3);
});

test('updateOne / updateMany report counts like Mongo; findByIdAndUpdate works', async () => {
  const r = await Thing.updateOne({ code: 'C3' }, { $set: { active: false } });
  assert.equal(r.matchedCount, 1);
  assert.equal(r.modifiedCount, 1);
  assert.equal((await Thing.updateOne({ code: 'NOPE' }, { $set: { active: false } })).matchedCount, 0);
  const many = await Thing.updateMany({ status: 'DONE' }, { $inc: { score: 1 } });
  assert.equal(many.matchedCount, await Thing.countDocuments({ status: 'DONE' }));
  const up = await Thing.updateOne({ code: 'UP1' }, { $set: { name: 'viaUpdateOne' } }, { upsert: true });
  assert.equal(up.upsertedCount, 1);
  assert.ok(up.upsertedId);
  const id = (await Thing.findOne({ code: 'UP1' }).lean())._id;
  assert.equal((await Thing.findByIdAndUpdate(id, { $set: { name: 'byId' } }, { new: true }).lean()).name, 'byId');
});

test('runValidators rejects an invalid update; a plain update does not validate (like Mongoose)', async () => {
  await assert.rejects(Thing.findOneAndUpdate({ code: 'B2' }, { $set: { status: 'WRONG' } }, { new: true, runValidators: true }), (e) => e.name === 'ValidationError');
  assert.equal((await Thing.findOne({ code: 'B2' }).lean()).status, 'DONE');
});

test('a unique violation inside an update is a code 11000 error too', async () => {
  await assert.rejects(Thing.updateOne({ code: 'B2' }, { $set: { code: 'C3' } }), (e) => e.code === 11000);
});

test('deleteOne / deleteMany / findByIdAndDelete', async () => {
  assert.equal((await Thing.deleteOne({ code: 'UP1' })).deletedCount, 1);
  assert.equal((await Thing.deleteOne({ code: 'UP1' })).deletedCount, 0);
  assert.equal((await Thing.deleteMany({ code: { $in: ['U1', 'RACE'] } })).deletedCount, 2);
  const id = (await Thing.findOne({ code: 'C3' }).lean())._id;
  const gone = await Thing.findByIdAndDelete(id);
  assert.equal(gone.code, 'C3');
  assert.equal(await Thing.findById(id), null);
  assert.equal(await Thing.findByIdAndDelete(id), null);
});

test('raw collections (no model): insert, find with sort/limit/projection, update operators, delete, count; Dates and ObjectIds survive', async () => {
  const col = mongoose.connection.db.collection('pg_raw_things');
  const when = new Date('2026-10-01T10:00:00Z');
  const a = await col.insertOne({ userId: 'u1', title: 'One', n: 1, when, nested: { x: 1 } });
  await col.insertOne({ userId: 'u1', title: 'Two', n: 2, when: new Date('2026-10-02T10:00:00Z') });
  await col.insertOne({ userId: 'u2', title: 'Three', n: 3, when });
  assert.match(String(a.insertedId), /^[0-9a-f]{24}$/);
  const got = await col.findOne({ _id: a.insertedId });
  assert.equal(got.title, 'One');
  assert.ok(got.when instanceof Date && got.when.getTime() === when.getTime());
  assert.equal(String(got._id), String(a.insertedId));
  assert.deepEqual((await col.find({ userId: 'u1' }).sort({ n: -1 }).toArray()).map((x) => x.title), ['Two', 'One']);
  assert.deepEqual((await col.find({ when: { $gte: new Date('2026-10-02T00:00:00Z') } }).toArray()).map((x) => x.title), ['Two']);
  assert.deepEqual((await col.find({ _id: { $in: [a.insertedId] } }).toArray()).map((x) => x.title), ['One']);
  assert.deepEqual(Object.keys(await col.findOne({ title: 'One' }, { projection: { title: 1 } })).sort(), ['_id', 'title']);
  assert.equal(await col.countDocuments({ userId: 'u1' }), 2);
  const up = await col.updateMany({ userId: 'u1' }, { $set: { seen: true, 'nested.y': 2 }, $inc: { n: 10 } });
  assert.equal(up.matchedCount, 2);
  assert.equal((await col.findOne({ title: 'One' })).n, 11);
  assert.deepEqual((await col.findOne({ title: 'One' })).nested, { x: 1, y: 2 });
  assert.equal((await col.updateOne({ userId: 'nobody' }, { $set: { a: 1 } })).matchedCount, 0);
  assert.equal((await col.deleteOne({ title: 'Two' })).deletedCount, 1);
  assert.equal((await col.deleteMany({ userId: { $in: ['u1', 'u2'] } })).deletedCount, 2);
  assert.equal(await col.countDocuments({}), 0);
});

test('a raw collection and a model on the same collection see the same rows', async () => {
  const col = mongoose.connection.db.collection('pg_things');
  const t = await Thing.create({ code: 'SHARED', name: 'Via model', address: { city: 'Goa' } });
  const raw = await col.findOne({ code: 'SHARED' });
  assert.equal(raw.name, 'Via model');
  assert.equal(raw.address.city, 'Goa');
  await col.updateOne({ code: 'SHARED' }, { $set: { name: 'Via raw', 'address.city': 'Kochi', extraField: 7 } });
  const back = await Thing.findOne({ code: 'SHARED' }).lean();
  assert.equal(back.name, 'Via raw');
  assert.equal(back.address.city, 'Kochi');
  const ins = await col.insertOne({ code: 'RAWIN', name: 'raw insert', status: 'OPEN', score: 4 });
  assert.equal((await Thing.findById(ins.insertedId).lean()).score, 4);
  await Thing.deleteMany({ code: { $in: ['SHARED', 'RAWIN'] } });
  assert.ok(t);
});

test('saving a document loaded without a select:false field neither validates nor erases it (the passwordHash case)', async () => {
  const strict = new mongoose.Schema({ key: { type: String, unique: true }, hash: { type: String, required: true, select: false }, label: String }, { collection: 'pg_secrets' });
  const Secret = mongoose.model('Secret', strict);
  if (ENGINE === 'mongo') await Secret.init(); else await Secret.$ensureTable?.();
  await Secret.create({ key: 'k1', hash: 'HASH', label: 'a' });
  const loaded = await Secret.findOne({ key: 'k1' });
  assert.equal(loaded.hash, undefined);
  loaded.label = 'b';
  await loaded.save();
  assert.equal((await Secret.findOne({ key: 'k1' }).select('+hash').lean()).hash, 'HASH');
  assert.equal((await Secret.findOne({ key: 'k1' }).lean()).label, 'b');
});

test('aggregation: $match/$unwind/$addFields/$facet/$count/$group/$project over arrays of events, and counts that return no row', async () => {
  const col = mongoose.connection.db.collection('pg_events');
  const t0 = new Date('2026-10-01T10:00:00Z');
  await col.insertOne({ sessionId: 's1', events: [
    { eventName: 'Map-Opened', clientTimestamp: t0, params: { driver_ids: ['d1', 'd2'] } },
    { eventName: 'driver_call_tapped', clientTimestamp: new Date('2026-10-01T10:05:00Z'), params: { driver_id: 'd1' } }
  ] });
  await col.insertOne({ sessionId: 's2', events: [{ eventName: 'driver_call_tapped', clientTimestamp: new Date('2026-10-02T10:00:00Z'), params: { driver_id: 'd2' } }] });
  const pre = [{ $unwind: '$events' }, { $addFields: { name: { $toLower: { $replaceAll: { input: { $ifNull: ['$events.eventName', ''] }, find: '-', replacement: '_' } } } } }];
  const window = { 'events.clientTimestamp': { $gte: new Date('2026-09-30T00:00:00Z'), $lte: new Date('2026-10-03T00:00:00Z'), $ne: null } };
  const res = await col.aggregate([...pre, { $match: window }, { $facet: {
    opened: [{ $match: { name: 'map_opened', 'events.params.driver_ids': 'd1' } }, { $count: 'total' }],
    calls: [{ $match: { name: 'driver_call_tapped', $or: [{ 'events.params.driver_id': 'd1' }, { 'events.params.driverId': 'd1' }] } }, { $count: 'total' }],
    none: [{ $match: { name: 'nothing' } }, { $count: 'total' }]
  } }]).toArray();
  assert.deepEqual(res[0].opened, [{ total: 1 }]);
  assert.deepEqual(res[0].calls, [{ total: 1 }]);
  assert.deepEqual(res[0].none, []);
  const dur = await col.aggregate([...pre, { $match: { name: { $in: ['map_opened', 'driver_call_tapped'] }, 'events.params.driver_ids': 'd1' } },
    { $group: { _id: '$sessionId', first: { $min: '$events.clientTimestamp' }, last: { $max: '$events.clientTimestamp' } } },
    { $project: { ms: { $subtract: ['$last', '$first'] } } }, { $group: { _id: null, total: { $sum: '$ms' } } }]).toArray();
  assert.deepEqual(dur, [{ _id: null, total: 0 }]); // only the first event of s1 names d1 in driver_ids
  const byStatus = await Thing.aggregate([{ $match: { status: { $in: ['NEW', 'OPEN', 'DONE'] } } }, { $group: { _id: '$status', n: { $sum: 1 }, score: { $sum: { $ifNull: ['$score', 0] } } } }]);
  assert.ok(byStatus.every((r) => typeof r.n === 'number' && typeof r.score === 'number'));
  assert.equal(byStatus.reduce((s, r) => s + r.n, 0), await Thing.countDocuments({ status: { $in: ['NEW', 'OPEN', 'DONE'] } }));
  await col.deleteMany({});
});

test('a partial unique index only guards the rows its filter matches (one ACTIVE assignment, any number ended)', async () => {
  const s = new mongoose.Schema({ who: String, what: String, active: Boolean }, { collection: 'pg_assign' });
  s.index({ who: 1 }, { unique: true, partialFilterExpression: { active: true } });
  const A = mongoose.model('Assign', s);
  if (ENGINE === 'mongo') await A.init();
  await A.create({ who: 'w1', what: 'a', active: true });
  await A.create({ who: 'w1', what: 'b', active: false });
  await A.create({ who: 'w1', what: 'c', active: false });
  await assert.rejects(A.create({ who: 'w1', what: 'd', active: true }), (e) => e.code === 11000);
  await A.updateOne({ what: 'a' }, { $set: { active: false } });
  await A.create({ who: 'w1', what: 'e', active: true });
});

test('null and a missing field stay different (older documents lack fields the schema now defaults to null)', async () => {
  const s = new mongoose.Schema({ key: String, a: { type: String, default: null }, b: String, c: { type: String, select: false, default: null } }, { collection: 'pg_nulls' });
  const N = mongoose.model('Nulls', s);
  const created = await N.create({ key: 'new' }); // a and c get their default null, b stays missing
  const lean = await N.findById(created._id).lean();
  assert.equal(lean.a, null);
  assert.equal('b' in lean, false);
  const raw = await mongoose.connection.db.collection('pg_nulls').insertOne({ key: 'legacy' }); // written before the schema had a / b / c
  const old = await N.findById(raw.insertedId).lean();
  assert.equal('a' in old, false);
  assert.equal('b' in old, false);
  const doc = await N.findById(raw.insertedId);
  doc.b = 'now';
  await doc.save();
  const after = await N.findById(raw.insertedId).lean();
  assert.equal(after.b, 'now');
  assert.equal('a' in after, false); // saving another field does not turn a missing field into null
  await N.updateOne({ key: 'legacy' }, { $set: { a: null } });
  assert.equal((await N.findById(raw.insertedId).lean()).a, null);
  const hidden = await N.findById(created._id).select('+c').lean();
  assert.equal(hidden.c, null);
  const fresh = await N.findById(created._id);
  fresh.b = 'x'; await fresh.save();
  assert.equal((await N.findById(created._id).select('+c').lean()).c, null); // an unselected null survives a save
});

test('defaults on older documents: what find, findOneAndUpdate and updateOne return and store', async () => {
  const s = new mongoose.Schema({ key: String, a: { type: String, default: null }, st: { type: String, default: 'ACTIVE' }, b: String }, { collection: 'pg_defaults' });
  const D = mongoose.model('Defaults', s);
  await mongoose.connection.db.collection('pg_defaults').insertOne({ key: 'old1' });
  await mongoose.connection.db.collection('pg_defaults').insertOne({ key: 'old2' });
  const viaFind = (await D.findOne({ key: 'old1' })).toObject();
  const viaLean = await D.findOne({ key: 'old1' }).lean();
  const viaUpdate = (await D.findOneAndUpdate({ key: 'old1' }, { $set: { b: 'x' } }, { new: true })).toObject();
  const viaUpdateLean = await D.findOneAndUpdate({ key: 'old2' }, { $set: { b: 'x' } }, { new: true }).lean();
  const stored = await mongoose.connection.db.collection('pg_defaults').findOne({ key: 'old1' });
  console.log('RESULT', ENGINE, JSON.stringify({
    find: Object.keys(viaFind).sort(), lean: Object.keys(viaLean).sort(), update: Object.keys(viaUpdate).sort(),
    updateLean: Object.keys(viaUpdateLean).sort(), stored: Object.keys(stored).sort()
  }));
});

test('a value that cannot be the type of its path raises the same CastError (an id that is not an id, text for a number)', async () => {
  const msg = async (p) => { try { await p; return null; } catch (e) { return `${e.name}: ${e.message}`; } };
  assert.equal(await msg(Thing.findById('not-an-id')), 'CastError: Cast to ObjectId failed for value "not-an-id" (type string) at path "_id" for model "Thing"');
  assert.equal(await msg(Thing.find({ score: 'abc' })), 'CastError: Cast to Number failed for value "abc" (type string) at path "score" for model "Thing"');
  assert.equal(await msg(Thing.updateOne({ _id: 'zzz' }, { $set: { name: 'x' } })), 'CastError: Cast to ObjectId failed for value "zzz" (type string) at path "_id" for model "Thing"');
  assert.equal(await msg(Thing.deleteOne({ _id: 'zzz' })), 'CastError: Cast to ObjectId failed for value "zzz" (type string) at path "_id" for model "Thing"');
  assert.equal(await msg(Thing.find({ score: '5' })), null, 'text that is a number is cast, not refused');
});
