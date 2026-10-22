/**
 * Version history and rollback for a business's settings.
 *
 * Tracked: the business details shown in the apps (name, app name, colour, logo, support contacts) and the settings groups
 * payout, tolls, app versions and ride settings. Every save of one of them writes a numbered copy of all tracked settings
 * (a "version"). The first time, the settings as they were just before the change are written too (the baseline), so there is
 * always something to go back to. A rollback applies an old copy and is itself recorded as a new version, so history is never
 * rewritten and a rollback can be rolled back.
 *
 * Not tracked here: fare rules, regions, categories, coupons, incentives and legal documents. They are separate records with
 * their own lifecycle (legal documents already have draft, publish and immutable versions).
 */
const GROUPS = {
  business: ['name', 'appName', 'brandColor', 'logoUrl', 'supportEmail', 'supportPhone'],
  payout: ['payoutSettings'],
  tolls: ['tollSettings'],
  appVersions: ['appVersions'],
  rideSettings: ['rideSettings']
};
const LABELS = { business: 'Business details', payout: 'Driver payouts', tolls: 'Tolls', appVersions: 'App versions', rideSettings: 'Ride settings' };
const FIELDS = Object.values(GROUPS).flat();

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/** The tracked settings of a business record, as plain data. */
function snapshotOf(tenant) {
  const out = {};
  for (const f of FIELDS) out[f] = plain(tenant ? tenant[f] : null);
  return out;
}

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

/** Field by field differences between two snapshots: [{ group, field, from, to }]. */
function diff(from, to) {
  const rows = [];
  for (const [group, fields] of Object.entries(GROUPS)) {
    for (const field of fields) {
      const a = from ? from[field] : null;
      const b = to ? to[field] : null;
      if (!same(a, b)) rows.push({ group, label: LABELS[group], field, from: a === undefined ? null : a, to: b === undefined ? null : b });
    }
  }
  return rows;
}

const changedGroups = (rows) => [...new Set(rows.map((r) => r.group))];

/**
 * Writes the version for a change. `before` and `after` are the business record around the save. When there is no history yet
 * the baseline (the settings before the change) is written first. Nothing is written when nothing tracked changed. Never throws:
 * a failure here must not undo a settings save that already happened.
 */
async function record({ ConfigVersion, tenantId, before, after, source, actor, rollbackOf = null }) {
  try {
    const rows = diff(snapshotOf(before), snapshotOf(after));
    if (!rows.length) return null;
    const latest = (await ConfigVersion.find({ tenantId }).sort({ version: -1 }).limit(1).lean())[0] || null;
    let next = latest ? latest.version + 1 : 1;
    const who = { actorId: actor && actor.adminId ? actor.adminId : null, actorEmail: actor && actor.email ? actor.email : null };
    if (!latest) {
      await ConfigVersion.create({ tenantId, version: 1, snapshot: snapshotOf(before), changed: [], source: 'baseline', ...who, createdAt: new Date() });
      next = 2;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await ConfigVersion.create({ tenantId, version: next, snapshot: snapshotOf(after), changed: changedGroups(rows), source: source || '', rollbackOf, ...who, createdAt: new Date() });
      } catch (e) {
        if (e && e.code === 11000) { next += 1; continue; } // another save took this number
        throw e;
      }
    }
    return null;
  } catch (e) {
    console.warn('[configVersions] could not record a version:', e.message);
    return null;
  }
}

/** What to write to the business record to put a version's settings back: only tracked fields, and only those that differ now. */
function restoreUpdate(snapshot, current) {
  const update = {};
  for (const f of FIELDS) {
    if (!snapshot || !(f in snapshot)) continue;
    if (!same(snapshot[f], current ? current[f] : null)) update[f] = snapshot[f];
  }
  return update;
}

module.exports = { GROUPS, LABELS, FIELDS, snapshotOf, diff, changedGroups, record, restoreUpdate };
