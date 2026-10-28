/**
 * Payment configuration and the production safeguards.
 *
 * The mock gateway exists only when PAYMENTS_MOCK_ENABLED=1 AND the server is not in production. A production server started with
 * PAYMENTS_MOCK_ENABLED set refuses to start (assertSafeStartup), so a deployment mistake cannot open a way to mark a real payment paid.
 *
 * A business's settings live on its record (`payments`). Everything has a safe default: cash only, no online provider, and recovery of
 * cash commission from online earnings the way the platform already behaves (DEDUCT_FROM_PAYABLE).
 */
const METHODS = ['CASH', 'UPI'];
const RECOVERY = ['DEDUCT_FROM_PAYABLE', 'MANUAL_ONLY'];
const PROVIDERS = ['MOCK', 'RAZORPAY', 'CASHFREE'];

const isProduction = (env = process.env) => String(env.NODE_ENV || '').toLowerCase() === 'production';
const mockEnabled = (env = process.env) => String(env.PAYMENTS_MOCK_ENABLED || '') === '1' && !isProduction(env);

function assertSafeStartup(env = process.env) {
  if (isProduction(env) && String(env.PAYMENTS_MOCK_ENABLED || '') !== '') {
    throw new Error('PAYMENTS_MOCK_ENABLED must not be set in production: the mock gateway can mark payments paid');
  }
}

function tenantPayments(tenant) {
  const p = (tenant && tenant.payments) || {};
  const methods = Array.isArray(p.enabledMethods) ? p.enabledMethods.map((m) => String(m).toUpperCase()).filter((m) => METHODS.includes(m)) : [];
  const provider = PROVIDERS.includes(String(p.provider || '').toUpperCase()) ? String(p.provider).toUpperCase() : null;
  return {
    enabledMethods: methods.length ? [...new Set(methods)] : ['CASH'],
    provider,
    merchantId: p.merchantId ? String(p.merchantId) : null,
    commissionRecovery: RECOVERY.includes(p.commissionRecovery) ? p.commissionRecovery : 'DEDUCT_FROM_PAYABLE',
    fundsFlow: 'MERCHANT_COLLECTS', // the only flow implemented: the business is the merchant and owes drivers their net
    paymentWindowMinutes: Number.isInteger(p.paymentWindowMinutes) && p.paymentWindowMinutes > 0 && p.paymentWindowMinutes <= 1440 ? p.paymentWindowMinutes : 15
  };
}

/** Which online providers can actually be used right now (the mock only where it is allowed; the real ones are not built yet). */
const usableProviders = (env = process.env) => (mockEnabled(env) ? ['MOCK'] : []);

/** Check what an administrator sent for a business's payment settings. -> { value, errors } */
function validateSettings(input, env = process.env) {
  const errors = {};
  const src = input && typeof input === 'object' ? input : {};
  const methods = Array.isArray(src.enabledMethods) ? [...new Set(src.enabledMethods.map((m) => String(m).toUpperCase()))] : ['CASH'];
  for (const m of methods) if (!METHODS.includes(m)) errors.enabledMethods = `Unknown payment method ${m}`;
  if (!methods.includes('CASH') && !errors.enabledMethods) errors.enabledMethods = 'Cash must stay available';
  let provider = src.provider ? String(src.provider).toUpperCase() : null;
  if (provider && !PROVIDERS.includes(provider)) { errors.provider = 'Unknown payment provider'; provider = null; }
  if (methods.includes('UPI')) {
    if (!provider) errors.provider = 'Choose a provider to take UPI payments';
    else if (!usableProviders(env).includes(provider)) errors.provider = `${provider} is not available yet: it needs a merchant account and an integration that has been tested in its sandbox`;
  }
  const recovery = src.commissionRecovery == null ? 'DEDUCT_FROM_PAYABLE' : String(src.commissionRecovery);
  if (!RECOVERY.includes(recovery)) errors.commissionRecovery = 'Choose DEDUCT_FROM_PAYABLE or MANUAL_ONLY';
  let window = 15;
  if (src.paymentWindowMinutes != null && src.paymentWindowMinutes !== '') {
    window = Number(src.paymentWindowMinutes);
    if (!Number.isInteger(window) || window < 5 || window > 60) errors.paymentWindowMinutes = 'Enter 5 to 60 minutes';
  }
  const merchantId = src.merchantId ? String(src.merchantId).trim().slice(0, 80) : null;
  return { value: { enabledMethods: methods.includes('UPI') && provider ? ['CASH', 'UPI'] : ['CASH'], provider: methods.includes('UPI') ? provider : null, merchantId, commissionRecovery: recovery, paymentWindowMinutes: window }, errors };
}

module.exports = { usableProviders, validateSettings, METHODS, RECOVERY, PROVIDERS, isProduction, mockEnabled, assertSafeStartup, tenantPayments };
