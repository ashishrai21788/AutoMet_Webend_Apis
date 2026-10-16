// A rider's own profile: read it (without tokens), edit it (name, optional email), and delete the account.
process.env.JWT_SECRET = 'test-secret-for-rider-profile-tests';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
require('../models/userOtpModel').deleteMany = async () => ({ deletedCount: 0 }); // no database in tests: nothing pending to erase
const users = require('../controllers/userController');

const run = async (handler, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await handler(req, res);
  return res;
};
const me = { authRole: 'user', authActorId: 'U1' };
const seedUser = (extra = {}) => db.User.create({
  userId: 'U1', firstName: 'Ashish', lastName: 'Rai', phone: '+919876500009', email: null, profilePhoto: null,
  accessToken: 'secret-token', fcmToken: 'fcm-secret', deviceId: 'dev-1', isPhoneVerified: true, createdAt: new Date('2025-03-01'), ...extra
});
const trip = (id, status, km = 0) => db.TripDetails.create({
  trip_id: id, request_id: 'R_' + id, user_id: 'U1', driver_id: 'D1', status, distance_km: km,
  pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 }, timeout_at: new Date()
});

test('profile detail has the stats and never the token or device identifiers', async () => {
  await seedUser();
  await trip('t1', 'COMPLETED', 12.34);
  await trip('t2', 'COMPLETED', 7.7);
  await trip('t3', 'CANCELLED_BY_USER', 99);
  const r = await run(users.getUserByUserId, { ...me, params: { userId: 'U1' } });
  assert.equal(r.statusCode, 200);
  const u = r.body.data.user;
  assert.equal(u.stats.total_rides, 2);
  assert.equal(u.stats.total_km, 20);
  assert.ok(u.stats.member_since);
  assert.equal(u.accessToken, undefined);
  assert.equal(u.fcmToken, undefined);
  assert.equal(u.deviceId, undefined);
  assert.equal(u.phone, '+919876500009');
});

test('another rider cannot read, edit or delete this account', async () => {
  const other = { authRole: 'user', authActorId: 'U2' };
  assert.equal((await run(users.getUserByUserId, { ...other, params: { userId: 'U1' } })).statusCode, 403);
  assert.equal((await run(users.updateUserProfile, { ...other, body: { userId: 'U1', firstName: 'X' } })).statusCode, 403);
  assert.equal((await run(users.deleteUserAccount, { ...other, body: { userId: 'U1' } })).statusCode, 403);
});

test('edit: name, a single name, optional email; a bad email is refused; an empty email removes it', async () => {
  let r = await run(users.updateUserProfile, { ...me, body: { userId: 'U1', firstName: 'Ashish', lastName: '', email: ' Ashish@Example.com ' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.data.user.email, 'ashish@example.com');
  assert.equal(r.body.data.user.lastName, '');
  assert.equal(r.body.data.user.accessToken, undefined, 'the edit response carries no token either');

  r = await run(users.updateUserProfile, { ...me, body: { userId: 'U1', email: 'not-an-email' } });
  assert.equal(r.statusCode, 400);

  r = await run(users.updateUserProfile, { ...me, body: { userId: 'U1', email: '' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.data.user.email, null);

  r = await run(users.updateUserProfile, { ...me, body: { userId: 'U1', firstName: '   ' } });
  assert.equal(r.statusCode, 400, 'the first name may not be blank');
});

test('delete: refused while a ride is live, then erases the details and frees the number', async () => {
  await trip('live1', 'DRIVER_ON_THE_WAY');
  let r = await run(users.deleteUserAccount, { ...me, body: { userId: 'U1' } });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.message, /ride/i);
  assert.equal(db.User.rows.find((x) => x.userId === 'U1').phone, '+919876500009', 'nothing erased yet');

  await db.TripDetails.findOneAndUpdate({ trip_id: 'live1' }, { $set: { status: 'COMPLETED' } });
  r = await run(users.deleteUserAccount, { ...me, body: { userId: 'U1' } });
  assert.equal(r.statusCode, 200);
  const row = db.User.rows.find((x) => x.userId === 'U1');
  assert.equal(row.firstName, 'Deleted');
  assert.equal(row.phone, 'deleted_U1');
  assert.equal(row.email, null);
  assert.equal(row.profilePhoto, null);
  assert.equal(row.accessToken, null);
  assert.equal(row.fcmToken, null);
  assert.equal(row.deviceId, null);
  assert.ok(row.deletedAt);
  assert.ok(db.TripDetails.rows.some((t) => t.trip_id === 't1'), 'finished trips stay as business records');
});

test('the public deletion page explains how, and loads no scripts', () => {
  const { PAGE } = require('../lib/accountDeletionPage');
  assert.match(PAGE, /Delete account/);
  assert.match(PAGE, /What is kept/);
  assert.doesNotMatch(PAGE, /<script/i);
});
