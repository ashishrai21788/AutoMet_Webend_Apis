const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Tenant, AdminUser, AdminAudit } = require('../models/adminModels');
const { TripDetails } = require('../models/tripDetailsModel');
const { createModel } = require('../models/dynamicModel');
const { signAdminToken } = require('../lib/adminAuth');
const { ROLES, isSuperAdmin } = require('../lib/adminPermissions');
const { resolveTenantScope, tenantMatch } = require('../lib/tenantScope');
const { ONGOING, startOfTodayIST, computeRates } = require('../lib/adminDashboard');
const { publicTenant, publicAdmin } = require('../lib/adminShapes');
const { ServiceRegion, VehicleCategory, FareRule, SetupProgress } = require('../models/businessModels');
const { computeSetup } = require('../lib/businessSetup');

// Cost 10 keeps a sign-in under about a second on a small server while staying within current guidance for bcrypt.
// Existing hashes made at a higher cost are upgraded to this one when their owner next signs in.
const BCRYPT_COST = 10;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const MIN_PASSWORD_LENGTH = 10;
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLANS = ['trial', 'standard', 'enterprise'];
const TENANT_STATUSES = ['active', 'trial', 'suspended'];
// Compared against when the email is unknown, so a miss takes as long as a wrong password. Built on first use with the
// async hash, which yields to the event loop, so it never stalls other requests (the rider and driver apps share this server).
let dummyHash;
const getDummyHash = () => (dummyHash ||= bcrypt.hash('not-a-real-password', BCRYPT_COST));

// A wrong current password is a mistake in the form, not an ended session, so it is a 400 with the field named (a 401 would
// make the dashboard sign the person out).
const fail400 = (res) => res.status(400).json({ success: false, message: 'Current password is incorrect', errors: { currentPassword: 'Current password is incorrect' }, data: null });
const ok = (res, data, status = 200) => res.status(status).json({ success: true, message: 'OK', data });
const bad = (res, status, message) => res.status(status).json({ success: false, message, data: null });
const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
// A business's appId: assigned once, never edited. Lower-case letters and digits, easy to read out loud.
const newAppId = () => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = 'app_';
  for (const b of crypto.randomBytes(10)) out += alphabet[b % alphabet.length];
  return out;
};

function temporaryPassword() {
  // 15 random characters from an unambiguous alphabet; shown once to the person creating the account.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(15);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

async function audit(req, action, { tenantId = null, targetType = null, targetId = null, meta = null, actor } = {}) {
  try {
    const who = actor || req.admin;
    await AdminAudit.create({
      tenantId, actorId: who?.adminId || null, actorEmail: who?.email || null, action, targetType, targetId, meta,
      ip: req.ip || null
    });
  } catch (e) {
    console.warn('[admin] audit write failed:', e.message);
  }
}

// ---------- auth ----------

exports.login = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return bad(res, 400, 'Email and password are required');

    const admin = await AdminUser.findOne({ email }).select('+passwordHash');
    if (admin && admin.lockUntil && admin.lockUntil > new Date()) {
      return bad(res, 429, 'Too many failed attempts. Try again in a few minutes.');
    }

    const match = await bcrypt.compare(password, admin ? admin.passwordHash : await getDummyHash());
    if (!admin || !match || !admin.active) {
      if (admin && !match) {
        admin.failedLogins = (admin.failedLogins || 0) + 1;
        if (admin.failedLogins >= MAX_FAILED_LOGINS) {
          admin.lockUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
          admin.failedLogins = 0;
        }
        await admin.save();
        await audit(req, 'auth.login_failed', { tenantId: admin.tenantId, actor: admin });
      }
      return bad(res, 401, 'Invalid email or password');
    }

    if (admin.tenantId) {
      const tenant = await Tenant.findOne({ tenantId: admin.tenantId });
      if (!tenant || tenant.status === 'suspended') return bad(res, 403, 'This client account is suspended');
    }

    admin.failedLogins = 0;
    admin.lockUntil = null;
    admin.lastLoginAt = new Date();
    if (bcrypt.getRounds(admin.passwordHash) > BCRYPT_COST) admin.passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await admin.save();
    await audit(req, 'auth.login', { tenantId: admin.tenantId, actor: admin });
    return ok(res, { token: signAdminToken(admin), user: publicAdmin(admin) });
  } catch (e) {
    console.error('[admin] login error:', e.message);
    return bad(res, 500, 'Sign in failed');
  }
};

