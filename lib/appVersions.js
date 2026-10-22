/**
 * Minimum app version per business and per app (rider, driver).
 *
 * A business can stop old builds of its apps from working once they are below a build number it sets. The apps send
 * their build number in `X-App-Version-Code` and their kind in `X-App-Type` (rider | driver) on every request. When the
 * build is below the minimum the server answers 426 with code UPDATE_REQUIRED and the app shows a blocking update
 * screen. A request that sends no version (an older build, a script, a browser) is never blocked, so turning this on
 * cannot lock out something that cannot answer it.
 *
 * The same minimums are in the public business config, so an app can ask before the first sign-in and also work out,
 * offline, that it must update.
 */
const TYPES = ['rider', 'driver'];
const DEFAULT_MESSAGE = 'A newer version of the app is required. Please update to continue.';
const MAX_CODE = 2000000000;

const normalise = (x) => {
  const v = x || {};
  const code = Number.isInteger(v.minVersionCode) && v.minVersionCode > 0 ? v.minVersionCode : 0;
  return { minVersionCode: code, message: String(v.message || '').trim(), storeUrl: String(v.storeUrl || '').trim() };
};

/** The stored settings for both apps, always complete. */
function settingsOf(tenant) {
  const v = (tenant && tenant.appVersions) || {};
  return { rider: normalise(v.rider), driver: normalise(v.driver) };
}

/** What the apps are told (the public config): the same as stored, with the default message filled in. */
function publicShape(tenant) {
  const s = settingsOf(tenant);
  const out = {};
  for (const t of TYPES) out[t] = { ...s[t], message: s[t].message || DEFAULT_MESSAGE };
  return out;
}

/** Checks the dashboard form. Returns { value, errors }. */
function validate(body) {
  const b = body || {};
  const errors = {};
  const value = {};
  for (const t of TYPES) {
    const input = b[t] || {};
    const raw = input.minVersionCode === '' || input.minVersionCode == null ? 0 : Number(input.minVersionCode);
    const message = String(input.message || '').trim();
    const storeUrl = String(input.storeUrl || '').trim();
    if (!Number.isInteger(raw) || raw < 0 || raw > MAX_CODE) errors[`${t}.minVersionCode`] = 'Enter a whole number, 0 for no minimum';
    if (message.length > 200) errors[`${t}.message`] = 'At most 200 characters';
    if (storeUrl && (storeUrl.length > 300 || !/^https:\/\/[^\s]+$/i.test(storeUrl))) errors[`${t}.storeUrl`] = 'Use a full https:// link, or leave it empty';
    value[t] = { minVersionCode: raw, message, storeUrl };
  }
  return { value, errors };
}

const typeOf = (req) => {
  const t = String((req.headers && req.headers['x-app-type']) || '').trim().toLowerCase();
  return TYPES.includes(t) ? t : null;
};
const codeOf = (req) => {
  const raw = String((req.headers && req.headers['x-app-version-code']) || '').trim();
  if (!/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
};

/** null when the request may go on, else what to tell the app. */
function gate(req, tenant) {
  const type = typeOf(req);
  const code = codeOf(req);
  if (!type || code == null || !tenant) return null;
  const s = publicShape(tenant)[type];
  if (!s.minVersionCode || code >= s.minVersionCode) return null;
  return { message: s.message, minVersionCode: s.minVersionCode, storeUrl: s.storeUrl };
}

/** Mounted after the business is known. The public configuration and public pages stay reachable so an app can read the policy. */
function enforceMinAppVersion(req, res, next) {
  if (req.path.startsWith('/v1/public')) return next();
  const blocked = gate(req, req.appTenant);
  if (!blocked) return next();
  return res.status(426).json({ success: false, code: 'UPDATE_REQUIRED', message: blocked.message, data: { minVersionCode: blocked.minVersionCode, storeUrl: blocked.storeUrl } });
}

module.exports = { TYPES, DEFAULT_MESSAGE, settingsOf, publicShape, validate, gate, enforceMinAppVersion };
