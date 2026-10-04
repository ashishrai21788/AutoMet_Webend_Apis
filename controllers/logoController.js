const multer = require('multer');
const { Tenant, AdminAudit } = require('../models/adminModels');
const { detectMime } = require('../lib/fileValidation');
const images = require('../lib/publicImages');
const c = require('./fleet/common');

const MAX_LOGO_BYTES = 1024 * 1024; // 1 MB; the logo is shown small in the apps
const LOGO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']); // not SVG: it can carry scripts

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 2 } }).single('file');

exports.parse = (req, res, next) => {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return c.fail(res, 413, 'The logo is too large (1 MB at most)', { file: 'The logo is too large (1 MB at most)' });
    return c.fail(res, 400, 'The upload could not be read', { file: 'Choose one JPEG, PNG or WebP image' });
  });
};

async function audit(req, action, meta) {
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType: 'business', targetId: req.business.tenantId, meta, ip: req.ip || null });
  } catch (e) { console.warn('[logo] audit write failed:', e.message); }
}

/** POST /business/logo (multipart, field "file"): replaces the business's logo. */
exports.upload = c.handle(async (req, res) => {
  if (!req.file) return c.invalid(res, { file: 'Choose a logo image' });
  const mime = detectMime(req.file.buffer); // the file's own bytes decide, not its name or the browser's claim
  if (!LOGO_MIMES.has(mime)) return c.invalid(res, { file: 'The logo must be a JPEG, PNG or WebP image' });
  if (!images.isAvailable()) return c.fail(res, 503, 'Image storage is not set up on this server, so a logo cannot be uploaded yet.');
  const url = await images.putLogo(req.file.buffer, { tenantId: req.business.tenantId, mime });
  await req.data.update(Tenant, {}, { logoUrl: url });
  await audit(req, 'business.logo_updated', { bytes: req.file.size, type: mime });
  return c.ok(res, { logoUrl: url });
});

/** DELETE /business/logo */
exports.remove = c.handle(async (req, res) => {
  await images.removeLogo({ tenantId: req.business.tenantId });
  await req.data.update(Tenant, {}, { logoUrl: '' });
  await audit(req, 'business.logo_removed', {});
  return c.ok(res, { logoUrl: '' });
});

exports.MAX_LOGO_BYTES = MAX_LOGO_BYTES;
