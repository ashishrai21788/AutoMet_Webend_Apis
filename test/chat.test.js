// Ride chat, end to end through the controller: send, read back, mark read, who may, when, how fast, retries, businesses, staff view.
process.env.JWT_SECRET = 'test-secret-for-chat';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const socket = require('../config/socket');
const push = require('../lib/pushNotification');
const chat = require('../controllers/chatController');

const sent = { push: [], live: [] };
socket.emitToUser = (id, event, payload) => sent.live.push({ to: `user:${id}`, event, payload });
socket.emitToDriver = (id, event, payload) => sent.live.push({ to: `driver:${id}`, event, payload });
push.sendPushToUser = async (id, p) => { sent.push.push({ to: `user:${id}`, ...p }); return { success: true }; };
push.sendPushToDriver = async (id, p) => { sent.push.push({ to: `driver:${id}`, ...p }); return { success: true }; };

const addTrip = (over = {}) => db.TripDetails.create({
  trip_id: 'T1', request_id: 'R1', tenant_id: 't1', user_id: 'U1', driver_id: 'D1', status: 'ACCEPTED', timeout_at: new Date(),
  pickup: { address: 'A', lat: 1, lng: 1 }, drop: { address: 'B', lat: 2, lng: 2 }, ...over
});
const reset = async (over) => {
  for (const m of ['Tenant', 'TripDetails', 'ChatMessage', 'User', 'Driver']) await db[m].deleteMany({});
  sent.push.length = 0; sent.live.length = 0;
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', slug: 'uride', appName: 'uRide', packageName: 'in.uride', isDefault: true });
  await db.User.create({ userId: 'U1', firstName: 'Asha', lastName: 'Rider', phone: '+919800000001', tenantId: 't1' });
  await db.Driver.create({ driverId: 'D1', firstName: 'Ravi', lastName: 'Driver', phone: '+919800000002', email: 'd1@t.test', tenantId: 't1' });
  await addTrip(over);
};

const call = async (fn, { role, id, body = {}, query = {}, account } = {}) => {
  const acct = account || (role === 'user' ? { userId: id, tenantId: 't1' } : { driverId: id, tenantId: 't1' });
  const req = { authRole: role, authActorId: id, user: role === 'user' ? acct : null, driver: role === 'driver' ? acct : null, body, query, params: {}, headers: {}, ip: '1.1.1.1' };
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};
const rider = (extra) => ({ role: 'user', id: 'U1', ...extra });
const driver = (extra) => ({ role: 'driver', id: 'D1', ...extra });
const say = (who, text, extra = {}) => call(chat.send, { ...who, body: { trip_id: 'T1', text, ...extra } });
const rows = () => db.ChatMessage.rows.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

test('a rider writes; it is stored for the business, the driver is told live and by push, and the rider gets the message back', async () => {
  await reset();
  const r = await say(rider(), '  Please wait at gate 2  ');
  assert.equal(r.code, 201, JSON.stringify(r.body));
  const m = r.body.data.message;
  assert.deepEqual([m.from, m.mine, m.text, m.read], ['rider', true, 'Please wait at gate 2', false]);
  assert.equal(rows().length, 1);
  assert.deepEqual([rows()[0].tenantId, rows()[0].senderId, rows()[0].recipientId, rows()[0].tripId], ['t1', 'U1', 'D1', 'T1']);
  assert.equal(sent.live.length, 1);
  assert.deepEqual([sent.live[0].to, sent.live[0].event, sent.live[0].payload.trip_id, sent.live[0].payload.message.mine], ['driver:D1', 'chat_message', 'T1', false], 'the driver sees it as not theirs');
  assert.equal(sent.push.length, 1);
  assert.equal(sent.push[0].to, 'driver:D1');
  assert.equal(sent.push[0].data.type, 'chat_message');
  assert.equal(sent.push[0].data.trip_id, 'T1');
  assert.equal(sent.push[0].body, 'Please wait at gate 2');
  assert.match(sent.push[0].title, /Asha/);
  // a tap opens this ride's chat; the dedicated channel makes it a heads-up with sound; the tag lets a newer message replace an older one
  assert.deepEqual([sent.push[0].channelId, sent.push[0].clickAction, sent.push[0].tag], ['chat_messages', 'OPEN_RIDE_CHAT', 'chat_T1']);
  assert.equal(sent.push[0].data.sender_name, 'Asha Rider', 'the full name, as the chat header shows it');
  assert.equal(sent.push[0].title, 'Asha Rider');
});

