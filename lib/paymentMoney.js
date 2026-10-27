/**
 * Money for payments, commission and the ledger. Every amount is a whole number of minor units (paise for INR): never a float.
 *
 * Rounding policy (the one place it is decided): a commission is `fare x rate`, rounded HALF UP to a whole minor unit, worked in
 * integer arithmetic (BigInt for the product, so no fare is large enough to lose a paisa). The driver's net is `fare - commission`,
 * not a second rounded calculation, so the two always add up to the fare exactly.
 *
 * Rates are whole basis points (1% = 100bp): 12.5% is 1250bp. A percentage with more than two decimals is refused rather than
 * rounded, so a rate typed by an admin is exactly the rate applied.
 *
 * A commission rule is `{ type, ruleId, version, ... }`. Its snapshot is stored with every finalised trip, so a later change to the
 * rule never rewrites an old trip. Supported: PERCENT (`rateBp`) and FIXED (`amountMinor`, never more than the fare). SUBSCRIPTION and
 * HYBRID are named in the design but not implemented: they are refused, not guessed.
 */
const MAX_BP = 10000;

function assertMinor(value, label = 'amount') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a whole, non-negative number of minor units`);
  return value;
}

function percentToBasisPoints(percent) {
  const n = typeof percent === 'string' ? Number(percent.trim()) : percent;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) throw new RangeError('percent must be a number from 0 to 100');
  const bp = Math.round(n * 100);
  if (Math.abs(n * 100 - bp) > 1e-9) throw new RangeError('percent may have at most two decimals');
  return bp;
}

function assertRate(rateBp) {
  if (typeof rateBp !== 'number' || !Number.isInteger(rateBp) || rateBp < 0 || rateBp > MAX_BP) throw new RangeError(`rate must be whole basis points from 0 to ${MAX_BP}`);
  return rateBp;
}

/** fare x rate / 10000, rounded half up, in integer arithmetic. */
function commissionMinor(fareMinor, rateBp) {
  assertMinor(fareMinor, 'fare');
  assertRate(rateBp);
  return Number((BigInt(fareMinor) * BigInt(rateBp) + 5000n) / 10000n);
}

/** { commissionMinor, netMinor, rule } for one fare under one rule. `rule` is the copy to store with the trip. */
function splitFare(fareMinor, rule) {
  assertMinor(fareMinor, 'fare');
  if (!rule || !rule.ruleId || !Number.isInteger(rule.version)) throw new TypeError('a commission rule needs a ruleId and version');
  let commission; let snapshot;
  if (rule.type === 'PERCENT') {
    commission = commissionMinor(fareMinor, rule.rateBp);
    snapshot = { type: 'PERCENT', rateBp: rule.rateBp, ruleId: rule.ruleId, version: rule.version };
  } else if (rule.type === 'FIXED') {
    assertMinor(rule.amountMinor, 'fixed commission');
    commission = Math.min(rule.amountMinor, fareMinor);
    snapshot = { type: 'FIXED', amountMinor: rule.amountMinor, ruleId: rule.ruleId, version: rule.version };
  } else {
    throw new TypeError(`commission rule type ${rule.type} is not supported`);
  }
  return { commissionMinor: commission, netMinor: fareMinor - commission, rule: snapshot };
}

module.exports = { MAX_BP, assertMinor, percentToBasisPoints, commissionMinor, splitFare };
