// Ride chat rules, with no database: who may talk, when, what a message may be, and how fast.
const test = require('node:test');
const assert = require('node:assert/strict');
const chat = require('../lib/chat');

const trip = (over = {}) => ({ trip_id: 'T1', user_id: 'U1', driver_id: 'D1', status: 'ACCEPTED', tenant_id: 't1', ...over });

test('only the trip\'s own rider and driver are participants, and each is told who the other is', () => {
  assert.deepEqual(chat.participantOf(trip(), 'user', 'U1'), { role: 'rider', me: 'U1', other: 'D1', otherRole: 'driver' });
  assert.deepEqual(chat.participantOf(trip(), 'driver', 'D1'), { role: 'driver', me: 'D1', other: 'U1', otherRole: 'rider' });
  assert.equal(chat.participantOf(trip(), 'user', 'U2'), null, 'another rider');
  assert.equal(chat.participantOf(trip(), 'driver', 'D2'), null, 'another driver');
  assert.equal(chat.participantOf(trip({ driver_id: null }), 'driver', 'D1'), null, 'a trip no driver has accepted');
  assert.equal(chat.participantOf(trip(), 'admin', 'U1'), null, 'a role that is neither');
  assert.equal(chat.participantOf(null, 'user', 'U1'), null);
});

test('chat is open from the moment a driver accepts until the ride ends', () => {
  for (const status of ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING']) assert.equal(chat.isOpen(trip({ status })), true, status);
  for (const status of ['REQUESTED', 'COMPLETED', 'CANCELLED_BY_USER', 'CANCELLED_BY_DRIVER', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE', 'REJECTED', 'TIMEOUT']) assert.equal(chat.isOpen(trip({ status })), false, status);
  assert.equal(chat.isOpen(null), false);
});

test('a message is trimmed, control characters become spaces, and it must have 1 to 500 characters', () => {
  assert.equal(chat.cleanText('  hello  '), 'hello');
  assert.equal(chat.cleanText('a\u0000b\u0007c'), 'a b c');
  assert.equal(chat.cleanText('line one\nline two'), 'line one line two');
  assert.equal(chat.cleanText('too   many    spaces'), 'too many spaces');
  assert.equal(chat.cleanText(''), '');
  assert.equal(chat.cleanText('   '), '');
  assert.equal(chat.cleanText(null), '');
  assert.equal(chat.cleanText(42), '42');
  assert.equal(chat.cleanText('x'.repeat(501)).length, 501, 'cleaning never truncates: too long is refused, not cut');
  assert.equal(chat.validate('ok').ok, true);
  assert.equal(chat.validate('').ok, false);
  assert.equal(chat.validate('   ').ok, false);
  assert.equal(chat.validate('x'.repeat(500)).ok, true);
  assert.equal(chat.validate('x'.repeat(501)).ok, false);
  assert.match(chat.validate('x'.repeat(501)).message, /500/);
  assert.equal(chat.validate('😀 on my way').ok, true, 'emoji are fine');
});

test('no more than 20 messages a minute from one person on one ride', () => {
  const now = new Date('2026-10-27T10:00:00Z');
  const at = (s) => new Date(now.getTime() - s * 1000);
  const many = (n, s) => Array.from({ length: n }, () => ({ createdAt: at(s) }));
  assert.equal(chat.tooFast(many(19, 10), now), false);
  assert.equal(chat.tooFast(many(20, 10), now), true);
  assert.equal(chat.tooFast(many(50, 120), now), false, 'older than a minute does not count');
});

test('what the app sees of a message: who it is from, whether it is mine, and nothing internal', () => {
  const row = { messageId: 'cm_1', tripId: 'T1', tenantId: 't1', senderRole: 'driver', senderId: 'D1', text: 'Coming now', createdAt: new Date('2026-10-27T10:00:00Z'), readAt: null, clientId: 'c-1', _id: 'x' };
  const seen = chat.publicMessage(row, 'driver');
  assert.deepEqual(seen, { id: 'cm_1', trip_id: 'T1', from: 'driver', mine: true, text: 'Coming now', at: '2026-10-27T10:00:00.000Z', read: false });
  assert.equal(chat.publicMessage(row, 'rider').mine, false);
  assert.equal(chat.publicMessage({ ...row, readAt: new Date() }, 'rider').read, true);
  for (const k of ['tenantId', 'senderId', 'clientId', '_id']) assert.ok(!(k in seen), `${k} is not sent to the app`);
});
