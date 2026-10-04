const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Tenant, AdminUser } = require('../models/adminModels');

/**
 * Runs once the database is connected. Idempotent and never overwrites anything:
 *  1. makes sure the default client exists (it owns every record created before multi-client support);
 *  2. if ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD are set and no super admin exists yet, creates one.
 * The password is never logged. Remove the two variables from the environment after the first sign-in.
 */
async function bootstrapAdmin() {
  const defaultSlug = process.env.DEFAULT_TENANT_SLUG || 'automet';
  let tenant = await Tenant.findOne({ isDefault: true });
  if (!tenant) {
    tenant = await Tenant.create({
      tenantId: `app_${crypto.randomBytes(5).toString('hex')}`,
      name: process.env.DEFAULT_TENANT_NAME || 'AutoMet',
      slug: defaultSlug,
      appName: process.env.DEFAULT_TENANT_NAME || 'AutoMet',
      packageName: 'in.automet.user',
      plan: 'enterprise',
      status: 'active',
      isDefault: true
    });
    console.log('[admin] created default client');
  }

  const email = String(process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '');
  if (!email || !password) return;

  if (await AdminUser.exists({ role: 'super_admin' })) return;
  if (password.length < 10) {
    console.warn('[admin] ADMIN_BOOTSTRAP_PASSWORD is shorter than 10 characters; super admin not created');
    return;
  }
  await AdminUser.create({
    adminId: `a_${crypto.randomBytes(8).toString('hex')}`,
    name: 'Platform Owner',
    email,
    role: 'super_admin',
    tenantId: null,
    passwordHash: await bcrypt.hash(password, 12),
    mustChangePassword: true
  });
  console.log('[admin] created the first super admin');
}

module.exports = { bootstrapAdmin };