test('the driver answers; each side reads the conversation in order with its own messages marked mine, and unread counts follow', async () => {
  await reset();
  await say(rider(), 'Hello');
  await new Promise((r) => setTimeout(r, 3));
  await say(driver(), 'On my way');
  const forRider = (await call(chat.list, { ...rider(), query: { trip_id: 'T1' } })).body.data;
  assert.deepEqual(forRider.messages.map((x) => [x.from, x.mine, x.text]), [['rider', true, 'Hello'], ['driver', false, 'On my way']]);
  assert.equal(forRider.unread, 1, 'the driver\'s reply is unread for the rider');
  assert.equal(forRider.open, true);
  const forDriver = (await call(chat.list, { ...driver(), query: { trip_id: 'T1' } })).body.data;
  assert.equal(forDriver.unread, 1, 'the rider\'s hello is unread for the driver');
  assert.deepEqual(forDriver.messages.map((x) => x.mine), [false, true]);

  const read = await call(chat.markRead, { ...rider(), body: { trip_id: 'T1' } });
  assert.equal(read.code, 200);
  assert.equal(read.body.data.read, 1, 'only the other person\'s message was marked');
  assert.equal((await call(chat.list, { ...rider(), query: { trip_id: 'T1' } })).body.data.unread, 0);
  assert.equal((await call(chat.list, { ...driver(), query: { trip_id: 'T1' } })).body.data.unread, 1, 'the rider reading does not mark the driver\'s unread');
  assert.equal((await call(chat.markRead, { ...rider(), body: { trip_id: 'T1' } })).body.data.read, 0, 'nothing new to mark');
});

test('only the trip\'s own rider and driver can write, read or mark; everyone else is refused', async () => {
  await reset();
  await say(rider(), 'private');
  for (const who of [{ role: 'user', id: 'U2' }, { role: 'driver', id: 'D2' }]) {
    assert.equal((await say(who, 'hi')).code, 403, `${who.id} writing`);
    assert.equal((await call(chat.list, { ...who, query: { trip_id: 'T1' } })).code, 403, `${who.id} reading`);
    assert.equal((await call(chat.markRead, { ...who, body: { trip_id: 'T1' } })).code, 403, `${who.id} marking`);
  }
  assert.equal(rows().length, 1);
});

test('a trip that does not exist is 404 and a missing trip id is 400', async () => {
  await reset();
  assert.equal((await call(chat.send, { ...rider(), body: { trip_id: 'NOPE', text: 'hi' } })).code, 404);
  assert.equal((await call(chat.send, { ...rider(), body: { text: 'hi' } })).code, 400);
  assert.equal((await call(chat.list, { ...rider(), query: {} })).code, 400);
});

test('chat opens when the driver accepts and closes when the ride ends; the history stays readable', async () => {
  for (const status of ['REQUESTED', 'COMPLETED', 'CANCELLED_BY_USER', 'CANCELLED_BY_DRIVER']) {
    await reset({ status });
    const r = await say(rider(), 'hello');
    assert.equal(r.code, 409, status);
    assert.equal(r.body.errors && r.body.errors.code, 'CHAT_CLOSED', status);
  }
  await reset({ status: 'ARRIVED' });
  assert.equal((await say(rider(), 'at the gate')).code, 201);
  await db.TripDetails.updateOne({ trip_id: 'T1' }, { $set: { status: 'COMPLETED' } });
  assert.equal((await say(driver(), 'thanks')).code, 409, 'closed after completion');
  const history = await call(chat.list, { ...rider(), query: { trip_id: 'T1' } });
  assert.equal(history.code, 200);
  assert.equal(history.body.data.messages.length, 1);
  assert.equal(history.body.data.open, false);
});

