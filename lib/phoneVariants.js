/**
 * The forms a phone number may be stored in. Drivers added from the admin dashboard are stored in international form
 * ("+919876543210"), while accounts created by the apps keep the number as it was typed ("9876543210"). Sign-in
 * matched the exact text, so the same person could not sign in with the other form. This returns every form of the
 * same number so a lookup finds the account whichever way it was saved.
 *
 * Only Indian numbers (10 digits, optionally with a 91 or +91 prefix) are widened; anything else is matched exactly.
 */
function phoneVariants(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return [];
  const digits = raw.replace(/\D/g, '');
  const out = new Set([raw]);
  const tail = digits.length >= 10 ? digits.slice(-10) : '';
  const indian = digits.length === 10 || (digits.length === 12 && digits.startsWith('91'));
  if (tail && indian) {
    out.add(tail);
    out.add('+91' + tail);
    out.add('91' + tail);
  }
  return Array.from(out);
}

module.exports = { phoneVariants };
