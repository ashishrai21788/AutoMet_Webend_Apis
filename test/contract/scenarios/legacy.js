/**
 * The generic collection routes (/api/:collectionName), which store whatever fields they are sent in collections without a
 * fixed schema, and the closed ones. Create, list, read one, update, delete, odd ids, odd bodies, and the collections the
 * server refuses.
 */
module.exports = async function legacy(t) {
  const { call, alias } = t;

  // ---- what is closed
  for (const name of ['admins', 'users', 'drivers']) {
    await call(`closed: ${name} list`, { path: `/api/${name}` });
    await call(`closed: ${name} create`, { method: 'POST', path: `/api/${name}`, body: { name: 'x' } });
    await call(`closed: ${name} one`, { path: `/api/${name}/123` });
    await call(`closed: ${name} update`, { method: 'PUT', path: `/api/${name}/123`, body: { name: 'x' } });
    await call(`closed: ${name} delete`, { method: 'DELETE', path: `/api/${name}/123` });
  }
  await call('unknown collection: list', { path: '/api/widgets' });
  await call('unknown collection: create', { method: 'POST', path: '/api/widgets', body: { a: 1 } });
  await call('unknown collection: one', { path: '/api/widgets/abc' });

  // ---- an open collection with no fixed schema: driver_faqs
  await call('faqs: empty list', { path: '/api/driver_faqs', expectStatus: 200 });
  await call('faqs: create without the fields every record needs', { method: 'POST', path: '/api/driver_faqs', body: { question: 'No name or phone' } });
  const first = await call('faqs: create', { method: 'POST', path: '/api/driver_faqs', body: { name: 'Going online', phone: '+910000000001', question: 'How do I go online?', answer: 'Tap the switch on the home screen.', order: 1, tags: ['start', 'basics'], meta: { audience: 'drivers', nested: { deep: [1, 2, { three: 3 }] } }, published: true, rating: 4.5, note: null }, expectStatus: 201 });
  const id1 = first.body.data._id;
  alias(id1, 'faq1');
  const second = await call('faqs: create another, different fields', { method: 'POST', path: '/api/driver_faqs', body: { name: 'Payouts', phone: '+910000000002', question: 'Where is my payout?', translations: { hi: 'मेरा भुगतान कहाँ है?' }, order: 2 }, expectStatus: 201 });
  const id2 = second.body.data._id;
  alias(id2, 'faq2');
  await call('faqs: create from an empty body', { method: 'POST', path: '/api/driver_faqs', body: {} });
  // MongoDB builds a collection's unique indexes in the background just after the collection is first used, so a duplicate sent
  // within milliseconds can still get in. (Postgres creates its constraint before the table is used.) Give the index time.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await call('faqs: a duplicate phone', { method: 'POST', path: '/api/driver_faqs', body: { name: 'Again', phone: '+910000000001' } });
  await call('faqs: list', { path: '/api/driver_faqs', expectStatus: 200 });
  await call('faqs: read one', { path: `/api/driver_faqs/${id1}`, expectStatus: 200 });
  await call('faqs: read one that does not exist', { path: '/api/driver_faqs/650000000000000000000099' });
  await call('faqs: read with an id that is not an id', { path: '/api/driver_faqs/not-an-id' });
  await call('faqs: update', { method: 'PUT', path: `/api/driver_faqs/${id1}`, body: { answer: 'Open the app and use the duty switch.', 'meta.audience': 'everyone', extra: { added: true }, order: 10 } });
  await call('faqs: read after the update', { path: `/api/driver_faqs/${id1}` });
  await call('faqs: update with an empty body', { method: 'PUT', path: `/api/driver_faqs/${id2}`, body: {} });
  await call('faqs: update one that does not exist', { method: 'PUT', path: '/api/driver_faqs/650000000000000000000099', body: { a: 1 } });
  await call('faqs: update with an id that is not an id', { method: 'PUT', path: '/api/driver_faqs/not-an-id', body: { a: 1 } });
  await call('faqs: names with a different case reach the same collection', { path: '/api/Driver_Faqs' });
  await call('faqs: delete', { method: 'DELETE', path: `/api/driver_faqs/${id2}` });
  await call('faqs: delete again', { method: 'DELETE', path: `/api/driver_faqs/${id2}` });
  await call('faqs: delete with an id that is not an id', { method: 'DELETE', path: '/api/driver_faqs/not-an-id' });
  await call('faqs: list after the delete', { path: '/api/driver_faqs' });

  // ---- the other two open collections
  const note = await call('drivers_notification: create', { method: 'POST', path: '/api/drivers_notification', body: { name: 'Note', phone: '+910000000003', driverId: 'D-LEGACY-1', title: 'Hello', description: 'A note', isUnread: true, date: '2026-10-01' }, expectStatus: 201 });
  alias(note.body.data._id, 'note1');
  await call('drivers_notification: list', { path: '/api/drivers_notification' });
  await call('drivers_notification: update', { method: 'PUT', path: `/api/drivers_notification/${note.body.data._id}`, body: { isUnread: false } });
  await call('drivers_notification: read one', { path: `/api/drivers_notification/${note.body.data._id}` });
  const issue = await call('driver_issues: create', { method: 'POST', path: '/api/driver_issues', body: { name: 'Issue', phone: '+910000000004', driverId: 'D-LEGACY-1', issueText: 'The app is slow', status: 'issue submitted' }, expectStatus: 201 });
  alias(issue.body.data._id, 'issue1');
  await call('driver_issues: list', { path: '/api/driver_issues' });
  await call('driver_issues: delete', { method: 'DELETE', path: `/api/driver_issues/${issue.body.data._id}` });
  await call('driver_issues: list after the delete', { path: '/api/driver_issues' });
  await call('drivers_notification: delete', { method: 'DELETE', path: `/api/drivers_notification/${note.body.data._id}` });
  await call('drivers_notification: list after the delete', { path: '/api/drivers_notification' });
};
