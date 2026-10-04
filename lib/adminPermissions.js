/**
 * Roles and permissions for the admin dashboard. Keep in sync with AutoMet_Admin/src/lib/permissions.ts.
 */
const ALL = [
  'dashboard.view', 'clients.manage', 'drivers.view', 'drivers.manage', 'riders.view',
  'trips.view', 'pricing.manage', 'payments.view', 'settings.manage', 'team.manage', 'audit.view'
];

const ROLE_PERMISSIONS = {
  super_admin: ALL,
  client_admin: ALL.filter((p) => p !== 'clients.manage'),
  operations: ['dashboard.view', 'drivers.view', 'drivers.manage', 'riders.view', 'trips.view'],
  support: ['dashboard.view', 'drivers.view', 'riders.view', 'trips.view'],
  finance: ['dashboard.view', 'trips.view', 'payments.view']
};

const ROLES = Object.keys(ROLE_PERMISSIONS);

function can(admin, permission) {
  return !!admin && Array.isArray(ROLE_PERMISSIONS[admin.role]) && ROLE_PERMISSIONS[admin.role].includes(permission);
}

const isSuperAdmin = (admin) => !!admin && admin.role === 'super_admin';

module.exports = { ROLE_PERMISSIONS, ROLES, can, isSuperAdmin };
