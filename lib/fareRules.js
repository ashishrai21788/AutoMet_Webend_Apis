/**
 * Fare-rule validation and the fare calculation shown in the dashboard preview.
 *
 * Calculation (one place, so the preview and any future live use agree):
 *   ride charge   = base fare + distance x per-km + time x per-minute + waiting charge
 *   waiting       = max(0, waiting minutes - free minutes) x waiting per-minute
 *   surged ride   = ride charge x surge multiplier   (multiplier is capped by the rule; 1 when surge is off)
 *   fare          = max(minimum fare, surged ride)   <- the minimum fare applies to the ride charge only
 *   fees          = booking fee + additional charges (fixed amounts, or a percent of `fare`)
 *   taxes         = each tax rate x its own base (`fare` or `fare + fees`); taxes are never taxed again
 *   total         = max(0, fare + fees + taxes - discount)
 * Every line is rounded to the currency's minor unit and the total is the sum of the rounded lines, so the
 * breakdown always adds up and nothing is counted twice.
 */
const MAX_MONEY = 1000000;

function minorDigits(currency) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

const roundTo = (value, digits) => {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
};

const isMoney = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MONEY;
const asNumber = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);

/** Validates and normalises the editable part of a fare rule. Returns { value, errors } (errors keyed by field). */
function validateFareRuleInput(input = {}) {
  const errors = {};
  const out = {};

  const money = (field, label, { allowZero = true } = {}) => {
    const v = asNumber(input[field]);
    if (!isMoney(v)) errors[field] = `${label} must be a number from 0 to ${MAX_MONEY.toLocaleString('en')}`;
    else if (!allowZero && v === 0) errors[field] = `${label} must be greater than 0`;
    else out[field] = v;
  };
  money('baseFare', 'Base fare');
  money('perKm', 'Price per km');
  money('perMinute', 'Price per minute');
  money('minimumFare', 'Minimum fare');
  money('bookingFee', 'Booking fee');
  money('waitingPerMinute', 'Waiting charge per minute');

  const free = asNumber(input.waitingFreeMinutes);
  if (!(typeof free === 'number' && Number.isFinite(free) && free >= 0 && free <= 120)) errors.waitingFreeMinutes = 'Free waiting must be 0 to 120 minutes';
  else out.waitingFreeMinutes = free;

  if (!errors.baseFare && !errors.perKm && !errors.perMinute && !errors.minimumFare &&
      out.baseFare === 0 && out.perKm === 0 && out.perMinute === 0 && out.minimumFare === 0) {
    errors.baseFare = 'Set a base fare, a distance or time rate, or a minimum fare; the fare cannot always be zero';
  }

  const charges = Array.isArray(input.additionalCharges) ? input.additionalCharges : [];
  if (charges.length > 10) errors.additionalCharges = 'At most 10 additional charges';
  out.additionalCharges = [];
  charges.slice(0, 10).forEach((c, i) => {
    const name = String(c?.name || '').trim();
    const amount = asNumber(c?.amount);
    const type = c?.type;
    if (!name || name.length > 60) errors[`additionalCharges.${i}.name`] = 'Name is required (60 characters at most)';
    else if (type !== 'fixed' && type !== 'percent_of_fare') errors[`additionalCharges.${i}.type`] = 'Choose fixed or percent of fare';
    else if (!isMoney(amount) || (type === 'percent_of_fare' && amount > 100)) errors[`additionalCharges.${i}.amount`] = type === 'percent_of_fare' ? 'Percent must be 0 to 100' : 'Amount must be 0 or more';
    else out.additionalCharges.push({ name, type, amount });
  });

  const taxes = Array.isArray(input.taxes) ? input.taxes : [];
  if (taxes.length > 5) errors.taxes = 'At most 5 taxes';
  out.taxes = [];
  taxes.slice(0, 5).forEach((t, i) => {
    const name = String(t?.name || '').trim();
    const rate = asNumber(t?.ratePercent);
    if (!name || name.length > 40) errors[`taxes.${i}.name`] = 'Tax name is required (40 characters at most)';
    else if (!(typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 100)) errors[`taxes.${i}.ratePercent`] = 'Rate must be 0 to 100';
    else if (t?.appliesTo !== 'fare' && t?.appliesTo !== 'fare_and_fees') errors[`taxes.${i}.appliesTo`] = 'Choose what the tax applies to';
    else out.taxes.push({ name, ratePercent: rate, appliesTo: t.appliesTo });
  });

  const surge = input.surge || {};
  const enabled = surge.enabled === true;
  const max = asNumber(surge.maxMultiplier);
  if (enabled && !(typeof max === 'number' && Number.isFinite(max) && max >= 1 && max <= 10)) errors['surge.maxMultiplier'] = 'Maximum multiplier must be 1 to 10';
  out.surge = { enabled, maxMultiplier: enabled ? max : 1 };

  return { value: out, errors };
}

