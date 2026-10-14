const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveOnboarding, driverOnboardingResponse, isManagedByBusiness } = require('../lib/driverOnboarding');

const managed = { driverId: 'D1', eligibleCategoryId: 'vc_1', operatingRegionId: 'rg_1' };
const eligible = { eligibility: { eligible: true, reasons: [] } };
const waiting = (code, message) => ({ eligibility: { eligible: false, reasons: [{ code, message }] } });

test('a driver approved under the old self-onboarding keeps working while eligibility is not enforced', () => {
  const legacy = { driverId: 'D2', verification_status: 'APPROVED', isVehicleAdded: true, isDocumentsUploaded: true };
  assert.equal(deriveOnboarding({ driver: legacy, availability: { enforced: false, eligibility: { eligible: false, reasons: [] } } }), null);
  // ...but once the business enforces eligibility, the records decide
  const r = deriveOnboarding({ driver: legacy, availability: { enforced: true, eligibility: { eligible: false, reasons: [{ code: 'NO_VEHICLE', message: 'No vehicle is assigned' }] } } });
  assert.equal(r.flags.verification_status, 'UNDER_REVIEW');
});

test('a driver who is still onboarding follows the business records, even with nothing set yet', () => {
  const fresh = { driverId: 'D3', verification_status: 'INCOMPLETE' };
  const r = deriveOnboarding({ driver: fresh, availability: waiting('NO_REGION', 'The driver has no operating region') });
  assert.equal(r.flags.verification_status, 'UNDER_REVIEW');
  assert.equal(r.onboarding.reasons[0].code, 'NO_REGION');
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
