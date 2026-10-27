// SOS: a rider or driver on a ride presses Emergency; the business is told (trip, who, where) and staff acknowledge and resolve it.
// The apps only ever open the phone's dialler; nothing here places a call.
process.env.JWT_SECRET = 'test-secret-for-sos';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const sos = require('../controllers/sosController');
const rules = require('../lib/sos');
const { emergencyNumberFor } = require('../lib/emergency');
const { buildPublicConfig } = require('../lib/publicConfig');

// ---------------------------------------------------------------- pure rules

test('the emergency number follows the business\'s country, and falls back to 112', () => {
  assert.equal(emergencyNumberFor('IN'), '112');
  assert.equal(emergencyNumberFor('us'), '911');
  assert.equal(emergencyNumberFor('GB'), '999');
  assert.equal(emergencyNumberFor('AU'), '000');
  assert.equal(emergencyNumberFor(null), '112');
  assert.equal(emergencyNumberFor('ZZ'), '112');
  assert.equal(emergencyNumberFor(' in '), '112');
});

test('the public config carries the emergency number for the business\'s country', () => {
  const cfg = buildPublicConfig({ tenant: { tenantId: 't1', name: 'X', market: { country: 'US', currency: 'USD', timezone: 'America/New_York' } }, regions: [], categories: [], pricedCategoryIds: new Set(), resolvedBy: 'header' });
  assert.equal(cfg.business.emergencyNumber, '911');
  const none = buildPublicConfig({ tenant: { tenantId: 't1', name: 'X' }, regions: [], categories: [], pricedCategoryIds: new Set(), resolvedBy: 'header' });
  assert.equal(none.business.emergencyNumber, '112');
});

test('an SOS may be raised during a ride and for 30 minutes after it completes, never before a driver is assigned or long after', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  for (const status of ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING']) assert.equal(rules.canRaise({ status }, now), true, status);
  assert.equal(rules.canRaise({ status: 'COMPLETED', completed_at: new Date('2026-10-27T11:45:00Z') }, now), true);
  assert.equal(rules.canRaise({ status: 'COMPLETED', completed_at: new Date('2026-10-27T11:20:00Z') }, now), false);
  assert.equal(rules.canRaise({ status: 'COMPLETED' }, now), false, 'no completion time: not recent');
  for (const status of ['REQUESTED', 'CANCELLED_BY_USER', 'REJECTED', 'NO_RESPONSE']) assert.equal(rules.canRaise({ status }, now), false, status);
  assert.equal(rules.canRaise(null, now), false);
});

test('a location is kept only when it is a real point; a bad one is ignored, never a reason to refuse an emergency', () => {
  assert.deepEqual(rules.cleanLocation({ lat: 28.5, lng: 77.4, accuracy: 12.4 }), { lat: 28.5, lng: 77.4, accuracy: 12.4 });
  assert.deepEqual(rules.cleanLocation({ lat: '28.5', lng: '77.4' }), { lat: 28.5, lng: 77.4, accuracy: null });
  for (const bad of [null, undefined, {}, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: 'x', lng: 1 }, { lat: NaN, lng: 1 }]) assert.equal(rules.cleanLocation(bad), null);
});

// ---------------------------------------------------------------- the endpoints

const reset = async (over = {}) => {
  for (const m of ['Tenant', 'TripDetails', 'SosAlert', 'User', 'Driver', 'Vehicle', 'DriverVehicleAssignment', 'AdminAudit']) db[m].rows.length = 0;
  await db.Tenant.create({ tenantId: 't1', name: 'uRide', slug: 'uride', appName: 'uRide', packageName: 'in.uride', isDefault: true, market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } });
  await db.Tenant.create({ tenantId: 't2', name: 'Other', slug: 'other', appName: 'Other', packageName: 'in.other', market: { country: 'US', currency: 'USD', timezone: 'America/New_York' } });
  await db.User.create({ userId: 'U1', firstName: 'Asha', lastName: 'Rider', phone: '+919800000001', tenantId: 't1' });
  await db.Driver.create({ driverId: 'D1', firstName: 'Ravi', lastName: 'Driver', phone: '+919800000002', email: 'd1@t.test', tenantId: 't1' });
  await db.Vehicle.create({ vehicleId: 'V1', tenantId: 't1', registrationNumber: 'UP16TS4321', registrationKey: 'up16ts4321', make: 'Maruti', model: 'Dzire' });
  await db.DriverVehicleAssignment.create({ assignmentId: 'AS1', tenantId: 't1', driverId: 'D1', vehicleId: 'V1', active: true });
  await db.TripDetails.create({
    trip_id: 'T1', request_id: 'R1', tenant_id: 't1', user_id: 'U1', driver_id: 'D1', status: 'ON_GOING', timeout_at: new Date(),
    pickup: { address: 'Sector 62, Noida', lat: 28.57, lng: 77.35 }, drop: { address: 'Connaught Place', lat: 28.63, lng: 77.21 }, ...over
  });
};

