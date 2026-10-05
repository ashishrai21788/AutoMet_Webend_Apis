/**
 * Private document storage. Files are never public: the database keeps only a storage key, and a file can be opened only
 * through a short-lived signed URL that the API issues to an authorised administrator (and records in the audit log).
 *
 * The backend is pluggable. In production it is Cloudinary using `type: authenticated` assets, so even a guessed URL
 * returns nothing without a valid signature; the signed link expires after a few minutes. Tests and the local dev server
 * install an in-memory backend. When no backend is available, uploads are refused with a clear message rather than
 * falling back to a public location.
 */
const crypto = require('crypto');

const SIGNED_URL_TTL_SECONDS = 5 * 60;
let backend = null;

function setBackend(next) {
  backend = next;
}

/** The Cloudinary backend, used when the CLOUDINARY_* variables are set. */
function cloudinaryBackend() {
  const cloudinary = require('cloudinary').v2;
  const configured = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
  if (!configured) return null;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true
  });
  const resourceType = (mime) => (mime === 'application/pdf' ? 'raw' : 'image');
  const extensionOf = (mime) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[mime]);
  return {
    name: 'cloudinary',
    async put(buffer, { folder, mime }) {
      const publicId = `${folder}/${crypto.randomBytes(16).toString('hex')}`;
      await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { public_id: publicId, resource_type: resourceType(mime), type: 'authenticated', overwrite: false },
          (err, result) => (err ? reject(err) : resolve(result))
        );
        stream.end(buffer);
      });
      return `${resourceType(mime)}:${publicId}`;
    },
    /** Removes every file under a folder prefix (best effort per resource type); returns how many were deleted. */
    async removePrefix(prefix) {
      let removed = 0;
      for (const resource_type of ['image', 'raw']) {
        try {
          const r = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type, type: 'authenticated' });
          removed += Object.values(r.deleted || {}).filter((v) => v === 'deleted').length;
        } catch (e) { if (!/not found/i.test(String(e && (e.message || (e.error && e.error.message))))) throw e; }
      }
      try { await cloudinary.api.delete_folder(prefix.replace(/\/$/, '')); } catch { /* the folder may already be gone */ }
      return removed;
    },
    url(key, { mime, ttlSeconds }) {
      const [type, ...rest] = key.split(':');
      return cloudinary.utils.private_download_url(rest.join(':'), extensionOf(mime) || '', {
        resource_type: type, type: 'authenticated', expires_at: Math.floor(Date.now() / 1000) + ttlSeconds
      });
    }
  };
}

function activeBackend() {
  if (!backend) backend = cloudinaryBackend();
  return backend;
}

const isAvailable = () => !!activeBackend();

/** Stores the bytes privately. Returns the storage key to keep in the database. */
async function putPrivate(buffer, { tenantId, kind, mime }) {
  const b = activeBackend();
  if (!b) {
    const err = new Error('Document storage is not configured');
    err.status = 503;
    throw err;
  }
  return b.put(buffer, { folder: `automet/${tenantId}/${kind}`, mime });
}

/** A link that opens the file for `ttlSeconds` and then stops working. */
function signedUrl(key, { mime, ttlSeconds = SIGNED_URL_TTL_SECONDS }) {
  const b = activeBackend();
  if (!b) return null;
  return b.url(key, { mime, ttlSeconds });
}

/** Deletes all files stored for one business. Returns the number removed, or null when storage is not available. */
async function removeTenantFiles(tenantId) {
  const b = activeBackend();
  if (!b || !b.removePrefix) return null;
  return b.removePrefix(`automet/${tenantId}/`);
}

module.exports = { setBackend, putPrivate, signedUrl, isAvailable, removeTenantFiles, SIGNED_URL_TTL_SECONDS };
