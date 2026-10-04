/**
 * Roles and permissions for the admin dashboard. Keep in sync with AutoMet_Admin/src/lib/permissions.ts.
 *
 * Two separate domains, so that holding one never grants the other:
 *
 *  PLATFORM (the owner of AutoMet, who sells the platform to businesses). Only the super admin has these.
 *    clients.manage     create, edit, suspend and activate businesses, and manage each business's admin accounts
 *    platform.billing   plans, subscriptions, invoices, payments and platform revenue (what businesses pay AutoMet)
 *    platform.team      platform (super admin) accounts
 *    platform.audit     the platform audit log
 *    platform.settings  platform settings and billing defaults
 *
 *  BUSINESS (a ride-hailing business running on the platform). Business roles have these, for their own business only.
 *    dashboard.view, drivers.*, vehicles.*, documents.view, verification.review, riders.*, trips.*, pricing.manage,
 *    payments.view, settings.manage, team.manage, audit.view, support.manage
 *
 * The super admin deliberately has no business permission: running a business's drivers, trips, prices or documents is
 * the business admin's job, and the platform owner's account must not be able to do it by accident or by being
 * compromised. (The business routes also refuse a super admin outright; see lib/businessContext.js.)
 */
const PLATFORM_PERMISSIONS = ['clients.manage', 'platform.billing', 'platform.team', 'platform.audit', 'platform.settings'];

const BUSINESS_PERMISSIONS = [
  'dashboard.view', 'drivers.view', 'drivers.manage', 'vehicles.view', 'vehicles.manage',
  'documents.view', 'verification.review', 'riders.view', 'trips.view', 'pricing.manage', 'payments.view',
  'settings.manage', 'team.manage', 'audit.view', 'riders.manage', 'trips.manage', 'support.manage'
];

const ROLE_PERMISSIONS = {
  super_admin: PLATFORM_PERMISSIONS,
  client_admin: BUSINESS_PERMISSIONS,
  operations: [
    'dashboard.view', 'drivers.view', 'drivers.manage', 'vehicles.view', 'vehicles.manage', 'documents.view',
    'verification.review', 'riders.view', 'trips.view', 'riders.manage', 'trips.manage', 'support.manage'
  ],
  support: ['dashboard.view', 'drivers.view', 'vehicles.view', 'riders.view', 'trips.view', 'support.manage'],
  finance: ['dashboard.view', 'trips.view', 'payments.view']
};

const ROLES = Object.keys(ROLE_PERMISSIONS);

function can(admin, permission) {
  if (!admin || !Array.isArray(ROLE_PERMISSIONS[admin.role])) return false;
  const wanted = Array.isArray(permission) ? permission : [permission];
  return wanted.some((p) => ROLE_PERMISSIONS[admin.role].includes(p));
}

const isSuperAdmin = (admin) => !!admin && admin.role === 'super_admin';

module.exports = { ROLE_PERMISSIONS, PLATFORM_PERMISSIONS, BUSINESS_PERMISSIONS, ROLES, can, isSuperAdmin };
