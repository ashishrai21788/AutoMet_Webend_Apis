/**
 * Two-step verification codes (TOTP, RFC 6238) for authenticator apps, with no dependency: 6 digits, 30 second steps, SHA-1
 * (what every authenticator app expects). A code is accepted within one step either side of now, and never twice
 * (`afterStep` is the last step already used for the account).
 *
 * The shared secret is encrypted at rest with a key derived from JWT_SECRET (AES-256-GCM), so a copy of the database alone
 * cannot produce valid codes.
 */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0; let value = 0; const out = [];
  for (const ch of String(text).toUpperCase().replace(/=+$/, '')) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}

/** Returns the matching step (a number) or null. `afterStep`: steps at or before it are refused (replay protection). */
function verify(secret, code, { now = Date.now(), window = 1, afterStep = -1 } = {}) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const current = Math.floor(now / 1000 / STEP_SECONDS);
  for (let d = -window; d <= window; d++) {
    const step = current + d;
    if (step <= afterStep) continue;
    const expected = Buffer.from(codeAt(secret, step));
    const given = Buffer.from(clean);
    if (crypto.timingSafeEqual(expected, given)) return step;
  }
  return null;
}

const otpauthUri = ({ secret, account, issuer }) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

// ---- encryption of the stored secret
function boxKey() {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error('Server auth misconfigured');
  return crypto.createHmac('sha256', base).update('automet-2fa-secret-v1').digest();
}
function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', boxKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function open(sealed) {
  const [iv, tag, enc] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', boxKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/** Single-use recovery codes, shown once; only their hashes are stored. */
const newRecoveryCodes = (n = 8) => Array.from({ length: n }, () => { const h = crypto.randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
const hashRecovery = (code) => crypto.createHash('sha256').update(String(code).trim().toLowerCase().replace(/\s/g, '')).digest('hex');

/** Whether the platform owner must use two-step verification (on unless REQUIRE_PLATFORM_2FA=0). */
const requiredForPlatform = (env = process.env) => !['0', 'false', 'no'].includes(String(env.REQUIRE_PLATFORM_2FA ?? '1').toLowerCase());

module.exports = { generateSecret, verify, codeAt, otpauthUri, seal, open, newRecoveryCodes, hashRecovery, requiredForPlatform, base32Encode, base32Decode, STEP_SECONDS };