exports.me = (req, res) => ok(res, publicAdmin(req.admin));

exports.changePassword = async (req, res) => {
  try {
    const current = String(req.body?.currentPassword || '');
    const next = String(req.body?.newPassword || '');
    if (next.length < MIN_PASSWORD_LENGTH) return bad(res, 400, `New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    if (next === current) return bad(res, 400, 'New password must be different');

    const admin = await AdminUser.findOne({ adminId: req.admin.adminId }).select('+passwordHash');
    if (!(await bcrypt.compare(current, admin.passwordHash))) return fail400(res);

    admin.passwordHash = await bcrypt.hash(next, BCRYPT_COST);
    admin.mustChangePassword = false;
    admin.tokenVersion = (admin.tokenVersion || 0) + 1; // signs out every other session
    await admin.save();
    await audit(req, 'auth.password_changed', { tenantId: admin.tenantId });
    return ok(res, { token: signAdminToken(admin), user: publicAdmin(admin) });
  } catch (e) {
    console.error('[admin] change password error:', e.message);
    return bad(res, 500, 'Could not change password');
  }
};

// ---------- tenants ----------

exports.listTenants = async (req, res) => {
  try {
    const filter = isSuperAdmin(req.admin) ? {} : { tenantId: req.admin.tenantId };
    const tenants = await Tenant.find(filter).sort({ createdAt: 1 });
    // One query per collection for all listed businesses, then split by appId (this is the platform-level view).
    const ids = tenants.map((t) => t.tenantId);
    const inList = { tenantId: { $in: ids } };
    const [regions, categories, fareRules, progress] = await Promise.all([
      ServiceRegion.find(inList), VehicleCategory.find(inList), FareRule.find(inList), SetupProgress.find(inList)
    ]);
    const mine = (rows, id) => rows.filter((r) => r.tenantId === id);
    return ok(res, tenants.map((t) => {
      const setup = computeSetup({
        market: t.market && t.market.country ? t.market : null,
        regions: mine(regions, t.tenantId), categories: mine(categories, t.tenantId), fareRules: mine(fareRules, t.tenantId),
        completedAt: mine(progress, t.tenantId)[0]?.completedAt || null
      });
      return { ...publicTenant(t), setup: { percent: setup.percent, complete: setup.complete, nextStep: setup.nextStep ? setup.nextStep.title : null } };
    }));
  } catch (e) {
    return bad(res, 500, 'Could not load clients');
  }
};

exports.createTenant = async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const appName = String(b.appName || '').trim();
  const packageName = String(b.packageName || '').trim().toLowerCase();
  const city = String(b.city || '').trim();
  const plan = String(b.plan || 'trial');
  const adminName = String(b.adminName || '').trim();
  const adminEmail = String(b.adminEmail || '').trim().toLowerCase();

  if (!name || !appName || !adminName) return bad(res, 400, 'name, appName and adminName are required');
  if (!PACKAGE_RE.test(packageName)) return bad(res, 400, 'packageName must look like com.client.rider');
  if (!EMAIL_RE.test(adminEmail)) return bad(res, 400, 'A valid adminEmail is required');
  if (!PLANS.includes(plan)) return bad(res, 400, `plan must be one of ${PLANS.join(', ')}`);

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return bad(res, 400, 'name must contain letters or digits');

  let tenant;
  try {
    if (await AdminUser.exists({ email: adminEmail })) return bad(res, 409, 'That admin email is already in use');
    tenant = await Tenant.create({
      tenantId: newAppId(), name, slug, appName, packageName, city, plan, status: plan === 'trial' ? 'trial' : 'active',
      brandColor: /^#[0-9a-fA-F]{6}$/.test(String(b.brandColor || '')) ? String(b.brandColor).toLowerCase() : '#f5a300'
    });
  } catch (e) {
    if (e.code === 11000) return bad(res, 409, 'A client with that name or package name already exists');
    console.error('[admin] create tenant error:', e.message);
    return bad(res, 500, 'Could not create the client');
  }

  try {
    const password = temporaryPassword();
    await AdminUser.create({
      adminId: newId('a'), name: adminName, email: adminEmail, role: 'client_admin', tenantId: tenant.tenantId,
      passwordHash: await bcrypt.hash(password, BCRYPT_COST), mustChangePassword: true
    });
    await audit(req, 'tenant.created', { tenantId: tenant.tenantId, targetType: 'tenant', targetId: tenant.tenantId, meta: { name } });
    return ok(res, { ...publicTenant(tenant), initialAdmin: { email: adminEmail, temporaryPassword: password } }, 201);
  } catch (e) {
    await Tenant.deleteOne({ tenantId: tenant.tenantId }); // do not leave a client without an admin
    if (e.code === 11000) return bad(res, 409, 'That admin email is already in use');
    console.error('[admin] create tenant admin error:', e.message);
    return bad(res, 500, 'Could not create the client admin');
  }
};

exports.setTenantStatus = async (req, res) => {
  try {
    const status = String(req.body?.status || '');
    if (!TENANT_STATUSES.includes(status)) return bad(res, 400, `status must be one of ${TENANT_STATUSES.join(', ')}`);
    const tenant = await Tenant.findOne({ tenantId: req.params.id });
    if (!tenant) return bad(res, 404, 'Client not found');
    if (tenant.isDefault && status === 'suspended') return bad(res, 400, 'The default client cannot be suspended');

    const before = tenant.status;
    tenant.status = status;
    await tenant.save();
    if (status === 'suspended') {
      // end every signed-in session of this client's admins right away
      await AdminUser.updateMany({ tenantId: tenant.tenantId }, { $inc: { tokenVersion: 1 } });
    }
    await audit(req, 'tenant.status_changed', { tenantId: tenant.tenantId, targetType: 'tenant', targetId: tenant.tenantId, meta: { from: before, to: status } });
    return ok(res, publicTenant(tenant));
  } catch (e) {
    return bad(res, 500, 'Could not change the client status');
  }
};

// ---------- team ----------

exports.listUsers = async (req, res) => {
  try {
    const scope = resolveTenantScope(req.admin, req.query.tenantId);
    const users = await AdminUser.find(scope === null ? {} : { tenantId: scope }).sort({ createdAt: 1 });
    return ok(res, users.map(publicAdmin));
  } catch (e) {
    return bad(res, e.status || 500, e.status ? e.message : 'Could not load the team');
  }
};

exports.createUser = async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const role = String(b.role || '');
    if (!name || !EMAIL_RE.test(email)) return bad(res, 400, 'name and a valid email are required');
    if (!ROLES.includes(role) || role === 'super_admin') return bad(res, 400, 'role must be one of client_admin, operations, support, finance');

    // A client admin can only add people to their own client; the super admin names the client.
    const tenantId = resolveTenantScope(req.admin, isSuperAdmin(req.admin) ? b.tenantId : req.admin.tenantId);
    if (!tenantId) return bad(res, 400, 'tenantId is required');
    if (!(await Tenant.exists({ tenantId }))) return bad(res, 404, 'Client not found');
    if (await AdminUser.exists({ email })) return bad(res, 409, 'That email is already in use');

    const password = temporaryPassword();
    const user = await AdminUser.create({
      adminId: newId('a'), name, email, role, tenantId,
      passwordHash: await bcrypt.hash(password, BCRYPT_COST), mustChangePassword: true
    });
    await audit(req, 'user.created', { tenantId, targetType: 'admin_user', targetId: user.adminId, meta: { role, email } });
    return ok(res, { ...publicAdmin(user), temporaryPassword: password }, 201);
  } catch (e) {
    if (e.code === 11000) return bad(res, 409, 'That email is already in use');
    return bad(res, e.status || 500, e.status ? e.message : 'Could not create the user');
  }
};

exports.setUserActive = async (req, res) => {
  try {
    const active = req.body?.active;
    if (typeof active !== 'boolean') return bad(res, 400, 'active must be true or false');
    const user = await AdminUser.findOne({ adminId: req.params.id });
    if (!user) return bad(res, 404, 'User not found');
    resolveTenantScope(req.admin, user.tenantId); // 403 when the user belongs to another client
    if (user.adminId === req.admin.adminId) return bad(res, 400, 'You cannot change your own access');
    if (user.role === 'super_admin' && !isSuperAdmin(req.admin)) return bad(res, 403, 'Not allowed');

    user.active = active;
    if (!active) user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await audit(req, active ? 'user.activated' : 'user.deactivated', { tenantId: user.tenantId, targetType: 'admin_user', targetId: user.adminId });
    return ok(res, publicAdmin(user));
  } catch (e) {
    return bad(res, e.status || 500, e.status ? e.message : 'Could not update the user');
  }
};

// ---------- dashboard ----------

exports.dashboard = async (req, res) => {
  try {
    const scope = resolveTenantScope(req.admin, req.query.tenantId);
    let tenant = null;
    if (scope) {
      tenant = await Tenant.findOne({ tenantId: scope });
      if (!tenant) return bad(res, 404, 'Client not found');
    }
    const tripScope = tenantMatch(tenant, 'tenant_id');
    const driverScope = tenantMatch(tenant, 'tenantId');

    const todayStart = startOfTodayIST();
    const weekStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
    const Driver = createModel('drivers');

    const [ridesToday, ongoingTrips, activeDrivers, revenue, statusRows] = await Promise.all([
      TripDetails.countDocuments({ ...tripScope, requested_at: { $gte: todayStart } }),
      TripDetails.countDocuments({ ...tripScope, status: { $in: ONGOING } }),
      Driver.countDocuments({ ...driverScope, isOnline: true }),
      TripDetails.aggregate([
        { $match: { ...tripScope, status: 'COMPLETED', completed_at: { $gte: todayStart } } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$fare', 0] } } } }
      ]),
      TripDetails.aggregate([
        { $match: { ...tripScope, requested_at: { $gte: weekStart } } },
        { $group: { _id: '$status', n: { $sum: 1 } } }
      ])
    ]);

    const counts = Object.fromEntries(statusRows.map((r) => [r._id, r.n]));
    return ok(res, {
      ridesToday,
      activeDrivers,
      ongoingTrips,
      revenueToday: Math.round(revenue[0]?.total || 0),
      ...computeRates(counts) // acceptance and cancellation rate cover the last 7 days
    });
  } catch (e) {
    console.error('[admin] dashboard error:', e.message);
    return bad(res, e.status || 500, e.status ? e.message : 'Could not load the dashboard');
  }
};

// ---------- audit log ----------

exports.listAudit = async (req, res) => {
  try {
    const scope = resolveTenantScope(req.admin, req.query.tenantId);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = await AdminAudit.find(scope === null ? {} : { tenantId: scope }).sort({ at: -1 }).limit(limit);
    return ok(res, rows.map((r) => ({
      id: String(r._id), at: r.at, action: r.action, actorEmail: r.actorEmail, targetType: r.targetType,
      targetId: r.targetId, tenantId: r.tenantId, meta: r.meta
    })));
  } catch (e) {
    return bad(res, e.status || 500, e.status ? e.message : 'Could not load the audit log');
  }
};
