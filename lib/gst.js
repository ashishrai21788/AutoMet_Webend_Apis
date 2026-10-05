/**
 * GST for the platform's own invoices (India). Pure functions.
 *
 *  - A GSTIN is 15 characters: 2-digit state code, 10-character PAN, entity number, "Z", check character.
 *  - Supply within the seller's state: CGST and SGST, half each. Supply to another state: IGST.
 *  - The platform charges GST only when it has its own GSTIN set. Without one, invoices carry no tax.
 *  - Money is rounded to paise at each line; CGST + SGST always add up to the tax exactly.
 * (Not tax advice: check the rate and SAC code with your accountant.)
 */
const GSTIN_RE = /^(\d{2})[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory'
};

const round = (n) => Math.round(n * 100) / 100;

const isGstin = (v) => { const m = GSTIN_RE.exec(String(v || '').trim().toUpperCase()); return !!m && !!STATES[m[1]]; };
const stateOfGstin = (v) => (isGstin(v) ? String(v).trim().toUpperCase().slice(0, 2) : null);
const isStateCode = (v) => Object.prototype.hasOwnProperty.call(STATES, String(v || ''));

/**
 * `seller.gstin` empty: no tax. Otherwise `buyerStateCode` is required (place of supply) and decides CGST+SGST or IGST.
 * Returns { rate, supply, taxable, cgst, sgst, igst, taxAmount, total }.
 */
function computeTax({ taxable, rate, sellerGstin, sellerStateCode, buyerStateCode }) {
  const base = round(taxable);
  const none = { rate: 0, supply: 'none', taxable: base, cgst: 0, sgst: 0, igst: 0, taxAmount: 0, total: base };
  const r = Number(rate);
  if (!sellerGstin || !(r > 0)) return none;
  const taxAmount = round((base * r) / 100);
  const seller = sellerStateCode || stateOfGstin(sellerGstin);
  if (seller && buyerStateCode && String(seller) === String(buyerStateCode)) {
    const cgst = round(taxAmount / 2);
    return { rate: r, supply: 'intra', taxable: base, cgst, sgst: round(taxAmount - cgst), igst: 0, taxAmount, total: round(base + taxAmount) };
  }
  return { rate: r, supply: 'inter', taxable: base, cgst: 0, sgst: 0, igst: taxAmount, taxAmount, total: round(base + taxAmount) };
}

/** Whole rupees and paise in words (Indian grouping), for the invoice footer. */
function amountInWords(amount) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const below100 = (n) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`);
  const below1000 = (n) => (n < 100 ? below100(n) : `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${below100(n % 100)}` : ''}`);
  const words = (n) => {
    if (n === 0) return 'Zero';
    const parts = [];
    for (const [div, name] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]) {
      if (n >= div) { parts.push(`${below1000(Math.floor(n / div))} ${name}`); n %= div; }
    }
    if (n > 0) parts.push(below1000(n));
    return parts.join(' ');
  };
  const total = Math.round(Math.abs(amount) * 100);
  const rupees = Math.floor(total / 100);
  const paise = total % 100;
  return `Rupees ${words(rupees)}${paise ? ` and ${words(paise)} Paise` : ''} Only`;
}

module.exports = { GSTIN_RE, STATES, isGstin, isStateCode, stateOfGstin, computeTax, amountInWords, round };
