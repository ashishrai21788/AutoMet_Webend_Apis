const test = require('node:test');
const assert = require('node:assert/strict');
const { generateOtp, testLoginConfig, last10 } = require('../lib/testLogin');

const env = { TEST_LOGIN_OTP: '246810', TEST_LOGIN_NUMBERS: '9876543210, +91 91234 56789' };

test('allow-listed numbers get the fixed code, in any common format', () => {
  assert.equal(generateOtp('9876543210', env), '246810');
  assert.equal(generateOtp('+919876543210', env), '246810');
  assert.equal(generateOtp('91 23456789'.replace(' ', '12345'), env).length, 6);
  assert.equal(generateOtp('+91 91234 56789', env), '246810');
});

test('other numbers get a random six-digit code', () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const otp = generateOtp('9000000000', env);
    assert.match(otp, /^[0-9]{6}$/);
    seen.add(otp);
  }
  assert.ok(seen.size > 1, 'random codes should vary');
  assert.notEqual(generateOtp('9000000000', env), '246810x');
});

test('nothing is fixed unless both variables are set and valid', () => {
  assert.equal(testLoginConfig({}), null);
  assert.equal(testLoginConfig({ TEST_LOGIN_OTP: '246810' }), null);
  assert.equal(testLoginConfig({ TEST_LOGIN_NUMBERS: '9876543210' }), null);
  assert.equal(testLoginConfig({ TEST_LOGIN_OTP: '12345', TEST_LOGIN_NUMBERS: '9876543210' }), null);
  assert.equal(testLoginConfig({ TEST_LOGIN_OTP: '246810', TEST_LOGIN_NUMBERS: '12345' }), null);
});

test('last10 normalises phone formats', () => {
  assert.equal(last10('+91 98765-43210'), '9876543210');
  assert.equal(last10(null), '');
});

test('testCodeFor returns the code for allow-listed numbers only', () => {
  const { testCodeFor } = require('../lib/testLogin');
  assert.equal(testCodeFor('+91 98765 43210', env), '246810');
  assert.equal(testCodeFor('9000000000', env), undefined);
  assert.equal(testCodeFor('9876543210', {}), undefined);
});
