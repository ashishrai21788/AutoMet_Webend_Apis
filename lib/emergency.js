/**
 * The number a person dials in an emergency, by country. The apps only ever open the phone's dialler with it (they never place the
 * call themselves); the number is told to them by the server so a business in another country is not sent to the wrong one.
 * 112 is the default: it works across the EU and India and is routed to the local service by many mobile networks elsewhere.
 */
const NUMBERS = {
  IN: '112', IE: '112', DE: '112', FR: '112', ES: '112', IT: '112', NL: '112', PT: '112', BE: '112', AT: '112', CH: '112', SE: '112',
  NO: '112', DK: '112', FI: '112', PL: '112', ZA: '112', NG: '112', LK: '112', NP: '112', BD: '999', PK: '15',
  US: '911', CA: '911', MX: '911', BR: '190', SA: '911', PH: '911',
  GB: '999', AE: '999', QA: '999', KW: '112', OM: '9999', BH: '999', MY: '999', KE: '999', HK: '999',
  AU: '000', NZ: '111', SG: '995', ID: '112', TH: '191', VN: '113', EG: '122', JP: '110', KR: '112'
};
const DEFAULT_NUMBER = '112';

const emergencyNumberFor = (country) => {
  const code = typeof country === 'string' ? country.trim().toUpperCase() : '';
  return NUMBERS[code] || DEFAULT_NUMBER;
};

module.exports = { emergencyNumberFor, DEFAULT_NUMBER };
