/**
 * Pure helpers for the cancellation policy history: the comparable terms of a policy, and what changed between two sets of terms.
 */
const RIDER_FIELDS = [['freeCancellationMinutes', 'Free cancellation window (min)'], ['feeAfterWindow', 'Rider fee after the free window'], ['feeAfterDriverArrived', 'Rider fee after the driver arrived'], ['noShowFee', 'No-show fee']];
const DRIVER_FIELDS = [['penaltyFee', 'Driver cancellation penalty'], ['graceCancellations', 'Free driver cancellations per day']];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The terms of a policy in a fixed plain shape; null when there is no policy. */
function termsOf(policy) {
  if (!policy) return null;
  const r = policy.rider || {};
  const d = policy.driver || {};
  return {
    rider: Object.fromEntries(RIDER_FIELDS.map(([k]) => [k, num(r[k])])),
    driver: Object.fromEntries(DRIVER_FIELDS.map(([k]) => [k, num(d[k])])),
    conditions: policy.conditions || '',
    currency: policy.currency || null
  };
}

const flat = (t) => {
  const out = {};
  for (const [k, label] of RIDER_FIELDS) out[`rider.${k}`] = { label, value: t ? t.rider[k] : null };
  for (const [k, label] of DRIVER_FIELDS) out[`driver.${k}`] = { label, value: t ? t.driver[k] : null };
  out.conditions = { label: 'Conditions', value: t ? t.conditions : null };
  return out;
};

/** [{ field, label, from, to }] for every term that differs; from or to is null on the side with no policy. */
function changedFields(before, after) {
  const a = flat(before);
  const b = flat(after);
  return Object.keys(a).filter((k) => a[k].value !== b[k].value).map((field) => ({ field, label: a[field].label, from: a[field].value, to: b[field].value }));
}

const same = (a, b) => changedFields(a, b).length === 0 && (a === null) === (b === null);

module.exports = { termsOf, changedFields, same };
