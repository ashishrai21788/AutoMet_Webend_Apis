const test = require('node:test');
const assert = require('node:assert/strict');
const { phoneVariants } = require('../lib/phoneVariants');

test('an Indian number matches its stored forms', () => {
  const want = ['+919876543210', '9876543210', '919876543210'];
  for (const input of ['9876543210', '+919876543210', '919876543210', ' +91 98765 43210 ']) {
    const v = phoneVariants(input);
    for (const w of want) assert.ok(v.includes(w), `${input} should include ${w}`);
  }
});

test('other numbers are matched exactly', () => {
  assert.deepEqual(phoneVariants('+14155550123'), ['+14155550123']);
  assert.deepEqual(phoneVariants('12345'), ['12345']);
});

test('empty input gives nothing', () => {
  assert.deepEqual(phoneVariants(''), []);
  assert.deepEqual(phoneVariants(null), []);
});

test('a number written with the national leading 0 is the same number', () => {
  const { phoneVariants: variants, canonicalPhone: canonical } = require('../lib/phoneVariants');
  assert.equal(canonical('09810000001'), '+919810000001');
  assert.ok(variants('09810000001').includes('+919810000001'));
  assert.ok(variants('+919810000001').includes('9810000001'));
});
