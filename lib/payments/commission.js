/**
 * The three commission amounts, kept apart (read from the ledger, never from a cached figure):
 *   accrued      commission earned on cash fares the driver collected (net of any reversal or adjustment of those bookings)
 *   collected    commission actually received: recovered from online earnings, or paid by the driver directly
 *   outstanding  what the driver still owes (accrued - collected, and the live balance of the receivable account)
 * Outstanding commission is a receivable, not collected revenue.
 */
const ledger = require('../ledger');
const { ACCOUNTS: A } = ledger;

const ACCRUAL = new Set(['CASH_COMMISSION_ACCRUED', 'CASH_COMMISSION_ADJUSTED']);
const COLLECTION = new Set(['COMMISSION_RECOVERED', 'COMMISSION_PAID_DIRECT']);

async function summary({ tenantId, driverId }) {
  let accrued = 0; let collected = 0; let outstanding = 0;
  for (const t of await ledger.list({ tenantId, driverId })) {
    const net = t.entries.filter((e) => e.account === A.DRIVER_COMMISSION_RECEIVABLE && e.driverId === driverId).reduce((n, e) => n + (e.debitMinor || 0) - (e.creditMinor || 0), 0);
    outstanding += net;
    const base = String(t.type).replace(/^REVERSAL_OF_/, '');
    if (ACCRUAL.has(base)) accrued += net;
    else if (COLLECTION.has(base)) collected -= net;
  }
  return { accruedMinor: accrued, collectedMinor: collected, outstandingMinor: outstanding };
}

module.exports = { summary };
