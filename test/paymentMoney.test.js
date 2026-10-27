// Payment money: integer minor units (paise), commission in basis points, one documented rounding rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const money = require('../lib/paymentMoney');

test('a percentage becomes whole basis points, and more than two decimals or out-of-range values are refused', () => {
  assert.equal(money.percentToBasisPoints(15), 1500);
  assert.equal(money.percentToBasisPoints('12.5'), 1250);
  assert.equal(money.percentToBasisPoints(0), 0);
  assert.equal(money.percentToBasisPoints(100), 10000);
  for (const bad of [12.555, -1, 100.01, NaN, 'abc', null, undefined, Infinity]) assert.throws(() => money.percentToBasisPoints(bad), RangeError, String(bad));
});

test('commission is the rate on the fare, rounded half up to a whole paisa, in integer arithmetic', () => {
  assert.equal(money.commissionMinor(20000, 1500), 3000, 'Rs 200 at 15% is Rs 30');
  assert.equal(money.commissionMinor(10001, 1500), 1500, '1500.15 rounds down');
  assert.equal(money.commissionMinor(10003, 1500), 1500, '1500.45 rounds down');
  assert.equal(money.commissionMinor(10004, 1500), 1501, '1500.60 rounds up');
  assert.equal(money.commissionMinor(10, 500), 1, '0.5 rounds up (half up)');
  assert.equal(money.commissionMinor(9, 500), 0, '0.45 rounds down');
  assert.equal(money.commissionMinor(0, 1500), 0);
  assert.equal(money.commissionMinor(12345678901, 1500), 1851851835, 'large fares stay exact (no floating point)');
});

test('amounts must be whole non-negative minor units; floats and strings are refused, never rounded silently', () => {
  for (const bad of [10.5, -1, '100', null, undefined, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => money.commissionMinor(bad, 1500), TypeError, String(bad));
  }
  for (const bad of [1.5, -1, 10001, '10', NaN]) assert.throws(() => money.commissionMinor(100, bad), RangeError, String(bad));
});

test('commission plus driver net always equals the fare, for every fare and rate (property check)', () => {
  let seed = 12345;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 5000; i += 1) {
    const fare = next() % 5_000_000;
    const bp = next() % 10001;
    const s = money.splitFare(fare, { type: 'PERCENT', rateBp: bp, ruleId: 'r', version: 1 });
    assert.equal(s.commissionMinor + s.netMinor, fare, `fare ${fare} at ${bp}bp`);
    assert.ok(s.commissionMinor >= 0 && s.netMinor >= 0 && s.commissionMinor <= fare);
  }
});

test('a fixed commission is a flat amount, never more than the fare, and the rule that produced it is recorded with it', () => {
  const a = money.splitFare(20000, { type: 'FIXED', amountMinor: 2500, ruleId: 'fx', version: 3 });
  assert.deepEqual([a.commissionMinor, a.netMinor], [2500, 17500]);
  const small = money.splitFare(1000, { type: 'FIXED', amountMinor: 2500, ruleId: 'fx', version: 3 });
  assert.deepEqual([small.commissionMinor, small.netMinor], [1000, 0], 'capped at the fare');
  assert.deepEqual(a.rule, { type: 'FIXED', amountMinor: 2500, ruleId: 'fx', version: 3 });
  const p = money.splitFare(20000, { type: 'PERCENT', rateBp: 1500, ruleId: 'p', version: 7 });
  assert.deepEqual(p.rule, { type: 'PERCENT', rateBp: 1500, ruleId: 'p', version: 7 });
  assert.throws(() => money.splitFare(100, { type: 'SUBSCRIPTION', ruleId: 's', version: 1 }), /not supported/);
  assert.throws(() => money.splitFare(100, { type: 'PERCENT', rateBp: 1500 }), /ruleId and version/);
});

test('the snapshot a rule leaves is a copy: changing the live rule afterwards cannot alter it', () => {
  const rule = { type: 'PERCENT', rateBp: 1500, ruleId: 'p', version: 1 };
  const s = money.splitFare(20000, rule);
  rule.rateBp = 3000; rule.version = 2;
  assert.equal(s.rule.rateBp, 1500);
  assert.equal(s.rule.version, 1);
});