const call = async (fn, { role, id, body = {}, params = {}, query = {}, tenant = 't1', admin = null } = {}) => {
  const account = role === 'user' ? { userId: id, tenantId: tenant } : { driverId: id, tenantId: tenant };
  const scope = (f = {}) => ({ ...f, tenantId: tenant });
  const req = {
    authRole: role, authActorId: id, user: role === 'user' ? account : null, driver: role === 'driver' ? account : null,
    body, params, query, headers: {}, ip: '1.1.1.1', business: { tenantId: tenant }, admin: admin || { adminId: 'A1', email: 'staff@t.test', role: 'support' },
    data: {
      find: (M, f) => M.find(scope(f)), findOne: (M, f) => M.findOne(scope(f)), count: (M, f) => M.countDocuments(scope(f)),
      update: (M, f, set) => M.findOneAndUpdate(scope(f), { $set: set }, { new: true })
    }
  };
  let out; const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await fn(req, res);
  return out;
};
const rider = (extra) => ({ role: 'user', id: 'U1', ...extra });
const driver = (extra) => ({ role: 'driver', id: 'D1', ...extra });
const press = (who, loc = { lat: 28.58, lng: 77.34, accuracy: 9 }) => call(sos.raise, { ...who, body: { trip_id: 'T1', ...loc } });

test('a rider presses SOS: the business gets the trip, both people, the vehicle and the location, and the app gets the number to dial', async () => {
  await reset();
  const r = await press(rider());
  assert.equal(r.code, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'OPEN');
  assert.equal(r.body.data.emergencyNumber, '112');
  const a = db.SosAlert.rows[0];
  assert.deepEqual([a.tripId, a.tenantId, a.raisedByRole, a.raisedById, a.raisedByName, a.otherName, a.status], ['T1', 't1', 'rider', 'U1', 'Asha Rider', 'Ravi Driver', 'OPEN']);
  assert.equal(a.otherPhone, '+919800000002');
  assert.match(a.vehicle, /UP16TS4321/);
  assert.equal(a.pickupAddress, 'Sector 62, Noida');
  assert.deepEqual([a.locations[0].lat, a.locations[0].lng], [28.58, 77.34]);
  assert.equal(a.tripStatus, 'ON_GOING');
});

test('a driver presses SOS: the same, from the driver\'s side', async () => {
  await reset();
  const r = await press(driver());
  assert.equal(r.code, 201);
  const a = db.SosAlert.rows[0];
  assert.deepEqual([a.raisedByRole, a.raisedByName, a.otherName], ['driver', 'Ravi Driver', 'Asha Rider']);
});

test('the number comes from the business\'s country', async () => {
  await reset();
  await db.Tenant.findOneAndUpdate({ tenantId: 't1' }, { $set: { market: { country: 'GB', currency: 'GBP', timezone: 'Europe/London' } } });
  assert.equal((await press(rider())).body.data.emergencyNumber, '999');
});

test('pressing again keeps one alert: the count goes up and the new location is added', async () => {
  await reset();
  await press(rider());
  const again = await press(rider(), { lat: 28.60, lng: 77.30 });
  assert.equal(again.code, 200, 'the same open alert, not a second one');
  assert.equal(db.SosAlert.rows.length, 1);
  assert.equal(db.SosAlert.rows[0].presses, 2);
  assert.equal(db.SosAlert.rows[0].locations.length, 2);
  assert.equal(again.body.data.sosId, db.SosAlert.rows[0].sosId);
});

test('the rider and the driver each get their own alert on the same trip', async () => {
  await reset();
  await press(rider()); await press(driver());
  assert.equal(db.SosAlert.rows.length, 2);
});

test('the location list is capped, and a missing or bad location never stops the alert', async () => {
  await reset();
  for (let i = 0; i < 30; i++) await press(rider(), { lat: 28 + i / 1000, lng: 77 });
  assert.equal(db.SosAlert.rows[0].locations.length, rules.MAX_LOCATIONS);
  assert.equal(db.SosAlert.rows[0].presses, 30);
  await reset();
  const r = await call(sos.raise, { ...rider(), body: { trip_id: 'T1' } });
  assert.equal(r.code, 201, 'no location at all is still an emergency');
  assert.deepEqual(db.SosAlert.rows[0].locations, []);
  const bad = await call(sos.raise, { ...driver(), body: { trip_id: 'T1', lat: 500, lng: 'x' } });
  assert.equal(bad.code, 201);
});

test('only the trip\'s own rider and driver may raise one, and only for their own business', async () => {
  await reset();
  await db.User.create({ userId: 'U2', firstName: 'Other', phone: '+919800000009', tenantId: 't1' });
  await db.Driver.create({ driverId: 'D2', firstName: 'Other', phone: '+919800000008', email: 'd2@t.test', tenantId: 't1' });
  assert.equal((await press({ role: 'user', id: 'U2' })).code, 403);
  assert.equal((await press({ role: 'driver', id: 'D2' })).code, 403);
  assert.equal((await press(rider({ tenant: 't2' }))).code, 403, 'a token from another business');
  assert.equal((await call(sos.raise, { ...rider(), body: {} })).code, 400, 'a trip is needed');
  assert.equal((await call(sos.raise, { ...rider(), body: { trip_id: 'nope' } })).code, 404);
  assert.equal(db.SosAlert.rows.length, 0);
});

