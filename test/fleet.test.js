// Verification status, eligibility, validation and file checks (no database). Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const ver = require('../lib/verification');
const { driverEligibility } = require('../lib/eligibility');
const fv = require('../lib/fleetValidation');
const { detectMime, safeFileName } = require('../lib/fileValidation');
const { can, ROLE_PERMISSIONS } = require('../lib/adminPermissions');

const NOW = new Date('2026-10-04T00:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86400000);
const driverReq = ver.resolveRequirements(null).driver;
const vehicleReq = ver.resolveRequirements(null).vehicle;
const doc = (type, status, expiryDate = null) => ({ type, status, expiryDate });

test('requirements: defaults, overrides, and the locked documents cannot be switched off', () => {
  const d = ver.resolveRequirements(null);
  assert.deepEqual(d.driver.filter((r) => r.mandatory).map((r) => r.type), ['DRIVING_LICENCE', 'IDENTITY']);
  assert.deepEqual(d.vehicle.filter((r) => r.mandatory).map((r) => r.type), ['REGISTRATION_CERTIFICATE', 'INSURANCE']);
  const custom = ver.resolveRequirements({ verificationRequirements: { driver: { ADDRESS_PROOF: true, IDENTITY: false }, vehicle: { PERMIT: true } } });
  assert.equal(custom.driver.find((r) => r.type === 'ADDRESS_PROOF').mandatory, true);
  assert.equal(custom.driver.find((r) => r.type === 'IDENTITY').mandatory, false);
  assert.equal(custom.vehicle.find((r) => r.type === 'PERMIT').mandatory, true);
  // an override can never turn off a locked type, even if one is stored
  const forced = ver.resolveRequirements({ verificationRequirements: { driver: { DRIVING_LICENCE: false } } });
  assert.equal(forced.driver.find((r) => r.type === 'DRIVING_LICENCE').mandatory, true);

  assert.ok(ver.validateRequirementsUpdate({ driver: { DRIVING_LICENCE: false } }).errors['driver.DRIVING_LICENCE']);
  assert.ok(ver.validateRequirementsUpdate({ vehicle: { REGISTRATION_CERTIFICATE: false } }).errors['vehicle.REGISTRATION_CERTIFICATE']);
  assert.ok(ver.validateRequirementsUpdate({ driver: { PROFILE_PHOTO: true } }).errors['driver.PROFILE_PHOTO']);
  assert.ok(ver.validateRequirementsUpdate({ driver: { NOPE: true } }).errors['driver.NOPE']);
  assert.ok(ver.validateRequirementsUpdate({ driver: { IDENTITY: 'yes' } }).errors['driver.IDENTITY']);
  assert.deepEqual(ver.validateRequirementsUpdate({ driver: { ADDRESS_PROOF: true } }).errors, {});
});

test('verification status is computed from the mandatory documents', () => {
  const st = (docs) => ver.computeVerification(docs, driverReq, NOW).status;
  assert.equal(st([]), 'INCOMPLETE', 'nothing submitted');
  assert.equal(st([doc('DRIVING_LICENCE', 'SUBMITTED', day(300))]), 'INCOMPLETE', 'one of two mandatory documents missing');
  assert.equal(st([doc('DRIVING_LICENCE', 'SUBMITTED', day(300)), doc('IDENTITY', 'SUBMITTED')]), 'PENDING_REVIEW');
  assert.equal(st([doc('DRIVING_LICENCE', 'APPROVED', day(300)), doc('IDENTITY', 'SUBMITTED')]), 'PENDING_REVIEW', 'approval needs every mandatory document');
  assert.equal(st([doc('DRIVING_LICENCE', 'APPROVED', day(300)), doc('IDENTITY', 'APPROVED')]), 'APPROVED');
  assert.equal(st([doc('DRIVING_LICENCE', 'REJECTED'), doc('IDENTITY', 'APPROVED')]), 'REJECTED');
  assert.equal(st([doc('DRIVING_LICENCE', 'REJECTED')]), 'REJECTED', 'a rejection outranks a missing document');
  assert.equal(st([doc('DRIVING_LICENCE', 'APPROVED', day(-1)), doc('IDENTITY', 'APPROVED')]), 'EXPIRED', 'an approved document past its expiry');
  assert.equal(st([doc('DRIVING_LICENCE', 'APPROVED', day(300)), doc('IDENTITY', 'APPROVED'), doc('ADDRESS_PROOF', 'REJECTED')]), 'APPROVED', 'an optional document does not block approval');
  const approved = ver.computeVerification([doc('DRIVING_LICENCE', 'APPROVED', day(300)), doc('IDENTITY', 'APPROVED', day(90))], driverReq, NOW);
  assert.equal(approved.expiresAt.getTime(), day(90).getTime(), 'the earliest expiry is tracked');
  const strict = ver.resolveRequirements({ verificationRequirements: { driver: { ADDRESS_PROOF: true } } }).driver;
  assert.equal(ver.computeVerification([doc('DRIVING_LICENCE', 'APPROVED', day(300)), doc('IDENTITY', 'APPROVED')], strict, NOW).status, 'INCOMPLETE');
});

test('vehicle verification uses the vehicle requirements', () => {
  const st = (docs) => ver.computeVerification(docs, vehicleReq, NOW).status;
  assert.equal(st([doc('REGISTRATION_CERTIFICATE', 'APPROVED'), doc('INSURANCE', 'APPROVED', day(100))]), 'APPROVED');
  assert.equal(st([doc('REGISTRATION_CERTIFICATE', 'APPROVED'), doc('INSURANCE', 'APPROVED', day(-5))]), 'EXPIRED');
});

test('stored status: an APPROVED record past its earliest expiry reads as EXPIRED', () => {
  assert.equal(ver.effectiveStoredStatus({ verificationStatus: 'APPROVED', verificationExpiresAt: day(-1) }, NOW), 'EXPIRED');
  assert.equal(ver.effectiveStoredStatus({ verificationStatus: 'APPROVED', verificationExpiresAt: day(5) }, NOW), 'APPROVED');
  assert.equal(ver.effectiveStoredStatus({ verificationStatus: 'REJECTED', verificationExpiresAt: day(-1) }, NOW), 'REJECTED');
  assert.equal(ver.effectiveStoredStatus({}, NOW), 'INCOMPLETE');
});

const goodDriver = { accountStatus: 'ACTIVE', driverVerificationStatus: 'APPROVED', verificationExpiresAt: day(100), operatingRegionId: 'r1', eligibleCategoryId: 'c1' };
const goodVehicle = { status: 'ACTIVE', verificationStatus: 'APPROVED', verificationExpiresAt: day(100), categoryId: 'c1', operatingRegionId: 'r1' };
const goodRegion = { regionId: 'r1', active: true };
const codes = (r) => r.reasons.map((x) => x.code);

test('eligibility: all conditions together, and each failure on its own', () => {
  const ok = driverEligibility({ driver: goodDriver, vehicle: goodVehicle, region: goodRegion, now: NOW });
  assert.equal(ok.eligible, true);
  assert.deepEqual(ok.reasons, []);

  const check = (over, code) => {
    const r = driverEligibility({ driver: { ...goodDriver, ...(over.driver || {}) }, vehicle: over.vehicle === null ? null : { ...goodVehicle, ...(over.vehicle || {}) }, region: over.region === undefined ? goodRegion : over.region, now: NOW });
    assert.equal(r.eligible, false, code);
    assert.ok(codes(r).includes(code), `${code} in ${codes(r)}`);
  };
  check({ driver: { accountStatus: 'SUSPENDED' } }, 'ACCOUNT_NOT_ACTIVE');
  check({ driver: { accountStatus: 'INACTIVE' } }, 'ACCOUNT_NOT_ACTIVE');
  check({ driver: { driverVerificationStatus: 'PENDING_REVIEW' } }, 'DRIVER_NOT_VERIFIED');
  check({ driver: { driverVerificationStatus: 'APPROVED', verificationExpiresAt: day(-1) } }, 'DRIVER_NOT_VERIFIED');
  check({ driver: { operatingRegionId: null } }, 'NO_REGION');
  check({ region: { regionId: 'r1', active: false } }, 'REGION_INACTIVE');
  check({ vehicle: null }, 'NO_VEHICLE');
  check({ vehicle: { status: 'INACTIVE' } }, 'VEHICLE_NOT_ACTIVE');
  check({ vehicle: { status: 'SUSPENDED' } }, 'VEHICLE_NOT_ACTIVE');
  check({ vehicle: { verificationStatus: 'REJECTED' } }, 'VEHICLE_NOT_VERIFIED');
  check({ vehicle: { verificationStatus: 'APPROVED', verificationExpiresAt: day(-2) } }, 'VEHICLE_NOT_VERIFIED');
  check({ vehicle: { categoryId: 'other' } }, 'CATEGORY_MISMATCH');
  check({ vehicle: { operatingRegionId: 'r2' } }, 'REGION_MISMATCH');
});

test('eligibility: a new account, or just assigning a vehicle, is not enough', () => {
  const fresh = { accountStatus: 'ACTIVE', operatingRegionId: 'r1' }; // created, nothing verified
  const r = driverEligibility({ driver: fresh, vehicle: goodVehicle, region: goodRegion, now: NOW });
  assert.equal(r.eligible, false);
  assert.ok(codes(r).includes('DRIVER_NOT_VERIFIED'));
  const suspended = driverEligibility({ driver: { ...goodDriver, accountStatus: 'SUSPENDED' }, vehicle: goodVehicle, region: goodRegion, now: NOW });
  assert.equal(suspended.eligible, false, 'a suspended driver stays ineligible with a perfect vehicle');
});

test('phone numbers: international format only, with the spellings older records may use', () => {
  assert.equal(fv.normalizePhone('+91 98765-43210'), '+919876543210');
  assert.equal(fv.normalizePhone('(+44) 7700 900123'), '+447700900123');
  assert.equal(fv.normalizePhone('9876543210'), null, 'the country code is required');
  assert.equal(fv.normalizePhone('+0123456789'), null);
  assert.equal(fv.normalizePhone('+12'), null);
  const variants = fv.phoneVariants('+919876543210');
  assert.ok(variants.includes('+919876543210') && variants.includes('919876543210') && variants.includes('9876543210'));
});

test('driver validation', () => {
  const ok = { fullName: 'Ravi Kumar Singh', phone: '+919876543210', email: 'Ravi@Example.com', dateOfBirth: '1990-05-01', address: { country: 'in', state: 'UP', city: 'Lucknow', line: '12 Park Road' } };
  const good = fv.validateDriverInput(ok, { now: NOW });
  assert.deepEqual(good.errors, {});
  assert.equal(good.value.firstName, 'Ravi');
  assert.equal(good.value.lastName, 'Kumar Singh');
  assert.equal(good.value.email, 'ravi@example.com');
  assert.equal(good.value.address.country, 'IN');
  assert.equal(fv.validateDriverInput({ fullName: 'Ravi', phone: '+919876543210' }, { now: NOW }).value.lastName, '-', 'single names are accepted');
  assert.ok(fv.validateDriverInput({ ...ok, fullName: '' }, { now: NOW }).errors.fullName);
  assert.ok(fv.validateDriverInput({ ...ok, phone: '98765' }, { now: NOW }).errors.phone);
  assert.ok(fv.validateDriverInput({ ...ok, email: 'nope' }, { now: NOW }).errors.email);
  assert.ok(fv.validateDriverInput({ ...ok, dateOfBirth: '2015-01-01' }, { now: NOW }).errors.dateOfBirth, 'under 18');
  assert.ok(fv.validateDriverInput({ ...ok, dateOfBirth: 'soon' }, { now: NOW }).errors.dateOfBirth);
  assert.equal(fv.validateDriverInput({ ...ok, email: '' }, { now: NOW }).value.email, '', 'email is optional');
  assert.deepEqual(fv.validateDriverInput({ email: 'a@b.co' }, { partial: true, now: NOW }).errors, {}, 'partial updates only check what is sent');
});

test('vehicle validation and registration normalisation', () => {
  assert.equal(fv.normalizeRegistration('mh 12-ab 1234'), 'MH12AB1234');
  assert.equal(fv.normalizeRegistration('MH12AB1234'), 'MH12AB1234');
  const ok = { registrationNumber: 'mh 12 ab 1234', make: 'Maruti', model: 'Dzire', year: 2021, colour: 'White', categoryId: 'c1', passengerCapacity: 4 };
  const good = fv.validateVehicleInput(ok, { now: NOW });
  assert.deepEqual(good.errors, {});
  assert.equal(good.value.registrationKey, 'MH12AB1234');
  assert.equal(good.value.registrationNumber, 'MH 12 AB 1234');
  assert.ok(fv.validateVehicleInput({ ...ok, registrationNumber: 'AB' }, { now: NOW }).errors.registrationNumber);
  assert.ok(fv.validateVehicleInput({ ...ok, registrationNumber: 'MH12<script>' }, { now: NOW }).errors.registrationNumber);
  assert.ok(fv.validateVehicleInput({ ...ok, make: '' }, { now: NOW }).errors.make);
  assert.ok(fv.validateVehicleInput({ ...ok, year: 1950 }, { now: NOW }).errors.year);
  assert.ok(fv.validateVehicleInput({ ...ok, year: 2040 }, { now: NOW }).errors.year);
  assert.ok(fv.validateVehicleInput({ ...ok, passengerCapacity: 0 }, { now: NOW }).errors.passengerCapacity);
  assert.ok(fv.validateVehicleInput({ ...ok, categoryId: '' }, { now: NOW }).errors.categoryId);
  assert.ok(fv.validateVehicleInput({ ...ok, status: 'BROKEN' }, { now: NOW }).errors.status);
});

test('document metadata: required fields and expiry dates', () => {
  const licence = ver.DRIVER_DOCUMENT_TYPES.find((d) => d.type === 'DRIVING_LICENCE');
  const identity = ver.DRIVER_DOCUMENT_TYPES.find((d) => d.type === 'IDENTITY');
  assert.deepEqual(fv.validateDocumentMeta({ number: 'DL-123', expiryDate: '2030-01-01' }, licence, { now: NOW }).errors, {});
  assert.ok(fv.validateDocumentMeta({ expiryDate: '2030-01-01' }, licence, { now: NOW }).errors.number, 'number is required');
  assert.ok(fv.validateDocumentMeta({ number: 'DL-123' }, licence, { now: NOW }).errors.expiryDate, 'expiry is required for a licence');
  assert.ok(fv.validateDocumentMeta({ number: 'DL-123', expiryDate: '2020-01-01' }, licence, { now: NOW }).errors.expiryDate, 'already expired');
  assert.ok(fv.validateDocumentMeta({ number: 'DL-123', expiryDate: 'tomorrow-ish' }, licence, { now: NOW }).errors.expiryDate);
  assert.deepEqual(fv.validateDocumentMeta({ number: 'ID-9' }, identity, { now: NOW }).errors, {}, 'identity has no expiry requirement');
  assert.deepEqual(fv.validateDocumentMeta({ number: 'DL', expiryDate: '2026-10-04' }, licence, { now: NOW }).errors, {}, 'expiring today is still valid today');
});

test('review and status inputs', () => {
  assert.deepEqual(fv.validateReview({ decision: 'APPROVE' }).errors, {});
  assert.ok(fv.validateReview({ decision: 'REJECT' }).errors.reason, 'a rejection needs a reason');
  assert.ok(fv.validateReview({ decision: 'REJECT', reason: 'bad' }).errors.reason);
  assert.deepEqual(fv.validateReview({ decision: 'REJECT', reason: 'The licence photo is blurry' }).errors, {});
  assert.ok(fv.validateReview({ decision: 'MAYBE' }).errors.decision);
  assert.ok(fv.validateStatusChange({ status: 'SUSPENDED' }, fv.DRIVER_ACCOUNT_STATUSES).errors.reason, 'a suspension needs a reason');
  assert.deepEqual(fv.validateStatusChange({ status: 'INACTIVE' }, fv.DRIVER_ACCOUNT_STATUSES).errors, {});
  assert.ok(fv.validateStatusChange({ status: 'DELETED' }, fv.DRIVER_ACCOUNT_STATUSES).errors.status);
});

test('uploaded files are identified by their bytes, not their name or declared type', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(20)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
  assert.equal(detectMime(jpeg), 'image/jpeg');
  assert.equal(detectMime(png), 'image/png');
  assert.equal(detectMime(pdf), 'application/pdf');
  assert.equal(detectMime(webp), 'image/webp');
  assert.equal(detectMime(Buffer.from('MZ\x90\x00\x03' + 'x'.repeat(30))), null, 'a Windows executable');
  assert.equal(detectMime(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(detectMime(Buffer.from('tiny')), null);
  assert.equal(safeFileName('..\\..\\evil/../licence photo (1).jpg'), 'licence photo _1_.jpg');
});

test('permissions: who can open documents and decide on them', () => {
  const role = (r) => ({ role: r });
  for (const p of ['documents.view', 'verification.review']) {
    assert.equal(can(role('client_admin'), p), true);
    assert.equal(can(role('super_admin'), p), true);
    assert.equal(can(role('operations'), p), true);
    assert.equal(can(role('support'), p), false, `support must not have ${p}`);
    assert.equal(can(role('finance'), p), false, `finance must not have ${p}`);
  }
  assert.equal(can(role('support'), 'drivers.view'), true);
  assert.equal(can(role('support'), 'drivers.manage'), false);
  assert.equal(can(role('support'), 'vehicles.view'), true);
  assert.equal(can(role('finance'), 'drivers.view'), false);
  assert.ok(ROLE_PERMISSIONS.client_admin.includes('vehicles.manage'));
});
