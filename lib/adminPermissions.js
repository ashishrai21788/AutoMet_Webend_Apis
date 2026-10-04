/**
 * Roles and permissions for the admin dashboard. Keep in sync with AutoMet_Admin/src/lib/permissions.ts.
 *
 * Fleet permissions:
 *   drivers.view / drivers.manage     see and edit driver records
 *   vehicles.view / vehicles.manage   see and edit vehicle records, assign drivers
 *   documents.view                    open uploaded documents (identity papers are sensitive, so not every role)
 *   verification.review               approve or reject documents (only the roles that run onboarding)
 */
const ALL = [
  'dashboard.view', 'clients.manage', 'drivers.view', 'drivers.manage', 'vehicles.view', 'vehicles.manage',
  'documents.view', 'verification.review', 'riders.view', 'trips.view', 'pricing.manage', 'payments.view',
  'settings.manage', 'team.manage', 'audit.view', 'riders.manage', 'trips.manage', 'support.manage'
];

const ROLE_PERMISSIONS = {
  super_admin: ALL,
  client_admin: ALL.filter((p) => p !== 'clients.manage'),
  operations: [
    'dashboard.view', 'drivers.view', 'drivers.manage', 'vehicles.view', 'vehicles.manage', 'documents.view',
    'verification.review', 'riders.view', 'trips.view', 'riders.manage', 'trips.manage', 'support.manage'
  ],
  support: ['dashboard.view', 'drivers.view', 'vehicles.view', 'riders.view', 'trips.view', 'support.manage'],
  finance: ['dashboard.view', 'trips.view', 'payments.view']
};

const ROLES = Object.keys(ROLE_PERMISSIONS);

function can(admin, permission) {
  return !!admin && Array.isArray(ROLE_PERMISSIONS[admin.role]) && ROLE_PERMISSIONS[admin.role].includes(permission);
}

const isSuperAdmin = (admin) => !!admin && admin.role === 'super_admin';

module.exports = { ROLE_PERMISSIONS, ROLES, can, isSuperAdmin };
