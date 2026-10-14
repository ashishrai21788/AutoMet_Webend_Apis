/**
 * Fixed sign-in code for named test numbers only.
 *
 * No SMS provider is wired up yet, so a code is generated and stored but never delivered. For the numbers listed in
 * TEST_LOGIN_NUMBERS the code is TEST_LOGIN_OTP instead of a random one, so QA and device testing can sign in.
 * Both variables must be set to override the built-in test accounts below; with neither set, the built-in numbers
 * get the built-in code, and every other number gets a random code. Set TEST_LOGIN_DISABLED=1 to turn the fixed code
 * off entirely (do this before real riders and drivers arrive). Numbers are compared on their last 10 digits so
 * "+91 98765 43210", "919876543210" and "9876543210" are the same number.
 */
const crypto = require('crypto');

const last10 = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);

// The project's own test accounts (uRide test driver, the demo driver and the test rider).
const DEFAULT_TEST_CODE = '123456';
const DEFAULT_TEST_NUMBERS = ['9876500001', '9876543210', '1234567891'];

function testLoginConfig(env = process.env) {
  if (String(env.TEST_LOGIN_DISABLED || '').trim() === '1') return null;
  const code = String(env.TEST_LOGIN_OTP || '').trim();
  const numbers = String(env.TEST_LOGIN_NUMBERS || '')
    .split(',')
    .map(last10)
    .filter((n) => n.length === 10);
  if (/^[0-9]{6}$/.test(code) && numbers.length > 0) return { code, numbers: new Set(numbers) };
  // nothing (valid) configured: the built-in test accounts
  return { code: DEFAULT_TEST_CODE, numbers: new Set(DEFAULT_TEST_NUMBERS) };
}

/** A fresh 6-digit sign-in code for [phone]: the fixed test code for allow-listed numbers, otherwise random. */
function generateOtp(phone, env = process.env) {
  const cfg = testLoginConfig(env);
  if (cfg && cfg.numbers.has(last10(phone))) return cfg.code;
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * The fixed code for an allow-listed number, else undefined. Login responses include it for those numbers only, so a
 * test device can fill the code in by itself (the apps already read data.otp.otp); other numbers never see a code.
 */
function testCodeFor(phone, env = process.env) {
  const cfg = testLoginConfig(env);
  return cfg && cfg.numbers.has(last10(phone)) ? cfg.code : undefined;
}

module.exports = { generateOtp, testCodeFor, testLoginConfig, last10 };
