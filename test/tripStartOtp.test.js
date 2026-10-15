// Trip start code: derived, shown only to the rider, required to start, locked after repeated wrong attempts.
process.env.JWT_SECRET = 'test-secret-for-trip-start-otp';
const test = require('node:test');
const assert = require('node:assert/strict');
const otp = require('../lib/tripStartOtp');

const trip = (extra = {}) => ({ trip_id: 'amt_1', status: 'DRIVER_ON_THE_WAY', responded_at: '2026-10-13T10:00:00.000Z', ...extra });
const withFlag = (value, fn) => { const prev = process.env.TRIP_START_OTP; if (value === undefined) delete process.env.TRIP_START_OTP; else process.env.TRIP_START_OTP = value; try { return fn(); } finally { if (prev === undefined) delete process.env.TRIP_START_OTP; else process.env.TRIP_START_OTP = prev; } };

test('switched off with TRIP_START_OTP=off: nothing is shown and nothing is required', () => withFlag('off', () => {
  assert.equal(otp.enabled(), false);
  assert.equal(otp.codeForRider(trip()), null);
  assert.deepEqual(otp.check(trip(), undefined), { ok: true });
}));

test('on by default: the rider gets a code and the driver must give it', () => withFlag(undefined, () => {
  assert.equal(otp.enabled(), true);
  assert.match(otp.codeForRider(trip()), /^[0-9]{4}$/);
  assert.equal(otp.check(trip(), undefined).code, 'OTP_REQUIRED');
}));

test('the code is four digits, stable for a trip and different between trips', () => withFlag('on', () => {
  const a = otp.codeFor(trip());
  assert.match(a, /^\d{4}$/);
  assert.equal(otp.codeFor(trip()), a, 'the same trip always has the same code');
  const others = new Set(Array.from({ length: 30 }, (_, i) => otp.codeFor(trip({ trip_id: `amt_${i + 2}` }))));
  assert.ok(others.size > 20, 'codes are spread across trips');
}));

test('a new assignment (different accept time) gets a new code', () => withFlag('on', () => {
  const a = otp.codeFor(trip());
  let moved = a;
  for (let m = 1; moved === a && m < 50; m += 1) moved = otp.codeFor(trip({ responded_at: `2026-10-13T10:${String(m).padStart(2, '0')}:00.000Z` }));
  assert.notEqual(moved, a);
}));

test('the rider sees the code only while the driver is coming or has arrived', () => withFlag('on', () => {
  for (const status of ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED']) assert.match(otp.codeForRider(trip({ status })), /^\d{4}$/, status);
  for (const status of ['REQUESTED', 'ON_GOING', 'COMPLETED', 'CANCELLED_BY_USER', 'NO_RESPONSE']) assert.equal(otp.codeForRider(trip({ status })), null, status);
}));

test('start requires the right code', () => withFlag('on', () => {
  const t = trip({ status: 'ARRIVED' });
  const good = otp.codeFor(t);
  assert.deepEqual(otp.check(t, good), { ok: true });
  assert.deepEqual(otp.check(t, ` ${good} `), { ok: true }, 'surrounding spaces are ignored');
  assert.equal(otp.check(t, undefined).code, 'OTP_REQUIRED');
  assert.equal(otp.check(t, '').code, 'OTP_REQUIRED');
  const wrong = good === '0000' ? '1111' : '0000';
  const bad = otp.check(t, wrong);
  assert.equal(bad.code, 'OTP_INVALID');
  assert.equal(bad.status, 403);
  for (const junk of ['12', '12345', 'abcd', '١٢٣٤']) assert.equal(otp.check(t, junk).ok, false, junk);
}));

test('five wrong attempts lock the trip, even for the right code', () => withFlag('on', () => {
  const t = trip({ status: 'ARRIVED', start_otp_attempts: otp.MAX_ATTEMPTS });
  const locked = otp.check(t, otp.codeFor(t));
  assert.equal(locked.code, 'OTP_LOCKED');
  assert.equal(locked.status, 429);
  assert.equal(otp.check(trip({ status: 'ARRIVED', start_otp_attempts: otp.MAX_ATTEMPTS - 1 }), otp.codeFor(t)).ok, true);
}));
