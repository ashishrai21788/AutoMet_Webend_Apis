/**
 * Business-setup reset: the logic behind scripts/resetBusinessSetup.js, kept free of any database driver so it can be
 * tested. `db` only needs `collection(name)` with `countDocuments(filter)`, `find(filter, { projection }).toArray()`
 * and `deleteMany(filter)` (a MongoDB driver Db, or a stand-in).
 *
 * It removes what the admin dashboard set up for businesses, and nothing the apps created:
 *   businesses, their regions, vehicle categories, fare rules, cancellation policies, setup progress, team accounts
 *   (never a super admin), the audit log, and each business's logo in image storage.
 * It does NOT touch drivers, riders, trips, OTP records, support reports, vehicles, driver and vehicle documents,
 * assignments or driver timelines.
 */
const TARGETS = [
  { name: 'tenants', filter: {}, label: 'businesses' },
  { name: 'service_regions', filter: {}, label: 'service regions' },
  { name: 'vehicle_categories', filter: {}, label: 'vehicle categories' },
  { name: 'fare_rules', filter: {}, label: 'fare rules' },
  { name: 'cancellation_policies', filter: {}, label: 'cancellation policies' },
  { name: 'business_setup_progress', filter: {}, label: 'setup progress records' },
  { name: 'admin_users', filter: { role: { $ne: 'super_admin' } }, label: 'team accounts (super admins are kept)' },
  { name: 'admin_audit_logs', filter: {}, label: 'audit log entries' }
];

/** Collections that are left alone but hold records tagged with a business, which become invisible once it is gone. */
const LEFT_ALONE = [
  { name: 'vehicles', label: 'vehicles' },
  { name: 'driver_documents', label: 'driver documents' },
  { name: 'vehicle_documents', label: 'vehicle documents' },
  { name: 'driver_vehicle_assignments', label: 'driver-vehicle assignments' },
  { name: 'entity_history', label: 'driver and vehicle timeline entries' }
];

async function plan(db) {
  const targets = [];
  for (const t of TARGETS) targets.push({ ...t, count: await db.collection(t.name).countDocuments(t.filter) });
  const leftAlone = [];
  for (const t of LEFT_ALONE) leftAlone.push({ ...t, count: await db.collection(t.name).countDocuments({}) });
  const superAdmins = await db.collection('admin_users').countDocuments({ role: 'super_admin' });
  const tenants = await db.collection('tenants').find({}, { projection: { tenantId: 1, name: 1, isDefault: 1 } }).toArray();
  return { targets, leftAlone, superAdmins, tenants: tenants.map((t) => ({ tenantId: t.tenantId, name: t.name, isDefault: !!t.isDefault })) };
}

/**
 * Deletes. `removeLogo(tenantId)` is called for each business first (best effort; a failure is reported, not fatal).
 * Refuses to run when no super admin exists, because nobody could sign in afterwards.
 */
async function execute(db, { removeLogo = async () => {} } = {}) {
  const before = await plan(db);
  if (before.superAdmins === 0) throw new Error('No super admin account exists, so nobody could sign in after the reset. Nothing was deleted.');

  const logoProblems = [];
  let logosRemoved = 0;
  for (const t of before.tenants) {
    try { await removeLogo(t.tenantId); logosRemoved += 1; } catch (e) { logoProblems.push(`${t.tenantId}: ${e.message}`); }
  }
  const deleted = [];
  for (const t of TARGETS) {
    const r = await db.collection(t.name).deleteMany(t.filter);
    deleted.push({ name: t.name, label: t.label, deleted: r.deletedCount ?? 0 });
  }
  return { before, deleted, logosRemoved, logoProblems };
}

module.exports = { TARGETS, LEFT_ALONE, plan, execute };
