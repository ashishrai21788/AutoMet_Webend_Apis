const mongoose = require('mongoose');
const { ROLES } = require('../lib/adminPermissions');

const marketSchema = new mongoose.Schema({
  country: { type: String, trim: true }, // ISO 3166-1 alpha-2
  currency: { type: String, trim: true }, // ISO 4217
  timezone: { type: String, trim: true } // IANA
}, { _id: false });

/** A client of the platform: one white-label app with its own data, admins and settings. */
const tenantSchema = new mongoose.Schema({
  /** The business's appId. Assigned once at creation and never changes. */
  tenantId: { type: String, required: true, unique: true, trim: true, immutable: true },
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  appName: { type: String, required: true, trim: true },
  packageName: { type: String, required: true, unique: true, trim: true },
  city: { type: String, default: '', trim: true },
  plan: { type: String, enum: ['trial', 'standard', 'enterprise'], default: 'trial' },
  status: { type: String, enum: ['active', 'trial', 'suspended'], default: 'trial', index: true },
  brandColor: { type: String, default: '#f5a300', trim: true },
  supportEmail: { type: String, default: '', trim: true },
  supportPhone: { type: String, default: '', trim: true },
  /** https link to the business's logo, shown in its apps. */
  logoUrl: { type: String, default: '', trim: true },
  /** Operating country of the business; null until the owner completes the first onboarding step. */
  market: { type: marketSchema, default: null },
  /** Ride rules: { requireEligibleDrivers } (see lib/driverAvailability.js). */
  rideSettings: { type: mongoose.Schema.Types.Mixed, default: {} },
  /** Overrides of which optional documents are mandatory for drivers and vehicles: { driver: {TYPE: bool}, vehicle: {TYPE: bool} }. */
  verificationRequirements: { type: mongoose.Schema.Types.Mixed, default: {} },
  /** The client that owns records created before multi-client support (they carry no tenant tag). */
  isDefault: { type: Boolean, default: false }
}, { timestamps: true, collection: 'tenants' });

const adminUserSchema = new mongoose.Schema({
  adminId: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, required: true },
  /** null for super admins. */
  tenantId: { type: String, default: null, index: true },
  active: { type: Boolean, default: true },
  mustChangePassword: { type: Boolean, default: false },
  /** Bumped on logout-everywhere, password change and deactivation; tokens carry the value they were issued with. */
  tokenVersion: { type: Number, default: 0 },
  failedLogins: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
  lastLoginAt: { type: Date, default: null }
}, { timestamps: true, collection: 'admin_users' });

const adminAuditSchema = new mongoose.Schema({
  tenantId: { type: String, default: null, index: true },
  actorId: { type: String, default: null },
  actorEmail: { type: String, default: null },
  action: { type: String, required: true },
  targetType: { type: String, default: null },
  targetId: { type: String, default: null },
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
  ip: { type: String, default: null },
  at: { type: Date, default: Date.now, index: true }
}, { collection: 'admin_audit_logs' });

const Tenant = mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema);
const AdminUser = mongoose.models.AdminUser || mongoose.model('AdminUser', adminUserSchema);
const AdminAudit = mongoose.models.AdminAudit || mongoose.model('AdminAudit', adminAuditSchema);

module.exports = { Tenant, AdminUser, AdminAudit };
