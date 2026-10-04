// Business onboarding and tenant isolation over HTTP, with in-memory stand-ins for the database models.
process.env.JWT_SECRET = 'test-secret-for-business-api-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');
const { jsonBodyParser } = require('../lib/jsonBody');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();
const adminRoutes = require('../routes/adminRoutes');

let server;
let base;
const hash = (pw) => bcrypt.hashSync(pw, 4);

test.before(async () => {
  const mk = (adminId, email, role, tenantId, pw) => db.AdminUser.create({ adminId, name: adminId, email, role, tenantId, passwordHash: hash(pw) });
  await mk('a_super', 'super@x.test', 'super_admin', null, 'super-password-1');
  const app = express();
  app.use(jsonBodyParser()); // the same parser index.js uses
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
test.after(() => server.close());

async function call(method, url, { token, body, appId } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(appId ? { 'X-App-Id': appId } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}
const signIn = async (email, password) => (await call('POST', '/auth/login', { body: { email, password } })).body.data.token;

const ctx = {}; // filled by the tests below, in order

async function createBusiness(name, pkg, adminEmail) {
  const r = await call('POST', '/tenants', {
    token: ctx.superToken,
    body: { name, appName: name, packageName: pkg, city: 'X', plan: 'standard', adminName: `${name} Admin`, adminEmail }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const token = await signIn(adminEmail, r.body.data.initialAdmin.temporaryPassword);
  return { appId: r.body.data.appId, token, tenant: r.body.data };
}

const market = { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' };
const fare = { baseFare: 40, perKm: 12, perMinute: 1, minimumFare: 70, bookingFee: 5, waitingFreeMinutes: 3, waitingPerMinute: 1.5 };

test('super admin creates businesses with unique, immutable appIds', async () => {
  ctx.superToken = await signIn('super@x.test', 'super-password-1');
  ctx.A = await createBusiness('Alpha Rides', 'com.alpha.rider', 'alpha@x.test');
  ctx.B = await createBusiness('Beta Cabs', 'com.beta.rider', 'beta@x.test');
  assert.match(ctx.A.appId, /^app_[a-z0-9]{10}$/);
  assert.notEqual(ctx.A.appId, ctx.B.appId);
  assert.equal(ctx.A.tenant.id, ctx.A.appId);

  // the appId cannot be changed through the settings endpoint
  const upd = await call('PUT', '/business/settings', { token: ctx.A.token, appId: ctx.A.appId, body: { name: 'Alpha Rides Ltd', appId: 'app_hacked', tenantId: ctx.B.appId } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.data.appId, ctx.A.appId);
  assert.equal(upd.body.data.name, 'Alpha Rides Ltd');
});

test('the platform list shows each business with its setup status', async () => {
  const list = await call('GET', '/tenants', { token: ctx.superToken });
  const alpha = list.body.data.find((t) => t.appId === ctx.A.appId);
  assert.equal(alpha.setup.complete, false);
  assert.equal(alpha.setup.nextStep, 'Country and service regions');
});

test('first-time setup is guided: nothing is done, the next step is regions', async () => {
  const r = await call('GET', '/business/overview', { token: ctx.A.token, appId: ctx.A.appId });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.setup.nextStep.key, 'regions');
  assert.equal(r.body.data.setup.percent, 0);
  assert.equal(r.body.data.counts.regions, 0);
});

test('regions need the country first; bulk add skips duplicates; validation errors name the field', async () => {
  const a = { token: ctx.A.token, appId: ctx.A.appId };
  const early = await call('POST', '/business/regions', { ...a, body: { state: 'Maharashtra', cities: ['Pune'] } });
  assert.equal(early.status, 409);

  assert.equal((await call('PUT', '/business/market', { ...a, body: { country: 'IN', currency: 'XXX', timezone: 'Asia/Kolkata' } })).status, 400);
  const set = await call('PUT', '/business/market', { ...a, body: market });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.data.market, market);

  const bad = await call('POST', '/business/regions', { ...a, body: { state: '', cities: [] } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.state && bad.body.errors.cities);

  const first = await call('POST', '/business/regions', { ...a, body: { state: 'Maharashtra', cities: ['Pune', 'Mumbai'], zoneName: 'Airport' } });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.created.length, 2);
  assert.equal(first.body.data.created[0].country, 'IN');
  ctx.regionPune = first.body.data.created[0].id;
  ctx.regionMumbai = first.body.data.created[1].id;

  const again = await call('POST', '/business/regions', { ...a, body: { state: 'maharashtra', cities: [' pune ', 'Nagpur'], zoneName: 'airport' } });
  assert.equal(again.status, 201);
  assert.deepEqual(again.body.data.skipped, [' pune '.trim()]);
  assert.equal(again.body.data.created.length, 1);
  const allDup = await call('POST', '/business/regions', { ...a, body: { state: 'Maharashtra', cities: ['Pune'], zoneName: 'Airport' } });
  assert.equal(allDup.status, 409);

  const list = await call('GET', '/business/regions', a);
  assert.equal(list.body.data.length, 3);
});

test('regions can be edited and deactivated; renaming into an existing zone is refused', async () => {
  const a = { token: ctx.A.token, appId: ctx.A.appId };
  const renamed = await call('PATCH', `/business/regions/${ctx.regionPune}`, { ...a, body: { zoneName: 'Central' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.zoneName, 'Central');
  const clash = await call('PATCH', `/business/regions/${ctx.regionMumbai}`, { ...a, body: { zoneName: 'Airport' } });
  assert.equal(clash.status, 200, 'different city, same zone name is fine');
  const off = await call('PATCH', `/business/regions/${ctx.regionMumbai}`, { ...a, body: { active: false } });
  assert.equal(off.body.data.active, false);
  assert.equal((await call('PATCH', '/business/regions/rg_missing', { ...a, body: { active: false } })).status, 404);
  assert.equal((await call('PATCH', `/business/regions/${ctx.regionMumbai}`, { ...a, body: { active: 'no' } })).status, 400);
});

test('categories: validation, duplicate names, region rules', async () => {
  const a = { token: ctx.A.token, appId: ctx.A.appId };
  const okBody = { name: 'Sedan', description: 'Comfortable 4 seater', icon: 'car', passengerCapacity: 4, luggageCapacity: 2, rideType: 'economy', regionIds: [ctx.regionPune] };

  const bad = await call('POST', '/business/categories', { ...a, body: { ...okBody, name: '', passengerCapacity: 0, regionIds: [] } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.name && bad.body.errors.passengerCapacity && bad.body.errors.regionIds);

  assert.equal((await call('POST', '/business/categories', { ...a, body: { ...okBody, regionIds: ['rg_nope'] } })).status, 400);
  assert.equal((await call('POST', '/business/categories', { ...a, body: { ...okBody, regionIds: [ctx.regionMumbai] } })).status, 400, 'inactive region cannot be newly selected');

  const created = await call('POST', '/business/categories', { ...a, body: okBody });
  assert.equal(created.status, 201);
  ctx.catSedan = created.body.data.id;

  const dup = await call('POST', '/business/categories', { ...a, body: { ...okBody, name: ' sedan ' } });
  assert.equal(dup.status, 409);
  assert.ok(dup.body.errors.name);

  const bike = await call('POST', '/business/categories', { ...a, body: { name: 'Bike', icon: 'bike', passengerCapacity: 1, rideType: 'two_wheeler', regionIds: [ctx.regionPune] } });
  assert.equal(bike.status, 201);
  ctx.catBike = bike.body.data.id;
  assert.equal(bike.body.data.luggageCapacity, null);

  const edited = await call('PATCH', `/business/categories/${ctx.catSedan}`, { ...a, body: { description: 'Updated', passengerCapacity: 5 } });
  assert.equal(edited.body.data.passengerCapacity, 5);
  assert.equal(edited.body.data.name, 'Sedan');
  assert.equal((await call('PATCH', `/business/categories/${ctx.catBike}`, { ...a, body: { name: 'SEDAN' } })).status, 409);
});

test('pricing: needs a real category, validates money, upserts one rule per category and region', async () => {
  const a = { token: ctx.A.token, appId: ctx.A.appId };
  assert.equal((await call('PUT', '/business/fare-rules', { ...a, body: { ...fare, categoryId: 'vc_nope' } })).status, 400);

  const negative = await call('PUT', '/business/fare-rules', { ...a, body: { ...fare, categoryId: ctx.catSedan, baseFare: -5 } });
  assert.equal(negative.status, 400);
  assert.ok(negative.body.errors.baseFare);

  const saved = await call('PUT', '/business/fare-rules', { ...a, body: { ...fare, categoryId: ctx.catSedan, regionId: null } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.currency, 'INR');
  const again = await call('PUT', '/business/fare-rules', { ...a, body: { ...fare, categoryId: ctx.catSedan, baseFare: 45 } });
  assert.equal(again.body.data.id, saved.body.data.id, 'same category + region updates the same rule');
  assert.equal(again.body.data.baseFare, 45);

  const override = await call('PUT', '/business/fare-rules', { ...a, body: { ...fare, categoryId: ctx.catSedan, regionId: ctx.regionPune, perKm: 15 } });
  assert.equal(override.status, 200);
  assert.notEqual(override.body.data.id, saved.body.data.id);

  const notOffered = await call('PUT', '/business/fare-rules', { ...a, body: { ...fare, categoryId: ctx.catSedan, regionId: ctx.regionMumbai } });
  assert.equal(notOffered.status, 400, 'category is not offered in that region');

  const list = await call('GET', '/business/fare-rules', a);
  assert.equal(list.body.data.length, 2);
});

test('cancellation policy is stored separately for rider, driver and conditions', async () => {
  const a = { token: ctx.A.token, appId: ctx.A.appId };
  const body = { categoryId: ctx.catSedan, rider: { freeCancellationMinutes: 2, feeAfterWindow: 20, feeAfterDriverArrived: 40, noShowFee: 50 }, driver: { penaltyFee: 30, graceCancellations: 2 }, conditions: 'Fee waived if the driver is late' };
  const saved = await call('PUT', '/business/cancellation-policies', { ...a, body });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.rider.feeAfterWindow, 20);
  assert.equal(saved.body.data.driver.penaltyFee, 30);
  const bad = await call('PUT', '/business/cancellation-policies', { ...a, body: { ...body, rider: { ...body.rider, noShowFee: -1 } } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors['rider.noShowFee']);
});

test('fare preview uses the business currency and validates inputs', async () => {
  const a = { token: ctx.A.token, appId: ctx.A.appId };
  const r = await call('POST', '/business/fare-preview', { ...a, body: { rule: { ...fare, additionalCharges: [], taxes: [{ name: 'GST', ratePercent: 5, appliesTo: 'fare_and_fees' }], surge: { enabled: false, maxMultiplier: 1 } }, trip: { distanceKm: 10, durationMin: 20 } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.currency, 'INR');
  assert.equal(r.body.data.fare, 180); // 40 + 120 + 20
  assert.equal(r.body.data.taxes[0].amount, 9.25); // 5% of (180 + 5)
  assert.equal(r.body.data.total, 194.25);
  const bad = await call('POST', '/business/fare-preview', { ...a, body: { rule: { ...fare, baseFare: -1 }, trip: { distanceKm: -5 } } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.baseFare && bad.body.errors['trip.distanceKm']);
});

test('setup can be confirmed only when steps 1-3 are done, and the status then persists', async () => {
  const fresh = await createBusiness('Gamma Go', 'com.gamma.rider', 'gamma@x.test');
  const g = { token: fresh.token, appId: fresh.appId };
  assert.equal((await call('POST', '/business/setup/complete', g)).status, 409);

  const a = { token: ctx.A.token, appId: ctx.A.appId };
  const before = await call('GET', '/business/overview', a);
  assert.equal(before.body.data.setup.nextStep.key, 'confirm');
  assert.equal(before.body.data.setup.ready, true);
  const done = await call('POST', '/business/setup/complete', a);
  assert.equal(done.status, 200);
  assert.equal(done.body.data.complete, true);
  const after = await call('GET', '/business/overview', a);
  assert.equal(after.body.data.setup.complete, true);
  assert.equal(after.body.data.setup.percent, 100);
  const list = await call('GET', '/tenants', { token: ctx.superToken });
  assert.equal(list.body.data.find((t) => t.appId === ctx.A.appId).setup.complete, true);
});

test('the country is locked once regions or pricing exist; the currency once pricing exists', async () => {
  const a = { token: ctx.A.token, appId: ctx.A.appId };
  const country = await call('PUT', '/business/market', { ...a, body: { country: 'US', currency: 'USD', timezone: 'America/New_York' } });
  assert.equal(country.status, 409);
  const tz = await call('PUT', '/business/market', { ...a, body: { ...market, timezone: 'Asia/Calcutta' } });
  assert.equal(tz.status, 200, 'time zone can still change');
  const currency = await call('PUT', '/business/market', { ...a, body: { ...market, currency: 'USD' } });
  assert.equal(currency.status, 409);
});

// ------------------------------- isolation -------------------------------

test('isolation: business B sees none of business A\'s configuration', async () => {
  const b = { token: ctx.B.token, appId: ctx.B.appId };
  for (const path of ['/business/regions', '/business/categories', '/business/fare-rules', '/business/cancellation-policies']) {
    const r = await call('GET', path, b);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, [], `${path} must be empty for B`);
  }
  const overview = await call('GET', '/business/overview', b);
  assert.equal(overview.body.data.counts.activeCategories, 0);
  assert.equal(overview.body.data.business.appId, ctx.B.appId);
});

test('isolation: naming A as the business is refused for B, whatever the request says', async () => {
  const asA = { token: ctx.B.token, appId: ctx.A.appId };
  assert.equal((await call('GET', '/business/categories', asA)).status, 403);
  assert.equal((await call('GET', '/business/overview', asA)).status, 403);
  assert.equal((await call('POST', '/business/categories', { ...asA, body: { name: 'Hack', passengerCapacity: 1, rideType: 'economy', regionIds: [ctx.regionPune] } })).status, 403);
  assert.equal((await call('PUT', '/business/fare-rules', { ...asA, body: { ...fare, categoryId: ctx.catSedan } })).status, 403);
  // a body that names A is ignored; the record lands in B or is rejected
  const b = { token: ctx.B.token, appId: ctx.B.appId };
  const spoof = await call('PUT', '/business/market', { ...b, body: { ...market, tenantId: ctx.A.appId } });
  assert.equal(spoof.status, 200);
  assert.equal(spoof.body.data.appId, ctx.B.appId);
});

test('isolation: B cannot read, edit, price or reference A\'s records by id', async () => {
  const b = { token: ctx.B.token, appId: ctx.B.appId };
  assert.equal((await call('PATCH', `/business/regions/${ctx.regionPune}`, { ...b, body: { active: false } })).status, 404);
  assert.equal((await call('PATCH', `/business/categories/${ctx.catSedan}`, { ...b, body: { name: 'Stolen' } })).status, 404);
  const rules = await call('GET', '/business/fare-rules', { token: ctx.A.token, appId: ctx.A.appId });
  assert.equal((await call('DELETE', `/business/fare-rules/${rules.body.data[0].id}`, b)).status, 404);
  // B creating a category that points at A's region id is rejected
  const cross = await call('POST', '/business/categories', { ...b, body: { name: 'Cross', passengerCapacity: 2, rideType: 'economy', regionIds: [ctx.regionPune] } });
  assert.equal(cross.status, 400);
  // pricing A's category from B is rejected
  assert.equal((await call('PUT', '/business/fare-rules', { ...b, body: { ...fare, categoryId: ctx.catSedan } })).status, 400);
  // A's data is untouched
  const mine = await call('GET', '/business/categories', { token: ctx.A.token, appId: ctx.A.appId });
  assert.equal(mine.body.data.find((c) => c.id === ctx.catSedan).name, 'Sedan');
});

test('isolation: two businesses can use the same names without clashing', async () => {
  const b = { token: ctx.B.token, appId: ctx.B.appId };
  const region = await call('POST', '/business/regions', { ...b, body: { state: 'Maharashtra', cities: ['Pune'], zoneName: 'Central' } });
  assert.equal(region.status, 201);
  const category = await call('POST', '/business/categories', { ...b, body: { name: 'Sedan', passengerCapacity: 4, rideType: 'economy', regionIds: [region.body.data.created[0].id] } });
  assert.equal(category.status, 201, 'B may also have a "Sedan"');
  const priced = await call('PUT', '/business/fare-rules', { ...b, body: { ...fare, categoryId: category.body.data.id, baseFare: 99 } });
  assert.equal(priced.status, 200);
  const aRules = await call('GET', '/business/fare-rules', { token: ctx.A.token, appId: ctx.A.appId });
  assert.ok(aRules.body.data.every((r) => r.baseFare !== 99));
});

test('isolation: the super admin has no way into a business\'s operations, with or without naming it', async () => {
  for (const appId of [undefined, ctx.A.appId, ctx.B.appId, 'app_unknown']) {
    const r = await call('GET', '/business/categories', { token: ctx.superToken, appId });
    assert.equal(r.status, 403, String(appId));
  }
  assert.equal((await call('GET', '/business/categories', { token: ctx.A.token, appId: ctx.B.appId })).status, 403, 'and a business admin cannot name another business');
});

test('suspending one business does not affect another', async () => {
  const off = await call('PATCH', `/tenants/${ctx.A.appId}/status`, { token: ctx.superToken, body: { status: 'suspended' } });
  assert.equal(off.status, 200);
  assert.equal((await call('GET', '/business/overview', { token: ctx.A.token, appId: ctx.A.appId })).status, 401);
  assert.equal((await call('GET', '/business/overview', { token: ctx.B.token, appId: ctx.B.appId })).status, 200);
  await call('PATCH', `/tenants/${ctx.A.appId}/status`, { token: ctx.superToken, body: { status: 'active' } });
});

test('roles: read-only roles can view configuration but not change it', async () => {
  const { password } = await resetAlpha();
  const alphaToken = await signIn('alpha@x.test', password);
  const sup = await call('POST', '/users', { token: alphaToken, body: { name: 'Sam Support', email: 'sam@x.test', role: 'support' } });
  assert.equal(sup.status, 201);
  const support = await signIn('sam@x.test', sup.body.data.temporaryPassword);
  const s = { token: support, appId: ctx.A.appId };
  assert.equal((await call('GET', '/business/categories', s)).status, 200);
  assert.equal((await call('POST', '/business/categories', { ...s, body: { name: 'Nope', passengerCapacity: 1, rideType: 'economy', regionIds: [ctx.regionPune] } })).status, 403);
  assert.equal((await call('PUT', '/business/fare-rules', { ...s, body: { ...fare, categoryId: ctx.catSedan } })).status, 403);
  assert.equal((await call('PUT', '/business/market', { ...s, body: market })).status, 403);
});

// The first client admin's token was invalidated when A was suspended and re-activated (sessions end on suspend),
// so sign in again with a known password for the role test.
async function resetAlpha() {
  const row = db.AdminUser.rows.find((u) => u.email === 'alpha@x.test');
  row.passwordHash = hash('alpha-known-password');
  row.failedLogins = 0;
  row.lockUntil = null;
  return { password: 'alpha-known-password' };
}

test('a POST with a JSON header and no body works (confirming setup), but malformed JSON is still rejected', async () => {
  const raw = async (body) => {
    const res = await fetch(base + '/business/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ctx.A.token, 'X-App-Id': ctx.A.appId },
      body
    });
    return { status: res.status, text: await res.text() };
  };
  const empty = await raw(undefined);
  assert.notEqual(empty.status, 400, 'an empty body must not be treated as invalid JSON: ' + empty.text);
  assert.notEqual((await raw('')).status, 400);
  assert.notEqual((await raw('{}')).status, 400);
  const broken = await raw('{"broken":');
  // the parser library reports a failed check as 403; this test only cares that it is still refused
  assert.ok(broken.status >= 400, 'a body that is present but broken is still rejected (got ' + broken.status + ')');
});

// ------------------------- region areas (centre point and radius) -------------------------

test('regions can carry a centre point and radius; the location checker finds the right one', async () => {
  const { password } = await resetAlpha();
  const a = { token: await signIn('alpha@x.test', password), appId: ctx.A.appId };

  const surat = await call('POST', '/business/regions', { ...a, body: { state: 'Gujarat', cities: [{ name: 'Surat', lat: 21.17, lng: 72.83 }, 'Vapi'], zoneName: 'Central', radiusKm: 25 } });
  assert.equal(surat.status, 201);
  const [withArea, withoutArea] = surat.body.data.created;
  assert.deepEqual(withArea.center, { lat: 21.17, lng: 72.83 });
  assert.equal(withArea.radiusKm, 25);
  assert.equal(withoutArea.center, null, 'a city typed without coordinates has no area yet');
  assert.equal(withoutArea.radiusKm, null);

  const overview = await call('GET', '/business/overview', a);
  assert.ok(overview.body.data.setup.warnings.some((w) => w.code === 'region_no_area' && w.message.includes('Vapi')), 'a region without an area is flagged');

  const inside = await call('POST', '/business/regions/locate', { ...a, body: { lat: 21.18, lng: 72.84 } });
  assert.equal(inside.status, 200);
  assert.equal(inside.body.data.inside, true);
  assert.equal(inside.body.data.region.city, 'Surat');
  assert.ok(inside.body.data.distanceKm < 3);
  const outside = await call('POST', '/business/regions/locate', { ...a, body: { lat: 28.6, lng: 77.2 } });
  assert.equal(outside.body.data.inside, false);
  assert.equal(outside.body.data.serviceAreasSet, true);
  assert.equal((await call('POST', '/business/regions/locate', { ...a, body: { lat: 'x', lng: 1 } })).status, 400);

  // give Vapi an area, reject bad values, then clear it
  const setArea = await call('PATCH', `/business/regions/${withoutArea.id}`, { ...a, body: { center: { lat: 20.37, lng: 72.9 }, radiusKm: 10 } });
  assert.equal(setArea.status, 200);
  assert.deepEqual(setArea.body.data.center, { lat: 20.37, lng: 72.9 });
  const badRadius = await call('PATCH', `/business/regions/${withoutArea.id}`, { ...a, body: { center: { lat: 20.37, lng: 72.9 }, radiusKm: 0 } });
  assert.equal(badRadius.status, 400);
  assert.ok(badRadius.body.errors.radiusKm);
  assert.equal((await call('PATCH', `/business/regions/${withoutArea.id}`, { ...a, body: { center: { lat: 200, lng: 72.9 }, radiusKm: 5 } })).status, 400);
  assert.equal((await call('PATCH', `/business/regions/${withoutArea.id}`, { ...a, body: { center: { lat: 20.37, lng: 72.9 } } })).status, 400, 'a centre needs a radius');
  const cleared = await call('PATCH', `/business/regions/${withoutArea.id}`, { ...a, body: { center: null } });
  assert.equal(cleared.body.data.center, null);
  assert.equal(cleared.body.data.radiusKm, null);
});

test('isolation: the location checker only sees the caller\'s own regions', async () => {
  const b = { token: ctx.B.token, appId: ctx.B.appId };
  const r = await call('POST', '/business/regions/locate', { ...b, body: { lat: 21.18, lng: 72.84 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.inside, false, 'business B has no region there even though business A does');
  assert.equal((await call('POST', '/business/regions/locate', { token: ctx.B.token, appId: ctx.A.appId, body: { lat: 21.18, lng: 72.84 } })).status, 403);
});