test('a retry with the same client id stores and pushes the message once', async () => {
  await reset();
  const a = await say(rider(), 'Hello', { client_id: 'c-1' });
  const b = await say(rider(), 'Hello', { client_id: 'c-1' });
  assert.equal(a.code, 201);
  assert.equal(b.code, 200, 'the repeat is answered, not stored again');
  assert.equal(b.body.data.message.id, a.body.data.message.id);
  assert.equal(rows().length, 1);
  assert.equal(sent.push.length, 1);
  assert.equal(sent.live.length, 1);
  assert.equal((await say(driver(), 'Hello', { client_id: 'c-1' })).code, 201, 'the same client id from the other person is a different message');
});

test('empty and too-long messages are refused with a clear message and store nothing', async () => {
  await reset();
  const empty = await say(rider(), '   ');
  assert.equal(empty.code, 400);
  assert.ok(empty.body.errors.text);
  const long = await say(rider(), 'x'.repeat(501));
  assert.equal(long.code, 400);
  assert.match(long.body.errors.text, /500/);
  assert.equal((await say(rider(), 'x'.repeat(500))).code, 201);
  assert.equal(rows().length, 1);
});

test('twenty messages a minute is the limit for one person on one ride', async () => {
  await reset();
  for (let i = 0; i < 20; i += 1) assert.equal((await say(rider(), `m${i}`)).code, 201, `message ${i}`);
  const r = await say(rider(), 'one too many');
  assert.equal(r.code, 429);
  assert.equal((await say(driver(), 'the driver has their own allowance')).code, 201);
});

test('a business can switch chat off; the conversation then cannot be written, and says why', async () => {
  await reset();
  await db.Tenant.updateOne({ tenantId: 't1' }, { $set: { chatEnabled: false } });
  const r = await say(rider(), 'hello');
  assert.equal(r.code, 403);
  assert.equal(r.body.errors.code, 'CHAT_DISABLED');
  assert.equal((await call(chat.list, { ...rider(), query: { trip_id: 'T1' } })).body.data.enabled, false);
});

test('an account of another business cannot use this business\'s trip, even with the same ids', async () => {
  await reset();
  const stranger = { userId: 'U1', tenantId: 't2' };
  assert.equal((await call(chat.send, { ...rider({ account: stranger }), body: { trip_id: 'T1', text: 'hi' } })).code, 403);
  assert.equal((await call(chat.list, { ...rider({ account: stranger }), query: { trip_id: 'T1' } })).code, 403);
  assert.equal(rows().length, 0);
});

test('a failed push or a dead socket never stops a message being stored and answered', async () => {
  await reset();
  const [p, e] = [push.sendPushToDriver, socket.emitToDriver];
  push.sendPushToDriver = async () => { throw new Error('fcm down'); };
  socket.emitToDriver = () => { throw new Error('socket down'); };
  const log = console.warn; console.warn = () => {};
  try {
    const r = await say(rider(), 'still stored');
    assert.equal(r.code, 201);
    assert.equal(rows().length, 1);
  } finally { push.sendPushToDriver = p; socket.emitToDriver = e; console.warn = log; }
});

test('"after" returns only newer messages and the limit is kept sensible', async () => {
  await reset();
  const ids = [];
  for (let i = 0; i < 5; i += 1) { ids.push((await say(rider(), `m${i}`)).body.data.message.id); await new Promise((r) => setTimeout(r, 2)); }
  const after = await call(chat.list, { ...driver(), query: { trip_id: 'T1', after: ids[2] } });
  assert.deepEqual(after.body.data.messages.map((m) => m.text), ['m3', 'm4']);
  const limited = await call(chat.list, { ...driver(), query: { trip_id: 'T1', limit: '2' } });
  assert.deepEqual(limited.body.data.messages.map((m) => m.text), ['m3', 'm4'], 'the newest two, still in order');
  const huge = await call(chat.list, { ...driver(), query: { trip_id: 'T1', limit: '99999' } });
  assert.equal(huge.body.data.messages.length, 5);
});

