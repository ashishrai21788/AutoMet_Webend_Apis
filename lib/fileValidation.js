/**
 * Server-side checks for uploaded documents. The browser's content type and the file name are not trusted: the file's
 * first bytes decide what it is, and only these types are accepted.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

/** The real type of the file from its signature, or null when it is not one of the accepted types. */
function detectMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.slice(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Strips path parts and odd characters from a client-supplied file name (kept only for display). */
function safeFileName(name) {
  return String(name || '').split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, '_').slice(0, 80);
}

module.exports = { MAX_UPLOAD_BYTES, detectMime, safeFileName, PHOTO_MIMES };
