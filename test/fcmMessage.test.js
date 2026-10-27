const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFcmMessage } = require('../config/firestore');

test('a notification message carries title, body, channel, tap action and a tag so a trip\'s messages replace each other', () => {
  const m = buildFcmMessage(' tok ', { title: 'Asha', body: 'Hello', channelId: 'chat_messages', clickAction: 'OPEN_RIDE_CHAT', tag: 'chat_T1', data: { type: 'chat_message', trip_id: 'T1' } });
  assert.equal(m.token, 'tok');
  assert.deepEqual(m.notification, { title: 'Asha', body: 'Hello' });
  assert.equal(m.android.priority, 'high');
  assert.equal(m.android.notification.channelId, 'chat_messages');
  assert.equal(m.android.notification.clickAction, 'OPEN_RIDE_CHAT');
  assert.equal(m.android.notification.tag, 'chat_T1');
  assert.deepEqual(m.data, { type: 'chat_message', trip_id: 'T1' });
});

test('without a tag or tap action nothing extra is sent, and the channel falls back to default', () => {
  const m = buildFcmMessage('tok', { title: 'Ride', body: 'Updated' });
  assert.equal(m.android.notification.channelId, 'default');
  assert.equal('clickAction' in m.android.notification, false);
  assert.equal('tag' in m.android.notification, false);
});

test('data values are stringified, because FCM only accepts strings', () => {
  const m = buildFcmMessage('tok', { title: 't', data: { n: 5, o: { a: 1 }, s: 'x' } });
  assert.deepEqual(m.data, { n: '5', o: '{"a":1}', s: 'x' });
});

test('a data-only message has no notification block and the display text moves into data', () => {
  const m = buildFcmMessage('tok', { title: 'Hi', body: 'There', channelId: 'c1' }, { dataOnly: true });
  assert.equal('notification' in m, false);
  assert.equal('notification' in m.android, false);
  assert.deepEqual([m.data.title, m.data.body, m.data.channel_id], ['Hi', 'There', 'c1']);
});
