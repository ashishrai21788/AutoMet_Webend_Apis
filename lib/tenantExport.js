/**
 * A downloadable copy of everything a business owns, for the platform owner to keep before deleting it. Account secrets
 * are never included (password hashes, tokens, one-time codes, push tokens), and document files are listed by name and
 * status only, not as links.
 */
const MAX = 20000;

const SECRET_KEY = /password|token|secret|otp|hash|fcm|storagekey/i;

function strip(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc || {})) if (!SECRET_KEY.test(k) && k !== '__v') out[k] = v;
  return out;
}

async function collect(query) {
  const rows = await query.limit(MAX + 1).lean();
  const truncated = rows.length > MAX;
  return { items: (truncated ? rows.slice(0, MAX) : rows).map(strip), truncated };
}

/**
 * `models` carries the Mongoose models (kept as a parameter so the file has no database dependency of its own):
 * { Tenant, AdminUser, ServiceRegion, VehicleCategory, FareRule, CancellationPolicy, SetupProgress, Drivers, Riders, TripDetails,
 *   Vehicle, DriverDocument, VehicleDocument, DriverVehicleAssignment, EntityHistory, DriverIssue, PlatformInvoice }
 */
async function buildExport(tenant, m) {
  const id = tenant.tenantId;
  const byTenant = { tenantId: id };
  const sections = {
    adminAccounts: m.AdminUser.find(byTenant), regions: m.ServiceRegion.find(byTenant), vehicleCategories: m.VehicleCategory.find(byTenant),
    fareRules: m.FareRule.find(byTenant), cancellationPolicies: m.CancellationPolicy.find(byTenant), setupProgress: m.SetupProgress.find(byTenant),
    drivers: m.Drivers.find(byTenant), riders: m.Riders.find(byTenant), trips: m.TripDetails.find({ tenant_id: id }),
    vehicles: m.Vehicle.find(byTenant), driverDocuments: m.DriverDocument.find(byTenant), vehicleDocuments: m.VehicleDocument.find(byTenant),
    driverVehicleAssignments: m.DriverVehicleAssignment.find(byTenant), timeline: m.EntityHistory.find(byTenant),
    supportReports: m.DriverIssue.find(byTenant), invoices: m.PlatformInvoice.find(byTenant)
  };
  const data = {};
  const truncated = [];
  for (const [name, query] of Object.entries(sections)) {
    const r = await collect(query);
    data[name] = r.items;
    if (r.truncated) truncated.push(name);
  }
  return {
    exportedAt: new Date().toISOString(),
    note: 'Account secrets are not included. Document files are not included, only their records.',
    business: strip(tenant.toObject ? tenant.toObject() : tenant),
    truncated,
    counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
    data
  };
}

module.exports = { buildExport, strip, MAX };
