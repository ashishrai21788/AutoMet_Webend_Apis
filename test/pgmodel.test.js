/**
 * The Postgres model layer, on an in-process Postgres (PGlite). Each behaviour is checked against what Mongoose does on
 * Mongo; the same expectations are what the real Mongo documents give (see test/contract for whole-API parity).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// PARITY_ENGINE=mongo runs these same expectations against real MongoDB (an in-memory server): the reference behaviour
const ENGINE = process.env.PARITY_ENGINE || 'postgres';
process.env.DB_ENGINE = ENGINE;
process.env.DATABASE_URL = 'pglite:memory';
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
  if (ENGINE === 'postgres') await assert.rejects(Thing.find({ score: { $bogus: 1 } }), /not supported/); // fails loudly instead of matching the wrong rows
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
