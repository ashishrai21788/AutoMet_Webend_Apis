/**
 * Public images (a business's logo). Unlike documents these are meant to be seen by every rider and driver of the
 * business, so they are stored publicly and the database keeps the link. The backend is pluggable like
 * lib/privateStorage.js: Cloudinary in production, an in-memory one in tests and the local dev server.
 */
let backend = null;

function setBackend(next) { backend = next; }

function cloudinaryBackend() {
  const configured = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
  if (!configured) return null;
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
  return {
    name: 'cloudinary',
    /** One logo per business: uploading again replaces it, and the returned link carries a new version so caches refresh. */
    async putLogo(buffer, { tenantId }) {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { public_id: `automet/logos/${tenantId}`, resource_type: 'image', type: 'upload', overwrite: true, invalidate: true, transformation: [{ width: 512, height: 512, crop: 'limit' }] },
          (err, r) => (err ? reject(err) : resolve(r))
        );
        stream.end(buffer);
      });
      return result.secure_url;
    },
    async removeLogo({ tenantId }) {
      try { await cloudinary.uploader.destroy(`automet/logos/${tenantId}`, { resource_type: 'image', invalidate: true }); } catch (e) { console.warn('[logo] could not delete the old logo:', e.message); }
    }
  };
}

function activeBackend() {
  if (!backend) backend = cloudinaryBackend();
  return backend;
}

const isAvailable = () => !!activeBackend();

async function putLogo(buffer, opts) {
  const b = activeBackend();
  if (!b) { const e = new Error('Image storage is not configured on this server'); e.status = 503; e.expose = true; throw e; }
  return b.putLogo(buffer, opts);
}

async function removeLogo(opts) {
  const b = activeBackend();
  if (b) await b.removeLogo(opts);
}

/** In-memory backend for tests and the local dev server. `baseUrl` is where the bytes are served from. */
function createMemoryImages({ baseUrl = 'https://images.test' } = {}) {
  const files = new Map();
  let n = 0;
  return {
    name: 'memory',
    files,
    async putLogo(buffer, { tenantId }) { n += 1; const id = `${tenantId}-${n}`; files.set(id, buffer); return `${baseUrl}/logo/${id}`; },
    async removeLogo({ tenantId }) { for (const k of [...files.keys()]) if (k.startsWith(`${tenantId}-`)) files.delete(k); },
    read: (id) => files.get(id) || null
  };
}

module.exports = { setBackend, isAvailable, putLogo, removeLogo, createMemoryImages };
