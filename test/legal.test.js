// Legal documents: versions, publishing rules, what is in force, safe rendering, consent, and the public pages.
process.env.JWT_SECRET = 'test-secret-for-legal';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const legal = require('../lib/legal');
const A = require('../controllers/legalAdminController');
const P = require('../controllers/legalController');

const NOW = Date.now();
const DAY = 24 * 3600 * 1000;
const tenant = { tenantId: 't1', name: 'uRide', appName: 'uRide' };
const TEXT = '# Privacy\n\nWe collect your phone number and location to run rides.\n\n- Phone\n- Location\n\nContact support for any question about your data and how it is used.';

const reset = () => { for (const m of ['LegalDocument', 'LegalAcceptance', 'AdminAudit', 'Tenant']) db[m].rows.length = 0; };
const withTenant = () => db.Tenant.create({ tenantId: 't1', name: 'uRide', appName: 'uRide', isDefault: true, market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } });

const admin = async (fn, { body = {}, params = {}, query = {} } = {}) => {
  const req = { body, params, query, ip: '1.1.1.1', business: tenant, admin: { adminId: 'A1', email: 'a@t.local', role: 'client_admin' } };
  let out;
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};
const pub = async (fn, { params = {}, query = {}, headers = {}, body = {}, authRole, authActorId } = {}) => {
  const req = { params, query, body, headers, appTenant: tenant, authRole, authActorId, ip: '2.2.2.2', protocol: 'https', get: () => 'api.example.com' };
  let out; const set = {};
  const res = { code: 200, set(h, v) { if (typeof h === 'object') Object.assign(set, h); else set[h] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; }, end() { out = { code: this.code }; return this; }, type() { return this; }, send(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return { ...out, headers: set };
};
const publish = async (type, content = TEXT, extra = {}) => {
  const d = await admin(A.createDraft, { params: { type }, body: { content, ...extra.draft } });
  assert.equal(d.code, 200, JSON.stringify(d.body).slice(0, 200));
  const p = await admin(A.publish, { params: { id: d.body.data.id }, body: extra.publish || {} });
  return { draft: d, published: p };
};

test('text is escaped before it becomes HTML, so nothing a business types can run', () => {
  const html = legal.textToHtml('# <script>alert(1)</script>\n\nHello <b>x</b> & "y"\n\n- one\n- two');
  assert.ok(!/<script/i.test(html) && !/<b>x<\/b>/.test(html));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&bull; one<br>&bull; two'));
  assert.ok(html.includes('<b>&lt;script'), 'the heading is bold, with its text escaped');
});

test('the document in force is the latest one that has started; a future version waits', () => {
  const docs = [
    { type: 'PRIVACY_POLICY', version: 1, status: 'PUBLISHED', effectiveAt: new Date(NOW - 30 * DAY), title: 'a', content: 'x' },
    { type: 'PRIVACY_POLICY', version: 2, status: 'PUBLISHED', effectiveAt: new Date(NOW - DAY), title: 'a', content: 'y' },
    { type: 'PRIVACY_POLICY', version: 3, status: 'PUBLISHED', effectiveAt: new Date(NOW + 5 * DAY), title: 'a', content: 'z' },
    { type: 'PRIVACY_POLICY', version: 4, status: 'DRAFT', effectiveAt: null, title: 'a', content: 'w' }
  ];
  assert.equal(legal.inForce(docs).get('PRIVACY_POLICY').version, 2);
  assert.equal(legal.inForce(docs, new Date(NOW + 6 * DAY)).get('PRIVACY_POLICY').version, 3, 'and then the new one takes over');
});

test('admin: drafts are numbered, one draft at a time, validated, and a published version is never changed or deleted', async () => {
  reset();
  const first = await admin(A.createDraft, { params: { type: 'PRIVACY_POLICY' }, body: { content: TEXT } });
  assert.equal(first.code, 200);
  assert.equal(first.body.data.version, 1);
  assert.equal((await admin(A.createDraft, { params: { type: 'PRIVACY_POLICY' } })).code, 409, 'a draft already exists');
  assert.equal((await admin(A.createDraft, { params: { type: 'NOT_A_TYPE' } })).code, 404);
  assert.equal((await admin(A.updateDraft, { params: { id: first.body.data.id }, body: { title: 'x' } })).code, 400, 'title too short');
  assert.equal((await admin(A.publish, { params: { id: first.body.data.id } })).code, 200, 'publish with no date: in force now');
  assert.equal((await admin(A.updateDraft, { params: { id: first.body.data.id }, body: { title: 'Changed title' } })).code, 409, 'published: no edits');
  assert.equal((await admin(A.deleteDraft, { params: { id: first.body.data.id } })).code, 409, 'published: no delete');
  assert.equal((await admin(A.publish, { params: { id: first.body.data.id } })).code, 409, 'already published');
  // the next draft starts from the text in force
  const second = await admin(A.createDraft, { params: { type: 'PRIVACY_POLICY' } });
  assert.equal(second.body.data.version, 2);
  assert.equal(second.body.data.content, TEXT);
  assert.equal((await admin(A.deleteDraft, { params: { id: second.body.data.id } })).code, 200, 'a draft can go');
  assert.ok(db.AdminAudit.rows.some((r) => r.action === 'legal.published'));
});

test('publishing checks the text and the date: too short, too far ahead, or before the version it replaces', async () => {
  reset();
  const d = await admin(A.createDraft, { params: { type: 'TERMS_RIDER' }, body: { content: 'too short' } });
  const short = await admin(A.publish, { params: { id: d.body.data.id } });
  assert.equal(short.code, 400); assert.ok(short.body.errors.content);
  await admin(A.updateDraft, { params: { id: d.body.data.id }, body: { content: TEXT } });
  const far = await admin(A.publish, { params: { id: d.body.data.id }, body: { effectiveAt: new Date(NOW + 400 * DAY).toISOString() } });
  assert.ok(far.body.errors.effectiveAt);
  assert.equal((await admin(A.publish, { params: { id: d.body.data.id }, body: { effectiveAt: new Date(NOW - 10 * DAY).toISOString() } })).code, 200);
  const d2 = await admin(A.createDraft, { params: { type: 'TERMS_RIDER' } });
  const early = await admin(A.publish, { params: { id: d2.body.data.id }, body: { effectiveAt: new Date(NOW - 20 * DAY).toISOString() } });
  assert.ok(early.body.errors.effectiveAt, 'cannot start before the version it replaces');
});

test('public: the apps get what is in force for their audience, with a hosted link; nothing published means no document', async () => {
  reset();
  assert.equal((await pub(P.one, { params: { type: 'privacy_policy' } })).code, 404, 'nothing published: the app uses its built-in text');
  await publish('PRIVACY_POLICY');
  await publish('TERMS_DRIVER');
  await publish('TERMS_RIDER');
  const rider = (await pub(P.list, { query: { audience: 'rider' } })).body.data.items.map((i) => i.type);
  assert.deepEqual(rider.sort(), ['PRIVACY_POLICY', 'TERMS_RIDER']);
  const driver = (await pub(P.list, { query: { audience: 'driver' } })).body.data.items.map((i) => i.type);
  assert.deepEqual(driver.sort(), ['PRIVACY_POLICY', 'TERMS_DRIVER']);
  const one = await pub(P.one, { params: { type: 'privacy_policy' } });
  assert.equal(one.code, 200);
  assert.equal(one.body.data.url, 'https://api.example.com/legal/t1/PRIVACY_POLICY');
  assert.ok(one.body.data.html.includes('&bull; Phone'));
  const again = await pub(P.one, { params: { type: 'PRIVACY_POLICY' }, headers: { 'if-none-match': one.headers.ETag } });
  assert.equal(again.code, 304, 'an unchanged document costs nothing');
});

test('the web page shows the document in force and escapes it', async () => {
  reset(); await withTenant();
  await publish('PRIVACY_POLICY', TEXT.replace('# Privacy', '# <img src=x onerror=alert(1)>'));
  const page = (await pub(P.page, { params: { appId: 't1', type: 'privacy_policy' } }));
  assert.equal(page.code, 200);
  assert.ok(!/<img src=x/.test(page.body) && page.body.includes('&lt;img'));
  assert.ok(/Version 1/.test(page.body));
  assert.equal((await pub(P.page, { params: { appId: 't1', type: 'terms_rider' } })).code, 404);
});

test('consent: required documents are pending until accepted, only the version in force can be accepted, and it is recorded once', async () => {
  reset();
  await publish('PRIVACY_POLICY', TEXT, { draft: { consentRequired: true } });
  await publish('LOCATION_DISCLOSURE', TEXT, { draft: { consentRequired: false } });
  const who = { authRole: 'user', authActorId: 'U1' };
  let pend = (await pub(P.pending, who)).body.data.items;
  assert.deepEqual(pend.map((i) => i.type), ['PRIVACY_POLICY'], 'only the one that needs consent');
  assert.equal((await pub(P.accept, { ...who, body: { type: 'PRIVACY_POLICY', version: 99 } })).code, 409, 'a stale version is refused');
  assert.equal((await pub(P.accept, { ...who, body: { type: 'TERMS_DRIVER', version: 1 } })).code, 400, 'not a document for a rider');
  assert.equal((await pub(P.accept, { ...who, body: { type: 'PRIVACY_POLICY', version: 1 } })).code, 200);
  assert.equal((await pub(P.accept, { ...who, body: { type: 'PRIVACY_POLICY', version: 1 } })).code, 200, 'again: still fine');
  assert.equal(db.LegalAcceptance.rows.length, 1, 'recorded once');
  pend = (await pub(P.pending, who)).body.data.items;
  assert.equal(pend.length, 0);
  // a new version asks again
  const d = await admin(A.createDraft, { params: { type: 'PRIVACY_POLICY' } });
  await admin(A.publish, { params: { id: d.body.data.id } });
  pend = (await pub(P.pending, who)).body.data.items;
  assert.equal(pend[0].version, 2, 'everyone is asked to agree to the new version');
  // a driver is a different account and is asked separately
  assert.equal((await pub(P.pending, { authRole: 'driver', authActorId: 'D1' })).body.data.items.length, 1);
  assert.equal((await pub(P.pending, {})).code, 403, 'not signed in');
  const counts = (await admin(A.acceptances)).body.data.items;
  assert.equal(counts.find((x) => x.type === 'PRIVACY_POLICY' && x.version === 1).riders, 1);
});

test('the acceptance counts are counted in the database, not by loading every acceptance', async () => {
  for (const m of ['LegalDocument', 'LegalAcceptance', 'AdminAudit', 'Tenant']) await db[m].deleteMany({}); // a real delete, so it also holds on Postgres
  await withTenant();
  await publish('PRIVACY_POLICY');
  await publish('TERMS_RIDER');
  const at = new Date();
  const agree = (role, accountId, type, version) => db.LegalAcceptance.create({ tenantId: 't1', role, accountId, type, version, at });
  for (let i = 0; i < 5; i += 1) await agree('rider', `R${i}`, 'PRIVACY_POLICY', 1);
  await agree('driver', 'D1', 'PRIVACY_POLICY', 1);
  await agree('driver', 'D2', 'PRIVACY_POLICY', 1);
  await db.LegalAcceptance.create({ tenantId: 't2', role: 'rider', accountId: 'X', type: 'PRIVACY_POLICY', version: 1, at }); // another business
  const original = db.LegalAcceptance.find;
  db.LegalAcceptance.find = () => { throw new Error('the acceptance rows must not be loaded'); };
  try {
    const items = (await admin(A.acceptances)).body.data.items;
    assert.deepEqual(items.map((x) => [x.type, x.version, x.riders, x.drivers]), [['PRIVACY_POLICY', 1, 5, 2]], 'a version nobody agreed to is left out, and another business is not counted');
  } finally { db.LegalAcceptance.find = original; }
});