test('the business\'s own staff can read a trip\'s conversation; another business\'s staff cannot', async () => {
  await reset();
  await say(rider(), 'The pickup pin is wrong');
  await say(driver(), 'I see it');
  const admin = async (business, id) => {
    const req = { business, params: { id }, query: {}, admin: { adminId: 'A1', email: 'a@t.local' }, ip: '1.1.1.1' };
    let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
    await chat.adminTripChat(req, res);
    return out;
  };
  const mine = await admin({ tenantId: 't1', isDefault: true }, 'T1');
  assert.equal(mine.code, 200, JSON.stringify(mine.body).slice(0, 200));
  assert.deepEqual(mine.body.data.messages.map((m) => [m.from, m.text]), [['rider', 'The pickup pin is wrong'], ['driver', 'I see it']]);
  assert.equal((await admin({ tenantId: 't2' }, 'T1')).code, 404, 'another business sees nothing of it');
  assert.equal((await admin({ tenantId: 't1', isDefault: true }, 'NOPE')).code, 404);
});

// ---- the business's own switch ----
const settingsCall = async (fn, { body = {}, tenantId = 't1' } = {}) => {
  const business = JSON.parse(JSON.stringify(await db.Tenant.findOne({ tenantId }).lean()));
  const scope = (f = {}) => ({ ...f, tenantId });
  const req = { body, params: {}, query: {}, ip: '1.1.1.1', business, admin: { adminId: 'A1', email: 'a@t.local' }, data: { find: (M, f) => M.find(scope(f)), findOne: (M, f) => M.findOne(scope(f)), update: (M, f, v) => M.findOneAndUpdate(scope(f), { $set: v }, { new: true }), create: (M, d) => M.create({ ...d, tenantId }) } };
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};

test('the switch is on by default, a business turns it off and on, and every change is recorded', async () => {
  await reset();
  await db.ConfigVersion.deleteMany({}); await db.AdminAudit.deleteMany({});
  assert.equal((await settingsCall(chat.getSettings)).body.data.enabled, true);
  assert.equal((await settingsCall(chat.setSettings, { body: { enabled: false } })).code, 200);
  assert.equal((await settingsCall(chat.getSettings)).body.data.enabled, false);
  assert.equal((await say(rider(), 'hello')).code, 403, 'switched off: nobody can write');
  assert.equal((await settingsCall(chat.setSettings, { body: { enabled: false } })).code, 200, 'saying the same again is harmless');
  assert.equal((await settingsCall(chat.setSettings, { body: { enabled: true } })).code, 200);
  assert.equal((await say(rider(), 'hello')).code, 201, 'switched on again');
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'chat.disabled'));
  assert.ok(db.AdminAudit.rows.some((a) => a.action === 'chat.enabled'));
  assert.equal(db.ConfigVersion.rows.filter((v) => v.source === 'business.chat_settings_updated').length, 2, 'two real changes in the settings history, not three');
});

test('a business\'s switch never touches another business', async () => {
  await reset();
  await db.Tenant.create({ tenantId: 't2', name: 'Other', slug: 'other', appName: 'Other', packageName: 'in.other' });
  await settingsCall(chat.setSettings, { body: { enabled: false }, tenantId: 't2' });
  assert.equal((await db.Tenant.findOne({ tenantId: 't1' }).lean()).chatEnabled === false, false, 't1 is still on');
  assert.equal((await say(rider(), 'hello')).code, 201);
});

test('the setting needs a yes or a no', async () => {
  await reset();
  assert.equal((await settingsCall(chat.setSettings, { body: {} })).code, 400);
  assert.equal((await settingsCall(chat.setSettings, { body: { enabled: 'maybe' } })).code, 400);
});
