// Driver and vehicle management over HTTP: the real routes and controllers, with in-memory stand-ins for the database
// models and for private document storage. Covers validation, document security, verification, assignments and
// isolation between businesses.
process.env.JWT_SECRET = 'test-secret-for-fleet-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');
const { createFakeDb } = require('./helpers/fakeDb');
const { createMemoryStorage } = require('./helpers/memoryStorage');
const { jsonBodyParser } = require('../lib/jsonBody');

const db = createFakeDb();
db.install();
const storage = createMemoryStorage();
const privateStorage = require('../lib/privateStorage');
privateStorage.setBackend(storage);
const adminRoutes = require('../routes/adminRoutes');

let server;
let base;
const hash = (pw) => bcrypt.hashSync(pw, 4);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 1)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 9)]);
const FUTURE = '2031-06-30';

const ctx = {};

test.before(async () => {
  const mkTenant = (tenantId, name, extra = {}) => db.Tenant.create({
    tenantId, name, slug: tenantId, appName: name, packageName: `com.${tenantId}.app`, status: 'active', plan: 'standard',
    market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }, ...extra
  });
  await mkTenant('app_a', 'Alpha');
  await mkTenant('app_b', 'Beta');
  await mkTenant('app_def', 'Default', { isDefault: true });

  const mkRegion = (tenantId, regionId, city, active = true) => db.ServiceRegion.create({ tenantId, regionId, country: 'IN', state: 'S', city, zoneName: 'All areas', key: `${tenantId}-${regionId}`, active });
  await mkRegion('app_a', 'rg_a1', 'Pune');
  await mkRegion('app_a', 'rg_a2', 'Mumbai');
  await mkRegion('app_a', 'rg_a_off', 'Nagpur', false);
  await mkRegion('app_b', 'rg_b1', 'Delhi');
  await mkRegion('app_def', 'rg_d1', 'Jaipur');

  const mkCat = (tenantId, categoryId, name, regionIds) => db.VehicleCategory.create({ tenantId, categoryId, name, nameKey: `${tenantId}-${name}`, active: true, regionIds, passengerCapacity: 4, rideType: 'economy' });
  await mkCat('app_a', 'vc_a_sedan', 'Sedan', ['rg_a1', 'rg_a2']);
  await mkCat('app_a', 'vc_a_bike', 'Bike', ['rg_a1']);
  await mkCat('app_b', 'vc_b_sedan', 'Sedan', ['rg_b1']);
  await mkCat('app_def', 'vc_d_auto', 'Auto', ['rg_d1']);

  const mkAdmin = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: hash(pw) });
  await mkAdmin('u_super', 'super@x.test', 'super_admin', null, 'super-password-1');
  await mkAdmin('u_a_admin', 'admin@a.test', 'client_admin', 'app_a', 'password-a-admin');
  await mkAdmin('u_a_ops', 'ops@a.test', 'operations', 'app_a', 'password-a-ops1');
  await mkAdmin('u_a_support', 'support@a.test', 'support', 'app_a', 'password-a-supp');
  await mkAdmin('u_a_finance', 'finance@a.test', 'finance', 'app_a', 'password-a-fin1');
  await mkAdmin('u_b_admin', 'admin@b.test', 'client_admin', 'app_b', 'password-b-admin');
  await mkAdmin('u_def_admin', 'admin@def.test', 'client_admin', 'app_def', 'password-d-admin');

  // a driver from before businesses were tracked: no tenant tag, so it belongs to the default business
  await db.Driver.create({ driverId: '0000000001', firstName: 'Legacy', lastName: 'Driver', email: 'legacy@x.test', phone: '9000000001', passwordHash: 'x', createdAt: new Date('2025-01-01') });

  const app = express();
  app.use(jsonBodyParser());
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
test.after(() => server.close());

async function signIn(email, password) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return (await res.json()).data.token;
}

async function call(method, url, { token, appId, body, form } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(appId ? { 'X-App-Id': appId } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined)
  });
  return { status: res.status, body: await res.json() };
}

const upload = (token, appId, kind, id, { type, number, expiryDate, bytes = JPEG, name = 'doc.jpg', mime = 'image/jpeg' }) => {
  const form = new FormData();
  form.append('type', type);
  if (number) form.append('number', number);
  if (expiryDate) form.append('expiryDate', expiryDate);
  if (bytes) form.append('file', new Blob([bytes], { type: mime }), name);
  return call('POST', `/business/${kind}/${id}/documents`, { token, appId, form });
};

const driverBody = (over = {}) => ({
  fullName: 'Ravi Kumar', phone: '+919811111111', email: 'ravi@example.com', dateOfBirth: '1990-04-02',
  address: { country: 'IN', state: 'Maharashtra', city: 'Pune', line: '1 Main Road' },
  operatingRegionId: 'rg_a1', eligibleCategoryId: 'vc_a_sedan', ...over
});
const vehicleBody = (over = {}) => ({
  registrationNumber: 'MH12AB1234', make: 'Maruti', model: 'Dzire', year: 2021, colour: 'White', categoryId: 'vc_a_sedan',
  passengerCapacity: 4, luggageCapacity: 2, operatingRegionId: 'rg_a1', status: 'INACTIVE', ...over
});

test('sign in as every role', async () => {
  ctx.super = await signIn('super@x.test', 'super-password-1');
  ctx.admin = await signIn('admin@a.test', 'password-a-admin');
  ctx.ops = await signIn('ops@a.test', 'password-a-ops1');
  ctx.support = await signIn('support@a.test', 'password-a-supp');
  ctx.finance = await signIn('finance@a.test', 'password-a-fin1');
  ctx.bAdmin = await signIn('admin@b.test', 'password-b-admin');
  ctx.defAdmin = await signIn('admin@def.test', 'password-d-admin');
  for (const k of ['super', 'admin', 'ops', 'support', 'finance', 'bAdmin', 'defAdmin']) assert.ok(ctx[k], k);
  ctx.a = { token: ctx.admin, appId: 'app_a' };
  ctx.b = { token: ctx.bAdmin, appId: 'app_b' };
});

// ----------------------------------- drivers -----------------------------------

test('create driver: required fields and formats are validated field by field', async () => {
  const r = await call('POST', '/business/drivers', { ...ctx.a, body: { fullName: '', phone: '98765', email: 'nope', dateOfBirth: '2015-01-01' } });
  assert.equal(r.status, 400);
  for (const f of ['fullName', 'phone', 'email', 'dateOfBirth', 'operatingRegionId', 'eligibleCategoryId']) assert.ok(r.body.errors[f], `error for ${f}`);
});

test('create driver: region and category must be this business\'s, active, and offered together', async () => {
  const other = await call('POST', '/business/drivers', { ...ctx.a, body: driverBody({ operatingRegionId: 'rg_b1' }) });
  assert.equal(other.status, 400, 'another business\'s region is not found');
  assert.ok(other.body.errors.operatingRegionId);
  const inactive = await call('POST', '/business/drivers', { ...ctx.a, body: driverBody({ operatingRegionId: 'rg_a_off' }) });
  assert.ok(inactive.body.errors.operatingRegionId);
  const notOffered = await call('POST', '/business/drivers', { ...ctx.a, body: driverBody({ eligibleCategoryId: 'vc_a_bike', operatingRegionId: 'rg_a2' }) });
  assert.ok(notOffered.body.errors.eligibleCategoryId, 'the bike category is only offered in Pune');
  const foreignCategory = await call('POST', '/business/drivers', { ...ctx.a, body: driverBody({ eligibleCategoryId: 'vc_b_sedan' }) });
  assert.ok(foreignCategory.body.errors.eligibleCategoryId);
});

