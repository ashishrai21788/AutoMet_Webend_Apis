/**
 * Recovering the commission a driver owes from cash fares out of what the business owes them from online fares.
 *
 * A cash fare leaves a receivable (DRIVER_COMMISSION_RECEIVABLE). When the driver later earns money the business holds (a verified online
 * fare, DRIVER_PAYABLE), the business may set the two against each other. That is only done when the business's policy allows it
 * (`payments.commissionRecovery` = DEDUCT_FROM_PAYABLE, the default and what the platform already does when it works out a payout) and it
 * needs a basis in the driver's agreement. With MANUAL_ONLY nothing is recovered automatically; an administrator can still run it.
 *
 * Each recovery is a separate ledger transaction (DR driver payable, CR driver commission receivable). The cash trip's own commission
 * entry is never touched. The amount is the smaller of what is owed by the driver and what is owed to them, so it can never take
 * more than the driver is owed, and never more than the outstanding commission.
 *
 * Concurrency: recoveries of one driver are numbered, and the number is part of the event key (`recovery:<driver>:<n>`). Two requests
 * working from the same state compute the same transaction and the second is recognised as a repeat; two working from different states
 * collide on the number, and the loser recomputes from the new balances. So the same commission can never be recovered twice.
 */
const ledger = require('../ledger');
const { ACCOUNTS: A } = ledger;
const { tenantPayments } = require('./config');
const svc = require('./service');

const MAX_ROUNDS = 8;

/** -> { recoveredMinor, duplicate, skipped } */
async function recoverCommission({ tenantId, driverId, trigger = 'auto', createdBy = 'system', currency = 'INR' }) {
  const cfg = tenantPayments(await svc.loadTenant(tenantId));
  if (trigger === 'auto' && cfg.commissionRecovery === 'MANUAL_ONLY') return { recoveredMinor: 0, duplicate: false, skipped: 'MANUAL_ONLY' };
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const seq = (await ledger.list({ tenantId, driverId, type: 'COMMISSION_RECOVERED' })).length + 1;
    const owedByDriver = await ledger.commissionOutstanding({ tenantId, driverId });
    const owedToDriver = await ledger.owedToDriver({ tenantId, driverId });
    const amount = Math.max(0, Math.min(owedByDriver, owedToDriver));
    if (amount === 0) return { recoveredMinor: 0, duplicate: false, skipped: null };
    try {
      const r = await ledger.post({
        tenantId, driverId, eventKey: `recovery:${driverId}:${seq}`, type: 'COMMISSION_RECOVERED', currency, createdBy,
        entries: [{ account: A.DRIVER_PAYABLE, driverId, debitMinor: amount }, { account: A.DRIVER_COMMISSION_RECEIVABLE, driverId, creditMinor: amount }],
        memo: `Commission from cash fares recovered from online earnings (${trigger})`
      });
      return { recoveredMinor: r.duplicate ? 0 : amount, duplicate: r.duplicate, skipped: null };
    } catch (e) {
      if (e.code !== 'EVENT_KEY_REUSED') throw e; // another recovery took this number with a different amount: look again
    }
  }
  throw Object.assign(new Error('commission recovery is busy; try again'), { code: 'BUSY', status: 409 });
}

module.exports = { recoverCommission };