/**
 * @param {object} rule validated fare rule fields
 * @param {{distanceKm:number, durationMin:number, waitingMin?:number, surgeMultiplier?:number, discount?:number}} trip
 * @param {string} currency ISO 4217
 */
function calculateFare(rule, trip, currency) {
  const digits = minorDigits(currency);
  const r = (v) => roundTo(v, digits);
  const distanceKm = Math.max(0, Number(trip.distanceKm) || 0);
  const durationMin = Math.max(0, Number(trip.durationMin) || 0);
  const waitingMin = Math.max(0, Number(trip.waitingMin) || 0);
  const discount = Math.max(0, Number(trip.discount) || 0);

  const lines = [];
  const base = r(rule.baseFare);
  const distance = r(distanceKm * rule.perKm);
  const time = r(durationMin * rule.perMinute);
  const waiting = r(Math.max(0, waitingMin - rule.waitingFreeMinutes) * rule.waitingPerMinute);
  lines.push({ key: 'base', label: 'Base fare', amount: base });
  lines.push({ key: 'distance', label: `Distance (${distanceKm} km)`, amount: distance });
  lines.push({ key: 'time', label: `Time (${durationMin} min)`, amount: time });
  if (waiting > 0) lines.push({ key: 'waiting', label: `Waiting (${waitingMin} min)`, amount: waiting });

  const rideCharge = base + distance + time + waiting;
  const cap = rule.surge?.enabled ? rule.surge.maxMultiplier : 1;
  const requested = Number(trip.surgeMultiplier) || 1;
  const multiplier = Math.min(Math.max(requested, 1), cap);
  let surgeAmount = 0;
  if (multiplier > 1) {
    surgeAmount = r(rideCharge * multiplier - rideCharge);
    lines.push({ key: 'surge', label: `Surge (x${multiplier})`, amount: surgeAmount });
  }
  const surged = rideCharge + surgeAmount;

  let minimumTopUp = 0;
  if (surged < rule.minimumFare) {
    minimumTopUp = r(rule.minimumFare - surged);
    lines.push({ key: 'minimum', label: `Minimum fare adjustment (minimum ${r(rule.minimumFare)})`, amount: minimumTopUp });
  }
  const fare = r(surged + minimumTopUp);

  const fees = [];
  if (rule.bookingFee > 0) fees.push({ key: 'booking', label: 'Booking fee', amount: r(rule.bookingFee) });
  (rule.additionalCharges || []).forEach((c, i) => {
    const amount = c.type === 'percent_of_fare' ? r((fare * c.amount) / 100) : r(c.amount);
    fees.push({ key: `charge-${i}`, label: c.type === 'percent_of_fare' ? `${c.name} (${c.amount}% of fare)` : c.name, amount });
  });
  const feesTotal = r(fees.reduce((a, f) => a + f.amount, 0));

  const taxes = (rule.taxes || []).map((t, i) => {
    const taxable = t.appliesTo === 'fare' ? fare : fare + feesTotal;
    return { key: `tax-${i}`, label: `${t.name} (${t.ratePercent}% of ${t.appliesTo === 'fare' ? 'fare' : 'fare + fees'})`, amount: r((taxable * t.ratePercent) / 100) };
  });
  const taxesTotal = r(taxes.reduce((a, t) => a + t.amount, 0));

  const gross = r(fare + feesTotal + taxesTotal);
  const appliedDiscount = Math.min(r(discount), gross);
  const total = r(gross - appliedDiscount);

  return {
    currency,
    multiplier,
    lines, // ride charge components, including surge and the minimum-fare adjustment
    fare, // ride charge after surge and minimum fare
    fees,
    feesTotal,
    taxes,
    taxesTotal,
    discount: appliedDiscount,
    total
  };
}

module.exports = { validateFareRuleInput, calculateFare, minorDigits, MAX_MONEY };