test('create driver: success, then duplicate phone and email are refused without revealing whose record', async () => {
  const created = await call('POST', '/business/drivers', { ...ctx.a, body: driverBody() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.d1 = created.body.data.id;
  assert.match(ctx.d1, /^\d{10}$/);

  const dupPhone = await call('POST', '/business/drivers', { ...ctx.a, body: driverBody({ email: 'other@example.com', phone: '+91 98111-11111' }) });
  assert.equal(dupPhone.status, 409);
  assert.ok(dupPhone.body.errors.phone);
  assert.equal(JSON.stringify(dupPhone.body).includes(ctx.d1), false, 'the existing driver\'s id is not revealed');
  const dupEmail = await call('POST', '/business/drivers', { ...ctx.a, body: driverBody({ phone: '+919822222222' }) });
  assert.equal(dupEmail.status, 409);
  assert.ok(dupEmail.body.errors.email);
  // phone numbers are unique across businesses, so another business cannot reuse it either
  const crossDup = await call('POST', '/business/drivers', { ...ctx.b, body: driverBody({ operatingRegionId: 'rg_b1', eligibleCategoryId: 'vc_b_sedan', email: 'new@b.test' }) });
  assert.equal(crossDup.status, 409);
});

test('a driver without an email gets a placeholder that is never shown', async () => {
  const r = await call('POST', '/business/drivers', { ...ctx.a, body: driverBody({ fullName: 'Meena Joshi', phone: '+919833333333', email: '' }) });
  assert.equal(r.status, 201);
  ctx.d2 = r.body.data.id;
  const detail = await call('GET', `/business/drivers/${ctx.d2}`, ctx.a);
  assert.equal(detail.body.data.email, null);
  assert.equal(JSON.stringify(detail.body).includes('noreply.invalid'), false);
  assert.equal(db.Driver.rows.find((d) => d.driverId === ctx.d2).email.endsWith('@noreply.invalid'), true);
});

test('driver detail: new drivers are unverified and not eligible; secrets are never returned', async () => {
  const r = await call('GET', `/business/drivers/${ctx.d1}`, ctx.a);
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.name, 'Ravi Kumar');
  assert.equal(d.accountStatus, 'ACTIVE');
  assert.equal(d.verificationStatus, 'INCOMPLETE');
  assert.equal(d.eligibility.eligible, false);
  assert.ok(d.eligibility.reasons.some((x) => x.code === 'DRIVER_NOT_VERIFIED'));
  assert.ok(d.eligibility.reasons.some((x) => x.code === 'NO_VEHICLE'));
  assert.equal(d.vehicle, null);
  assert.equal(d.activity.createdByAdmin, true);
  for (const secret of ['passwordHash', 'accessToken', 'fcmToken']) assert.equal(JSON.stringify(r.body).includes(secret), false, secret);
  assert.equal((await call('GET', '/business/drivers/does-not-exist', ctx.a)).status, 404);
});

test('driver list: search, filters and server-side pagination', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/business/drivers', { ...ctx.a, body: driverBody({ fullName: `Test Driver${i}`, phone: `+91990000000${i}`, email: `t${i}@example.com`, operatingRegionId: 'rg_a2' }) });
    assert.equal(r.status, 201);
  }
  const all = await call('GET', '/business/drivers?pageSize=3', ctx.a);
  assert.equal(all.body.data.total, 7);
  assert.equal(all.body.data.items.length, 3);
  assert.equal(all.body.data.page, 1);
  const page3 = await call('GET', '/business/drivers?pageSize=3&page=3', ctx.a);
  assert.equal(page3.body.data.items.length, 1);

  assert.equal((await call('GET', '/business/drivers?search=ravi', ctx.a)).body.data.total, 1);
  assert.equal((await call('GET', '/business/drivers?search=kumar%20ravi', ctx.a)).body.data.total, 1, 'every word must match, in any order');
  assert.equal((await call('GET', `/business/drivers?search=${ctx.d1}`, ctx.a)).body.data.total, 1, 'by driver id');
  assert.equal((await call('GET', '/business/drivers?search=9811111111', ctx.a)).body.data.total, 1, 'by phone');
  assert.equal((await call('GET', '/business/drivers?search=driver3', ctx.a)).body.data.total, 1);
  assert.equal((await call('GET', '/business/drivers?search=%5E.*%24', ctx.a)).body.data.total, 0, 'regex characters are matched literally');
  assert.equal((await call('GET', '/business/drivers?regionId=rg_a2', ctx.a)).body.data.total, 5);
  assert.equal((await call('GET', '/business/drivers?account=SUSPENDED', ctx.a)).body.data.total, 0);
  assert.equal((await call('GET', '/business/drivers?account=ACTIVE', ctx.a)).body.data.total, 7);
  assert.equal((await call('GET', '/business/drivers?verification=INCOMPLETE', ctx.a)).body.data.total, 7);
  assert.equal((await call('GET', '/business/drivers?verification=APPROVED', ctx.a)).body.data.total, 0);
  assert.equal((await call('GET', '/business/drivers?categoryId=vc_a_sedan', ctx.a)).body.data.total, 7);
  const item = all.body.data.items[0];
  for (const f of ['id', 'name', 'phone', 'verificationStatus', 'accountStatus', 'registeredAt', 'eligible']) assert.ok(f in item, f);
  assert.equal('licenceNumber' in item || 'documents' in item, false, 'no sensitive details in the list');
});

test('default business: untagged drivers from before multi-business belong to it and to nobody else', async () => {
  const mine = await call('GET', '/business/drivers', { token: ctx.defAdmin, appId: 'app_def' });
  assert.deepEqual(mine.body.data.items.map((d) => d.id), ['0000000001']);
  const legacy = await call('GET', '/business/drivers/0000000001', { token: ctx.defAdmin, appId: 'app_def' });
  assert.equal(legacy.status, 200);
  assert.equal((await call('GET', '/business/drivers/0000000001', ctx.a)).status, 404, 'not visible to another business');
  assert.equal((await call('GET', '/business/drivers/0000000001', ctx.b)).status, 404);
  // a driver added by the default business is stamped with its appId
  const created = await call('POST', '/business/drivers', { token: ctx.defAdmin, appId: 'app_def', body: driverBody({ fullName: 'Dev Default', phone: '+919844444444', email: 'dev@d.test', operatingRegionId: 'rg_d1', eligibleCategoryId: 'vc_d_auto' }) });
  assert.equal(created.status, 201);
  assert.equal(db.Driver.rows.find((d) => d.driverId === created.body.data.id).tenantId, 'app_def');
});

