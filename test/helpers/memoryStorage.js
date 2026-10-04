/**
 * In-memory private storage for tests and the local dev server. Mirrors the real behaviour: files are reachable only
 * through a signed URL that expires. `read(url)` plays the part of the file host (checks signature and expiry).
 */
const crypto = require('crypto');

function createMemoryStorage({ secret = 'memory-storage-secret', baseUrl = 'http://files.test' } = {}) {
  const files = new Map();
  const sign = (key, exp) => crypto.createHmac('sha256', secret).update(`${key}|${exp}`).digest('hex');

  const backend = {
    name: 'memory',
    files,
    async put(buffer, { folder, mime }) {
      const key = `${folder}/${crypto.randomBytes(8).toString('hex')}`;
      files.set(key, { buffer, mime });
      return key;
    },
    url(key, { ttlSeconds }) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      return `${baseUrl}/files?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sign(key, exp)}`;
    },
    /** What the file host does with a URL: returns { status, mime, buffer }. */
    read(url, now = Date.now()) {
      const u = new URL(url);
      const key = u.searchParams.get('key');
      const exp = Number(u.searchParams.get('exp'));
      const sig = u.searchParams.get('sig') || '';
      const good = sign(key || '', exp);
      if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return { status: 403 };
      if (now / 1000 > exp) return { status: 410 };
      const file = files.get(key);
      return file ? { status: 200, mime: file.mime, buffer: file.buffer } : { status: 404 };
    }
  };
  return backend;
}

module.exports = { createMemoryStorage };
