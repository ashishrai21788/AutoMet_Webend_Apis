/**
 * The upkeep payments need, for every business, meant to be called on a schedule (POST /api/v1/payments/jobs/run, protected by the
 * scheduler secret like the ride timeouts):
 *   - close online payments left open past their window (after asking the provider, so a payment that was really made succeeds instead),
 *   - finish interrupted bookings: a succeeded online payment or a confirmed cash fare whose ledger posting never completed,
 *   - ask the provider about refunds still waiting.
 * Every step is safe to repeat, and one business failing never stops the others.
 */
const { Tenant } = require('../../models/adminModels');
const { PaymentRefund } = require('../../models/paymentModels');
const svc = require('./service');
const cash = require('./cash');
const refunds = require('./refunds');
const { tenantPayments } = require('./config');

async function runAll({ env = process.env, now = new Date() } = {}) {
  const tenants = (await Tenant.find({}).lean()) || [];
  const report = [];
  for (const t of tenants) {
    const row = { tenantId: t.tenantId, expired: 0, repairedOnline: 0, repairedCash: 0, refundsSettled: 0, errors: [] };
    const step = async (name, fn) => { try { return await fn(); } catch (e) { row.errors.push(`${name}: ${e.message}`); return null; } };
    const cfg = tenantPayments(t);
    if (cfg.provider) {
      row.expired = (await step('expire', () => svc.expireStale({ tenantId: t.tenantId, now, env })) || []).length;
      row.repairedOnline = await step('repair online', () => svc.repairUnposted({ tenantId: t.tenantId })) || 0;
      for (const r of (await PaymentRefund.find({ tenantId: t.tenantId, status: 'REQUESTED' }).lean()) || []) {
        if (await step('settle refund', () => refunds.settleRefund({ tenantId: t.tenantId, refundId: r.refundId, env }))) row.refundsSettled += 1;
      }
    }
    row.repairedCash = await step('repair cash', () => cash.repairUnposted({ tenantId: t.tenantId })) || 0;
    report.push(row);
  }
  return report;
}

module.exports = { runAll };
