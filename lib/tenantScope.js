const { isSuperAdmin } = require('./adminPermissions');

class ForbiddenError extends Error {
  constructor(message = 'You do not have access to this client') {
    super(message);
    this.name = 'ForbiddenError';
    this.status = 403;
  }
}

/**
 * The single rule for which client's data an admin request may touch (the dashboard has the same rule in
 * AutoMet_Admin/src/lib/scope.ts).
 *  - super admin: any client, or null for all clients
 *  - everyone else: only the client on their account; asking for another one is a 403
 * The client always comes from the verified account, never from a request parameter alone.
 */
function resolveTenantScope(admin, requested) {
  const wanted = requested ? String(requested) : null;
  if (isSuperAdmin(admin)) return wanted;
  if (!admin.tenantId) throw new ForbiddenError('Account is not linked to a client');
  if (wanted && wanted !== admin.tenantId) throw new ForbiddenError();
  return admin.tenantId;
}

/**
 * Mongo filter fragment limiting `field` to one client. Records written before multi-client support have no
 * tenant tag, so they belong to the default client.
 */
function tenantMatch(tenant, field) {
  if (!tenant) return {};
  return tenant.isDefault ? { [field]: { $in: [tenant.tenantId, null] } } : { [field]: tenant.tenantId };
}

module.exports = { ForbiddenError, resolveTenantScope, tenantMatch };