test('update driver: edits are validated, duplicates refused, status is not editable here', async () => {
  const ok = await call('PATCH', `/business/drivers/${ctx.d2}`, { ...ctx.a, body: { fullName: 'Meena J Joshi', address: { country: 'IN', state: 'MH', city: 'Pune', line: '2 Lake Road' } } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', `/business/drivers/${ctx.d2}`, ctx.a)).body.data.name, 'Meena J Joshi');
  assert.equal((await call('PATCH', `/business/drivers/${ctx.d2}`, { ...ctx.a, body: { phone: '+919811111111' } })).status, 409, 'cannot take another driver\'s phone');
  assert.equal((await call('PATCH', `/business/drivers/${ctx.d2}`, { ...ctx.a, body: { phone: '12' } })).status, 400);
  assert.equal((await call('PATCH', `/business/drivers/${ctx.d2}`, { ...ctx.a, body: { operatingRegionId: 'rg_b1' } })).status, 400);
  assert.equal((await call('PATCH', `/business/drivers/${ctx.d2}`, { ...ctx.a, body: { eligibleCategoryId: '' } })).status, 400);
  await call('PATCH', `/business/drivers/${ctx.d2}`, { ...ctx.a, body: { accountStatus: 'SUSPENDED' } });
  assert.equal((await call('GET', `/business/drivers/${ctx.d2}`, ctx.a)).body.data.accountStatus, 'ACTIVE', 'accountStatus in an edit is ignored');
  // keeping their own phone is fine
  assert.equal((await call('PATCH', `/business/drivers/${ctx.d2}`, { ...ctx.a, body: { phone: '+91 98333 33333' } })).status, 200);
});

test('account status: deactivate, suspend (reason required), reactivate; history is kept', async () => {
  assert.equal((await call('POST', `/business/drivers/${ctx.d2}/status`, { ...ctx.a, body: { status: 'SUSPENDED' } })).status, 400, 'a suspension needs a reason');
  assert.equal((await call('POST', `/business/drivers/${ctx.d2}/status`, { ...ctx.a, body: { status: 'ACTIVE' } })).status, 409, 'already active');
  assert.equal((await call('POST', `/business/drivers/${ctx.d2}/status`, { ...ctx.a, body: { status: 'DELETED' } })).status, 400);
  assert.equal((await call('POST', `/business/drivers/${ctx.d2}/status`, { ...ctx.a, body: { status: 'SUSPENDED', reason: 'Complaint under review' } })).status, 200);
  assert.equal((await call('GET', `/business/drivers/${ctx.d2}`, ctx.a)).body.data.accountStatus, 'SUSPENDED');
  assert.equal((await call('POST', `/business/drivers/${ctx.d2}/status`, { ...ctx.a, body: { status: 'ACTIVE' } })).status, 200);
  const history = (await call('GET', `/business/drivers/${ctx.d2}/history`, ctx.a)).body.data;
  const changes = history.filter((h) => h.action === 'ACCOUNT_STATUS_CHANGED');
  assert.equal(changes.length, 2);
  assert.ok(changes.some((h) => h.to === 'SUSPENDED' && h.reason === 'Complaint under review' && h.actor === 'admin@a.test'));
  assert.ok(history.some((h) => h.action === 'CREATED'), 'records are never deleted: creation stays in the history');
  assert.equal(db.Driver.rows.some((d) => d.driverId === ctx.d2), true);
});

// ----------------------------------- documents -----------------------------------

test('documents: the file\'s real type, size, required fields and expiry are enforced', async () => {
  const { token, appId } = ctx.a;
  const up = (over) => upload(token, appId, 'drivers', ctx.d1, over);
  assert.equal((await up({ type: 'NOPE', number: 'X', bytes: JPEG })).status, 400);
  const noFile = await up({ type: 'DRIVING_LICENCE', number: 'DL1', expiryDate: FUTURE, bytes: null });
  assert.equal(noFile.status, 400);
  assert.ok(noFile.body.errors.file);
  const exe = await up({ type: 'DRIVING_LICENCE', number: 'DL1', expiryDate: FUTURE, bytes: EXE, name: 'licence.jpg', mime: 'image/jpeg' });
  assert.equal(exe.status, 400, 'an executable named .jpg is refused');
  assert.match(exe.body.errors.file, /JPEG, PNG, WebP or PDF/);
  const noNumber = await up({ type: 'DRIVING_LICENCE', expiryDate: FUTURE });
  assert.ok(noNumber.body.errors.number);
  const noExpiry = await up({ type: 'DRIVING_LICENCE', number: 'DL1' });
  assert.ok(noExpiry.body.errors.expiryDate);
  const expired = await up({ type: 'DRIVING_LICENCE', number: 'DL1', expiryDate: '2020-01-01' });
  assert.match(expired.body.errors.expiryDate, /already expired/);
  const big = await up({ type: 'DRIVING_LICENCE', number: 'DL1', expiryDate: FUTURE, bytes: Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024 + 10)]) });
  assert.equal(big.status, 413);
  assert.equal(db.DriverDocument.rows.length, 0, 'nothing was stored for any of the refused uploads');
  assert.equal(storage.files.size, 0, 'and nothing reached storage');
  const photoAsPdf = await up({ type: 'PROFILE_PHOTO', bytes: PDF, name: 'photo.pdf', mime: 'application/pdf' });
  assert.equal(photoAsPdf.status, 400, 'a photo must be an image');
});

