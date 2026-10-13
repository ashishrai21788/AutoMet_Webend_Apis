/**
 * Fixed sign-in code for named test numbers only.
 *
 * No SMS provider is wired up yet, so a code is generated and stored but never delivered. For the numbers listed in
 * TEST_LOGIN_NUMBERS the code is TEST_LOGIN_OTP instead of a random one, so QA and device testing can sign in.
 * Both variables must be set; with either missing every number gets a random code as before. Numbers are compared on
 * their last 10 digits so "+91 98765 43210", "919876543210" and "9876543210" are the same number.
 */
const crypto = require('crypto');

const last10 = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);

function testLoginConfig(env = process.env) {
  const code = String(env.TEST_LOGIN_OTP || '').trim();
  const numbers = String(env.TEST_LOGIN_NUMBERS || '')
    .split(',')
    .map(last10)
    .filter((n) => n.length === 10);
  if (!/^[0-9]{6}$/.test(code) || numbers.length === 0) return null;
  return { code, numbers: new Set(numbers) };
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
