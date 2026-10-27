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

module.exports = { METHODS, RECOVERY, PROVIDERS, isProduction, mockEnabled, assertSafeStartup, tenantPayments };