test('documents: upload works, files go to private storage, and no file link is ever stored', async () => {
  const { token, appId } = ctx.a;
  const lic = await upload(token, appId, 'drivers', ctx.d1, { type: 'DRIVING_LICENCE', number: 'DL-0420110012345', expiryDate: FUTURE });
  assert.equal(lic.status, 201, JSON.stringify(lic.body));
  ctx.licDoc = lic.body.data.document.id;
  assert.equal(lic.body.data.document.status, 'SUBMITTED');
  assert.equal(lic.body.data.verificationStatus, 'INCOMPLETE', 'one of two mandatory documents');
  const row = db.DriverDocument.rows.find((d) => d.docId === ctx.licDoc);
  assert.equal(row.tenantId, 'app_a');
  assert.match(row.file.key, /^automet\/app_a\/driver-documents\//);
  assert.equal(row.file.mime, 'image/jpeg');
  assert.equal(JSON.stringify(row).includes('http'), false, 'no URL is stored with the document');

  const id = await upload(token, appId, 'drivers', ctx.d1, { type: 'IDENTITY', number: 'ID-778899', bytes: PDF, name: 'id.pdf', mime: 'application/pdf' });
  assert.equal(id.status, 201);
  ctx.idDoc = id.body.data.document.id;
  assert.equal(id.body.data.verificationStatus, 'PENDING_REVIEW');
  const photo = await upload(token, appId, 'drivers', ctx.d1, { type: 'PROFILE_PHOTO' });
  assert.equal(photo.status, 201);
  assert.equal(photo.body.data.document.status, 'APPROVED', 'photos need no review');
});

test('documents: the list shows requirements and statuses; roles without document access see masked numbers', async () => {
  const full = await call('GET', `/business/drivers/${ctx.d1}/documents`, ctx.a);
  assert.equal(full.status, 200);
  const lic = full.body.data.requirements.find((r) => r.type === 'DRIVING_LICENCE');
  assert.equal(lic.mandatory, true);
  assert.equal(lic.document.number, 'DL-0420110012345');
  assert.equal(full.body.data.canView, true);
  assert.equal(full.body.data.requirements.find((r) => r.type === 'ADDRESS_PROOF').document, null);

  const masked = await call('GET', `/business/drivers/${ctx.d1}/documents`, { token: ctx.support, appId: 'app_a' });
  assert.equal(masked.status, 200, 'support can see that documents exist');
  const m = masked.body.data.requirements.find((r) => r.type === 'DRIVING_LICENCE').document;
  assert.notEqual(m.number, 'DL-0420110012345');
  assert.match(m.number, /2345$/);
  assert.equal(m.viewable, false);
  assert.equal(m.fileName, null);
  assert.equal(JSON.stringify(masked.body).includes('0420110012'), false);
});

test('document links: short-lived, signed, role-restricted and audited', async () => {
  const link = await call('GET', `/business/driver-documents/${ctx.licDoc}/url`, ctx.a);
  assert.equal(link.status, 200);
  assert.equal(link.body.data.expiresInSeconds, 300);
  const url = link.body.data.url;
  assert.equal(storage.read(url).status, 200);
  assert.equal(storage.read(url).mime, 'image/jpeg');
  // the signature protects the link: changing the file or the expiry breaks it
  const tampered = url.replace(/sig=[0-9a-f]+/, 'sig=' + '0'.repeat(64));
  assert.equal(storage.read(tampered).status, 403);
  assert.equal(storage.read(url.replace(/exp=\d+/, 'exp=9999999999')).status, 403);
  assert.equal(storage.read(url, Date.now() + 10 * 60 * 1000).status, 410, 'expires after a few minutes');

  assert.equal((await call('GET', `/business/driver-documents/${ctx.licDoc}/url`, { token: ctx.support, appId: 'app_a' })).status, 403, 'support cannot open documents');
  assert.equal((await call('GET', `/business/driver-documents/${ctx.licDoc}/url`, { token: ctx.finance, appId: 'app_a' })).status, 403);
  assert.equal((await call('GET', `/business/driver-documents/${ctx.licDoc}/url`, { token: ctx.ops, appId: 'app_a' })).status, 200, 'operations can');
  assert.equal((await call('GET', `/business/driver-documents/${ctx.licDoc}/url`, { appId: 'app_a' })).status, 401);
  const viewed = db.AdminAudit.rows.filter((a) => a.action === 'driver_document.viewed');
  assert.ok(viewed.length >= 2);
  assert.equal(JSON.stringify(viewed).includes('sig='), false, 'the audit log never contains the link');
  assert.equal(viewed[0].actorEmail, 'admin@a.test');
});

test('storage unavailable: uploads are refused clearly instead of falling back to anything public', async () => {
  privateStorage.setBackend(null);
  const r = await upload(ctx.admin, 'app_a', 'drivers', ctx.d2, { type: 'DRIVING_LICENCE', number: 'DL9', expiryDate: FUTURE });
  assert.equal(r.status, 503);
  assert.match(r.body.message, /not configured/);
  assert.equal(db.DriverDocument.rows.filter((d) => d.driverId === ctx.d2).length, 0);
  privateStorage.setBackend(storage);
});

// ----------------------------------- verification workflow -----------------------------------

test('verification: nothing is approved until every mandatory document is; approval needs the right role', async () => {
  const { token, appId } = ctx.a;
  const detail = async () => (await call('GET', `/business/drivers/${ctx.d1}`, ctx.a)).body.data;
  assert.equal((await detail()).verificationStatus, 'PENDING_REVIEW');

  assert.equal((await call('POST', `/business/driver-documents/${ctx.licDoc}/review`, { token: ctx.support, appId, body: { decision: 'APPROVE' } })).status, 403, 'support cannot approve');
  assert.equal((await call('POST', `/business/driver-documents/${ctx.licDoc}/review`, { token: ctx.finance, appId, body: { decision: 'APPROVE' } })).status, 403);
  assert.equal((await call('POST', `/business/driver-documents/${ctx.licDoc}/review`, { token, appId, body: { decision: 'MAYBE' } })).status, 400);

  const approveLic = await call('POST', `/business/driver-documents/${ctx.licDoc}/review`, { token: ctx.ops, appId, body: { decision: 'APPROVE' } });
  assert.equal(approveLic.status, 200);
  assert.equal(approveLic.body.data.verificationStatus, 'PENDING_REVIEW', 'identity is still waiting');
  assert.equal((await call('POST', `/business/driver-documents/${ctx.licDoc}/review`, { token, appId, body: { decision: 'APPROVE' } })).status, 409, 'already approved');

  const approveId = await call('POST', `/business/driver-documents/${ctx.idDoc}/review`, { token, appId, body: { decision: 'APPROVE' } });
  assert.equal(approveId.body.data.verificationStatus, 'APPROVED');
  assert.equal((await detail()).verificationStatus, 'APPROVED');
  assert.equal((await call('GET', '/business/drivers?verification=APPROVED', ctx.a)).body.data.total, 1);
});

test('verification: a rejection must give a reason, blocks approval, and a resubmission restarts review', async () => {
  const { token, appId } = ctx.a;
  const noReason = await call('POST', `/business/driver-documents/${ctx.idDoc}/review`, { token, appId, body: { decision: 'REJECT' } });
  assert.equal(noReason.status, 400);
  assert.ok(noReason.body.errors.reason);
  assert.equal((await call('POST', `/business/driver-documents/${ctx.idDoc}/review`, { token, appId, body: { decision: 'REJECT', reason: 'no' } })).status, 400);

  const reject = await call('POST', `/business/driver-documents/${ctx.idDoc}/review`, { token, appId, body: { decision: 'REJECT', reason: 'The photo is blurry, please upload a clear copy' } });
  assert.equal(reject.status, 200, 'an approved document can be revoked with a reason');
  assert.equal(reject.body.data.verificationStatus, 'REJECTED');
  assert.equal((await call('GET', '/business/drivers?verification=REJECTED', ctx.a)).body.data.total, 1);
  assert.equal((await call('POST', `/business/driver-documents/${ctx.idDoc}/review`, { token, appId, body: { decision: 'APPROVE' } })).status, 409, 'a rejected document needs a new upload first');

  const docs = (await call('GET', `/business/drivers/${ctx.d1}/documents`, ctx.a)).body.data.requirements.find((r) => r.type === 'IDENTITY').document;
  assert.equal(docs.rejectionReason, 'The photo is blurry, please upload a clear copy');
  assert.equal(docs.status, 'REJECTED');

  const again = await upload(token, appId, 'drivers', ctx.d1, { type: 'IDENTITY', number: 'ID-778899', bytes: PDF, name: 'id2.pdf', mime: 'application/pdf' });
  assert.equal(again.status, 200, 'a resubmission replaces the document');
  assert.equal(again.body.data.document.status, 'SUBMITTED');
  assert.equal(again.body.data.document.rejectionReason, '');
  assert.equal(again.body.data.document.version, 2);
  assert.equal(again.body.data.verificationStatus, 'PENDING_REVIEW');
  const row = db.DriverDocument.rows.find((d) => d.docId === ctx.idDoc);
  assert.equal(row.previousFiles.length, 1, 'the replaced file stays on record');
  assert.equal(row.previousFiles[0].rejectionReason, 'The photo is blurry, please upload a clear copy');

  await call('POST', `/business/driver-documents/${ctx.idDoc}/review`, { token, appId, body: { decision: 'APPROVE' } });
  assert.equal((await call('GET', `/business/drivers/${ctx.d1}`, ctx.a)).body.data.verificationStatus, 'APPROVED');
});

test('verification history records who decided what, and when', async () => {
  const history = (await call('GET', `/business/drivers/${ctx.d1}/history`, ctx.a)).body.data;
  const verification = history.filter((h) => h.kind === 'VERIFICATION');
  assert.ok(verification.some((h) => h.action === 'DOCUMENT_APPROVED' && h.actor === 'ops@a.test'));
  assert.ok(verification.some((h) => h.action === 'DOCUMENT_REJECTED' && h.reason.includes('blurry') && h.actor === 'admin@a.test'));
  assert.ok(verification.some((h) => h.action === 'VERIFICATION_STATUS_CHANGED' && h.to === 'APPROVED'));
  assert.ok(history.some((h) => h.action === 'DOCUMENT_RESUBMITTED'));
  assert.ok(history.every((h) => h.at), 'every entry has a timestamp');
  const audit = db.AdminAudit.rows.filter((a) => a.action === 'driver.document_rejected');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorEmail, 'admin@a.test');
});

