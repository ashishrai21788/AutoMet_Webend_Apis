/**
 * Tolls on a trip.
 *
 * A toll is a pass-through: the driver pays it on the road and the rider pays it back, on top of the metered fare. The driver
 * says how much it was when ending the trip. It is added to what the rider pays and to what the driver receives, is never
 * discounted by a coupon, and the business takes no commission on it. A business must switch tolls on and sets the most a
 * driver may enter (a typo or a dishonest amount is refused, not charged). Once a trip is completed its toll is fixed.
 *
 * Amounts are in whole minor units (paise, cents) on the trip (`toll_minor`) and in major units in requests.
 */
const { digitsOf, toMinor } = require('./riderInvoice');

/** The stored settings, always complete. */
function settingsOf(tenant) {
  const s = (tenant && tenant.tollSettings) || {};
  const max = Number(s.maxTollMinor);
  return { enabled: !!s.enabled, maxTollMinor: Number.isInteger(max) && max > 0 ? max : 0 };
}

const currencyOf = (tenant) => (tenant && tenant.market && tenant.market.currency) || 'INR';

/** What the driver app is told (the public config): whether to ask, and the most that may be entered. */
function publicShape(tenant) {
  const s = settingsOf(tenant);
  const digits = digitsOf(currencyOf(tenant));
  return { enabled: s.enabled && s.maxTollMinor > 0, maxToll: s.maxTollMinor / 10 ** digits };
}

/** Checks the dashboard form (major units). Returns { value, errors }; value is the stored shape. */
function validateSettings(body, tenant) {
  const b = body || {};
  const digits = digitsOf(currencyOf(tenant));
  const errors = {};
  const enabled = !!b.enabled;
  const raw = b.maxToll === '' || b.maxToll == null ? 0 : Number(b.maxToll);
  if (!Number.isFinite(raw) || raw < 0 || raw > 1000000) errors.maxToll = 'Enter 0 or more';
  else if (enabled && raw <= 0) errors.maxToll = 'Enter the most a driver may enter for one trip';
  const minor = Number.isFinite(raw) && raw > 0 ? toMinor(raw, digits) : 0;
  return { value: { enabled, maxTollMinor: minor }, errors };
}

/**
 * The toll the driver entered when ending the trip: nothing (or 0) means none. Returns { ok: true, minor } or
 * { ok: false, message } with a message fit to show the driver.
 */
function parseToll(body, tenant) {
  const raw = body && (body.toll_amount ?? body.toll);
  if (raw === undefined || raw === null || raw === '') return { ok: true, minor: 0 };
  const digits = digitsOf(currencyOf(tenant));
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return { ok: false, message: 'Enter the toll as a number, 0 or more' };
  if (n === 0) return { ok: true, minor: 0 };
  const minor = Math.round(n * 10 ** digits);
  if (Math.abs(minor / 10 ** digits - n) > 1e-9) return { ok: false, message: `The toll can have at most ${digits} decimal places` };
  const s = settingsOf(tenant);
  if (!s.enabled || s.maxTollMinor <= 0) return { ok: false, message: 'Tolls are not enabled for this business' };
  if (minor > s.maxTollMinor) return { ok: false, message: `The toll cannot be more than ${s.maxTollMinor / 10 ** digits}` };
  return { ok: true, minor };
}

module.exports = { settingsOf, publicShape, validateSettings, parseToll };
