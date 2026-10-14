const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveOnboarding, driverOnboardingResponse, isManagedByBusiness } = require('../lib/driverOnboarding');

const managed = { driverId: 'D1', eligibleCategoryId: 'vc_1', operatingRegionId: 'rg_1' };
const eligible = { eligibility: { eligible: true, reasons: [] } };
const waiting = (code, message) => ({ eligibility: { eligible: false, reasons: [{ code, message }] } });

test('a driver the business has not touched keeps their own flags', () => {
  assert.equal(isManagedByBusiness({ driverId: 'D2' }), false);
  assert.equal(deriveOnboarding({ driver: { driverId: 'D2' }, availability: eligible }), null);
});

test('an eligible managed driver is approved, with vehicle and documents done', () => {
  const r = deriveOnboarding({ driver: managed, availability: eligible });
  assert.deepEqual(r.flags, { isVehicleAdded: true, isDocumentsUploaded: true, verification_status: 'APPROVED' });
  assert.equal(r.onboarding.eligible, true);
});

test('a managed driver who is not eligible yet waits, with the reasons', () => {
  const r = deriveOnboarding({ driver: managed, availability: waiting('NO_VEHICLE', 'No vehicle is assigned') });
  assert.equal(r.flags.verification_status, 'UNDER_REVIEW');
  assert.equal(r.flags.isVehicleAdded, true); // nothing for the app to fill in
  assert.deepEqual(r.onboarding.reasons, [{ code: 'NO_VEHICLE', message: 'No vehicle is assigned' }]);
});

test('a rejected or expired verification shows the rejected screen', () => {
  for (const s of ['REJECTED', 'EXPIRED']) {
    const r = deriveOnboarding({ driver: { ...managed, driverVerificationStatus: s }, availability: waiting('DRIVER_NOT_VERIFIED', 'x') });
    assert.equal(r.flags.verification_status, 'REJECTED');
  }
});

test('the response middleware rewrites the driver object and leaves everything else alone', async () => {
  const mw = driverOnboardingResponse(async () => managed, async () => eligible);
  let sent;
  const res = { json(b) { sent = b; return this; } };
  await new Promise((resolve) => {
    const orig = res.json;
    res.json = function (b) { orig.call(this, b); resolve(); return this; };
    mw({}, res, () => {});
    res.json({ success: true, data: { driver: { driverId: 'D1', phone: '+91', isVehicleAdded: false, isDocumentsUploaded: false, verification_status: 'INCOMPLETE', firstName: 'Anil' } } });
  });
  assert.equal(sent.data.driver.verification_status, 'APPROVED');
  assert.equal(sent.data.driver.isVehicleAdded, true);
  assert.equal(sent.data.driver.firstName, 'Anil');
  assert.equal(sent.data.driver.onboarding.eligible, true);
});

test('a lookup failure still sends the original response', async () => {
  const mw = driverOnboardingResponse(async () => { throw new Error('db down'); }, async () => eligible);
  let sent;
  await new Promise((resolve) => {
    const res = { json(b) { sent = b; resolve(); return this; } };
    mw({}, res, () => {});
    res.json({ success: true, data: { driverId: 'D1', phone: '+91', verification_status: 'INCOMPLETE' } });
  });
  assert.equal(sent.data.verification_status, 'INCOMPLETE');
});