test('verification: an expired mandatory document makes the driver EXPIRED', async () => {
  // time passes: the approved licence is now past its expiry date
  const lic = db.DriverDocument.rows.find((d) => d.docId === ctx.licDoc);
  lic.expiryDate = new Date(Date.now() - 24 * 3600 * 1000);
  const driver = db.Driver.rows.find((d) => d.driverId === ctx.d1);
  driver.verificationExpiresAt = lic.expiryDate; // what the stored value would be

  const detail = (await call('GET', `/business/drivers/${ctx.d1}`, ctx.a)).body.data;
  assert.equal(detail.verificationStatus, 'EXPIRED');
  assert.ok(detail.verification.expired.includes('DRIVING_LICENCE'));
  assert.equal(detail.eligibility.eligible, false);
  const expiredList = await call('GET', '/business/drivers?verification=EXPIRED', ctx.a);
  assert.equal(expiredList.body.data.total, 1);
  assert.equal(expiredList.body.data.items[0].verificationStatus, 'EXPIRED');
  assert.equal((await call('GET', '/business/drivers?verification=APPROVED', ctx.a)).body.data.total, 0);
  const docs = (await call('GET', `/business/drivers/${ctx.d1}/documents`, ctx.a)).body.data.requirements.find((r) => r.type === 'DRIVING_LICENCE').document;
  assert.equal(docs.effectiveStatus, 'EXPIRED');

  // a new licence restores eligibility for review
  const renew = await upload(ctx.admin, 'app_a', 'drivers', ctx.d1, { type: 'DRIVING_LICENCE', number: 'DL-0420110012345', expiryDate: '2032-01-01' });
  assert.equal(renew.status, 200);
  assert.equal(renew.body.data.verificationStatus, 'PENDING_REVIEW');
  await call('POST', `/business/driver-documents/${ctx.licDoc}/review`, { token: ctx.admin, appId: 'app_a', body: { decision: 'APPROVE' } });
  assert.equal((await call('GET', `/business/drivers/${ctx.d1}`, ctx.a)).body.data.verificationStatus, 'APPROVED');
});

test('requirements: a business can make optional documents mandatory; the licence stays mandatory', async () => {
  const defaults = await call('GET', '/business/requirements', ctx.a);
  assert.equal(defaults.body.data.driver.find((r) => r.type === 'ADDRESS_PROOF').mandatory, false);
  assert.equal((await call('PUT', '/business/requirements', { token: ctx.support, appId: 'app_a', body: { driver: { ADDRESS_PROOF: true } } })).status, 403);
  assert.equal((await call('PUT', '/business/requirements', { ...ctx.a, body: { driver: { DRIVING_LICENCE: false } } })).status, 400);
  const set = await call('PUT', '/business/requirements', { ...ctx.a, body: { driver: { ADDRESS_PROOF: true } } });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.driver.find((r) => r.type === 'ADDRESS_PROOF').mandatory, true);
  // business B is unaffected
  assert.equal((await call('GET', '/business/requirements', ctx.b)).body.data.driver.find((r) => r.type === 'ADDRESS_PROOF').mandatory, false);
  // d1 now lacks the newly mandatory document, as computed live
  assert.equal((await call('GET', `/business/drivers/${ctx.d1}`, ctx.a)).body.data.verificationStatus, 'INCOMPLETE');
  await call('PUT', '/business/requirements', { ...ctx.a, body: { driver: { ADDRESS_PROOF: false } } });
  assert.equal((await call('GET', `/business/drivers/${ctx.d1}`, ctx.a)).body.data.verificationStatus, 'APPROVED');
});

// ----------------------------------- vehicles -----------------------------------