test('a ride that is not under way refuses, with a clear reason, and a recently completed one still accepts', async () => {
  await reset({ status: 'REQUESTED', driver_id: null });
  const early = await press(rider());
  assert.ok([403, 409].includes(early.code), 'no driver assigned yet: refused');
  assert.equal(db.SosAlert.rows.length, 0);
  await reset({ status: 'CANCELLED_BY_USER' });
  assert.equal((await press(rider())).code, 409);
  await reset({ status: 'COMPLETED', completed_at: new Date(Date.now() - 5 * 60 * 1000) });
  assert.equal((await press(rider())).code, 201);
  await reset({ status: 'COMPLETED', completed_at: new Date(Date.now() - 3 * 60 * 60 * 1000) });
  assert.equal((await press(rider())).code, 409);
});

// ---------------------------------------------------------------- staff

const staff = (extra = {}) => ({ role: 'user', id: 'A1', ...extra });

test('staff see open emergencies first with who, where and the people involved; the list stays inside the business', async () => {
  await reset();
  await press(rider());
  await db.SosAlert.create({ sosId: 'sos_other', tenantId: 't2', tripId: 'TX', raisedByRole: 'rider', raisedById: 'UX', status: 'OPEN', presses: 1, locations: [], createdAt: new Date() });
  const r = await call(sos.list, staff());
  assert.equal(r.code, 200);
  assert.equal(r.body.data.open, 1);
  const item = r.body.data.items[0];
  assert.deepEqual([item.tripId, item.raisedBy.role, item.raisedBy.name, item.other.name, item.status], ['T1', 'rider', 'Asha Rider', 'Ravi Driver', 'OPEN']);
  assert.equal(item.locations[0].lat, 28.58);
  assert.match(item.mapUrl, /28\.58,77\.34/);
  assert.equal(r.body.data.items.some((x) => x.id === 'sos_other'), false);
});

test('staff acknowledge, then resolve with a note; each is recorded in the audit log, and neither can be repeated or skipped wrongly', async () => {
  await reset();
  await press(rider());
  const id = db.SosAlert.rows[0].sosId;
  const ack = await call(sos.acknowledge, staff({ params: { id } }));
  assert.equal(ack.code, 200, JSON.stringify(ack.body));
  assert.equal(db.SosAlert.rows[0].status, 'ACKNOWLEDGED');
  assert.equal(db.SosAlert.rows[0].acknowledgedBy.email, 'staff@t.test');
  assert.equal((await call(sos.acknowledge, staff({ params: { id } }))).code, 409, 'already acknowledged');
  const res = await call(sos.resolve, staff({ params: { id }, body: { note: 'Spoke to both; the rider is safe' } }));
  assert.equal(res.code, 200);
  assert.equal(db.SosAlert.rows[0].status, 'RESOLVED');
  assert.equal(db.SosAlert.rows[0].resolution, 'Spoke to both; the rider is safe');
  assert.equal((await call(sos.resolve, staff({ params: { id }, body: {} }))).code, 409, 'already resolved');
  assert.deepEqual(db.AdminAudit.rows.map((a) => a.action), ['sos.acknowledged', 'sos.resolved']);
  assert.equal((await call(sos.list, staff())).body.data.open, 0);
});

test('an open alert can be resolved directly, and a new press after resolving starts a new alert', async () => {
  await reset();
  await press(rider());
  const id = db.SosAlert.rows[0].sosId;
  assert.equal((await call(sos.resolve, staff({ params: { id }, body: { note: 'False alarm' } }))).code, 200);
  const again = await press(rider());
  assert.equal(again.code, 201);
  assert.equal(db.SosAlert.rows.length, 2);
});

test('staff cannot touch another business\'s alert, and an unknown id is a 404', async () => {
  await reset();
  await db.SosAlert.create({ sosId: 'sos_other', tenantId: 't2', tripId: 'TX', raisedByRole: 'rider', raisedById: 'UX', status: 'OPEN', presses: 1, locations: [], createdAt: new Date() });
  assert.equal((await call(sos.acknowledge, staff({ params: { id: 'sos_other' } }))).code, 404);
  assert.equal((await call(sos.resolve, staff({ params: { id: 'missing' }, body: {} }))).code, 404);
  assert.equal(db.SosAlert.rows.find((x) => x.sosId === 'sos_other').status, 'OPEN');
});

test('a resolution note is limited in length', async () => {
  await reset();
  await press(rider());
  const id = db.SosAlert.rows[0].sosId;
  assert.equal((await call(sos.resolve, staff({ params: { id }, body: { note: 'x'.repeat(400) } }))).code, 400);
  assert.equal(db.SosAlert.rows[0].status, 'OPEN');
});
