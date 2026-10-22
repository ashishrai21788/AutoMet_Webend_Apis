/**
 * Pure helpers for pricing drafts and versions (no database): what a rule is, how two sets of rules differ, and what publishing
 * a set of drafts would change.
 */
const RULE_FIELDS = ['baseFare', 'perKm', 'perMinute', 'minimumFare', 'bookingFee', 'waitingFreeMinutes', 'waitingPerMinute', 'additionalCharges', 'taxes', 'surge'];

const regionKeyOf = (regionId) => regionId || 'default';
const keyOf = (categoryId, regionKey) => `${categoryId}|${regionKey || 'default'}`;
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

/** The comparable part of a rule: its editable fields, in a fixed shape. */
function fieldsOf(rule) {
  const out = {};
  for (const f of RULE_FIELDS) out[f] = plain(rule ? rule[f] : null);
  if (out.surge) out.surge = { enabled: !!out.surge.enabled, maxMultiplier: out.surge.enabled ? Number(out.surge.maxMultiplier) || 1 : 1 };
  return out;
}

/** Every live rule as plain data, sorted so two snapshots of the same pricing are identical. */
function snapshotRules(liveRows) {
  return (liveRows || []).map((r) => ({
    categoryId: r.categoryId, regionId: r.regionId || null, regionKey: r.regionKey || regionKeyOf(r.regionId), currency: r.currency || null,
    active: r.active !== false, ...fieldsOf(r)
  })).sort((a, b) => keyOf(a.categoryId, a.regionKey).localeCompare(keyOf(b.categoryId, b.regionKey)));
}

const fieldChanges = (from, to) => RULE_FIELDS.filter((f) => !same(from ? from[f] : null, to ? to[f] : null)).map((field) => ({ field, from: from ? plain(from[field]) : null, to: to ? plain(to[field]) : null }));

/** Differences between two snapshots: [{ key, categoryId, regionId, kind: ADDED|CHANGED|REMOVED, fields: [{field, from, to}] }]. */
function diffSnapshots(fromList, toList) {
  const a = new Map((fromList || []).map((r) => [keyOf(r.categoryId, r.regionKey), r]));
  const b = new Map((toList || []).map((r) => [keyOf(r.categoryId, r.regionKey), r]));
  const rows = [];
  for (const [key, r] of b) {
    const before = a.get(key);
    if (!before) rows.push({ key, categoryId: r.categoryId, regionId: r.regionId || null, kind: 'ADDED', fields: fieldChanges(null, r) });
    else { const f = fieldChanges(before, r); if (f.length) rows.push({ key, categoryId: r.categoryId, regionId: r.regionId || null, kind: 'CHANGED', fields: f }); }
  }
  for (const [key, r] of a) if (!b.has(key)) rows.push({ key, categoryId: r.categoryId, regionId: r.regionId || null, kind: 'REMOVED', fields: fieldChanges(r, null) });
  return rows.sort((x, y) => x.key.localeCompare(y.key));
}

const summaryOf = (rows) => ({ added: rows.filter((r) => r.kind === 'ADDED').length, changed: rows.filter((r) => r.kind === 'CHANGED').length, removed: rows.filter((r) => r.kind === 'REMOVED').length });

/** What publishing these drafts would do to this live pricing. A draft that already matches live changes nothing and is left out. */
function draftChanges(liveRows, drafts) {
  const live = new Map(snapshotRules(liveRows).map((r) => [keyOf(r.categoryId, r.regionKey), r]));
  const out = [];
  for (const d of drafts || []) {
    const key = keyOf(d.categoryId, d.regionKey);
    const cur = live.get(key) || null;
    if (d.op === 'DELETE') {
      if (cur) out.push({ key, categoryId: d.categoryId, regionId: d.regionId || null, kind: 'REMOVED', fields: fieldChanges(cur, null) });
      continue;
    }
    const next = fieldsOf(d.fields);
    if (!cur) out.push({ key, categoryId: d.categoryId, regionId: d.regionId || null, kind: 'ADDED', fields: fieldChanges(null, next) });
    else { const f = fieldChanges(cur, next); if (f.length) out.push({ key, categoryId: d.categoryId, regionId: d.regionId || null, kind: 'CHANGED', fields: f }); }
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

/** Drafts whose live rule has been changed since the draft was made (a draft of a rule that did not exist is stale if one exists now). */
function staleDrafts(liveRows, drafts) {
  const live = new Map((liveRows || []).map((r) => [keyOf(r.categoryId, r.regionKey || regionKeyOf(r.regionId)), r]));
  return (drafts || []).filter((d) => {
    const cur = live.get(keyOf(d.categoryId, d.regionKey));
    const curAt = cur && cur.updatedAt ? new Date(cur.updatedAt).getTime() : null;
    const baseAt = d.baseUpdatedAt ? new Date(d.baseUpdatedAt).getTime() : null;
    return curAt !== baseAt;
  }).map((d) => keyOf(d.categoryId, d.regionKey));
}

module.exports = { RULE_FIELDS, regionKeyOf, keyOf, fieldsOf, snapshotRules, diffSnapshots, summaryOf, draftChanges, staleDrafts };