test('create vehicle: validation, duplicate registrations and category/region rules', async () => {
  const bad = await call('POST', '/business/vehicles', { ...ctx.a, body: { registrationNumber: 'A', make: '', model: '', categoryId: '', passengerCapacity: 0 } });
  assert.equal(bad.status, 400);
  for (const f of ['registrationNumber', 'make', 'model', 'categoryId', 'passengerCapacity']) assert.ok(bad.body.errors[f], f);
  assert.ok((await call('POST', '/business/vehicles', { ...ctx.a, body: vehicleBody({ categoryId: 'vc_b_sedan' }) })).body.errors.categoryId, 'another business\'s category');
  assert.ok((await call('POST', '/business/vehicles', { ...ctx.a, body: vehicleBody({ categoryId: 'vc_a_bike', operatingRegionId: 'rg_a2' }) })).body.errors.operatingRegionId, 'bike is not offered in Mumbai');

  const created = await call('POST', '/business/vehicles', { ...ctx.a, body: vehicleBody() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.v1 = created.body.data.id;

  for (const reg of ['MH12AB1234', 'mh 12 ab 1234', 'MH-12-AB-1234']) {
    const dup = await call('POST', '/business/vehicles', { ...ctx.a, body: vehicleBody({ registrationNumber: reg }) });
    assert.equal(dup.status, 409, reg);
    assert.ok(dup.body.errors.registrationNumber);
  }
  // another business may register the same plate (the rule is per business)
  const other = await call('POST', '/business/vehicles', { ...ctx.b, body: vehicleBody({ categoryId: 'vc_b_sedan', operatingRegionId: 'rg_b1' }) });
  assert.equal(other.status, 201);
  ctx.vB = other.body.data.id;
});

test('vehicle list and detail', async () => {
  for (const [i, reg] of ['KA01AA0001', 'KA01AA0002', 'DL3CAB9999'].entries()) {
    const r = await call('POST', '/business/vehicles', { ...ctx.a, body: vehicleBody({ registrationNumber: reg, make: i === 2 ? 'Tata' : 'Hyundai', categoryId: 'vc_a_sedan', operatingRegionId: i === 0 ? 'rg_a1' : 'rg_a2' }) });
    assert.equal(r.status, 201);
  }
  const all = await call('GET', '/business/vehicles?pageSize=2', ctx.a);
  assert.equal(all.body.data.total, 4);
  assert.equal(all.body.data.items.length, 2);
  assert.equal((await call('GET', '/business/vehicles?search=mh12', ctx.a)).body.data.total, 1);
  assert.equal((await call('GET', '/business/vehicles?search=mh-12%20ab', ctx.a)).body.data.total, 1);
  assert.equal((await call('GET', '/business/vehicles?search=tata', ctx.a)).body.data.total, 1);
  assert.equal((await call('GET', '/business/vehicles?regionId=rg_a2', ctx.a)).body.data.total, 2);
  assert.equal((await call('GET', '/business/vehicles?categoryId=vc_a_bike', ctx.a)).body.data.total, 0);
  assert.equal((await call('GET', '/business/vehicles?status=ACTIVE', ctx.a)).body.data.total, 0);
  assert.equal((await call('GET', '/business/vehicles?verification=INCOMPLETE', ctx.a)).body.data.total, 4);
  assert.equal((await call('GET', '/business/vehicles?assignment=unassigned', ctx.a)).body.data.total, 4);
  assert.equal((await call('GET', '/business/vehicles?assignment=assigned', ctx.a)).body.data.total, 0);
  const detail = (await call('GET', `/business/vehicles/${ctx.v1}`, ctx.a)).body.data;
  assert.equal(detail.registrationNumber, 'MH12AB1234');
  assert.equal(detail.categoryName, 'Sedan');
  assert.equal(detail.driver, null);
  assert.equal(detail.operational, false);
  assert.equal(detail.verificationStatus, 'INCOMPLETE');
});

test('vehicle documents: upload, review, and the vehicle becomes verified', async () => {
  const { token, appId } = ctx.a;
  assert.equal((await upload(token, appId, 'vehicles', ctx.v1, { type: 'INSURANCE', number: 'POL-1', expiryDate: '2020-01-01' })).status, 400, 'expired insurance cannot be submitted');
  const rc = await upload(token, appId, 'vehicles', ctx.v1, { type: 'REGISTRATION_CERTIFICATE', number: 'RC-1', bytes: PDF, name: 'rc.pdf', mime: 'application/pdf' });
  assert.equal(rc.status, 201);
  const ins = await upload(token, appId, 'vehicles', ctx.v1, { type: 'INSURANCE', number: 'POL-1', expiryDate: FUTURE });
  assert.equal(ins.status, 201);
  assert.equal(ins.body.data.verificationStatus, 'PENDING_REVIEW');
  ctx.vRc = rc.body.data.document.id;
  ctx.vIns = ins.body.data.document.id;
  assert.equal((await call('POST', `/business/vehicle-documents/${ctx.vRc}/review`, { token: ctx.support, appId, body: { decision: 'APPROVE' } })).status, 403);
  await call('POST', `/business/vehicle-documents/${ctx.vRc}/review`, { token, appId, body: { decision: 'APPROVE' } });
  const done = await call('POST', `/business/vehicle-documents/${ctx.vIns}/review`, { token, appId, body: { decision: 'APPROVE' } });
  assert.equal(done.body.data.verificationStatus, 'APPROVED');
  assert.equal((await call('GET', `/business/vehicles/${ctx.v1}`, ctx.a)).body.data.verificationStatus, 'APPROVED');
  assert.equal((await call('GET', '/business/vehicles?verification=APPROVED', ctx.a)).body.data.total, 1);
  const link = await call('GET', `/business/vehicle-documents/${ctx.vIns}/url`, ctx.a);
  assert.equal(storage.read(link.body.data.url).status, 200);
});

test('vehicle status: activation, suspension needs a reason, and expired documents block activation', async () => {
  const set = (status, reason) => call('POST', `/business/vehicles/${ctx.v1}/status`, { ...ctx.a, body: { status, reason } });
  assert.equal((await set('SUSPENDED')).status, 400);
  assert.equal((await set('INACTIVE')).status, 409, 'already inactive');
  assert.equal((await set('ACTIVE')).status, 200);
  assert.equal((await call('GET', `/business/vehicles/${ctx.v1}`, ctx.a)).body.data.operational, true);

  // the insurance runs out
  const ins = db.VehicleDocument.rows.find((d) => d.docId === ctx.vIns);
  ins.expiryDate = new Date(Date.now() - 24 * 3600 * 1000);
  db.Vehicle.rows.find((x) => x.vehicleId === ctx.v1).verificationExpiresAt = ins.expiryDate;
  assert.equal((await call('GET', `/business/vehicles/${ctx.v1}`, ctx.a)).body.data.verificationStatus, 'EXPIRED');
  assert.equal((await call('GET', `/business/vehicles/${ctx.v1}`, ctx.a)).body.data.operational, false);
  assert.equal((await set('INACTIVE')).status, 200);
  const blocked = await set('ACTIVE');
  assert.equal(blocked.status, 409, 'a vehicle with an expired mandatory document cannot be made operational');
  assert.match(blocked.body.message, /expired/);
  assert.equal((await call('GET', '/business/vehicles?verification=EXPIRED', ctx.a)).body.data.total, 1);

  const renew = await upload(ctx.admin, 'app_a', 'vehicles', ctx.v1, { type: 'INSURANCE', number: 'POL-2', expiryDate: '2032-02-02' });
  assert.equal(renew.status, 200);
  await call('POST', `/business/vehicle-documents/${ctx.vIns}/review`, { ...ctx.a, body: { decision: 'APPROVE' } });
  assert.equal((await set('ACTIVE')).status, 200);
  assert.equal((await set('SUSPENDED', 'Accident, inspection pending')).status, 200);
  const history = (await call('GET', `/business/vehicles/${ctx.v1}/history`, ctx.a)).body.data;
  assert.ok(history.some((h) => h.action === 'VEHICLE_STATUS_CHANGED' && h.to === 'SUSPENDED' && h.reason.includes('Accident')));
  assert.equal((await set('ACTIVE')).status, 200, 'reactivated again for the assignment tests');
});

// ----------------------------------- assignments and eligibility -----------------------------------

test('assignment: both permissions are needed, the vehicle must suit the driver, and conflicts are refused', async () => {
  const assign = (token, driverId, vehicleId, extra = {}) => call('POST', `/business/drivers/${driverId}/assign-vehicle`, { token, appId: 'app_a', body: { vehicleId, ...extra } });
  assert.equal((await assign(ctx.support, ctx.d1, ctx.v1)).status, 403, 'support cannot assign');
  assert.equal((await assign(ctx.admin, ctx.d1, '')).status, 400);

  // d1 is eligible for Sedan in Pune (rg_a1). A bike vehicle and a Mumbai vehicle do not fit.
  const bike = await call('POST', '/business/vehicles', { ...ctx.a, body: vehicleBody({ registrationNumber: 'BIKE0001', categoryId: 'vc_a_bike', operatingRegionId: 'rg_a1', passengerCapacity: 1 }) });
  const wrongCategory = await assign(ctx.admin, ctx.d1, bike.body.data.id);
  assert.equal(wrongCategory.status, 409);
  assert.match(wrongCategory.body.message, /category/);
  const mumbai = (await call('GET', '/business/vehicles?search=KA01AA0002', ctx.a)).body.data.items[0];
  const wrongRegion = await assign(ctx.admin, ctx.d1, mumbai.id);
  assert.equal(wrongRegion.status, 409);
  assert.match(wrongRegion.body.message, /region/);

  assert.equal((await assign(ctx.ops, ctx.d1, ctx.v1)).status, 200, 'operations has both permissions');
  assert.equal((await assign(ctx.admin, ctx.d1, ctx.v1)).body.data.unchanged, true, 'assigning the same pair again changes nothing');
});

test('eligibility becomes true only when everything lines up, and drops when any part fails', async () => {
  const eligibility = async () => (await call('GET', `/business/drivers/${ctx.d1}`, ctx.a)).body.data.eligibility;
  let e = await eligibility();
  assert.equal(e.eligible, true, JSON.stringify(e));
  const inList = (await call('GET', `/business/drivers?search=${ctx.d1}`, ctx.a)).body.data.items[0];
  assert.equal(inList.eligible, true);
  assert.equal(inList.vehicle.registrationNumber, 'MH12AB1234');

  // suspended driver: the vehicle stays assigned but the driver is not eligible
  await call('POST', `/business/drivers/${ctx.d1}/status`, { ...ctx.a, body: { status: 'SUSPENDED', reason: 'Under investigation' } });
  e = await eligibility();
  assert.equal(e.eligible, false);
  assert.ok(e.reasons.some((x) => x.code === 'ACCOUNT_NOT_ACTIVE'));
  await call('POST', `/business/drivers/${ctx.d1}/status`, { ...ctx.a, body: { status: 'ACTIVE' } });
  assert.equal((await eligibility()).eligible, true);

  // the vehicle is deactivated
  await call('POST', `/business/vehicles/${ctx.v1}/status`, { ...ctx.a, body: { status: 'INACTIVE' } });
  assert.ok((await eligibility()).reasons.some((x) => x.code === 'VEHICLE_NOT_ACTIVE'));
  await call('POST', `/business/vehicles/${ctx.v1}/status`, { ...ctx.a, body: { status: 'ACTIVE' } });
  assert.equal((await eligibility()).eligible, true);

  // the region is deactivated
  db.ServiceRegion.rows.find((r) => r.regionId === 'rg_a1').active = false;
  assert.ok((await eligibility()).reasons.some((x) => x.code === 'REGION_INACTIVE'));
  db.ServiceRegion.rows.find((r) => r.regionId === 'rg_a1').active = true;
  assert.equal((await eligibility()).eligible, true);
});

test('a suspended driver or vehicle cannot be assigned; one vehicle per driver and one driver per vehicle', async () => {
  const assign = (driverId, vehicleId, extra = {}) => call('POST', `/business/drivers/${driverId}/assign-vehicle`, { ...ctx.a, body: { vehicleId, ...extra } });
  // d3: a fresh Pune sedan driver; v2: another Pune sedan
  const d3 = (await call('POST', '/business/drivers', { ...ctx.a, body: driverBody({ fullName: 'Sunil Rao', phone: '+919855555555', email: 'sunil@example.com' }) })).body.data.id;
  const v2 = (await call('POST', '/business/vehicles', { ...ctx.a, body: vehicleBody({ registrationNumber: 'MH14XY5555' }) })).body.data.id;

  const taken = await assign(d3, ctx.v1);
  assert.equal(taken.status, 409, 'the vehicle already has a driver');
  assert.match(taken.body.message, /already assigned/);
  assert.equal(taken.body.errors.conflict, 'vehicle');
  const driverBusy = await assign(ctx.d1, v2);
  assert.equal(driverBusy.status, 409, 'the driver already has a vehicle');
  assert.equal(driverBusy.body.errors.conflict, 'driver');

  await call('POST', `/business/vehicles/${v2}/status`, { ...ctx.a, body: { status: 'SUSPENDED', reason: 'Awaiting repairs' } });
  assert.equal((await assign(d3, v2)).status, 409, 'a suspended vehicle cannot be assigned');
  await call('POST', `/business/vehicles/${v2}/status`, { ...ctx.a, body: { status: 'INACTIVE' } });
  await call('POST', `/business/drivers/${d3}/status`, { ...ctx.a, body: { status: 'SUSPENDED', reason: 'Documents under dispute' } });
  assert.equal((await assign(d3, v2)).status, 409, 'a suspended driver cannot be assigned');
  await call('POST', `/business/drivers/${d3}/status`, { ...ctx.a, body: { status: 'ACTIVE' } });

  // reassign moves the vehicle, ends the old assignment and keeps the history
  const moved = await assign(d3, ctx.v1, { reassign: true });
  assert.equal(moved.status, 200);
  assert.equal((await call('GET', `/business/drivers/${ctx.d1}`, ctx.a)).body.data.vehicle, null, 'd1 lost the vehicle');
  assert.equal((await call('GET', `/business/drivers/${d3}`, ctx.a)).body.data.vehicle.id, ctx.v1);
  const rows = db.DriverVehicleAssignment.rows.filter((a) => a.vehicleId === ctx.v1);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((a) => a.active).length, 1, 'exactly one active assignment');
  assert.equal(rows.find((a) => !a.active).endReason, 'Reassigned');
  const vehicleHistory = (await call('GET', `/business/vehicles/${ctx.v1}/history`, ctx.a)).body.data;
  assert.ok(vehicleHistory.some((h) => h.action === 'DRIVER_UNASSIGNED') && vehicleHistory.some((h) => h.action === 'DRIVER_ASSIGNED'));

  // unassign, from the vehicle side
  assert.equal((await call('POST', `/business/vehicles/${ctx.v1}/unassign-driver`, { ...ctx.a, body: { reason: 'Driver left' } })).status, 200);
  assert.equal((await call('POST', `/business/vehicles/${ctx.v1}/unassign-driver`, { ...ctx.a, body: {} })).status, 404, 'nothing left to unassign');
  assert.equal((await call('GET', `/business/drivers/${d3}`, ctx.a)).body.data.vehicle, null);
  // and assign from the vehicle side
  assert.equal((await call('POST', `/business/vehicles/${ctx.v1}/assign-driver`, { ...ctx.a, body: { driverId: ctx.d1 } })).status, 200);
  assert.equal((await call('GET', `/business/drivers/${ctx.d1}`, ctx.a)).body.data.eligibility.eligible, true);
  ctx.d3 = d3;
  ctx.v2 = v2;
});

test('changing a vehicle must not break its assigned driver', async () => {
  // v1 is Sedan in Pune, assigned to d1 who is eligible for Sedan in Pune
  const toBike = await call('PATCH', `/business/vehicles/${ctx.v1}`, { ...ctx.a, body: { categoryId: 'vc_a_bike' } });
  assert.equal(toBike.status, 409);
  assert.match(toBike.body.message, /conflicts with the assigned driver/);
  const toMumbai = await call('PATCH', `/business/vehicles/${ctx.v1}`, { ...ctx.a, body: { operatingRegionId: 'rg_a2' } });
  assert.equal(toMumbai.status, 409);
  assert.equal((await call('PATCH', `/business/vehicles/${ctx.v1}`, { ...ctx.a, body: { colour: 'Silver', registrationNumber: 'MH12AB1234' } })).status, 200, 'harmless edits are fine');
  assert.equal((await call('PATCH', `/business/vehicles/${ctx.v2}`, { ...ctx.a, body: { registrationNumber: 'MH 12 AB 1234' } })).status, 409, 'cannot take another vehicle\'s plate');
});

// ----------------------------------- isolation and permissions -----------------------------------

test('isolation: business B sees none of A, and every attempt on A\'s records fails', async () => {
  const b = ctx.b;
  assert.equal((await call('GET', '/business/drivers', b)).body.data.total, 0, 'B has no drivers yet');
  assert.equal((await call('GET', '/business/vehicles', b)).body.data.total, 1, 'B has only its own vehicle');
  const own = await call('POST', '/business/drivers', { ...b, body: driverBody({ fullName: 'Bela Das', phone: '+919866666666', email: 'bela@b.test', operatingRegionId: 'rg_b1', eligibleCategoryId: 'vc_b_sedan' }) });
  assert.equal(own.status, 201);
  ctx.dB = own.body.data.id;
  const list = await call('GET', '/business/drivers', b);
  assert.deepEqual(list.body.data.items.map((d) => d.id), [ctx.dB]);

  // A's driver and vehicle: every route answers "not found" for B
  const attempts = [
    ['GET', '/business/drivers/' + ctx.d1], ['PATCH', '/business/drivers/' + ctx.d1, { fullName: 'Hijacked' }],
    ['POST', '/business/drivers/' + ctx.d1 + '/status', { status: 'INACTIVE' }], ['GET', '/business/drivers/' + ctx.d1 + '/history'],
    ['GET', '/business/drivers/' + ctx.d1 + '/documents'], ['POST', '/business/drivers/' + ctx.d1 + '/unassign-vehicle', {}],
    ['GET', '/business/vehicles/' + ctx.v1], ['PATCH', '/business/vehicles/' + ctx.v1, { colour: 'Pink' }],
    ['POST', '/business/vehicles/' + ctx.v1 + '/status', { status: 'SUSPENDED', reason: 'hijack attempt' }], ['GET', '/business/vehicles/' + ctx.v1 + '/history'],
    ['GET', '/business/vehicles/' + ctx.v1 + '/documents'], ['POST', '/business/vehicles/' + ctx.v1 + '/unassign-driver', {}],
    ['GET', '/business/driver-documents/' + ctx.licDoc + '/url'], ['POST', '/business/driver-documents/' + ctx.licDoc + '/review', { decision: 'REJECT', reason: 'hijack attempt' }],
    ['GET', '/business/vehicle-documents/' + ctx.vIns + '/url'], ['POST', '/business/vehicle-documents/' + ctx.vIns + '/review', { decision: 'REJECT', reason: 'hijack attempt' }]
  ];
  for (const [method, path, body] of attempts) {
    const r = await call(method, path, { ...b, body });
    assert.equal(r.status, 404, `${method} ${path} should be 404 for another business, got ${r.status}`);
  }
  assert.equal((await upload(b.token, b.appId, 'drivers', ctx.d1, { type: 'ADDRESS_PROOF' })).status, 404, 'cannot upload into A\'s driver');
  assert.equal((await upload(b.token, b.appId, 'vehicles', ctx.v1, { type: 'PERMIT', expiryDate: FUTURE })).status, 404);

  // assignments cannot cross businesses, from either side
  assert.equal((await call('POST', '/business/drivers/' + ctx.dB + '/assign-vehicle', { ...b, body: { vehicleId: ctx.v1 } })).status, 404, 'B\'s driver, A\'s vehicle');
  assert.equal((await call('POST', '/business/drivers/' + ctx.d1 + '/assign-vehicle', { ...b, body: { vehicleId: ctx.vB } })).status, 404, 'A\'s driver, B\'s vehicle');
  assert.equal((await call('POST', '/business/vehicles/' + ctx.vB + '/assign-driver', { ...b, body: { driverId: ctx.d1 } })).status, 404);
  assert.equal((await call('POST', '/business/vehicles/' + ctx.v1 + '/assign-driver', { ...b, body: { driverId: ctx.dB } })).status, 404);
  // and the search never reaches across
  assert.equal((await call('GET', '/business/drivers?search=ravi', b)).body.data.total, 0);
  assert.equal((await call('GET', '/business/vehicles?search=MH12AB1234&pageSize=100', b)).body.data.items.every((x) => x.id === ctx.vB), true);

  // nothing of A's changed
  const a = (await call('GET', '/business/drivers/' + ctx.d1, ctx.a)).body.data;
  assert.equal(a.name, 'Ravi Kumar');
  assert.equal(a.accountStatus, 'ACTIVE');
  assert.equal((await call('GET', '/business/vehicles/' + ctx.v1, ctx.a)).body.data.colour, 'Silver');
  assert.equal(db.DriverDocument.rows.find((d) => d.docId === ctx.licDoc).status, 'APPROVED');
});

test('isolation: naming another business in the header is refused, and a body cannot move a record', async () => {
  for (const path of ['/business/drivers', '/business/vehicles', '/business/drivers/' + ctx.d1, '/business/requirements']) {
    assert.equal((await call('GET', path, { token: ctx.bAdmin, appId: 'app_a' })).status, 403, path);
  }
  assert.equal((await call('POST', '/business/drivers', { token: ctx.bAdmin, appId: 'app_a', body: driverBody({ phone: '+919877777777', email: 'x@y.test' }) })).status, 403);
  // a tenantId in the body is ignored: the driver and the vehicle land in the signed-in business
  const d = await call('POST', '/business/drivers', { ...ctx.a, body: { ...driverBody({ fullName: 'Spoof Test', phone: '+919888888888', email: 'spoof@x.test' }), tenantId: 'app_b', tenant_id: 'app_b' } });
  assert.equal(d.status, 201);
  assert.equal(db.Driver.rows.find((x) => x.driverId === d.body.data.id).tenantId, 'app_a');
  const v = await call('POST', '/business/vehicles', { ...ctx.a, body: { ...vehicleBody({ registrationNumber: 'SPOOF1234' }), tenantId: 'app_b' } });
  assert.equal(db.Vehicle.rows.find((x) => x.vehicleId === v.body.data.id).tenantId, 'app_a');
  assert.equal((await call('GET', '/business/vehicles?search=SPOOF1234', ctx.b)).body.data.total, 0);
});

test('super admin: refused on every fleet route, whichever business it names', async () => {
  for (const appId of [undefined, 'app_a', 'app_b', 'app_nobody']) {
    for (const path of ['/business/drivers', '/business/vehicles', '/business/drivers/' + ctx.d1 + '/documents']) {
      assert.equal((await call('GET', path, { token: ctx.super, appId })).status, 403, path + ' ' + appId);
    }
  }
  assert.equal((await call('POST', '/business/drivers', { token: ctx.super, appId: 'app_a', body: {} })).status, 403);
  const b = await call('GET', '/business/drivers', { token: ctx.bAdmin, appId: 'app_b' });
  assert.deepEqual(b.body.data.items.map((x) => x.id), [ctx.dB], 'the business admin sees only their own');
});

test('role permissions on the fleet screens', async () => {
  const as = (token) => ({ token, appId: 'app_a' });
  // finance has no fleet access at all
  for (const path of ['/business/drivers', '/business/vehicles', '/business/drivers/' + ctx.d1 + '/documents']) {
    assert.equal((await call('GET', path, as(ctx.finance))).status, 403, 'finance ' + path);
  }
  // support can look, but not change, and cannot open documents or review
  assert.equal((await call('GET', '/business/drivers', as(ctx.support))).status, 200);
  assert.equal((await call('GET', '/business/vehicles', as(ctx.support))).status, 200);
  assert.equal((await call('GET', '/business/drivers/' + ctx.d1, as(ctx.support))).status, 200);
  assert.equal((await call('POST', '/business/drivers', { ...as(ctx.support), body: driverBody({ phone: '+919899999999', email: 's@x.test' }) })).status, 403);
  assert.equal((await call('PATCH', '/business/drivers/' + ctx.d1, { ...as(ctx.support), body: { fullName: 'X Y' } })).status, 403);
  assert.equal((await call('POST', '/business/drivers/' + ctx.d1 + '/status', { ...as(ctx.support), body: { status: 'INACTIVE' } })).status, 403);
  assert.equal((await call('POST', '/business/vehicles', { ...as(ctx.support), body: vehicleBody({ registrationNumber: 'SUPP0001' }) })).status, 403);
  assert.equal((await upload(ctx.support, 'app_a', 'drivers', ctx.d1, { type: 'ADDRESS_PROOF' })).status, 403);
  assert.equal((await call('POST', '/business/vehicles/' + ctx.v1 + '/status', { ...as(ctx.support), body: { status: 'INACTIVE' } })).status, 403);
  // no token at all
  assert.equal((await call('GET', '/business/drivers', { appId: 'app_a' })).status, 401);
  assert.equal((await call('POST', '/business/drivers', { appId: 'app_a', body: driverBody() })).status, 401);
  // operations can run the fleet but not business settings
  assert.equal((await call('POST', '/business/drivers', { ...as(ctx.ops), body: driverBody({ fullName: 'Ops Added', phone: '+919800000001', email: 'ops@added.test' }) })).status, 201);
  assert.equal((await call('PUT', '/business/requirements', { ...as(ctx.ops), body: { driver: { ADDRESS_PROOF: true } } })).status, 403);
});

test('audit: sensitive actions are on record with the actor, never with secrets', async () => {
  const actions = new Set(db.AdminAudit.rows.filter((r) => r.tenantId === 'app_a').map((r) => r.action));
  for (const a of ['driver.created', 'driver.account_status_changed', 'driver.document_submitted', 'driver.document_approved', 'driver.document_rejected', 'driver_document.viewed', 'vehicle.created', 'vehicle.vehicle_status_changed', 'driver.vehicle_assigned', 'vehicle.driver_assigned']) {
    assert.ok(actions.has(a), 'audit has ' + a);
  }
  const blob = JSON.stringify(db.AdminAudit.rows);
  assert.equal(blob.includes('DL-0420110012345'), false, 'document numbers are not written to the audit log');
  assert.equal(blob.includes('sig='), false, 'neither are file links');
  assert.equal(blob.includes('passwordHash'), false);
  assert.ok(db.AdminAudit.rows.filter((r) => r.tenantId === 'app_a' && r.action.startsWith('driver')).every((r) => r.actorEmail));
});
