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
